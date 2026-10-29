/** The input schemas of plugin-inspect's intents. */

import { jsonSchema, type SousSchema } from "@sous-io/plugin-api";
import type { ConfigGetInput, ConfigShowInput, PluginsShowInput, TimingsShowInput } from "./types.js";

/** `config.show`. */
export const configShowSchema: SousSchema<ConfigShowInput> = jsonSchema<ConfigShowInput>({
    type: "object",
    properties: {
        layers: { type: "boolean", description: "Show each contributor's changes, in order, and the passes." },
        raw: { type: "boolean", description: "Show each config file as written, in order." },
    },
});

/** `config.get`. */
export const configGetSchema: SousSchema<ConfigGetInput> = jsonSchema<ConfigGetInput>({
    type: "object",
    properties: {
        path: { type: "string", description: "Path into the config, with [n] for array indices." },
        layers: { type: "boolean", description: "Show each contributor's changes to the value, in order." },
        raw: { type: "boolean", description: "Show each config file as written, in order." },
    },
    required: ["path"],
});

/** `plugins.show`. */
export const pluginsShowSchema: SousSchema<PluginsShowInput> = jsonSchema<PluginsShowInput>({
    type: "object",
    properties: { name: { type: "string", description: "Only this plugin." } },
});

/** `timings.show`. */
export const timingsShowSchema: SousSchema<TimingsShowInput> = jsonSchema<TimingsShowInput>({
    type: "object",
    properties: {
        overBudget: { type: "boolean", description: "Only entries that went over budget." },
        category: { type: "string", description: "Only one category, such as contributor or intent." },
    },
});
