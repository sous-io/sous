/**
 * The memories migration (1.1.0; spec 19, "the first migration"). Before 1.1.0, sous compiled the
 * recipes' memories into the root `CLAUDE.md`; now they go to `.claude/rules/SOUS-MEMORIES.md`,
 * which Claude Code loads beside any `CLAUDE.md`. A project upgraded from the old default would get
 * its memories twice, so the migration asks:
 *
 * | Answer | What it writes |
 * |---|---|
 * | `move` (the default) | `.sous/MEMORIES.tpl.md` with the two default lines; the new default path applies. |
 * | `keep` | `memoriesOutputPath: "${projectRoot}/CLAUDE.md"` in the config, and `.sous/MEMORIES.tpl.md` with only the recipes' line, so `CLAUDE.md` stays as it was. |
 *
 * A project that builds `CLAUDE.md` from its own source with a line `@#memories/**\/*.md` would, after
 * `move`, hold the recipes' memories in both files. So after `move` a second question, default
 * `no`, offers to remove that line from the project's source. On `no` it stays, and the outcome
 * says the memories will be read twice.
 *
 * The migration asks nothing, and changes nothing, when the project has nothing to migrate: the
 * Claude Code memories file is switched off, `memoriesOutputPath` is already set (the choice is
 * made), or sous never wrote the recipes' memories into the root `CLAUDE.md`. Running it twice
 * changes nothing the second time.
 */

import fs from "node:fs";
import path from "node:path";
import type { Context } from "@sous-io/sous-plugin-api";
import type { CompilationFile, CompilationTarget } from "@sous-io/sous-plugin-compiler/types";
import type {} from "@sous-io/sous-plugin-config-files/types";
import type {} from "@sous-io/sous-plugin-memories/types";
import type { MigrationDefinition, MigrationOutcome } from "@sous-io/sous-plugin-migrations/types";
import type { ClaudeCodePluginOptions } from "../types.js";

/** The question that chooses where the memories go. */
export const LOCATION_QUESTION = "claude-code.memories";

/** The follow-up question that offers to remove a now-duplicating include line. */
export const REMOVE_LINE_QUESTION = "claude-code.memories.remove-line";

/** The plugin's name, whose options hold `memoriesOutputPath`. */
const PLUGIN = "@sous-io/sous-plugin-claude-code";

/** Its name before sous 1.1.0, under which a project's config may still hold its options. */
const FORMER_PLUGIN = "@sous-io/plugin-claude-code";

/** The config path of the option the `keep` answer writes. */
export const OUTPUT_PATH_KEY = `plugins.options."${PLUGIN}".memoriesOutputPath`;

/** The value the `keep` answer writes. */
export const ROOT_CLAUDE_MD = "${projectRoot}/CLAUDE.md";

/** The file the `keep` answer writes the option to when the main config is code. */
export const KEEP_LAYER = "600-claude-code-memories.jsonc";

/** The id the old default's compilation target had, recorded in the state file. */
export const OLD_TARGET_ID = "memories/claude-code";

/** The include line that pulls in the recipes' memories. */
export const RECIPES_LINE = "@#memories/**/*.md";

/** The project's own memories line, relative to `.sous/`. */
export const PROJECT_LINE = "@memories/**/*.md";

/** The memories source's name inside `.sous/`. */
export const MEMORIES_SOURCE = "MEMORIES.tpl.md";

/** The comment at the top of a memories source, as `sous init` writes it. */
function sourceComment(lines: readonly string[]): string {
    const described = lines.map((line) =>
        line === PROJECT_LINE
            ? `  ${PROJECT_LINE}    this project's own memories: every markdown file under \`.sous/memories/\``
            : `  ${RECIPES_LINE}   the memories of every recipe this project subscribes to`,
    );

    return `{% comment %}
Sous compiles this file into the memories file your coding tool reads in every session
(\`.claude/rules/SOUS-MEMORIES.md\` for Claude Code, unless memoriesOutputPath says otherwise).
${lines.length === 1 ? "The line below includes" : "Each line below includes one part"}:

${described.join("\n")}

Removing a line removes that part, and moving a line changes the order. Run \`sous build\` after
a change.
{% endcomment -%}
${lines.join("\n")}
`;
}

