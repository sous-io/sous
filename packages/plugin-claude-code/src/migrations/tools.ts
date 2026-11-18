/**
 * The migration for the harness id's rename (1.1.0): `tools.claude` becomes `tools.claude-code`.
 *
 * In a project's JSON, JSONC and YAML config files (the main `sous.config.*` and every `conf.d`
 * file), the key is renamed surgically, so comments, key order and formatting stay. A file that is
 * code (`.js`, `.ts`) or a patch file is not edited: the migration names it and says what to change.
 *
 * ```jsonc
 * // before                                  // after
 * "tools": {                                 "tools": {
 *     // my launch settings                      // my launch settings
 *     "claude": { "args": ["--x"] }              "claude-code": { "args": ["--x"] }
 * }                                          }
 * ```
 */

import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "@sous-io/documents";
import type { Context } from "@sous-io/plugin-api";
import type {} from "@sous-io/plugin-confd/types";
import type {} from "@sous-io/plugin-config-files/types";
import type { MigrationDefinition, MigrationOutcome } from "@sous-io/sous-plugin-migrations/types";
import { HARNESS_ID } from "../harness.js";

/** The key's old name under `tools`. */
export const OLD_TOOL_KEY = "claude";

/** What the migration found and did in one file. */
export interface ToolsFileResult {
    readonly file: string;
    /** `renamed`: done; `report`: a file sous cannot edit that seems to set the key; `conflict`: both keys are set. */
    readonly result: "renamed" | "report" | "conflict";
}

/** The format sous edits a config file as, or `undefined` for one it cannot edit. */
function editableFormat(file: string): "json" | "jsonc" | "yaml" | undefined {
    const name = path.basename(file);

    if (name.endsWith(".patch.json") || name.endsWith(".patch.jsonl")) {
        return undefined;
    }

    if (name.endsWith(".jsonc")) return "jsonc";
    if (name.endsWith(".json")) return "json";
    if (name.endsWith(".yaml") || name.endsWith(".yml")) return "yaml";

    return undefined;
}

/**
 * Whether the text of a file sous cannot edit seems to set `tools.claude`: a key `claude` (quoted or
 * not), or the path `tools.claude` or `/tools/claude` in a patch file.
 */
export function mentionsOldKey(text: string): boolean {
    return /(^|[\s{,])["']?claude["']?\s*:/m.test(text) || /tools[./]claude(?![-\w])/.test(text);
}

/**
 * Renames `tools.claude` in one file, or says why it did not. Returns `undefined` when the file
 * does not set the key.
 *
 * ```ts
 * renameInFile(".sous/sous.config.jsonc", { dryRun: false });
 * // -> { file: ".sous/sous.config.jsonc", result: "renamed" }
 * ```
 */
export function renameInFile(file: string, options: { dryRun?: boolean } = {}): ToolsFileResult | undefined {
    let text: string;

    try {
        text = fs.readFileSync(file, "utf8");
    } catch {
        return undefined;
    }

    const format = editableFormat(file);

    if (format === undefined) {
        return mentionsOldKey(text) ? { file, result: "report" } : undefined;
    }

    const document = parseDocument(text, format);
    const old = document.atPath(["tools", OLD_TOOL_KEY]);

    if (!old.exists()) {
        return undefined;
    }

    if (document.atPath(["tools", HARNESS_ID]).exists()) {
        return { file, result: "conflict" };
    }

    old.rename(HARNESS_ID);

    if (options.dryRun !== true) {
        fs.writeFileSync(file, document.toString());
    }

    return { file, result: "renamed" };
}

/** The project's config files: the main `sous.config.*` and every `conf.d` file, in that order. */
export function projectConfigFiles(ctx: Pick<Context, "project" | "services">): string[] {
    const project = ctx.project;

    if (project === undefined) {
        return [];
    }

    const files: string[] = [];
    const main = ctx.services.has("config-files.loader") ? ctx.services.get("config-files.loader").findMain(project.sousDir) : project.configPath;

    if (main !== undefined) {
        files.push(main);
    }

    if (ctx.services.has("confd.files")) {
        files.push(...ctx.services.get("confd.files").list().map((entry) => entry.path));
    }

    return files;
}

/** Runs the rename over every project config file, and says what it did and what is left to do by hand. */
export function migrateToolsKey(ctx: Pick<Context, "project" | "services">): MigrationOutcome {
    const results = projectConfigFiles(ctx)
        .map((file) => renameInFile(file))
        .filter((result): result is ToolsFileResult => result !== undefined);
    const label = (file: string) => (ctx.project === undefined ? file : path.relative(ctx.project.root, file));
    const details = results.map((entry) =>
        entry.result === "renamed"
            ? `${label(entry.file)}: renamed tools.claude to tools.claude-code.`
            : entry.result === "conflict"
              ? `${label(entry.file)}: sets both tools.claude and tools.claude-code, so nothing was changed. Merge tools.claude into tools.claude-code by hand, then remove it.`
              : `${label(entry.file)}: sous cannot edit this file, and it seems to set tools.claude. Rename that key to "claude-code" by hand.`,
    );

    if (results.length === 0) {
        return { summary: "No config file sets tools.claude, so nothing changed." };
    }

    const renamed = results.filter((entry) => entry.result === "renamed").length;

    return {
        summary:
            renamed === results.length
                ? "The Claude Code launch settings moved from tools.claude to tools.claude-code."
                : "Some config files still set tools.claude and must be changed by hand: the Claude Code settings key is now tools.claude-code.",
        details,
    };
}

/** The migration. */
export function toolsKeyMigration(version: string): MigrationDefinition {
    return {
        version,
        // Before the memories migration, so a project's launch settings are fixed first.
        order: 400,
        id: "claude-code/tools-key",
        description: "Rename the Claude Code launch settings from tools.claude to tools.claude-code, the harness's new id.",
        up: (ctx) => migrateToolsKey(ctx),
    };
}
