/**
 * The migration that rewrites an output's removed `_if` as the config expression that replaces it.
 *
 * ```jsonc
 * // before
 * { "_if": { "stage": { "eq": "prod" } }, "destinationFile": "prod.md" }
 * // after
 * { "$if": { "expr": "stage == 'prod'", "then": { "destinationFile": "prod.md" } } }
 * ```
 *
 * - A config written as data (`.json`, `.jsonc`, `.yaml`, `.yml`, in `.sous/` and `.sous/conf.d/`)
 *   is edited surgically through `@sous-io/documents`: only the output that held `_if` changes,
 *   and comments and layout elsewhere stay.
 * - A config written as code (`.js`, `.ts` and the like) cannot be edited by Sous, so each `_if`
 *   is reported with its file, its line and the text to write instead.
 * - An `_if` naming a variable called `env` or `host` is left as it is and reported: an expression
 *   reads those names as Sous's own values, so the variable must be renamed first.
 *
 * Running it again finds nothing to change.
 */

import fs from "node:fs";
import path from "node:path";
import { isJsonObject, parseDocument, type DocNode, type DocumentFormat, type JsonObject, type JsonValue } from "@sous-io/documents";
import type { Context } from "@sous-io/plugin-api";
import type { MigrationDefinition, MigrationOutcome } from "@sous-io/sous-plugin-migrations/types";

/** The version of sous that removed `_if`, whose migrations a project upgraded past it runs. */
export const IF_MIGRATION_VERSION = "1.0.20";

/** Names an expression reads as Sous's own values, so an `_if` on a variable of that name cannot move. */
const SHADOWED = new Set(["env", "host"]);

/** File endings of a config written as data, and the format each is parsed in. */
const DATA_ENDINGS: ReadonlyArray<readonly [string, DocumentFormat]> = [
    [".jsonc", "jsonc"],
    [".json", "json"],
    [".yaml", "yaml"],
    [".yml", "yaml"],
];

/** File endings of a config written as code. */
const CODE_ENDINGS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"];

/**
 * The expression an `_if`'s conditions mean: each variable equals its value, all of them.
 *
 * ```ts
 * ifExpression({ stage: { eq: "prod" }, os: { eq: "linux" } });   // "stage == 'prod' and os == 'linux'"
 * ```
 */
export function ifExpression(conditions: unknown): string {
    const tests =
        conditions !== null && typeof conditions === "object"
            ? Object.entries(conditions as Record<string, unknown>).map(([name, condition]) => {
                  const value = (condition as { eq?: unknown } | null)?.eq;

                  return `${name} == '${String(value).replace(/'/g, "\\'")}'`;
              })
            : [];

    return tests.join(" and ") || "true";
}

/** An output with `_if`, as the config expression that replaces it. */
export function ifReplacementValue(output: Readonly<Record<string, unknown>>): JsonObject {
    const { _if: conditions, ...rest } = output;

    return { $if: { expr: ifExpression(conditions), then: rest as JsonObject } };
}

/** The variables an `_if` names that an expression would read as Sous's own values. */
function shadowedNames(conditions: unknown): string[] {
    return conditions !== null && typeof conditions === "object" ? Object.keys(conditions).filter((name) => SHADOWED.has(name)) : [];
}

/** Every config file of a project: the main `sous.config.*` and each file in `conf.d/`. */
export function configFiles(sousDir: string, confDir: string): string[] {
    const main = fs.existsSync(sousDir)
        ? fs
              .readdirSync(sousDir)
              .filter((name) => name.startsWith("sous.config."))
              .map((name) => path.join(sousDir, name))
        : [];
    const layers = fs.existsSync(confDir)
        ? fs
              .readdirSync(confDir)
              .filter((name) => !name.startsWith(".") && !name.includes(".patch."))
              .map((name) => path.join(confDir, name))
        : [];

    return [...main, ...layers].filter((file) => fs.statSync(file).isFile()).sort();
}

/** Every output holding `_if`, as nodes, anywhere in a document: inside `outputs` lists. */
function outputsWithIf(node: DocNode, value: JsonValue | undefined, inOutputs = false, found: DocNode[] = []): DocNode[] {
    if (Array.isArray(value)) {
        value.forEach((item, index) => void outputsWithIf(node.atIndex(index), item, false, found));

        if (inOutputs) {
            value.forEach((item, index) => {
                if (isJsonObject(item) && "_if" in item) {
                    found.push(node.atIndex(index));
                }
            });
        }
    } else if (isJsonObject(value)) {
        for (const [key, child] of Object.entries(value)) {
            outputsWithIf(node.atPath([key]), child, key === "outputs", found);
        }
    }

    return found;
}