/** The memories source the `move` answer writes: the two default lines, as `sous init` writes them. */
export const MOVE_SOURCE = sourceComment([PROJECT_LINE, RECIPES_LINE]);

/** The memories source the `keep` answer writes: the recipes' line only, so `CLAUDE.md` keeps its content. */
export const KEEP_SOURCE = sourceComment([RECIPES_LINE]);

/** A line of a project's own source that pulls the recipes' memories into the root `CLAUDE.md`. */
export interface IncludeLine {
    /** The source file, absolute. */
    readonly file: string;
    /** 1-based. */
    readonly line: number;
}

/** What the migration sees in a project. */
export interface MemoriesSituation {
    /** Nothing to migrate, and why; `undefined` when there is something. */
    readonly nothing?: string;
    /** The lines in the project's own sources that would duplicate the memories after `move`. */
    readonly lines: readonly IncludeLine[];
    /** Project targets compiled from files under `.sous/memories/`, which the default source also includes. */
    readonly alsoCompiled: readonly string[];
}

/** This plugin's options, from the config. */
function options(ctx: Pick<Context, "config">): ClaudeCodePluginOptions {
    // The options may still be written under this plugin's name from before 1.1.0.
    return ctx.config.get<ClaudeCodePluginOptions>(["plugins", "options", PLUGIN]) ?? ctx.config.get<ClaudeCodePluginOptions>(["plugins", "options", FORMER_PLUGIN]) ?? {};
}

/** The root `CLAUDE.md`. */
function rootClaudeMd(root: string): string {
    return path.join(root, "CLAUDE.md");
}

/**
 * The lines `@#memories/**\/*.md`, alone on their line, in the sources of the project's own targets
 * that write the root `CLAUDE.md`.
 */
export function findIncludeLines(ctx: Pick<Context, "config" | "project">): IncludeLine[] {
    if (ctx.project === undefined) {
        return [];
    }

    const targets = ctx.config.get<CompilationTarget[]>("compilation.targets") ?? [];
    const files = ctx.config.get<CompilationFile[]>("compilation.files") ?? [];
    const destination = rootClaudeMd(ctx.project.root);
    const sources = new Set(
        files
            .filter((file) => path.resolve(file.destination) === destination && targets[file.targetIndex]?.origin?.plugin === undefined)
            .map((file) => file.source),
    );
    const found: IncludeLine[] = [];

    for (const source of sources) {
        let text: string;

        try {
            text = fs.readFileSync(source, "utf8");
        } catch {
            continue;
        }

        text.split("\n").forEach((line, index) => {
            if (line.trim() === RECIPES_LINE) {
                found.push({ file: source, line: index + 1 });
            }
        });
    }

    return found;
}

/** The project's own targets whose source lies under `.sous/memories/`. */
function compiledFromMemories(ctx: Pick<Context, "config" | "project">): string[] {
    if (ctx.project === undefined) {
        return [];
    }

    const targets = ctx.config.get<CompilationTarget[]>("compilation.targets") ?? [];
    const files = ctx.config.get<CompilationFile[]>("compilation.files") ?? [];
    const memoriesDir = path.join(ctx.project.sousDir, "memories") + path.sep;

    return [
        ...new Set(
            files.filter((file) => targets[file.targetIndex]?.origin?.plugin === undefined && path.resolve(file.source).startsWith(memoriesDir)).map((file) => file.source),
        ),
    ];
}

/** Whether the previous build wrote the root `CLAUDE.md` from the old default's memories target. */
function oldDefaultWrote(ctx: Pick<Context, "services" | "project">): boolean {
    if (ctx.project === undefined || !ctx.services.has("compiler.state")) {
        return false;
    }

    const destination = rootClaudeMd(ctx.project.root);

    return ctx.services
        .get("compiler.state")
        .entries()
        .some((entry) => entry.target === OLD_TARGET_ID && path.resolve(ctx.project!.root, entry.dest) === destination);
}

