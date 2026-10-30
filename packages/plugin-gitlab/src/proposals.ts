/**
 * Proposing changes on GitLab: merge requests through `glab`, the only part of this plugin that
 * needs it. `GITLAB_HOST` tells glab which instance, so a self-managed one works too.
 *
 * Sous does not fork on GitLab: it opens a merge request from a branch the contributor can already
 * push, so `canPush` answers "cannot tell" and `fork` refuses with the manual route.
 */

import { ConfigError } from "@sous-io/plugin-api";
import type {
    ProposalState,
    ProposalStatus,
    ProposalSummary,
    RepositoryHostContext,
    RepositoryHostEntity,
} from "@sous-io/plugin-recipes/types";
import type { CanonicalRepository } from "@sous-io/repository-hosts";
import { cliFailure, cliJson, cliOutput, firstUrlIn, runCli } from "@sous-io/repository-hosts";
import { GLAB, projectArg } from "./glab.js";

/** What GitLab calls a proposal. */
const NOUN = "merge request";

/** The fields of a merge request sous reads from `glab ... --output json`. */
interface GlabMergeRequest {
    iid: number;
    web_url?: string;
    state?: string;
    title?: string;
    draft?: boolean;
    work_in_progress?: boolean;
    target_branch?: string;
    source_project_id?: number;
    target_project_id?: number;
    author?: { username?: string } | null;
    detailed_merge_status?: string;
    merge_status?: string;
    has_conflicts?: boolean;
    head_pipeline?: { status?: string } | null;
}

/** The environment that points glab at the repository's instance. */
function glabEnv(repository: CanonicalRepository) {
    return { env: { GITLAB_HOST: repository.host } };
}

/** The write-path methods of the entity. */
export function gitlabProposals(): Pick<
    RepositoryHostEntity,
    "canPush" | "fork" | "proposeChange" | "findProposal" | "proposalStatus" | "updateProposal"
> {
    return {
        canPush: async () => undefined,

        async fork(repository) {
            throw new ConfigError(`Sous does not fork ${repository.owner}/${repository.name} for you on ${GLAB.label}; it opens a ${NOUN} from a branch you can already push.`, {
                details: [`Fork the project yourself, push your branch to the fork, then open the ${NOUN} from there.`],
            });
        },

        async proposeChange(repository, proposal, ctx) {
            const args = ["mr", "create", "--repo", projectArg(repository), "--source-branch", proposal.branch];

            if (proposal.base !== undefined) {
                args.push("--target-branch", proposal.base);
            }

            args.push("--title", proposal.title, "--description", proposal.body, "--yes");

            if (proposal.draft) {
                args.push("--draft");
            }

            const result = await runCli(GLAB, args, ctx, glabEnv(repository));

            if (result.exitCode !== 0) {
                throw cliFailure(GLAB, "mr create", result, "so no proposal was opened");
            }

            const url = firstUrlIn(result.stdout);

            return url === undefined
                ? { detail: `The ${NOUN} was opened, but '${GLAB.command}' printed no address for it.` }
                : { url, detail: `The ${NOUN} is at ${url}.` };
        },

        async findProposal(repository, query, ctx) {
            const forkOwner = query.fromFork ? (query.forkOwner ?? (await signedInUser(repository, ctx))) : undefined;
            const listed = await cliJson<GlabMergeRequest[]>(
                GLAB,
                ["mr", "list", "--repo", projectArg(repository), "--source-branch", query.branch, "--all", "--per-page", "50", "--output", "json"],
                "mr list",
                NOUN,
                ctx,
                glabEnv(repository),
            );

            const mine = listed.filter((entry) => {
                const crossProject = entry.source_project_id !== undefined && entry.source_project_id !== entry.target_project_id;

                return query.fromFork ? crossProject && entry.author?.username === forkOwner : !crossProject;
            });

            if (mine.length === 0) {
                return undefined;
            }

            const chosen = mine.find((entry) => stateOf(entry.state) === "open") ?? [...mine].sort((a, b) => b.iid - a.iid)[0]!;

            return summarize(chosen);
        },

        async proposalStatus(repository, id, ctx) {
            const viewed = await cliJson<GlabMergeRequest>(GLAB, ["mr", "view", id, "--repo", projectArg(repository), "--output", "json"], "mr view", NOUN, ctx, glabEnv(repository));

            return statusOf(viewed);
        },

        async updateProposal(repository, id, update, ctx) {
            const args = ["mr", "update", id, "--repo", projectArg(repository)];

            if (update.title !== undefined) {
                args.push("--title", update.title);
            }

            if (update.body !== undefined) {
                args.push("--description", update.body);
            }

            const result = await runCli(GLAB, args, ctx, glabEnv(repository));

            if (result.exitCode !== 0) {
                throw cliFailure(GLAB, "mr update", result, `so the ${NOUN} kept its title and body`);
            }

            const url = firstUrlIn(result.stdout);

            return url === undefined ? { detail: `The ${NOUN} was updated.` } : { url, detail: `The ${NOUN} at ${url} was updated.` };
        },
    };
}

/** The username glab is signed in as, the owner of any fork the branch is on. */
async function signedInUser(repository: CanonicalRepository, ctx: RepositoryHostContext): Promise<string> {
    const output = await cliOutput(GLAB, ["api", "user"], ctx, glabEnv(repository));
    let username: unknown;

    try {
        username = output === undefined ? undefined : (JSON.parse(output) as { username?: unknown }).username;
    } catch {
        username = undefined;
    }

    if (typeof username !== "string" || username.length === 0) {
        throw new ConfigError(`Sous could not read your GitLab username from '${GLAB.command} api user', so it cannot tell which fork a ${NOUN} would come from.`);
    }

    return username;
}

/** GitLab's state, in the words every host shares. */
function stateOf(state: string | undefined): ProposalState {
    if (state === "merged") {
        return "merged";
    }

    return state === "closed" || state === "locked" ? "closed" : "open";
}

/** The plain summary of a merge request. */
export function summarize(entry: GlabMergeRequest): ProposalSummary {
    return {
        id: String(entry.iid),
        ...(entry.web_url === undefined ? {} : { url: entry.web_url }),
        state: stateOf(entry.state),
        title: entry.title ?? "",
        draft: entry.draft === true || entry.work_in_progress === true,
        ...(entry.target_branch === undefined ? {} : { base: entry.target_branch }),
    };
}

/** Pipeline states that are still running. */
const PENDING_PIPELINES = new Set(["created", "waiting_for_resource", "preparing", "pending", "running", "scheduled", "manual"]);

/**
 * A merge request's status: the review from its merge status, the head pipeline as one check, and
 * whether it can be merged.
 */
export function statusOf(entry: GlabMergeRequest): ProposalStatus {
    const pipeline = entry.head_pipeline?.status;
    const checks =
        pipeline === undefined
            ? undefined
            : {
                  passed: pipeline === "success" ? 1 : 0,
                  failed: pipeline === "failed" || pipeline === "canceled" ? 1 : 0,
                  pending: PENDING_PIPELINES.has(pipeline) ? 1 : 0,
              };
    const review = entry.detailed_merge_status === "not_approved" ? ("review required" as const) : undefined;
    const mergeable =
        entry.has_conflicts === true || entry.merge_status === "cannot_be_merged"
            ? false
            : entry.merge_status === "can_be_merged" || entry.detailed_merge_status === "mergeable"
              ? true
              : undefined;

    return {
        proposal: summarize(entry),
        ...(review === undefined ? {} : { review }),
        ...(checks === undefined ? {} : { checks }),
        ...(mergeable === undefined ? {} : { mergeable }),
    };
}
