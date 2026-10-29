import { type ConfigKeyEntity, jsonSchema } from "@sous-io/plugin-api";

const stringList = { type: "array", items: { type: "string" }, default: [] } as const;
const pickTable = { type: "object", additionalProperties: { type: "string" }, default: {} } as const;

/**
 * The config keys core owns, as `config-key` entities (S2, "Plugins add config keys").
 */
export const CORE_CONFIG_KEYS: readonly ConfigKeyEntity[] = [
    {
        id: "plugins",
        description: "Which plugins load, which never load, and each plugin's own options (S1).",
        schema: jsonSchema({
            type: "object",
            properties: {
                discover: { enum: ["dependencies", "scan"], default: "dependencies" },
                load: stringList,
                disabled: stringList,
                options: { type: "object", additionalProperties: { type: "object" }, default: {} },
            },
        }),
    },
    {
        id: "services",
        description: "Which plugin's replacement of a service wins: services.replace.\"<name>\": \"<plugin>\".",
        schema: jsonSchema({ type: "object", properties: { replace: pickTable } }),
    },
    {
        id: "intents",
        description: "Which plugin's intent wins when two add one name: intents.replace.\"<intent>\": \"<plugin>\".",
        schema: jsonSchema({ type: "object", properties: { replace: pickTable } }),
    },
    {
        id: "budgets",
        description: "Time budgets in milliseconds, by \"<category>\" or \"<category>:<name>\"; false turns a warning off.",
        schema: jsonSchema({
            type: "object",
            additionalProperties: { anyOf: [{ type: "number" }, { const: false }] },
            default: {},
        }),
    },
    {
        id: "limits",
        description: "The loop-detection limits.",
        schema: jsonSchema({
            type: "object",
            properties: {
                configPasses: { type: "integer" },
                rebuildsChanging: { type: "integer" },
                rebuildsRepeating: { type: "integer" },
                runDepth: { type: "integer" },
                sameIntentDepth: { type: "integer" },
                eventDepth: { type: "integer" },
            },
            additionalProperties: false,
            default: {},
        }),
    },
];
