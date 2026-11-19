/**
 * The two migrations for 1.1.0, run through the real migrations plugin so their questions are
 * answered the way `sous doctor` and `sous upgrade` answer them (`--yes`, `--answer`, a terminal).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine } from "@sous-io/sous-lib-core";
import { BufferedReporter, definePlugin, IntentOutputs, jsonSchema, type JsonObject } from "@sous-io/sous-plugin-api";
import type { CompilationFile, CompilationTarget, StateFileEntry } from "@sous-io/sous-plugin-compiler/types";
import { doctorPlugin } from "@sous-io/sous-plugin-doctor";
import { migrationsPlugin } from "@sous-io/sous-plugin-migrations";
import type { MigrationsRunResult } from "@sous-io/sous-plugin-migrations/types";
import { KEEP_LAYER, KEEP_SOURCE, MOVE_SOURCE, memoriesMigration, migrateMemories, OUTPUT_PATH_KEY, removeLines } from "../src/migrations/memories.js";
import { mentionsOldKey, migrateToolsKey, renameInFile } from "../src/migrations/tools.js";

const dirs: string[] = [];

function tmp(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sous-claude-code-migrations-"));

    dirs.push(dir);

    return dir;
}

afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** What a test project looks like to the migration. */
interface World {
    /** The state file's entries: what the last build wrote. */
    state?: Partial<StateFileEntry>[];
    /** Config values: `compilation.targets`, `compilation.files`, `plugins.options`. */
    config?: JsonObject;
    /** How many recipe memories the selection holds. */
    memories?: number;
}

/** The `config.set` calls the migration made. */
type SetCall = { path: string; value?: string; file?: string };

/** An engine running sous 1.1.0 in a project migrated to 1.0.19, with the memories migration. */
async function engineFor(root: string, world: World) {
    const sets: SetCall[] = [];
    let lockfile: Record<string, unknown> = { formatVersion: 1, repos: {}, recipes: {}, migratedVersion: "1.0.19" };
    const stand = definePlugin({
        name: "test-stand-ins",
        register(sous) {
            sous.entities.add("config-key", { id: "compilation", schema: jsonSchema({}) });
            sous.services.add(
                "recipes.lock",
                () =>
                    ({
                        path: () => path.join(root, ".sous", "sous.lock.json"),
                        read: () => lockfile,
                        exists: () => true,
                        migratedVersion: () => lockfile.migratedVersion,
                        setMigratedVersion: async (version: string) => {
                            lockfile = { ...lockfile, migratedVersion: version };
                        },
                    }) as never,
                { lifetime: "singleton" },
            );
            sous.services.add("compiler.state", () => ({ entries: () => world.state ?? [] }) as never, { lifetime: "singleton" });
            sous.services.add("memories.selection", () => ({ selected: () => Array.from({ length: world.memories ?? 0 }, () => ({})) }) as never, { lifetime: "singleton" });
            sous.intents.add({
                intent: "config.set" as never,
                handle: (input: SetCall) => {
                    sets.push(input);

                    return IntentOutputs.of({ changed: true }) as never;
                },
            });
            sous.config.contribute({ id: "test-config", contribute: (config) => config.root().merge((world.config ?? {}) as never) });
            sous.migrations.add(memoriesMigration("1.1.0"));
        },
    });
    const engine = createEngine({
        builtIns: [doctorPlugin, migrationsPlugin, stand],
        app: { name: "sous", version: "1.1.0" },
        project: { root, sousDir: path.join(root, ".sous"), configPath: undefined, confDir: path.join(root, ".sous", "conf.d") },
        reporter: new BufferedReporter(),
    });

    await engine.buildConfig();

    return {
        sets,
        run: async (input: Record<string, unknown> = {}) =>
            (await engine.handle.submit({ intent: "migrations.run", input })).toPlain() as unknown as MigrationsRunResult,
    };
}

/** The old default: the last build wrote the root CLAUDE.md from the memories target. */
const oldDefault = (root: string): World => ({ state: [{ dest: path.join(root, "CLAUDE.md"), target: "memories/claude-code" }], memories: 2 });

/** The hard case: the project's own target writes CLAUDE.md from a source that includes the recipes' memories. */
function ownSource(root: string): World {
    const source = path.join(root, ".sous", "prompts", "CLAUDE.tpl.md");

    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, "# Project\n\n@#memories/**/*.md\n\nMore.\n");

    const targets: CompilationTarget[] = [{ entryPoint: source, outputs: [{ destinationFile: "${projectRoot}/CLAUDE.md" }] }];
    const files: CompilationFile[] = [{ target: "0", targetIndex: 0, source, output: 0, destination: path.join(root, "CLAUDE.md") }];

    return { config: { compilation: { targets, files } } as never, memories: 2 };
}

const read = (file: string) => fs.readFileSync(file, "utf8");

