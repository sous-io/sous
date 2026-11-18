/**
 * The internal `editor.apply` intent: reads `editor.edits` from the finished config (law L8: it
 * never reads a manifest or any other declaration's source), works out who declared each entry,
 * substitutes `${var}`, and applies the list (see `apply.ts`).
 *
 * The `build` intent runs it after the compiler has written its outputs:
 *
 * ```ts
 * const edits = (await ctx.run("editor.apply", { dryRun, ignoreFailedAssertions })).toPlain();
 *
 * if (!edits.ok) {
 *     // An assertion at level error failed: the build fails.
 * }
 * ```
 */

import fs from "node:fs";
import path from "node:path";
import { isJsonObject, type JsonValue } from "@sous-io/documents";
import { IntentOutput, IntentOutputs, type BuiltConfig, type Context } from "@sous-io/plugin-api";
import { Backups, createTokenCounter } from "@sous-io/plugin-compiler";
import type {} from "@sous-io/plugin-host/types";
import type { VariablesResolver } from "@sous-io/plugin-variables/types";
import { applyEdits, type DeclaredEntry } from "./apply.js";
import { declarerLabel, EDITS_KEY, entryIdentity, listOwners, normalizeEntry } from "./entries.js";
import { HISTORY_FILE_NAME, toStored } from "./history.js";
import { OPERATIONS } from "./operations.js";
import type { EditorApplyInput, EditorApplyResult } from "./types.js";

/** Substitutes `${var}` in an entry, with the recipe's own answers when a recipe declared it. */
function substitute(entry: JsonValue, config: BuiltConfig, resolver: VariablesResolver | undefined, where: string): JsonValue {
    if (resolver === undefined) {
        return entry;
    }

    const recipe = isJsonObject(entry) && typeof entry.recipe === "string" ? entry.recipe : undefined;
    const scope = resolver.scopeIn(config, recipe === undefined ? {} : { scopeKey: recipe });

    return resolver.substituteValue(entry, scope, where);
}

/** Resolves a written file path: `~` expanded, relative to the project root. */
function resolveFile(file: string, root: string, resolver: VariablesResolver | undefined): string {
    const normalized = resolver === undefined ? file : resolver.normalizePath(file);

    return path.resolve(root, normalized);
}

/** The declared entries of a built config, in config order, with who declared each. */
export function declaredEntries(
    config: BuiltConfig,
    root: string,
    resolver: VariablesResolver | undefined,
    warn: (message: string) => void,
): { entries: DeclaredEntry[]; complete: boolean } {
    const raw = config.get<JsonValue[]>(EDITS_KEY) ?? [];
    const owners = listOwners(config.contributions(), EDITS_KEY, raw.length);
    const entries: DeclaredEntry[] = [];
    const seen = new Map<string, number>();
    let complete = true;

    raw.forEach((item, index) => {
        const where = `${EDITS_KEY}[${index}]`;

        try {
            const resolved = substitute(item, config, resolver, where);
            const normalized = normalizeEntry(resolved);
            const declarer = declarerLabel(owners?.[index], normalized.recipe);
            const file = normalized.file === undefined ? undefined : resolveFile(normalized.file, root, resolver);
            const said = entryIdentity(declarer, file === undefined ? "" : toStored(file, root), normalized.steps);
            const occurrence = seen.get(said) ?? 0;

            seen.set(said, occurrence + 1);

            entries.push({
                identity: occurrence === 0 ? said : entryIdentity(declarer, file === undefined ? "" : toStored(file, root), normalized.steps, occurrence),
                declarer,
                file,
                settings: normalized.settings,
                steps: normalized.steps,
                asserts: normalized.asserts,
                silences: normalized.silences,
            });
        } catch (error) {
            complete = false;
            warn(`${where} was skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    return { entries, complete };
}

/**
 * Makes sure `.sous/.gitignore`'s managed block holds the history file and `backups/`, so neither
 * reaches git. `sous init` writes both into a new project's block; a project set up before the
 * editor existed gains them here, the first time the editor writes. A history file outside `.sous/`
 * is the project's to ignore. A damaged block is reported and left alone.
 */
export async function ensureIgnored(ctx: Context, sousDir: string, historyFile: string): Promise<void> {
    if (!ctx.services.has("host.gitignore")) {
        return;
    }

    const relative = path.relative(sousDir, historyFile);
    const lines = [...(relative.startsWith("..") || path.isAbsolute(relative) ? [] : [relative.split(path.sep).join("/")]), "backups/"];

    try {
        await ctx.services.get("host.gitignore").add(path.join(sousDir, ".gitignore"), lines);
    } catch (error) {
        ctx.reporter.warning(`Sous could not add ${lines.join(" and ")} to .sous/.gitignore: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/** The handler of `editor.apply`. */
export async function applyIntent(input: EditorApplyInput, ctx: Context): Promise<IntentOutputs<EditorApplyResult>> {
    const project = ctx.project;
    const dryRun = input.dryRun === true;

    if (project === undefined) {
        const empty: EditorApplyResult = { ok: true, dryRun, files: [], directories: { created: [], removed: [] }, assertions: [], applied: 0, undone: 0 };

        return new IntentOutputs<EditorApplyResult>(new IntentOutput({ data: empty }));
    }

    const resolver = ctx.services.has("variables.resolver") ? ctx.services.get("variables.resolver") : undefined;
    const { entries, complete } = declaredEntries(ctx.config, project.root, resolver, (message) => ctx.reporter.warning(message));
    const configured = ctx.config.get("editor.historyFile") as string | undefined;
    const historyFile =
        configured === undefined
            ? path.join(project.sousDir, HISTORY_FILE_NAME)
            : resolveFile(resolver === undefined ? configured : resolver.substitute(configured, resolver.scopeIn(ctx.config)), project.root, resolver);
    const backups = new Backups(path.join(project.sousDir, "backups"), project.root);
    const counter = await createTokenCounter();

    try {
        // Undo only after a config build that succeeded, and only when every entry could be read:
        // otherwise an entry that failed to load would look the same as one that was removed.
        const undo = complete && ctx.engine.configError === undefined;
        const hadHistory = fs.existsSync(historyFile);
        const result = await applyEdits(
            entries,
            {
                projectRoot: project.root,
                historyFile,
                reporter: ctx.reporter,
                backup: (file) => backups.copy(file, ctx.chain?.id),
                countTokens: async (text) => counter.count(text),
            },
            { dryRun, ignoreFailedAssertions: input.ignoreFailedAssertions === true, undo },
            (op) => OPERATIONS.get(op),
        );

        // Only a project that uses the editor gains the lines: one with entries, or with a history.
        if (!dryRun && (entries.length > 0 || hadHistory)) {
            await ensureIgnored(ctx, project.sousDir, historyFile);
        }

        return new IntentOutputs<EditorApplyResult>(new IntentOutput({ data: result }), result.ok ? {} : { exitCode: 1 });
    } finally {
        counter.free();
    }
}
