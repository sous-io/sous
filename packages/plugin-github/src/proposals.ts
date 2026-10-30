/**
 * Proposing changes on GitHub: pull requests through `gh`, the only part of this plugin that needs
 * it. A contributor without push permission works through a fork made by `gh repo fork`.
 * Finding a pull request again, reporting where it stands and replacing its text go through
 * `gh pr list`, `gh pr view` and `gh pr edit`.
 */

import { ConfigError } from "@sous-io/plugin-api";
import type {
    ProposalReview,
    ProposalState,
    ProposalStatus,
    ProposalSummary,
    RepositoryHostContext,
    RepositoryHostEntity,
} from "@sous-io/plugin-recipes/types";
import { cliFailure, cliJson, cliOutput, firstUrlIn, runCli, type CanonicalRepository } from "@sous-io/repository-hosts";
import { GH, ghEnv, repoArg } from "./gh.js";

/** What GitHub calls a proposal. */
const NOUN = "pull request";

/** The fields sous asks `gh` for, as it prints them. */
export interface GhPullRequest {
    number: number;
    url?: string;
    state?: string;
    title?: string;
    isDraft?: boolean;
    baseRefName?: string;
    headRepositoryOwner?: { login?: string } | null;
    isCrossRepository?: boolean;
    reviewDecision?: string | null;
    statusCheckRollup?: GhCheck[] | null;
    mergeable?: string;
}

/** One entry of a status check rollup: a check run or a commit status. */
export interface GhCheck {
    __typename?: string;
    status?: string;
    conclusion?: string | null;
    state?: string;
}

/** The write-path methods of the entity. */
export function githubProposals(): Pick<
    RepositoryHostEntity,
    "canPush" | "fork" | "proposeChange" | "findProposal" | "proposalStatus" | "updateProposal"
> {
    return {
        async canPush(repository, ctx) {
            const answer = await cliOutput(GH, ["api", `repos/${repoArg(repository)}`, "--jq", ".permissions.push"], ctx, ghEnv(repository));

            if (answer === "true") {
                return true;
            }

            return answer === "false" ? false : undefined;
        },

        async fork(repository, ctx) {
            const forked = await runCli(GH, ["repo", "fork", repoArg(repository), "--remote=false"], ctx, ghEnv(repository));

            if (forked.exitCode !== 0) {
                throw cliFailure(GH, "repo fork", forked, "");
            }

            const owner = await cliOutput(GH, ["api", "user", "--jq", ".login"], ctx, ghEnv(repository));

            if (owner === undefined) {
                throw new ConfigError(
                    `The fork was requested, but sous could not read your GitHub login from '${GH.command} api user', so it does not know where the fork lives.`,
                );
            }

            return {
                owner,
                name: repository.name,
                httpsUrl: `https://${repository.host}/${owner}/${repository.name}.git`,
                sshUrl: `git@${repository.host}:${owner}/${repository.name}.git`,
            };
        },

        async proposeChange(repository, proposal, ctx) {
            const head = proposal.head === undefined ? proposal.branch : `${proposal.head.owner}:${proposal.branch}`;
            const args = ["pr", "create", "--repo", repoArg(repository)];

            if (proposal.base !== undefined) {
                args.push("--base", proposal.base);
            }

            args.push("--head", head, "--title", proposal.title, "--body", proposal.body);

            if (proposal.draft) {
                args.push("--draft");
            }

            const result = await runCli(GH, args, ctx, ghEnv(repository));

            if (result.exitCode !== 0) {
                throw cliFailure(GH, "pr create", result, "so no proposal was opened");
            }

            const url = firstUrlIn(result.stdout);

            return url === undefined
                ? { detail: `The ${NOUN} was opened, but '${GH.command}' printed no address for it.` }
                : { url, detail: `The ${NOUN} is at ${url}.` };
        },

        async findProposal(repository, query, ctx) {
            const forkOwner = query.fromFork ? (query.forkOwner ?? (await signedInLogin(repository, ctx))) : undefined;
            const listed = await cliJson<GhPullRequest[]>(
                GH,
                [
                    "pr",
                    "list",
                    "--repo",
                    repoArg(repository),
                    "--head",
                    query.branch,
                    "--state",
                    "all",
                    "--limit",
                    "50",
                    "--json",
                    "number,url,state,title,isDraft,baseRefName,headRepositoryOwner,isCrossRepository",
                ],
                "pr list",
                NOUN,
                ctx,
                ghEnv(repository),
            );

            const mine = listed.filter((entry) =>
                query.fromFork ? entry.isCrossRepository === true && entry.headRepositoryOwner?.login === forkOwner : entry.isCrossRepository !== true,
            );

            if (mine.length === 0) {
                return undefined;
            }

            const chosen = mine.find((entry) => entry.state === "OPEN") ?? [...mine].sort((a, b) => b.number - a.number)[0]!;

            return summarizePullRequest(chosen);
        },

        async proposalStatus(repository, id, ctx) {
            const viewed = await cliJson<GhPullRequest>(
                GH,
                ["pr", "view", id, "--repo", repoArg(repository), "--json", "number,url,state,title,isDraft,baseRefName,reviewDecision,statusCheckRollup,mergeable"],
                "pr view",
                NOUN,
                ctx,
                ghEnv(repository),
            );

            return statusOf(viewed);
        },

        async updateProposal(repository, id, update, ctx) {
            const args = ["pr", "edit", id, "--repo", repoArg(repository)];

            if (update.title !== undefined) {
                args.push("--title", update.title);
            }

            if (update.body !== undefined) {
                args.push("--body", update.body);
            }

            const result = await runCli(GH, args, ctx, ghEnv(repository));

            if (result.exitCode !== 0) {
                throw cliFailure(GH, "pr edit", result, `so the ${NOUN} kept its title and body`);
            }

            const url = firstUrlIn(result.stdout);

            return url === undefined ? { detail: `The ${NOUN} was updated.` } : { url, detail: `The ${NOUN} at ${url} was updated.` };
        },
    };
}

