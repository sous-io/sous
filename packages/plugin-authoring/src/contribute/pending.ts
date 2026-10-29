/**
 * What a checkout's branch still has to propose: its uncommitted changes, its commits beyond the
 * upstream default branch, and which of those no pushed copy of the branch holds. Nothing is
 * fetched; the pushed copies are the remote-tracking branches a push leaves behind.
 */

import { ConfigError, type IntentResult } from "@sous-io/plugin-api";
import type { ProposalSummary } from "@sous-io/plugin-recipes/types";
import { FORK_REMOTE, lines, UPSTREAM_REMOTE, type RepoGit } from "../shared/git.js";

/** What a branch holds that a proposal may not carry yet. */
export interface PendingWork {
    /** `undefined` on a detached head. */
    readonly branch?: string;
    readonly baseBranch?: string;
    /** Every uncommitted change, as `git status --porcelain` prints it. */
    readonly uncommitted: string[];
    /** Commits the upstream default branch lacks, one line each. */
    readonly ahead: string[];
    /** Of those, the commits no pushed copy of the branch holds. */
    readonly unpushed: string[];
    /** The pushed copies this checkout knows: `origin/my-change`. */
    readonly pushedCopies: string[];
}

/**
 * Whether a branch has something to propose: `nothing`, work no proposal carries (`pending`), or
 * everything pushed, so only the proposal can say (`lookup`).
 */
export type PendingVerdict =
    | { readonly kind: "nothing"; readonly reason: string }
    | { readonly kind: "pending"; readonly reason: string }
    | { readonly kind: "lookup"; readonly reason: string };

/** Reads what a checkout's branch holds; the checked-out one when `branch` is left out. */
export async function pendingWork(git: RepoGit, branch?: string): Promise<PendingWork> {
    const status = await git.tryRun(["status", "--porcelain"]);

    if (status === undefined) {
        throw new ConfigError(`Sous could not read the checkout at ${git.rootDir}.\n  Check that it is still a git checkout, then run the command again.`);
    }

    const refExists = async (ref: string) => (await git.tryRun(["rev-parse", "--verify", "--quiet", ref])) !== undefined;
    const examined = branch ?? (await git.currentBranch());
    const tip = examined === undefined ? "HEAD" : `refs/heads/${examined}`;

    if (!(await refExists(tip))) {
        throw new ConfigError(
            `The checkout at ${git.rootDir} has no branch named '${examined}'.\n` +
                `  Name a branch it has with '--branch', or leave the flag off to use the one that is checked out.`,
        );
    }

    const baseBranch = await git.defaultBranch();
    const baseRef = baseBranch !== undefined && (await refExists(`refs/remotes/${UPSTREAM_REMOTE}/${baseBranch}`)) ? `refs/remotes/${UPSTREAM_REMOTE}/${baseBranch}` : undefined;
    const pushedCopies: string[] = [];

    if (examined !== undefined) {
        for (const remote of [UPSTREAM_REMOTE, FORK_REMOTE]) {
            if (await refExists(`refs/remotes/${remote}/${examined}`)) {
                pushedCopies.push(`${remote}/${examined}`);
            }
        }
    }

    const commitsNotIn = async (exclude: string[]): Promise<string[]> => {
        // With no default branch to measure against, a commit is the branch's own when no remote holds it.
        const args = ["log", "--oneline", "--no-decorate", tip, "--not", ...(exclude.length === 0 ? ["--remotes"] : exclude)];

        return lines((await git.tryRun(args)) ?? "");
    };

    const base = baseRef === undefined ? [] : [baseRef];
    const ahead = await commitsNotIn(base);
    const unpushed = pushedCopies.length === 0 ? ahead : await commitsNotIn([...base, ...pushedCopies.map((copy) => `refs/remotes/${copy}`)]);

    return {
        ...(examined === undefined ? {} : { branch: examined }),
        ...(baseBranch === undefined ? {} : { baseBranch }),
        uncommitted: lines(status),
        ahead,
        unpushed,
        pushedCopies,
    };
}

/** Judges what `pendingWork` found, without asking the host anything. */
export function assessPendingWork(work: PendingWork): PendingVerdict {
    const branch = work.branch === undefined ? "the checked-out commit" : `the branch '${work.branch}'`;
    const Branch = `${branch[0]!.toUpperCase()}${branch.slice(1)}`;
    const base = work.baseBranch === undefined ? "any remote" : `${UPSTREAM_REMOTE}/${work.baseBranch}`;

    if (work.uncommitted.length > 0) {
        return { kind: "pending", reason: `The checkout holds ${count(work.uncommitted.length, "uncommitted change")}.` };
    }

    if (work.ahead.length === 0) {
        return { kind: "nothing", reason: `${Branch} holds no commits that ${base} lacks, so there is nothing to submit.` };
    }

    if (work.unpushed.length > 0) {
        return {
            kind: "pending",
            reason:
                `${Branch} holds ${count(work.unpushed.length, "commit")} that ` +
                (work.pushedCopies.length === 0 ? "has never been pushed" : `${work.pushedCopies.join(" and ")} lacks`) +
                `, so no proposal carries ${work.unpushed.length === 1 ? "it" : "them"} yet.`,
        };
    }

    return { kind: "lookup", reason: `Every commit on ${branch} was pushed to ${work.pushedCopies.join(" and ")}.` };
}

/**
 * Judges a pushed branch by its proposal: an open or merged one carries everything; none, or one
 * closed without merging, does not.
 */
export function assessProposal(branch: string, proposal: ProposalSummary | undefined, noun: string): PendingVerdict {
    if (proposal === undefined) {
        return { kind: "pending", reason: `Every commit on the branch '${branch}' was pushed, but no ${noun} is open for it.` };
    }

    if (proposal.state === "open") {
        return {
            kind: "nothing",
            reason: `Every commit on the branch '${branch}' is already in its open ${noun}${proposal.url === undefined ? "" : `, ${proposal.url}`}.`,
        };
    }

    if (proposal.state === "merged") {
        return { kind: "nothing", reason: `The ${noun} for the branch '${branch}' was merged${proposal.url === undefined ? "" : `: ${proposal.url}`}.` };
    }

    return {
        kind: "pending",
        reason: `The ${noun} for the branch '${branch}' was closed without being merged, so no open ${noun} carries its commits.`,
    };
}

/** The verdict from a `repo.submit --status` result. */
export function assessStatusResult(branch: string, result: IntentResult<"repo.submit">): PendingVerdict {
    return assessProposal(branch, result.proposal, result.proposalNoun);
}

function count(value: number, noun: string): string {
    return `${value} ${noun}${value === 1 ? "" : "s"}`;
}
