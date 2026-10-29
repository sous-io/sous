/**
 * The input schemas of plugin-authoring's intents. Every input is a flag or an argument (L4), and
 * every question an intent may ask names the field that answers it.
 */

import { jsonSchema, type JsonSchema } from "@sous-io/plugin-api";
import type { RepoContributeInput, RepoInitInput, RepoReleaseInput, RepoSubmitInput } from "./types.js";

const yes: JsonSchema = { type: "boolean", description: "Answer yes to every confirmation, so nothing is asked" };
const dryRun: JsonSchema = { type: "boolean", description: "Show what would happen, changing nothing" };
const title: JsonSchema = { type: "string", description: "The proposal's title; required for a new proposal, and replaces an open one's" };
const body: JsonSchema = { type: "string", description: "The proposal's description; required for a new proposal, and replaces an open one's" };

/** `repo.release`. */
export const releaseInput = jsonSchema<RepoReleaseInput>({
    type: "object",
    additionalProperties: false,
    properties: {
        directory: { type: "string", description: "The repository to release, or a directory inside it (default: the working directory)" },
        check: { type: "boolean", description: "Only check: validate, and fail on any problem; reports how merging rewrites the index" },
        ci: { type: "boolean", description: "Run the way a merge does: never bump, accept the plan, never ask, and fail on anything unbumped" },
        namespace: { type: "array", items: { type: "string" }, description: "Release only this namespace. Repeat to name several" },
        recipe: { type: "array", items: { type: "string" }, description: "Release only this recipe, as 'namespace/name'. Repeat to name several" },
        bump: { type: "string", enum: ["patch", "minor", "major", "prerelease"], description: "How far to raise a changed recipe's version. Defaults to a patch step" },
        noBump: { type: "boolean", description: "Raise no versions; a changed recipe that was never raised is an error" },
        includeUnchanged: { type: "boolean", description: "Release every recipe in scope, whether its files changed or not" },
        tag: { type: "boolean", description: "Cut the tags even on a branch other than the default one" },
        push: { type: "boolean", description: "Push the commit, and the tags this run created, to the remote" },
        yes: { ...yes, description: "Accept the plan without being asked" },
        dryRun: { ...dryRun, description: "Print the plan and stop, changing nothing" },
    },
});

/** `repo.submit`. */
export const submitInput = jsonSchema<RepoSubmitInput>({
    type: "object",
    additionalProperties: false,
    properties: {
        repo: { type: "string", description: "The linked repository to propose a change from, when run inside a project" },
        directory: { type: "string", description: "The directory to start from (default: the working directory)" },
        title,
        body,
        branch: { type: "string", description: "The branch to work with, instead of the one that is checked out" },
        status: { type: "boolean", description: "Only report where the branch's proposal stands" },
        commit: { type: "boolean", description: "Commit uncommitted changes for you, after listing them and asking once" },
        draft: { type: "boolean", description: "Open a new proposal as a draft" },
        nextBranch: { type: "string", description: "The new branch to continue on when the branch's proposal was already merged" },
        acceptFirst: { type: "boolean", description: "When the repository named matches several, take the first one listed" },
        yes,
        dryRun: { ...dryRun, description: "Check everything and print the plan without writing or sending anything" },
    },
});

/** `repo.contribute`. */
export const contributeInput = jsonSchema<RepoContributeInput>({
    type: "object",
    additionalProperties: false,
    required: ["ref"],
    properties: {
        ref: { type: "string", description: "The repository to contribute to, or a namespace or recipe it publishes" },
        finish: { type: "boolean", description: "Finish the contribution: submit what no proposal carries yet, then unlink and update the pins" },
        branch: { type: "string", description: "The existing branch to work on when starting, or to submit from when finishing" },
        createBranch: { type: "string", description: "Start the contribution on a new branch with this name" },
        generateBranch: {
            type: "boolean",
            description: "Start the contribution on a new branch named sous/edit-<date>-<time>, which is what happens when no branch is named",
        },
        from: { type: "string", description: "Start the new branch from this branch instead of the repository's default branch" },
        global: { type: "boolean", description: "Work with the machine-wide link, sharing one checkout, rather than this project's link" },
        submit: {
            type: "boolean",
            description: "Submit what no proposal carries yet without asking, or with --no-submit, finish without submitting it",
        },
        title,
        body,
        draft: { type: "boolean", description: "Open a new proposal as a draft" },
        commit: { type: "boolean", description: "Commit uncommitted changes for you when submitting, after listing them and asking once" },
        remove: { type: "boolean", description: "Delete the checkout as well when unlinking, when sous cloned it" },
        yes,
        acceptFirst: { type: "boolean", description: "When the reference matches several things, take the first one listed" },
        dryRun: { ...dryRun, description: "Print each step this would run without running any of them" },
    },
});

/** `repo.init`. */
export const initInput = jsonSchema<RepoInitInput>({
    type: "object",
    additionalProperties: false,
    properties: {
        directory: { type: "string", description: "Directory to create the repository in (defaults to the current one)" },
        name: { type: "string", description: "Short name for the repository (defaults to the directory's own name)" },
        namespace: { type: "string", description: "Name of the one namespace to declare (defaults to the repository's name)" },
        force: { type: "boolean", description: "Write the scaffold over a repository that already exists" },
        host: {
            type: "string",
            description: "The repository host whose CI workflow and files to add, such as 'github' (default: from the git remote, else none)",
        },
        dryRun: { ...dryRun, description: "Print the files that would be written without writing them" },
    },
});