/** The login `gh` is signed in as, the owner of any fork sous made. */
async function signedInLogin(repository: CanonicalRepository, ctx: RepositoryHostContext): Promise<string> {
    const login = await cliOutput(GH, ["api", "user", "--jq", ".login"], ctx, ghEnv(repository));

    if (login === undefined) {
        throw new ConfigError(`Sous could not read your GitHub login from '${GH.command} api user', so it cannot tell which fork a ${NOUN} would come from.`);
    }

    return login;
}

/** A pull request's state, in the words every host shares. */
function stateOf(state: string | undefined): ProposalState {
    if (state === "MERGED") {
        return "merged";
    }

    return state === "CLOSED" ? "closed" : "open";
}

/** The plain summary of a pull request. */
export function summarizePullRequest(entry: GhPullRequest): ProposalSummary {
    return {
        id: String(entry.number),
        ...(entry.url === undefined ? {} : { url: entry.url }),
        state: stateOf(entry.state),
        title: entry.title ?? "",
        draft: entry.isDraft === true,
        ...(entry.baseRefName === undefined ? {} : { base: entry.baseRefName }),
    };
}

/** A pull request's status: its review, its checks counted, and whether it can be merged. */
export function statusOf(viewed: GhPullRequest): ProposalStatus {
    const review = reviewOf(viewed.reviewDecision);
    const checks = checksOf(viewed.statusCheckRollup);
    const mergeable = viewed.mergeable === "MERGEABLE" ? true : viewed.mergeable === "CONFLICTING" ? false : undefined;

    return {
        proposal: summarizePullRequest(viewed),
        ...(review === undefined ? {} : { review }),
        ...(checks === undefined ? {} : { checks }),
        ...(mergeable === undefined ? {} : { mergeable }),
    };
}

/** GitHub's review decision, in the words every host shares. */
function reviewOf(decision: string | null | undefined): ProposalReview | undefined {
    switch (decision) {
        case "APPROVED":
            return "approved";
        case "CHANGES_REQUESTED":
            return "changes requested";
        case "REVIEW_REQUIRED":
            return "review required";
        default:
            return undefined;
    }
}

/** Check-run conclusions that count as passing. */
const PASSING = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/**
 * Counts a status check rollup. A check run that has not completed is pending; a commit status
 * reports its state directly.
 */
export function checksOf(rollup: readonly GhCheck[] | null | undefined): { passed: number; failed: number; pending: number } | undefined {
    if (rollup === null || rollup === undefined || rollup.length === 0) {
        return undefined;
    }

    const counts = { passed: 0, failed: 0, pending: 0 };

    for (const check of rollup) {
        const isStatus = check.__typename === "StatusContext" || (check.status === undefined && check.state !== undefined);

        if (isStatus) {
            if (check.state === "SUCCESS") {
                counts.passed += 1;
            } else if (check.state === "PENDING" || check.state === "EXPECTED") {
                counts.pending += 1;
            } else {
                counts.failed += 1;
            }
        } else if (check.status !== "COMPLETED") {
            counts.pending += 1;
        } else if (PASSING.has(check.conclusion ?? "")) {
            counts.passed += 1;
        } else {
            counts.failed += 1;
        }
    }

    return counts;
}
