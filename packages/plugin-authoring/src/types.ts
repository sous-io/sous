/**
 * The contract of plugin-authoring (S6, "Authoring: plugin-authoring"): releasing a recipe
 * repository (validate, plan, tag, bump, changelog, settle, build the index), proposing changes to
 * one, contributing (link, submit and unlink in one go) and scaffolding one. Everything a host does
 * differently (proposals, the CI workflow) comes from its `repository-host` entity.
 *
 * Other plugins import this file type-only.
 */

import type { IndexFile } from "@sous-io/plugin-formats/types";
import type {
    CheckoutFlags,
    ProposalStatus,
    ProposalSummary,
    RepoLinkResult,
    RepoUnlinkResult,
} from "@sous-io/plugin-recipes/types";

/** How a version is bumped. */
export type ReleaseBump = "patch" | "minor" | "major" | "prerelease";

/** One problem validation found. */
export interface ReleaseProblem {
    readonly level: "error" | "warning";
    /** The recipe, `namespace/recipe`, or `undefined` for the repository. */
    readonly recipe?: string;
    readonly file?: string;
    readonly message: string;
}

/** What a release does to one recipe. */
export interface ReleasePlanEntry {
    readonly key: string;
    readonly path: string;
    /** The last released version, or `undefined` for a first release. */
    readonly from?: string;
    readonly to: string;
    readonly bump: ReleaseBump | "none" | "first";
    /** Why it is released: its files changed, a dependency moved, `--include-unchanged`. */
    readonly reason: "changed" | "dependency" | "included" | "first";
    /** `namespace/recipe@version`. */
    readonly tag: string;
    readonly hash: string;
    /** The changelog lines written for it. */
    readonly changelog: readonly string[];
}

/** `repo.release`. */
export interface RepoReleaseInput {
    /** Validates and plans, writing nothing; fails when a release is due (for CI). */
    check?: boolean;
    /** Runs as CI does: no questions, tags pushed. */
    ci?: boolean;
    /** Only these namespaces. */
    namespace?: string[];
    /** Only these recipes. */
    recipe?: string[];
    bump?: ReleaseBump;
    /** Keeps every version as it is (an index rebuild). */
    noBump?: boolean;
    /** Releases recipes whose files did not change. */
    includeUnchanged?: boolean;
    /** Creates the git tags. */
    tag?: boolean;
    /** Pushes the tags and the release commit. */
    push?: boolean;
    yes?: boolean;
    dryRun?: boolean;
}

/** The result of `repo.release`. */
export interface RepoReleaseResult {
    readonly ok: boolean;
    readonly repository: string;
    readonly problems: readonly ReleaseProblem[];
    readonly plan: readonly ReleasePlanEntry[];
    /** The index written (or that would be). */
    readonly index?: IndexFile;
    readonly indexPath: string;
    readonly indexChanged: boolean;
    readonly tagged: string[];
    readonly pushed: boolean;
    readonly dryRun: boolean;
}

/** `repo.submit`: proposes the changes in a linked checkout. */
export interface RepoSubmitInput {
    /** The repository; default the one the working directory is inside. */
    repo?: string;
    title?: string;
    body?: string;
    branch?: string;
    /** Shows the proposal's status instead. */
    status?: boolean;
    /** Commits uncommitted changes first. */
    commit?: boolean;
    draft?: boolean;
    yes?: boolean;
    dryRun?: boolean;
}

/** The result of `repo.submit`. */
export interface RepoSubmitResult {
    readonly repo: string;
    readonly branch: string;
    /** True when the branch was pushed to a fork. */
    readonly fromFork: boolean;
    readonly committed: boolean;
    readonly pushed: boolean;
    readonly created: boolean;
    readonly updated: boolean;
    readonly proposal?: ProposalSummary;
    readonly status?: ProposalStatus;
    readonly dryRun: boolean;
}

/** `repo.contribute`: link, submit and unlink in one go; runs `repo.link`, `repo.submit`, `repo.unlink`. */
export interface RepoContributeInput extends CheckoutFlags {
    /** The recipe, namespace or repository to contribute to. */
    ref: string;
    /** Submits and unlinks, finishing a contribution started earlier. */
    finish?: boolean;
    /** Links machine-wide. */
    global?: boolean;
    /** Submits straight after linking. */
    submit?: boolean;
    title?: string;
    body?: string;
    draft?: boolean;
    commit?: boolean;
    /** Deletes the checkout when unlinking. */
    remove?: boolean;
    yes?: boolean;
    acceptFirst?: boolean;
    dryRun?: boolean;
}

/** The result of `repo.contribute`. */
export interface RepoContributeResult {
    /** How far it went. */
    readonly stage: "linked" | "submitted" | "finished";
    readonly link?: RepoLinkResult;
    readonly submit?: RepoSubmitResult;
    readonly unlink?: RepoUnlinkResult;
    readonly dryRun: boolean;
}

/** `repo.init`: scaffolds a recipe repository. */
export interface RepoInitInput {
    /** Default the working directory. */
    directory?: string;
    name?: string;
    /** The first namespace. */
    namespace?: string;
    /** Writes into a directory that is not empty. */
    force?: boolean;
    /** The `repository-host` whose CI workflow and files it gets. Default: from the git remote, else none. */
    host?: string;
    dryRun?: boolean;
}

/** The result of `repo.init`. */
export interface RepoInitResult {
    readonly directory: string;
    readonly name: string;
    readonly namespace?: string;
    readonly host?: string;
    /** Files written, relative to the directory. */
    readonly files: readonly string[];
    readonly dryRun: boolean;
}

/** The payload of `authoring.released`. */
export interface AuthoringReleasedPayload {
    readonly repository: string;
    readonly recipes: ReadonlyArray<{ readonly key: string; readonly version: string; readonly tag: string }>;
    readonly pushed: boolean;
}

/** The payload of `authoring.submitted`. */
export interface AuthoringSubmittedPayload {
    readonly repo: string;
    readonly branch: string;
    readonly proposal?: ProposalSummary;
}

declare module "@sous-io/plugin-api" {
    interface SousIntents {
        "repo.release": { input: RepoReleaseInput; result: RepoReleaseResult };
        "repo.submit": { input: RepoSubmitInput; result: RepoSubmitResult };
        "repo.contribute": { input: RepoContributeInput; result: RepoContributeResult };
        "repo.init": { input: RepoInitInput; result: RepoInitResult };
    }

    interface SousEvents {
        "authoring.released": AuthoringReleasedPayload;
        "authoring.submitted": AuthoringSubmittedPayload;
    }
}