/** What the migration found and did in one data file. */
interface FileResult {
    converted: string[];
    leftAlone: string[];
}

/** Rewrites each output's `_if` in a config written as data. Writes the file only when something changed. */
export function migrateDataFile(file: string, format: DocumentFormat, dryRun = false): FileResult {
    const text = fs.readFileSync(file, "utf8");
    const result: FileResult = { converted: [], leftAlone: [] };

    if (!text.includes("_if")) {
        return result;
    }

    const doc = parseDocument(text, format);

    for (const node of outputsWithIf(doc.root(), doc.value())) {
        const output = node.get<JsonObject>()!;
        const shadowed = shadowedNames(output._if);

        if (shadowed.length > 0) {
            result.leftAlone.push(
                `${node.pathString}: names ${shadowed.map((name) => `'${name}'`).join(" and ")}, which an expression reads as Sous's own value; rename the variable, then write ${JSON.stringify(ifReplacementValue(output))}.`,
            );
            continue;
        }

        node.set(ifReplacementValue(output));
        result.converted.push(node.pathString);
    }

    if (result.converted.length > 0 && !dryRun) {
        fs.writeFileSync(file, doc.toString(), "utf8");
    }

    return result;
}

/**
 * Each `_if` in a config written as code, with its line and the text to write instead. A one-line
 * `_if: { name: { eq: "value" } }` gives the expression itself; any other form gives the shape.
 */
export function reportCodeFile(file: string): string[] {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    const found: string[] = [];

    lines.forEach((line, index) => {
        if (!/(^|[\s{,'"])_if['"]?\s*:/.test(line)) {
            return;
        }

        const conditions: Record<string, { eq: string }> = {};

        for (const match of line.matchAll(/['"]?([A-Za-z_][\w-]*)['"]?\s*:\s*\{\s*eq\s*:\s*(['"])(.*?)\2\s*\}/g)) {
            conditions[match[1]!] = { eq: match[3]! };
        }

        const expr = Object.keys(conditions).length > 0 ? ifExpression(conditions) : "<variable> == '<value>'";

        found.push(`${file}:${index + 1}: write the output as { $if: { expr: ${JSON.stringify(expr)}, then: { ...the output without _if... } } }`);
    });

    return found;
}

/** Runs the migration over a project's config files. */
export function migrateIfConditions(sousDir: string, confDir: string, dryRun = false): MigrationOutcome {
    const converted: string[] = [];
    const reported: string[] = [];

    for (const file of configFiles(sousDir, confDir)) {
        const name = file.toLowerCase();
        const data = DATA_ENDINGS.find(([ending]) => name.endsWith(ending));

        if (data !== undefined) {
            const result = migrateDataFile(file, data[1], dryRun);

            converted.push(...result.converted.map((at) => `${file}: ${at}`));
            reported.push(...result.leftAlone.map((line) => `${file}: ${line}`));
        } else if (CODE_ENDINGS.some((ending) => name.endsWith(ending))) {
            reported.push(...reportCodeFile(file));
        }
    }

    if (converted.length === 0 && reported.length === 0) {
        return { summary: "No output in the config uses '_if'." };
    }

    const parts = [
        ...(converted.length > 0 ? [`${converted.length === 1 ? "One output's '_if' was" : `${converted.length} outputs' '_if' were`} rewritten as a config expression ($if)`] : []),
        ...(reported.length > 0 ? [`${reported.length === 1 ? "one '_if' needs" : `${reported.length} '_if' need`} changing by hand, as listed`] : []),
    ];

    return { summary: `${parts.join("; ")}.`, details: [...converted, ...reported] };
}

/** The migration, as `sous.migrations.add` takes it. */
export const ifMigration: MigrationDefinition = {
    version: IF_MIGRATION_VERSION,
    id: "compiler/if-to-expression",
    description: "Rewrite each compilation output's removed '_if' as the config expression ($if) that replaces it",
    up(ctx: Context) {
        const project = ctx.project;

        if (project === undefined) {
            return { summary: "There is no project here." };
        }

        return migrateIfConditions(project.sousDir, project.confDir);
    },
};