describe("the memories migration", () => {
    /**
     * --yes takes "move": the default memories source is written and the config is not touched, so
     * the new default path applies.
     */
    it("moves the memories to the rules file under --yes", async () => {
        const root = tmp();
        const { run, sets } = await engineFor(root, oldDefault(root));
        const result = await run({ yes: true });

        expect(result.migrations[0]).toMatchObject({ result: "ran", answers: [{ question: "claude-code.memories", value: "move", source: "default" }, { question: "claude-code.memories.remove-line", value: "no", source: "config" }] });
        expect(read(path.join(root, ".sous", "MEMORIES.tpl.md"))).toBe(MOVE_SOURCE);
        expect(sets).toEqual([]);
    });

    /**
     * "keep" writes memoriesOutputPath (to a conf.d layer, since the main config here is not one sous
     * can edit) and a memories source holding only the recipes' line.
     */
    it("keeps the memories in the root CLAUDE.md on keep", async () => {
        const root = tmp();
        const { run, sets } = await engineFor(root, oldDefault(root));

        await run({ answer: ["claude-code.memories=keep"] });

        expect(sets).toEqual([{ path: OUTPUT_PATH_KEY, value: JSON.stringify("${projectRoot}/CLAUDE.md"), file: KEEP_LAYER }]);
        expect(read(path.join(root, ".sous", "MEMORIES.tpl.md"))).toBe(KEEP_SOURCE);
        expect(KEEP_SOURCE.trimEnd().split("\n").at(-1)).toBe("@#memories/**/*.md");
    });

    /** On "move", the line in the project's own source is removed when the person says yes. */
    it("removes the duplicating include line when asked to", async () => {
        const root = tmp();
        const world = ownSource(root);
        const { run } = await engineFor(root, world);
        const source = path.join(root, ".sous", "prompts", "CLAUDE.tpl.md");
        const result = await run({ answer: ["claude-code.memories=move", "claude-code.memories.remove-line=yes"] });

        expect(read(source)).toBe("# Project\n\nMore.\n");
        expect(result.migrations[0]?.outcome?.details?.join("\n")).toContain("Removed the line @#memories/**/*.md from .sous/prompts/CLAUDE.tpl.md:3");
    });

    /** On "move" and "no", the line stays and the outcome says the memories are read twice. */
    it("leaves the line, and says so, under --yes", async () => {
        const root = tmp();
        const { run } = await engineFor(root, ownSource(root));
        const source = path.join(root, ".sous", "prompts", "CLAUDE.tpl.md");
        const result = await run({ yes: true });

        expect(read(source)).toContain("@#memories/**/*.md");
        expect(result.migrations[0]?.outcome?.details?.join("\n")).toContain("Claude Code will read the recipes' memories twice");
    });

    /** Without a terminal or --yes, both questions wait and nothing runs. */
    it("waits for answers without a terminal", async () => {
        const root = tmp();
        const { run } = await engineFor(root, ownSource(root));
        const result = await run();

        expect(result.unanswered.map((question) => question.question)).toEqual(["claude-code.memories", "claude-code.memories.remove-line"]);
        expect(fs.existsSync(path.join(root, ".sous", "MEMORIES.tpl.md"))).toBe(false);
    });

    /** A project with nothing to migrate is asked nothing, and nothing changes. */
    it("asks nothing and changes nothing when there is nothing to migrate", async () => {
        const root = tmp();
        const { run } = await engineFor(root, {});
        const result = await run();

        expect(result.unanswered).toEqual([]);
        expect(result.migrations[0]?.outcome?.summary).toContain("never wrote the recipes' memories into the root CLAUDE.md");
        expect(fs.existsSync(path.join(root, ".sous", "MEMORIES.tpl.md"))).toBe(false);
    });

    /** A project that already set memoriesOutputPath has made the choice. */
    it("asks nothing when memoriesOutputPath is already set", async () => {
        const root = tmp();
        const { run, sets } = await engineFor(root, {
            ...oldDefault(root),
            config: { plugins: { options: { "@sous-io/sous-plugin-claude-code": { memoriesOutputPath: "${projectRoot}/CLAUDE.md" } } } },
        });
        const result = await run();

        expect(result.unanswered).toEqual([]);
        expect(result.migrations[0]?.outcome?.summary).toContain("memoriesOutputPath is already set");
        expect(sets).toEqual([]);
    });

    /** Running the step again changes nothing more: the source is not rewritten, the line not removed twice. */
    it("is safe to run twice", async () => {
        const root = tmp();
        const world = ownSource(root);
        const { run } = await engineFor(root, world);

        await run({ answer: ["claude-code.memories=move", "claude-code.memories.remove-line=yes"] });

        const source = path.join(root, ".sous", "prompts", "CLAUDE.tpl.md");
        const memories = path.join(root, ".sous", "MEMORIES.tpl.md");

        fs.writeFileSync(memories, "@#memories/**/*.md\n");

        const again = await migrateMemories(
            {
                project: { root, sousDir: path.join(root, ".sous"), configPath: undefined, confDir: path.join(root, ".sous", "conf.d") },
                config: { get: (key: unknown) => (key === "compilation.targets" ? (world.config!.compilation as JsonObject).targets : key === "compilation.files" ? (world.config!.compilation as JsonObject).files : undefined) },
                services: { has: () => false },
                configChanged: () => undefined,
            } as never,
            { "claude-code.memories": "move", "claude-code.memories.remove-line": "yes" },
        );

        expect(read(source)).toBe("# Project\n\nMore.\n");
        expect(read(memories)).toBe("@#memories/**/*.md\n");
        expect(again.summary).toContain("never wrote");
    });
});

