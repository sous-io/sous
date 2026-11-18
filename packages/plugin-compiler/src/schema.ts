/**
 * The `compilation` and `_aliases` config keys, as `config-key` entities with their schemas and
 * defaults. Every object level is strict, so a typo such as
 * `destinationFiles` is an error naming the file that wrote it, not an output quietly dropped.
 */

import type { ConfigKeyEntity } from "@sous-io/plugin-api";
import { z } from "zod";
import { compilePatternList } from "@sous-io/plugin-host";
import { isReservedAliasName } from "./aliases.js";

/** Where the state file goes when the config says nothing. */
export const DEFAULT_STATE_FILE = "${sousDir}/sous.state.json";

const varsSchema = z.record(z.string(), z.string());

/**
 * What to write instead of an output's removed `_if`: the same output under a config expression.
 *
 * ```ts
 * ifReplacement({ _if: { env: { eq: "prod" } }, destinationFile: "prod.md" });
 * // -> '{ "$if": { "expr": "env == \'prod\'", "then": { "destinationFile": "prod.md" } } }'
 * ```
 */
export function ifReplacement(output: Record<string, unknown>): string {
    const { _if: conditions, ...rest } = output;
    const tests =
        conditions !== null && typeof conditions === "object"
            ? Object.entries(conditions as Record<string, unknown>).map(([name, condition]) => {
                  const value = (condition as { eq?: unknown } | null)?.eq;

                  return `${name} == '${String(value).replace(/'/g, "\\'")}'`;
              })
            : [];

    return `{ "$if": { "expr": ${JSON.stringify(tests.join(" and ") || "true")}, "then": ${JSON.stringify(rest)} } }`;
}

const outputSchema = z
    .object({
        /** Removed; kept only to say what to write instead (see `ifReplacement`). */
        _if: z.unknown().optional(),
        _vars: varsSchema.optional(),
        destinationFile: z.string().optional(),
        destinationDir: z.string().optional(),
        transforms: z.array(z.string()).optional(),
        harness: z.string().min(1).optional().describe("The harness this output belongs to (claude-code, codex). Templates read it as harness.id."),
    })
    .strict()
    .superRefine((output, ctx) => {
        if (output._if === undefined) {
            return;
        }

        const names = output._if !== null && typeof output._if === "object" ? Object.keys(output._if) : [];
        const shadowed = names.filter((name) => name === "env" || name === "host");

        ctx.addIssue({
            code: "custom",
            path: ["_if"],
            message:
                `'_if' was removed; a config expression on the output replaces it. Write the output as ` +
                `${ifReplacement(output)}. The expression reads variables by their bare name, as every config expression does.` +
                (shadowed.length > 0
                    ? ` An expression reads ${shadowed.map((name) => `'${name}'`).join(" and ")} as sous's own value (the environment, the machine), so rename that variable first.`
                    : ""),
        });
    });

const originSchema = z
    .object({
        plugin: z.string().optional(),
        recipe: z.string().optional(),
        repository: z.string().optional(),
    })
    .strict();

/** One compilation target: exactly one of `entryPoint`, `entryGlob` and `content`; `content` needs an `id`. */
export const targetSchema = z
    .object({
        id: z.string().min(1).optional(),
        _vars: varsSchema.optional(),
        entryPoint: z.string().optional(),
        entryGlob: z.string().optional(),
        content: z.string().optional(),
        globBase: z.string().optional(),
        includeSourceComments: z.boolean().optional(),
        generateRuntimeContext: z.boolean().optional(),
        transforms: z.array(z.string()).optional(),
        origin: originSchema.optional(),
        outputs: z.array(outputSchema),
    })
    .strict()
    .superRefine((target, ctx) => {
        const sources = [target.entryPoint, target.entryGlob, target.content].filter((source) => source !== undefined).length;

        if (sources !== 1) {
            ctx.addIssue({ code: "custom", message: "a target must have exactly one of 'entryPoint', 'entryGlob' or 'content'" });
        }

        if (target.content !== undefined && target.id === undefined) {
            ctx.addIssue({ code: "custom", path: ["id"], message: "a target whose source is 'content' needs an 'id', which names it in errors" });
        }
    });

