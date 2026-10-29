/**
 * The `compilation` and `_aliases` config keys, as `config-key` entities with their schemas and
 * defaults (S2, "Plugins add config keys"; C71). Every object level is strict, so a typo such as
 * `destinationFiles` is an error naming the file that wrote it, not an output quietly dropped.
 */

import type { ConfigKeyEntity } from "@sous-io/plugin-api";
import { z } from "zod";
import { isReservedAliasName } from "./aliases.js";

/** Where the state file goes when the config says nothing. */
export const DEFAULT_STATE_FILE = "${sousDir}/sous.state.json";

const varsSchema = z.record(z.string(), z.string());

const outputSchema = z
    .object({
        _if: z.record(z.string(), z.object({ eq: z.string() }).strict()).optional(),
        _vars: varsSchema.optional(),
        destinationFile: z.string().optional(),
        destinationDir: z.string().optional(),
        transforms: z.array(z.string()).optional(),
    })
    .strict();

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

/** The `compilation` key. */
export const compilationSchema = z
    .object({
        _vars: varsSchema.optional(),
        includeSourceComments: z.boolean().default(false),
        overwriteUntracked: z.boolean().default(true),
        stateFile: z.string().default(DEFAULT_STATE_FILE),
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
        description: "What to compile: targets, their outputs, source comments, the state file, overwriting files sous did not write.",
    },
    {
        id: "_aliases",
        schema: aliasesSchema.optional(),
        description: "Include aliases: a name to one base directory or several, tried in order.",
    },
];