/** Removing the include line leaves the file's blank lines as they would be had it never been there. */
describe("removeLines", () => {
    function removed(text: string, line: number): string {
        const file = path.join(tmp(), "CLAUDE.tpl.md");

        fs.writeFileSync(file, text);
        removeLines([{ file, line }]);

        return read(file);
    }

    it("takes one of the blank lines around it along", () => {
        expect(removed("# Project\n\n@#memories/**/*.md\n\nMore.\n", 3)).toBe("# Project\n\nMore.\n");
    });

    it("takes the blank line after it along at the start of the file", () => {
        expect(removed("@#memories/**/*.md\n\nMore.\n", 1)).toBe("More.\n");
    });

    it("keeps the file's final newline at the end of the file", () => {
        expect(removed("# Project\n\n@#memories/**/*.md\n", 3)).toBe("# Project\n\n");
    });

    it("leaves the blank lines alone when the line was not between two", () => {
        expect(removed("# Project\n@#memories/**/*.md\n\nMore.\n", 2)).toBe("# Project\n\nMore.\n");
    });
});

describe("the tools key migration", () => {
    /** tools.claude is renamed in JSON, JSONC and YAML files, comments and layout kept. */
    it("renames tools.claude surgically in data config files", () => {
        const root = tmp();
        const jsonc = path.join(root, "sous.config.jsonc");
        const yaml = path.join(root, "610-tools.yaml");

        fs.writeFileSync(jsonc, '{\n  // launch settings\n  "tools": {\n    "claude": { "args": ["--x"] } // mine\n  }\n}\n');
        fs.writeFileSync(yaml, "tools:\n  # mine\n  claude:\n    args: [--x]\n");

        expect(renameInFile(jsonc)).toEqual({ file: jsonc, result: "renamed" });
        expect(renameInFile(yaml)).toEqual({ file: yaml, result: "renamed" });
        expect(read(jsonc)).toBe('{\n  // launch settings\n  "tools": {\n    "claude-code": { "args": ["--x"] } // mine\n  }\n}\n');
        expect(read(yaml)).toBe("tools:\n  # mine\n  claude-code:\n    args: [--x]\n");
        // Run again, nothing is left to rename.
        expect(renameInFile(jsonc)).toBeUndefined();
    });

    /** A file setting both keys is left alone and reported; a code file is reported, not edited. */
    it("reports what it cannot change", () => {
        const root = tmp();
        const both = path.join(root, "both.json");
        const code = path.join(root, "sous.config.js");

        fs.writeFileSync(both, JSON.stringify({ tools: { claude: {}, "claude-code": {} } }));
        fs.writeFileSync(code, "export const config = { tools: { claude: { command: \"claude\" } } };\n");

        expect(renameInFile(both)?.result).toBe("conflict");
        expect(renameInFile(code)?.result).toBe("report");
        expect(read(code)).toContain("claude: {");
        expect(mentionsOldKey('tools: { "claude-code": { command: "claude" } }')).toBe(false);
    });

    /** The migration goes through the main config and every conf.d file, and says what it did. */
    it("goes through the project's config files", () => {
        const root = tmp();
        const main = path.join(root, ".sous", "sous.config.js");
        const layer = path.join(root, ".sous", "conf.d", "610-tools.jsonc");

        fs.mkdirSync(path.dirname(layer), { recursive: true });
        fs.writeFileSync(main, "export const config = { tools: { claude: {} } };\n");
        fs.writeFileSync(layer, '{ "tools": { "claude": {} } }\n');

        const outcome = migrateToolsKey({
            project: { root, sousDir: path.join(root, ".sous"), configPath: main, confDir: path.dirname(layer) },
            services: {
                has: (name: string) => name === "config-files.loader" || name === "confd.files",
                get: (name: string) => (name === "config-files.loader" ? { findMain: () => main } : { list: () => [{ path: layer }] }),
            },
        } as never);

        expect(outcome.details).toEqual([
            ".sous/sous.config.js: sous cannot edit this file, and it seems to set tools.claude. Rename that key to \"claude-code\" by hand.",
            ".sous/conf.d/610-tools.jsonc: renamed tools.claude to tools.claude-code.",
        ]);
        expect(read(layer)).toBe('{ "tools": { "claude-code": {} } }\n');
    });
});