/** One entry of `compilation.files`, which the `compiler.files` contributor sets. */
const fileSchema = z
    .object({
        target: z.string(),
        targetIndex: z.number().int().min(0),
        source: z.string(),
        output: z.number().int().min(0),
        destination: z.string(),
        harness: z.string().optional(),
        _vars: varsSchema.optional(),
    })
    .strict();

const listingSchema = z
    .object({
        targets: z.number().int().min(0),
        problems: z.array(
            z
                .object({
                    level: z.enum(["error", "warning"]),
                    message: z.string(),
                    target: z.string().optional(),
                    file: z.string().optional(),
                    line: z.number().optional(),
                    targetIndex: z.number().int().min(0).optional(),
                })
                .strict(),
        ),
    })
    .strict();

/** One pattern or several: each a glob, or a regular expression written `/.../`. */
const patternsSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

/** One rule of `compilation.varOverrides`. A `/.../` entry that is not a valid regular expression is refused. */
const varOverrideSchema = z
    .object({
        match: patternsSchema.describe("The output paths the rule applies to: a glob, or a regular expression written /.../, or a list of them."),
        exclude: patternsSchema.optional().describe("Output paths the rule leaves out, though match takes them."),
        _vars: varsSchema.describe("The variables to set. They win over the output's own _vars; a later rule wins over an earlier one."),
    })
    .strict()
    .superRefine((rule, ctx) => {
        for (const key of ["match", "exclude"] as const) {
            const value = rule[key];
            const entries = value === undefined ? [] : typeof value === "string" ? [value] : value;

            entries.forEach((entry, index) => {
                try {
                    compilePatternList([entry], typeof value === "string" ? key : `${key}[${index}]`, () => false);
                } catch (error) {
                    ctx.addIssue({ code: "custom", path: typeof value === "string" ? [key] : [key, index], message: error instanceof Error ? error.message : String(error) });
                }
            });
        }
    });

/** The `compilation` key. */
export const compilationSchema = z
    .object({
        _vars: varsSchema.optional(),
        varOverrides: z
            .array(varOverrideSchema)
            .default([])
            .describe("Variables for every output whose path matches a pattern, outputs a plugin or a recipe added included. A rule wins over the output's own _vars."),
        files: z.array(fileSchema).optional().describe("Every file a build writes, listed while the config is built. Set by sous; anything written here is replaced."),
        listing: listingSchema.optional().describe("What listing compilation.files found. Set by sous."),
        includeSourceComments: z.boolean().default(false),
        overwriteUntracked: z
            .boolean()
            .default(true)
            .describe(
                "Overwrite an output file sous did not write, and take it over. Sous copies the file to <sousDir>/backups/ first. With false, the file is left alone and the build warns.",
            ),
        stateFile: z
            .string()
            .default(DEFAULT_STATE_FILE)
            .describe("Where sous records every file it wrote and the hash of what it wrote, which tells prune and clear what is theirs to remove and which outputs were edited by hand."),
        targets: z.array(targetSchema).default([]),
    })
    .strict();

/** The `_aliases` key: a name to one base directory or several, tried in order. */
export const aliasesSchema = z.record(z.string(), z.union([z.string(), z.array(z.string())])).superRefine((aliases, ctx) => {
    for (const name of Object.keys(aliases)) {
        if (isReservedAliasName(name)) {
            ctx.addIssue({
                code: "custom",
                path: [name],
                message: `Alias "${name}" is invalid: names beginning with "~" or "#" are reserved ("~" for the home directory and recipe namespaces, "#" for built-in names).`,
            });
        }
    }
});

/** The config keys this plugin owns. */
export const CONFIG_KEYS: ConfigKeyEntity[] = [
    {
        id: "compilation",
        schema: compilationSchema,
        description:
            "What to compile: targets, their outputs, source comments, the state file, overwriting files sous did not write. Content sous did not produce is backed up to <sousDir>/backups/ before it is overwritten or removed.",
    },
    {
        id: "_aliases",
        schema: aliasesSchema.optional(),
        description: "Include aliases: a name to one base directory or several, tried in order.",
    },
];
