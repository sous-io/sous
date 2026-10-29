/**
 * The input schemas of part B's intents and its entity kind, written with `jsonSchema` so the CLI
 * and MCP get flags and tools from the same JSON Schema.
 */

import { jsonSchema, type SousSchema } from "@sous-io/plugin-api";
import type { ActiveRecipeEntity, LockRebuildInput, RepoGcInput, RepoLinkInput, RepoUnlinkInput } from "../types.js";

const dryRun = { type: "boolean", description: "Print what would change without writing anything" } as const;
const yes = { type: "boolean", description: "Answer yes to every question this command can ask (trusting a repository, discarding work)" } as const;

/** `lock.rebuild`. */
export const lockRebuildInputSchema: SousSchema<LockRebuildInput> = jsonSchema<LockRebuildInput>({
    type: "object",
    properties: { dryRun: { ...dryRun, description: "Print what would change without writing the lockfile" } },
    additionalProperties: false,
});

/** `lock.show`. */
export const lockShowInputSchema: SousSchema<Record<string, never>> = jsonSchema<Record<string, never>>({ type: "object", properties: {}, additionalProperties: false });

/** `repo.gc`. */
export const repoGcInputSchema: SousSchema<RepoGcInput> = jsonSchema<RepoGcInput>({
    type: "object",
    properties: {
        maxBytes: { type: "integer", description: "The size cap to collect down to, instead of the one this project's config sets" },
        dryRun: { ...dryRun, description: "Print what would be evicted without removing anything" },
    },
    additionalProperties: false,
});

/** `repo.link`. */
export const repoLinkInputSchema: SousSchema<RepoLinkInput> = jsonSchema<RepoLinkInput>({
    type: "object",
    properties: {
        repo: { type: "string", description: "The repository's short name from this project's config, its full URL, or the path of a checkout to link in place" },
        path: { type: "string", description: "An existing checkout to link. Without it, the repository is cloned." },
        global: { type: "boolean", description: "Link for every project on this machine, sharing one checkout, rather than for this project" },
        yes,
        dryRun: { ...dryRun, description: "Print what would change without cloning or writing anything" },
        branch: { type: "string", description: "Switch the checkout to this existing branch, fetching it from upstream first" },
        createBranch: { type: "string", description: "Create this new branch in the checkout and switch to it" },
        generateBranch: { type: "boolean", description: "Create a new branch named sous/edit-<date>-<time> in the checkout and switch to it" },
        from: { type: "string", description: "Start the new branch from this branch instead of the repository's default branch" },
        latest: { type: "boolean", description: "Make the branch being worked from match upstream's, after listing any local work that would be discarded" },
    },
    required: ["repo"],
    additionalProperties: false,
});

/** `repo.unlink`. */
export const repoUnlinkInputSchema: SousSchema<RepoUnlinkInput> = jsonSchema<RepoUnlinkInput>({
    type: "object",
    properties: {
        repo: { type: "string", description: "The repository's short name, as it appears in the links map" },
        global: { type: "boolean", description: "Remove the machine-wide link rather than this project's link" },
        update: { type: "boolean", description: "Move this repository's pins to the newest versions their ranges allow before rebuilding" },
        remove: { type: "boolean", description: "Delete the checkout as well, when sous cloned it" },
        yes,
        dryRun,
        noBuild: { type: "boolean", description: "Unlink without rebuilding the project" },
        answer: { type: "array", items: { type: "string" }, description: "Answer a recipe question ahead of time: <name>=<value>; repeatable" },
        answersFile: { type: "string", description: "A file of answers to recipe questions" },
    },
    required: ["repo"],
    additionalProperties: false,
});

/** The `active-recipe` entity kind: plain data, checked loosely. */
export const activeRecipeSchema: SousSchema<ActiveRecipeEntity> = jsonSchema<ActiveRecipeEntity>({
    type: "object",
    properties: {
        id: { type: "string" },
        namespace: { type: "string" },
        name: { type: "string" },
        repo: { type: "string" },
        identity: { type: "string" },
        version: { type: "string" },
        hash: { type: "string" },
        kind: { enum: ["subscribes", "depends"] },
        requestedBy: { type: "array", items: { type: "string" } },
        dir: { type: "string" },
        source: { enum: ["store", "link", "core", "project"] },
        manifest: { type: "object" },
    },
    required: ["id", "namespace", "name", "repo", "identity", "version", "hash", "kind", "requestedBy", "dir", "source", "manifest"],
});
