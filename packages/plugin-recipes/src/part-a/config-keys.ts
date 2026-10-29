/**
 * The config keys part A owns (`repos`, `subscriptions`, `store`), as `config-key` entities with
 * their schemas and defaults (S2, "Plugins add config keys"; "No setDefault").
 */

import { jsonSchema, type ConfigKeyEntity, type JsonSchema } from "@sous-io/plugin-api";

/** Default size cap of the store: one gibibyte. */
export const DEFAULT_STORE_MAX_BYTES = 1024 * 1024 * 1024;

/** Default freshness window of a fetched index, in seconds. */
export const DEFAULT_FRESHNESS_SECONDS = 300;

/** Default watch-mode poll interval, in seconds. */
export const DEFAULT_WATCH_POLL_SECONDS = 300;

const repoEntry: JsonSchema = {
    type: "object",
    description: "One trusted repository. Adding it trusts it.",
    properties: {
        url: { type: "string", description: "Where the repository lives." },
        enabled: { type: "boolean", description: "False opts out of a repository sous provides itself." },
        provider: { type: "string", description: "The repository host, when the URL does not give it away." },
        alwaysPull: { type: "boolean", description: "Install a newer in-range version whenever one exists." },
        addedAt: { type: "string" },
        addedBy: { type: "string" },
    },
    additionalProperties: true,
};

const subscriptionEntry: JsonSchema = {
    type: "object",
    description: "One subscription, to a namespace or to one recipe.",
    properties: {
        enabled: { type: "boolean", description: "False switches it off on this machine, keeping its pins." },
        range: { type: "string", description: "The version range. Default `*`." },
        prerelease: { type: "boolean" },
        alwaysPull: { type: "boolean" },
        addedAt: { type: "string" },
        addedBy: { type: "string" },
    },
    additionalProperties: true,
};

const store: JsonSchema = {
    type: "object",
    description: "The machine-wide recipe store.",
    default: {},
    properties: {
        maxBytes: { type: "integer", default: DEFAULT_STORE_MAX_BYTES, description: "Size cap past which old entries are collected." },
        freshnessSeconds: { type: "integer", default: DEFAULT_FRESHNESS_SECONDS, description: "How long a fetched index stays fresh." },
        watchPollSeconds: { type: "integer", default: DEFAULT_WATCH_POLL_SECONDS, description: "How often watch mode checks upstream." },
    },
    additionalProperties: false,
};

/** The three `config-key` entities. */
export function configKeys(): ConfigKeyEntity[] {
    return [
        {
            id: "repos",
            description: "The repositories this project trusts, by short name.",
            schema: jsonSchema({ type: "object", default: {}, additionalProperties: repoEntry }),
        },
        {
            id: "subscriptions",
            description: "What this project subscribes to, keyed by namespace or namespace/recipe.",
            schema: jsonSchema({ type: "object", default: {}, additionalProperties: subscriptionEntry }),
        },
        {
            id: "store",
            description: "The machine-wide recipe store's settings.",
            schema: jsonSchema(store),
        },
    ];
}