/**
 * Whether the old default would have written the recipes' memories into the root `CLAUDE.md`: the
 * recipes have memories and no target of the project's own writes that file (a project never built
 * since it upgraded has no state file to say so).
 */
function oldDefaultWould(ctx: Pick<Context, "services" | "config" | "project">): boolean {
    if (ctx.project === undefined || !ctx.services.has("memories.selection")) {
        return false;
    }

    const targets = ctx.config.get<CompilationTarget[]>("compilation.targets") ?? [];
    const files = ctx.config.get<CompilationFile[]>("compilation.files") ?? [];
    const destination = rootClaudeMd(ctx.project.root);
    const ownWritesIt = files.some((file) => path.resolve(file.destination) === destination && targets[file.targetIndex]?.origin?.plugin === undefined);

    return !ownWritesIt && ctx.services.get("memories.selection").selected().length > 0;
}

/** What there is to migrate in this project. */
export function situation(ctx: Pick<Context, "services" | "config" | "project">): MemoriesSituation {
    if (ctx.project === undefined) {
        return { nothing: "There is no project here.", lines: [], alsoCompiled: [] };
    }

    const own = options(ctx);

    if (own.memories === false) {
        return { nothing: "The Claude Code memories file is switched off (memories: false), so nothing changed.", lines: [], alsoCompiled: [] };
    }

    if (own.memoriesOutputPath !== undefined) {
        return { nothing: `memoriesOutputPath is already set (${own.memoriesOutputPath}), so the choice is made and nothing changed.`, lines: [], alsoCompiled: [] };
    }

    const lines = findIncludeLines(ctx);

    if (lines.length === 0 && !oldDefaultWrote(ctx) && !oldDefaultWould(ctx)) {
        return { nothing: "Sous never wrote the recipes' memories into the root CLAUDE.md here, so nothing changed.", lines, alsoCompiled: [] };
    }

    return { lines, alsoCompiled: compiledFromMemories(ctx) };
}

/** Writes the memories source unless the project already has one. */
function writeSource(sousDir: string, text: string): string | undefined {
    const file = path.join(sousDir, MEMORIES_SOURCE);

    if (fs.existsSync(file)) {
        return undefined;
    }

    fs.mkdirSync(sousDir, { recursive: true });
    fs.writeFileSync(file, text);

    return file;
}

/**
 * Removes the given lines (1-based) from their files, each file read and written once. A line that
 * stood alone between blank lines takes the blank line after it along, so no doubled blank line is
 * left where it was.
 */
export function removeLines(lines: readonly IncludeLine[]): void {
    const byFile = new Map<string, Set<number>>();

    for (const { file, line } of lines) {
        byFile.set(file, (byFile.get(file) ?? new Set()).add(line));
    }

    for (const [file, numbers] of byFile) {
        const source = fs.readFileSync(file, "utf8").split("\n");
        const kept: string[] = [];

        for (let index = 0; index < source.length; index++) {
            const line = source[index] ?? "";

            if (!(numbers.has(index + 1) && line.trim() === RECIPES_LINE)) {
                kept.push(line);
                continue;
            }

            const blankBefore = kept.length === 0 || kept.at(-1)?.trim() === "";
            // The last element is what follows the file's final newline; it is kept so the newline stays.
            const blankAfter = index + 1 < source.length - 1 && source[index + 1]?.trim() === "";

            if (blankBefore && blankAfter) index++;
        }

        fs.writeFileSync(file, kept.join("\n"));
    }
}

/** Where the `keep` answer writes `memoriesOutputPath`: the main config when sous can edit it, else a `conf.d` layer. */
function keepFile(ctx: Pick<Context, "project">): string | undefined {
    const main = ctx.project?.configPath;

    return main !== undefined && /\.(jsonc?|ya?ml)$/.test(main) ? undefined : KEEP_LAYER;
}

