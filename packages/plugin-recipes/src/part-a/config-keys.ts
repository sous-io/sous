/**
 * The config keys part A owns (`repos`, `subscriptions`, `store`), as `config-key` entities with
 * their schemas and defaults (S2, "Plugins add config keys"; "No setDefault").
 */

import { jsonSchema, type ConfigKeyEntity, type JsonSchema, type SousSchema } from "@sous-io/plugin-api";
import semver from "semver";
import { REPO_NAME_PATTERN } from "./util.js";

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
    required: ["url"],
    additionalProperties: false,
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
    additionalProperties: false,
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

/** A subscription key: a namespace, or a namespace and a recipe, with no repository and no range. */
const SUBSCRIPTION_KEY_PATTERN = /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)?$/;

/** One problem a check found, at a path under the key. */
interface Issue {
    readonly path: Array<string | number>;
    readonly message: string;
}

/** A plain object, or nothing. */
function objectOf(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Whether a repository URL is one sous can read: a URL, an SSH address, or an absolute path. */
export function isRepoUrl(url: string): boolean {
    return /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(url) || /^[\w.-]+@[\w.-]+:\S+$/.test(url) || url.startsWith("/") || /^[A-Za-z]:[\\/]/.test(url);
}

/**
 * A JSON Schema with checks it cannot express itself (key patterns, URL forms, ranges, bounds), run
 * after it. The JSON Schema still describes the key for `config schema` and the docs.
 */
function checked<T>(schema: JsonSchema, more: (value: Record<string, unknown>) => Issue[]): SousSchema<T, T> {
    const base = jsonSchema<T>(schema);
    const standard = base["~standard"];

    return {
        "~standard": {
            ...standard,
            validate(value: unknown) {
                const result = standard.validate(value) as { value?: T; issues?: ReadonlyArray<Issue> };
                const object = objectOf(value);
                const extra = object === undefined ? [] : more(object);

                if (extra.length === 0) {
                    return result;
                }

                return { issues: [...(result.issues ?? []), ...extra] };
            },
        },
    } as SousSchema<T, T>;
}

/** What is wrong with the `repos` key's names and URLs. */
function repoIssues(repos: Record<string, unknown>): Issue[] {
    const issues: Issue[] = [];

    for (const [name, entry] of Object.entries(repos)) {
        if (!REPO_NAME_PATTERN.test(name)) {
            issues.push({ path: [name], message: "invalid key; a repo name must be lowercase kebab-case: a letter, then letters, digits or hyphens (for example 'sous-recipes')" });
        }

        const url = objectOf(entry)?.url;

        if (typeof url === "string" && !isRepoUrl(url)) {
            issues.push({ path: [name, "url"], message: "must be a repository URL, or an absolute path to one on this machine" });
        }
    }

    return issues;
}

/** What is wrong with the `subscriptions` key's names and ranges. */
function subscriptionIssues(subscriptions: Record<string, unknown>): Issue[] {
    const issues: Issue[] = [];

    for (const [key, entry] of Object.entries(subscriptions)) {
        if (!SUBSCRIPTION_KEY_PATTERN.test(key)) {
            issues.push({
                path: [key],
                message:
                    "invalid key; a subscription key must be a namespace ('workflow') or a namespace and recipe ('workflow/task-files'), with no repository qualifier and no version range (the range goes in the entry)",
            });
        }

        const range = objectOf(entry)?.range;

        if (typeof range === "string" && semver.validRange(range) === null) {
            issues.push({ path: [key, "range"], message: "must be a semantic version range, such as '^1.2.0', '~2.1', '>=1.0.0 <2.0.0' or '*'" });
        }
    }

    return issues;
}

/** What is wrong with the store's numbers: whole, and above zero (a zero-byte cap is not a cap). */
function storeIssues(store: Record<string, unknown>): Issue[] {
    const issues: Issue[] = [];

    for (const name of ["maxBytes", "freshnessSeconds", "watchPollSeconds"]) {
        const value = store[name];

        if (typeof value === "number" && (!Number.isInteger(value) || (name === "maxBytes" ? value <= 0 : value < 0))) {
            issues.push({ path: [name], message: name === "maxBytes" ? "must be a whole number of bytes, above zero" : "must be a whole number of seconds, zero or more" });
        }
    }

    return issues;
}

/** The three `config-key` entities. */
export function configKeys(): ConfigKeyEntity[] {
    return [
        {
            id: "repos",
            description: "The repositories this project trusts, by short name.",
            schema: checked({ type: "object", default: {}, additionalProperties: repoEntry }, repoIssues),
        },
        {
            id: "subscriptions",
            description: "What this project subscribes to, keyed by namespace or namespace/recipe.",
            schema: checked({ type: "object", default: {}, additionalProperties: subscriptionEntry }, subscriptionIssues),
        },
        {
            id: "store",
            description: "The machine-wide recipe store's settings.",
            schema: checked(store, storeIssues),
        },
    ];
}
