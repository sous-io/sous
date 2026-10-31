/**
 * The contract of plugin-authoring: releasing a recipe
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
    /** Where it was found: a repository-relative file, with a field path when there is one, or a flag. */
    readonly where: string;
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
    /** The repository, or any directory inside it; default the working directory. */
    directory?: string;
    /**
     * Validates and regenerates the index in memory, writing nothing; fails on a problem or on a change
     * to a recipe that takes no proposals, and reports index drift as what merging changes (for CI).
     */
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
    /** Whether a release commit was made. */
    readonly committed?: boolean;
    /** Recipes the plan left alone, and why. */
    readonly skipped?: ReadonlyArray<{ readonly key: string; readonly reason: string }>;
    /** With `--check`: how the committed index differs from the regenerated one. */
    readonly drift?: readonly string[];
    /** True when the person declined the plan; nothing was written. */
    readonly cancelled?: boolean;
}

/** `repo.submit`: proposes the changes in a linked checkout. */
export interface RepoSubmitInput {
    /** The linked repository to propose from, when run inside a project; default the one the working directory is inside. */
    repo?: string;
    /** The directory to start from; default the working directory. */
    directory?: string;
    title?: string;
    body?: string;
    branch?: string;
    /** Shows the proposal's status instead. */
    status?: boolean;
    /** Commits uncommitted changes first. */
    commit?: boolean;
    draft?: boolean;
    /**
     * The branch to continue on when the branch's proposal was already merged; answers that question
     * ahead of time. `--yes` generates one instead.
     */
    nextBranch?: string;
    /** When the repository named matches several, takes the first one listed. */
    acceptFirst?: boolean;
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
    /** How it ended. */
    readonly outcome: "created" | "updated" | "unchanged" | "status" | "cancelled";
    /** The `repository-host` the proposal went to. */
    readonly host?: string;
    /** What the host calls a proposal: `pull request`, `merge request`. */
    readonly proposalNoun: string;
    /** The branch the proposal targets. */
    readonly baseBranch?: string;
    /** The remote the branch was (or would be) pushed to: `origin`, or `fork`. */
    readonly pushedTo?: string;
    /** The branch's proposal as it stood before this run, when it had one. */
    readonly previous?: ProposalSummary;
    readonly title?: string;
    /** The paths committed with `--commit`. */
    readonly committedPaths?: readonly string[];
    /** The changelog appended to the proposal, as Markdown. */
    readonly changelog?: string;
    /** Recipes the change touches that take no proposals. */
    readonly refusing: ReadonlyArray<{ readonly key: string; readonly path: string; readonly instead?: string }>;
    /** Every step that completed, in order. */
    readonly completed: readonly string[];
}

/** `repo.contribute`: link, submit and unlink in one go; runs `repo.link`, `repo.submit`, `repo.unlink`. */
export interface RepoContributeInput extends CheckoutFlags {
    /** The recipe, namespace or repository to contribute to. */
    ref: string;
    /** Submits and unlinks, finishing a contribution started earlier. */
    finish?: boolean;
    /** Links machine-wide. */
    global?: boolean;
    /**
     * With `--finish`: submits what no proposal carries yet without asking (`true`), or finishes without
     * submitting it (`false`, `--no-submit`). Unset, the person is asked.
     */
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
    /** The repository's short name. */
    readonly repo: string;
    /** Each step, as the command line that runs it. */
    readonly steps: readonly string[];
    /** Every step that completed, in order. */
    readonly completed: readonly string[];
    /** With `--finish`: why the branch has, or has not, something to submit. */
    readonly verdict?: string;
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