/** Runs the migration with the answers given. */
export async function migrateMemories(ctx: Context, answers: Readonly<Record<string, string>>): Promise<MigrationOutcome> {
    const found = situation(ctx);

    if (found.nothing !== undefined || ctx.project === undefined) {
        return { summary: found.nothing ?? "There is no project here." };
    }

    const label = (file: string) => path.relative(ctx.project!.root, file);
    const details: string[] = [];

    if (answers[LOCATION_QUESTION] === "keep") {
        const file = keepFile(ctx);

        if (file !== undefined) {
            fs.mkdirSync(ctx.project.confDir, { recursive: true });
        }

        await ctx.run("config.set", { path: OUTPUT_PATH_KEY, value: JSON.stringify(ROOT_CLAUDE_MD), ...(file === undefined ? {} : { file }) });
        details.push(`Set ${OUTPUT_PATH_KEY} to ${ROOT_CLAUDE_MD} in ${file === undefined ? label(ctx.project.configPath!) : `.sous/conf.d/${file}`}.`);

        const written = writeSource(ctx.project.sousDir, KEEP_SOURCE);

        if (written !== undefined) {
            details.push(`Wrote ${label(written)}, which includes only the recipes' memories, as CLAUDE.md did.`);
        }

        ctx.configChanged();

        return { summary: "The recipes' memories stay in the root CLAUDE.md.", details };
    }

    const written = writeSource(ctx.project.sousDir, MOVE_SOURCE);

    if (written !== undefined) {
        details.push(`Wrote ${label(written)} with the default lines: this project's memories, then the recipes'.`);
    }

    if (found.lines.length > 0) {
        const where = found.lines.map((line) => `${label(line.file)}:${line.line}`).join(", ");

        if (answers[REMOVE_LINE_QUESTION] === "yes") {
            removeLines(found.lines);
            details.push(`Removed the line ${RECIPES_LINE} from ${where}, so the root CLAUDE.md no longer repeats the recipes' memories.`);
        } else {
            details.push(`Left the line ${RECIPES_LINE} in ${where}: Claude Code will read the recipes' memories twice, in CLAUDE.md and in .claude/rules/SOUS-MEMORIES.md.`);
        }
    }

    for (const source of found.alsoCompiled) {
        details.push(`${label(source)} is compiled by a target of this project and is also included by the new memories file, so its text reaches Claude Code twice. Remove that target, or the line ${PROJECT_LINE} from .sous/${MEMORIES_SOURCE}.`);
    }

    ctx.configChanged();

    return { summary: "The recipes' memories now go to .claude/rules/SOUS-MEMORIES.md.", details };
}

/** The migration. */
export function memoriesMigration(version: string): MigrationDefinition {
    return {
        version,
        id: "claude-code/memories-file",
        description: "Move the recipes' memories out of the root CLAUDE.md into .claude/rules/SOUS-MEMORIES.md, or keep them in CLAUDE.md.",
        questions: [
            {
                id: LOCATION_QUESTION,
                message: "Sous now writes the recipes' memories to .claude/rules/SOUS-MEMORIES.md instead of the root CLAUDE.md. Where should they go?",
                choices: [
                    { value: "move", label: "To .claude/rules/SOUS-MEMORIES.md, the new default (Claude Code reads it beside CLAUDE.md)" },
                    { value: "keep", label: "To the root CLAUDE.md, as before (sets memoriesOutputPath)" },
                ],
                default: "move",
                // Nothing to migrate means nothing to ask; "move" then changes nothing.
                answered: (ctx) => (situation(ctx).nothing === undefined ? undefined : "move"),
            },
            {
                id: REMOVE_LINE_QUESTION,
                message: `Your own source for the root CLAUDE.md includes the recipes' memories with the line ${RECIPES_LINE}, so after the move they would be read twice. Remove that line?`,
                default: "no",
                answered: (ctx, earlier) => (earlier[LOCATION_QUESTION] === "keep" || situation(ctx).lines.length === 0 ? "no" : undefined),
            },
        ],
        up: (ctx, { answers }) => migrateMemories(ctx, answers),
    };
}
