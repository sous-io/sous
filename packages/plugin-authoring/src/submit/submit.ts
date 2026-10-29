/**
 * `repo.submit`: proposes a change to a recipe repository and follows the proposal through its life,
 * for the branch checked out or the one `--branch` names:
 *
 *   - no proposal yet: open one;
 *   - an open proposal: push what is new, and replace its title or body when given;
 *   - a merged proposal: continue on a new branch, which gets a new proposal;
 *   - a proposal closed without merging: open a fresh one;
 *   - a pushed branch holding commits the local one lacks: git refuses, and that refusal is passed on.
 *
 * This is a sequencer. Every host-specific fact (forks, proposals, the host's command line tool) is
 * asked of the `repository-host` entity, and every question goes through the chain's prompter, naming
 * the flag that answers it (L4). Everything is worked out, and every question asked, before anything
 * is written; every step is announced before it runs, and a failure says which steps completed.
 */

import path from "node:path";
import { ConfigError, type Context } from "@sous-io/plugin-api";
import type { CanonicalRepository } from "@sous-io/plugin-refs/types";
import type { ProposalStatus, ProposalSummary, RepositoryHostContext, RepositoryHostEntity } from "@sous-io/plugin-recipes/types";
import type { RepoSubmitInput, RepoSubmitResult } from "../types.js";
import { toolsFrom, type AuthoringTools } from "../tools.js";
import { FORK_REMOTE, RepoGit, submitBranchName, UPSTREAM_REMOTE, type ChangedPath } from "../shared/git.js";
import { describeCount, describeError, errorsIn, hasErrors, renderProblems } from "../shared/problems.js";
import { INDEX_FILE, validateRepo, type RepoValidation } from "../shared/repository.js";
import { recipesRefusingSubmissions, type RefusingRecipe } from "../release/submissions.js";
import { buildChangelog, commitMessage, composeProposalBody, readManifestsAt, renderChangelog, snapshotOf, type Changelog } from "./changelog.js";
import { findSubmitCheckout } from "./checkout.js";

/** What a proposal is called when the host does not say. */
const DEFAULT_PROPOSAL_NOUN = "proposal";

/** Where and when a submission runs, for tests. */
export interface SubmitOptions {
    readonly cwd?: string;
    readonly now?: Date;
}

/** A host that can carry a proposal. */
type SubmitHost = RepositoryHostEntity &
    Required<Pick<RepositoryHostEntity, "authStatus" | "canPush" | "fork" | "proposeChange">>;

/** A host that can also look a proposal up afterwards. */
type ProposalHost = SubmitHost & Required<Pick<RepositoryHostEntity, "findProposal" | "proposalStatus" | "updateProposal">>;

/** The intent's handler. */
export async function handleSubmit(input: RepoSubmitInput, ctx: Context): Promise<RepoSubmitResult> {
    const result = await runSubmit(toolsFrom(ctx), input, {});

    if (!result.dryRun && (result.created || result.updated)) {
        await ctx.emit("authoring.submitted", {
            repo: result.repo,
            branch: result.branch,
            ...(result.proposal === undefined ? {} : { proposal: result.proposal }),
        });
    }

    return result;
}

/** Finds the checkout, then carries its branch's proposal one step further. */
export async function runSubmit(tools: AuthoringTools, input: RepoSubmitInput, options: SubmitOptions): Promise<RepoSubmitResult> {
    const cwd = path.resolve(input.directory ?? options.cwd ?? process.cwd());
    const checkout = await findSubmitCheckout(tools, cwd, input.repo, input.acceptFirst === true);

    tools.reporter.log("info", `Checkout: ${checkout.rootDir}`, { checkout: checkout.rootDir });
    tools.reporter.note(checkout.reason);

    return submitRepo(tools, checkout.rootDir, input, { ...options, ...(checkout.repo === undefined ? {} : { repo: checkout.repo }) });
}

/** Validates a repository and carries its branch's proposal one step further. */
export async function submitRepo(
    tools: AuthoringTools,
    rootDir: string,
    input: RepoSubmitInput,
    options: SubmitOptions & { repo?: string; statusOnly?: boolean },
): Promise<RepoSubmitResult> {
    const reporter = tools.reporter;
    const git = new RepoGit(tools.git, rootDir);
    const dryRun = input.dryRun === true;
    const now = options.now ?? new Date();
    const completed: string[] = [];
    const step = (message: string) => reporter.log("info", `  ${message}`);
    const notice = (message: string) => reporter.note(message);

    /** Runs one step, announcing it first and recording it once it succeeds. */
    const doStep = async <T>(message: string, action: () => Promise<T>): Promise<T> => {
        step(message);

        const result = await action().catch((error: unknown) => {
            throw partialStateError(message, completed, error);
        });

        completed.push(message);

        return result;
    };

    /** Runs one read-only check, announcing it first. */
    const check = async <T>(message: string, done: string, action: () => Promise<T>): Promise<T> => {
        step(message);

        const result = await action();

        completed.push(done);

        return result;
    };

    // --- Preflight ------------------------------------------------------------------------------

    const validation = await check(
        "Reading the repository manifest and every recipe in it",
        "Read the repository manifest and every recipe in it",
        () => validateRepo(tools, rootDir),
    );
    const upstreamUrl = await check("Looking up where this repository was cloned from", "Looked up where this repository was cloned from", () =>
        git.remoteUrl(UPSTREAM_REMOTE),
    );

    if (upstreamUrl === undefined) {
        throw new ConfigError(
            `This repository has no '${UPSTREAM_REMOTE}' remote, so sous cannot tell where to propose the change.\n` +
                `  Add one with 'git remote add ${UPSTREAM_REMOTE} <url>', then run the command again.`,
        );
    }

    const host = requireSubmitHost(tools, upstreamUrl, validation);
    const hostCtx = tools.hostContext();
    const repo = host.canonicalize(upstreamUrl);
    const proposalNoun = host.proposalNoun ?? DEFAULT_PROPOSAL_NOUN;
    const tracksProposals = supportsProposals(host);
    const signInLabel = host.cli?.label ?? "the repository host's command line tool";
    const auth = await check(`Checking that ${signInLabel} is installed and signed in`, `Checked that ${signInLabel} is installed and signed in`, () =>
        host.authStatus(hostCtx),
    );

    if (!auth.ok) {
        throw new ConfigError(`${auth.detail}\n${contributePointer(validation)}`);
    }

    const baseBranch = (await git.defaultBranch()) ?? "main";
    const checkedOut = await git.currentBranch();

    // --- The repository itself, or a fork ----------------------------------------------------

    const canPush = await check("Checking whether you can push to the repository itself", "Checked whether you can push to the repository itself", () =>
        host.canPush(repo, hostCtx),
    );
    const usedFork = canPush === false;
    const pushRemote = usedFork ? FORK_REMOTE : UPSTREAM_REMOTE;

    if (canPush === undefined) {
        notice(`Sous could not tell whether you can push to ${repo.owner}/${repo.name}, so the change goes to '${UPSTREAM_REMOTE}' as it stands.`);
    }

    const knownForkOwner = usedFork ? await forkOwnerFromRemote(git, host) : undefined;
    const repoName = options.repo ?? `${repo.owner}/${repo.name}`;
    const base = {
        repo: repoName,
        host: host.id,
        proposalNoun,
        baseBranch,
        fromFork: usedFork,
        pushedTo: pushRemote,
        completed,
    };

    const lookUp = async (branch: string): Promise<ProposalSummary | undefined> => {
        if (!supportsProposals(host)) {
            return undefined;
        }

        return check(`Looking for a ${proposalNoun} for the branch '${branch}'`, `Looked for a ${proposalNoun} for the branch '${branch}'`, () =>
            host.findProposal(repo, { branch, fromFork: usedFork, ...(knownForkOwner === undefined ? {} : { forkOwner: knownForkOwner }) }, hostCtx),
        );
    };

    const statusOf = async (proposal: ProposalSummary): Promise<ProposalStatus> => {
        if (!supportsProposals(host)) {
            return { proposal };
        }

        return check(`Reading where the ${proposalNoun} stands`, `Read where the ${proposalNoun} stands`, () => host.proposalStatus(repo, proposal.id, hostCtx));
    };

    const outcome = (fields: Partial<RepoSubmitResult> & Pick<RepoSubmitResult, "outcome" | "branch" | "dryRun">): RepoSubmitResult => ({
        ...base,
        committed: false,
        pushed: false,
        created: false,
        updated: false,
        refusing: [],
        ...fields,
    });

    // --- Status only ---------------------------------------------------------------------------

    if (input.status === true || options.statusOnly === true) {
        if (!tracksProposals) {
            throw new ConfigError(
                `The '${host.id}' host cannot look a ${proposalNoun} up after it was opened, so sous cannot report on one.\n` +
                    `  Open the repository on its host to see where the ${proposalNoun} stands.`,
            );
        }

        const branch = input.branch ?? checkedOut;

        if (branch === undefined) {
            throw new ConfigError("No branch is checked out, so there is no proposal to report on.\n  Name the branch with '--branch <name>'.");
        }

        const found = await lookUp(branch);
        const status = found === undefined ? undefined : await statusOf(found);

        if (found === undefined) {
            reporter.log("info", `The branch '${branch}' has no ${proposalNoun}.`);
        } else {
            reportStatus(tools, proposalNoun, status!);
        }

        return outcome({
            outcome: "status",
            branch,
            dryRun: true,
            ...(found === undefined ? {} : { proposal: found }),
            ...(status === undefined ? {} : { status }),
        });
    }

    // --- The working tree ------------------------------------------------------------------------

    const uncommitted = await check("Checking that everything is committed", "Checked that everything is committed", () => git.uncommittedChanges());
    const toCommit = input.commit === true ? uncommitted : [];

    if (uncommitted.length > 0 && input.commit !== true) {
        throw new ConfigError(
            "Cannot propose a change while the working tree has uncommitted changes.\n\n" +
                `${uncommitted.map((entry) => `    ${entry.path}`).join("\n")}\n\n` +
                "  A proposal is made of commits, so everything it should carry has to be committed first.\n" +
                "  Commit these yourself, or pass '--commit' to have sous commit them, then run the command again.",
        );
    }

    if (input.commit === true && uncommitted.length === 0) {
        notice("Everything is already committed, so '--commit' has nothing to commit.");
    }

    if (toCommit.some((entry) => entry.path === INDEX_FILE)) {
        throw indexEditedError(`git checkout HEAD -- ${INDEX_FILE}`);
    }

    if (toCommit.length > 0) {
        const identified = await check("Checking that git knows who is committing", "Checked that git knows who is committing", () => git.hasCommitIdentity());

        if (!identified) {
            throw new ConfigError(
                "Sous cannot commit for you, because git cannot work out who is committing.\n" +
                    "  Set it with 'git config user.name \"Your Name\"' and 'git config user.email you@example.com', then run the command again.",
            );
        }
    }

    // --- Validate what is about to be proposed ------------------------------------------------

    step("Checking that every recipe describes itself correctly");
    assertRepoValidates(validation);
    completed.push("Checked that every recipe describes itself correctly");

    const since = await check(`Checking that ${INDEX_FILE} was left alone`, `Checked that ${INDEX_FILE} was left alone`, async () => {
        const point = await git.forkPoint(UPSTREAM_REMOTE, baseBranch);

        if (point === undefined) {
            notice(
                `This checkout holds no copy of '${UPSTREAM_REMOTE}/${baseBranch}', so sous could not check whether ${INDEX_FILE} ` +
                    `was changed, which recipes the change touches, or what merging it changes.`,
            );
        } else if (await git.pathChangedSince(point, INDEX_FILE)) {
            throw indexEditedError(`git checkout ${point.slice(0, 12)} -- ${INDEX_FILE}`);
        }

        return point;
    });

    const changedPaths = [...(since === undefined ? [] : await git.pathsChangedSince(since)), ...toCommit.map((entry) => entry.path)];

    // --- Recipes that take no proposals -------------------------------------------------------

    const refusing = recipesRefusingSubmissions(validation, changedPaths);
    const refusingFacts = refusing.map((recipe) => ({ key: recipe.key, path: recipe.path, ...(recipe.instead === undefined ? {} : { instead: recipe.instead }) }));

    const cancelled = (reason: string): RepoSubmitResult => {
        notice(`${reason} Nothing was written.`);

        return outcome({ outcome: "cancelled", branch: input.branch ?? checkedOut ?? baseBranch, dryRun: true, refusing: refusingFacts });
    };

    if (refusing.length > 0) {
        reporter.warning(describeRefusing(refusing));

        if (input.yes !== true && !(await tools.prompter.confirm({ message: "Propose the change anyway?", answeredBy: "--yes" }))) {
            return cancelled("You chose not to propose a change to those recipes.");
        }
    }

    // --- Which branch, and which proposal -----------------------------------------------------

    let branch: string;
    let branchAction: "stay" | "switch" | "create";

    if (input.branch !== undefined && input.branch !== checkedOut) {
        branch = input.branch;
        branchAction = (await git.branchExists(branch)) ? "switch" : "create";
    } else if (checkedOut === undefined || checkedOut === baseBranch) {
        branch = input.branch ?? submitBranchName(now);
        branchAction = "create";
    } else {
        branch = checkedOut;
        branchAction = "stay";
    }

    let previous: ProposalSummary | undefined;

    // A named branch that does not exist here may have been pushed from another machine.
    if (branchAction !== "create" || (tracksProposals && input.branch !== undefined)) {
        previous = await lookUp(branch);
    }

    if (!tracksProposals) {
        notice(
            `The '${host.id}' host cannot look for a ${proposalNoun} that is already open, so sous opens a new one. If this ` +
                `branch already has one, pushing updates it and opening another may be refused.`,
        );
    }

    let action: "create" | "update" = previous?.state === "open" ? "update" : "create";

    if (previous?.state === "merged") {
        notice(
            `The ${proposalNoun} for '${branch}' was merged${previous.url === undefined ? "." : `: ${previous.url}.`} A merged branch ` +
                `takes no further changes, so the next change goes on a new branch.`,
        );

        const next = await chooseNextBranch(tools, input, previous, submitBranchName(now));

        if (next === undefined) {
            return cancelled("You chose not to continue on a new branch.");
        }

        branch = next;
        branchAction = "create";
        action = "create";
    } else if (previous?.state === "closed") {
        notice(
            `The ${proposalNoun} for '${branch}' was closed without being merged${previous.url === undefined ? "." : `: ${previous.url}.`} ` +
                `A fresh ${proposalNoun} is opened for the branch.`,
        );
    }

    // --- The text ---------------------------------------------------------------------------------
    // A new proposal, and a commit sous makes, need a title and a description the person wrote.

    const needsText = action === "create" || toCommit.length > 0;
    let title = blankToUndefined(input.title);
    let description = blankToUndefined(input.body);

    if (needsText && title === undefined) {
        title = (await askText(tools, "What is the title of this proposal?", "--title")).trim();
    }

    if (needsText && description === undefined) {
        description = (await askText(tools, "Describe the change: what it does, and why.", "--body")).trim();
    }

    if (needsText && (title === undefined || title.length === 0)) {
        throw new ConfigError(`A new ${proposalNoun} needs a title; pass '--title'.`);
    }

    if (needsText && (description === undefined || description.length === 0)) {
        throw new ConfigError(`A new ${proposalNoun} needs a description; pass '--body'.`);
    }

    if (toCommit.length > 0 && !(await confirmCommit(tools, input, toCommit))) {
        return cancelled("You chose not to commit those changes.");
    }

    // --- The changelog ----------------------------------------------------------------------------

    const changelog: Changelog = buildChangelog({
        baseBranch,
        base: since === undefined ? undefined : await readManifestsAt(tools, git, since),
        head: snapshotOf(validation),
        changedPaths,
    });
    const rendered = renderChangelog(changelog);

    reporter.log("info", rendered, { changelog });

    const proposalBody = description === undefined ? undefined : composeProposalBody(description, changelog);
    const facts = {
        changelog: rendered,
        refusing: refusingFacts,
        ...(title === undefined ? {} : { title }),
        ...(toCommit.length > 0 ? { committedPaths: toCommit.map((entry) => entry.path) } : {}),
        ...(previous === undefined ? {} : { previous }),
    };

    // --- A dry run stops here ---------------------------------------------------------------------

    if (dryRun) {
        if (branchAction === "create") {
            notice(`A branch named '${branch}' would be created from the current commit.`);
        } else if (branchAction === "switch") {
            notice(`The branch '${branch}' would be checked out.`);
        }

        if (toCommit.length > 0) {
            notice(`${describeCount(toCommit.length, "path")} would be committed.`);
        }

        if (usedFork) {
            notice(`You cannot push to ${repo.owner}/${repo.name}, so the change would go through a fork on your own account.`);
        }

        notice("Nothing was sent; this was a dry run.");

        return outcome({
            outcome: action === "update" ? "updated" : "created",
            branch,
            dryRun: true,
            created: action === "create",
            updated: action === "update",
            ...(previous === undefined ? {} : { proposal: previous }),
            ...facts,
        });
    }

    // --- Write: the branch, the commit --------------------------------------------------------

    if (branchAction === "create") {
        await doStep(`Creating the branch '${branch}' from the current commit`, () => git.createBranch(branch));
    } else if (branchAction === "switch") {
        await doStep(`Checking out the branch '${branch}'`, () => git.switchBranch(branch));
    }

    if (toCommit.length > 0) {
        await doStep(`Committing ${describeCount(toCommit.length, "path")}`, () => git.commitEverything(commitMessage(title!, description!, changelog)));
    }

    // --- Fork, push, propose ------------------------------------------------------------------

    let forkOwner = knownForkOwner;

    if (usedFork) {
        forkOwner = await prepareFork(git, repo, host, hostCtx, doStep);
    }

    const pushed = await doStep(`Pushing '${branch}' to '${pushRemote}'`, () =>
        git.pushBranch(pushRemote, branch).catch((error: unknown) => {
            throw new ConfigError(
                `${describeError(error)}\n  Sous never forces a push. When the branch on '${pushRemote}' holds commits yours lacks ` +
                    `(a maintainer may have pushed to it), bring them in with 'git pull ${pushRemote} ${branch}', then run the command again.`,
            );
        }),
    );

    if (action === "update" && previous !== undefined && supportsProposals(host)) {
        const replace = { ...(title === undefined ? {} : { title }), ...(proposalBody === undefined ? {} : { body: proposalBody }) };
        let url = previous.url;

        if (Object.keys(replace).length > 0) {
            const updated = await doStep(`Updating the ${proposalNoun}'s title and body`, () => host.updateProposal(repo, previous!.id, replace, hostCtx));

            url = updated.url ?? url;
        }

        const changed = pushed === "updated" || Object.keys(replace).length > 0;
        const status = await statusOf(previous);
        const proposal = { ...previous, ...(url === undefined ? {} : { url }), ...(title === undefined ? {} : { title }) };

        reporter.log("info", changed ? `The ${proposalNoun} was updated with what this run sent.` : `There was nothing new to send, so the ${proposalNoun} was left as it was.`);
        reportStatus(tools, proposalNoun, status);

        return outcome({
            outcome: changed ? "updated" : "unchanged",
            branch,
            dryRun: false,
            pushed: true,
            updated: changed,
            committed: toCommit.length > 0,
            proposal,
            status,
            ...facts,
        });
    }

    const proposed = await doStep(`Opening a ${proposalNoun} for review`, () =>
        host.proposeChange(
            repo,
            { branch, base: baseBranch, title: title!, body: proposalBody!, draft: input.draft === true, ...(forkOwner === undefined ? {} : { head: { owner: forkOwner } }) },
            hostCtx,
        ),
    );

    if (proposed.url === undefined) {
        notice(proposed.detail);
    }

    reporter.log(
        "info",
        `The ${proposalNoun} is open for review${proposed.url === undefined ? "" : `: ${proposed.url}`}. The maintainers decide what happens ` +
            `next; sous never publishes on their behalf.`,
    );

    return outcome({
        outcome: "created",
        branch,
        dryRun: false,
        pushed: true,
        created: true,
        committed: toCommit.length > 0,
        proposal: {
            id: proposed.url ?? branch,
            ...(proposed.url === undefined ? {} : { url: proposed.url }),
            state: "open",
            title: title!,
            draft: input.draft === true,
            base: baseBranch,
        },
        ...facts,
    });
}

/** Says which recipes a change touches although they take no proposals, and where to go instead. */
export function describeRefusing(refusing: readonly RefusingRecipe[]): string {
    const lines = [
        refusing.length === 1 ? "This change touches a recipe that does not take proposed changes:" : "This change touches recipes that do not take proposed changes:",
    ];

    for (const recipe of refusing) {
        lines.push(`  ${recipe.key} (${recipe.path}), as ${recipe.declaredBy === "recipe" ? "its own manifest" : "the repository manifest"} says.`);

        if (recipe.instead !== undefined) {
            lines.push(`    Instead: ${recipe.instead}`);
        }
    }

    lines.push("Merging such a change usually breaks whatever publishes those recipes, and the repository's own check refuses it.");

    return lines.join("\n");
}

/** Whether a host can carry a proposal: it says `submit` and has the methods. */
export function supportsSubmit(host: RepositoryHostEntity): host is SubmitHost {
    return (
        host.features.includes("submit") &&
        typeof host.authStatus === "function" &&
        typeof host.canPush === "function" &&
        typeof host.fork === "function" &&
        typeof host.proposeChange === "function"
    );
}

/** Whether a host can look a proposal up afterwards. */
export function supportsProposals(host: RepositoryHostEntity): host is ProposalHost {
    return (
        supportsSubmit(host) &&
        host.features.includes("proposals") &&
        typeof host.findProposal === "function" &&
        typeof host.proposalStatus === "function" &&
        typeof host.updateProposal === "function"
    );
}

/** The `repository-host` entity that reads a URL. */
export function hostForUrl(tools: AuthoringTools, url: string): RepositoryHostEntity | undefined {
    const locator = safely(() => tools.locations.hostFor(url));
    const byLocator = locator === undefined ? undefined : tools.entities.get("repository-host", locator.id);

    return byLocator ?? tools.entities.list("repository-host").find((host) => safely(() => host.matches(url)) === true);
}

function requireSubmitHost(tools: AuthoringTools, upstreamUrl: string, validation: RepoValidation): SubmitHost {
    const host = hostForUrl(tools, upstreamUrl);

    if (host === undefined) {
        throw new ConfigError(`Sous does not know how to propose a change to ${upstreamUrl}.\n${contributePointer(validation)}`);
    }

    if (!supportsSubmit(host)) {
        throw new ConfigError(`The '${host.id}' host cannot propose a change on your behalf.\n${contributePointer(validation)}`);
    }

    return host;
}

function contributePointer(validation: RepoValidation): string {
    const contribute = validation.manifest.contribute;

    return contribute === undefined
        ? "  This repository's manifest does not say where to send a change, so send it the way its maintainers prefer."
        : `  This repository asks that changes be sent this way:\n    ${contribute}`;
}

function assertRepoValidates(validation: RepoValidation): void {
    if (!hasErrors(validation.problems)) {
        return;
    }

    throw new ConfigError(
        "This repository does not validate, so there is nothing worth proposing yet:\n\n" +
            renderProblems(errorsIn(validation.problems)) +
            "\n\n  Fix these, then run the command again.",
    );
}

function indexEditedError(restore: string): ConfigError {
    return new ConfigError(
        `This change edits ${INDEX_FILE}. The index is written by the repository's own release, after a change is merged, ` +
            `so a proposal leaves it as it found it.\n  Restore it with '${restore}', commit that, then run the command again.`,
    );
}

async function askText(tools: AuthoringTools, message: string, flag: string): Promise<string> {
    return tools.prompter.askValue({
        message,
        answeredBy: `${flag} (a new proposal, and a commit sous makes for you, need a title and a description written by you)`,
        validate: (answer) => (answer.trim().length > 0 ? undefined : "An answer is required."),
    });
}

async function confirmCommit(tools: AuthoringTools, input: RepoSubmitInput, paths: readonly ChangedPath[]): Promise<boolean> {
    if (input.yes === true) {
        return true;
    }

    tools.reporter.log("info", `These paths are uncommitted, and '--commit' would commit all of them:\n${paths.map((entry) => `  ${entry.path}`).join("\n")}`);

    return tools.prompter.confirm({ message: "Commit these paths?", answeredBy: "--yes" });
}

/** The branch to continue on after a merged proposal, or `undefined` to stop. */
async function chooseNextBranch(tools: AuthoringTools, input: RepoSubmitInput, merged: ProposalSummary, generated: string): Promise<string | undefined> {
    const named = blankToUndefined(input.nextBranch);

    if (named !== undefined) {
        return named;
    }

    if (input.yes === true) {
        return generated;
    }

    const picked = await tools.prompter.askChoice<"generate" | "name" | "cancel">({
        message: `The ${merged.title === "" ? "proposal" : `proposal '${merged.title}'`} was merged. Continue on a new branch?`,
        answeredBy: "--next-branch <name>, or --yes for a generated name",
        choices: [
            { label: `Generate one: ${generated}`, value: "generate" },
            { label: "Name the branch myself", value: "name" },
            { label: "Cancel", value: "cancel" },
        ],
    });

    if (picked === "cancel") {
        return undefined;
    }

    if (picked === "generate") {
        return generated;
    }

    const name = (await tools.prompter.askValue({ message: "What should the new branch be called?", answeredBy: "--next-branch <name>" })).trim();

    return name.length === 0 ? generated : name;
}

async function forkOwnerFromRemote(git: RepoGit, host: RepositoryHostEntity): Promise<string | undefined> {
    const url = await git.remoteUrl(FORK_REMOTE);

    if (url === undefined || safely(() => host.matches(url)) !== true) {
        return undefined;
    }

    return safely(() => host.canonicalize(url).owner);
}

/** Forks onto the person's account through the host, then makes sure a remote points at the fork. */
async function prepareFork(
    git: RepoGit,
    repo: CanonicalRepository,
    host: SubmitHost,
    hostCtx: RepositoryHostContext,
    doStep: <T>(message: string, action: () => Promise<T>) => Promise<T>,
): Promise<string> {
    const fork = await doStep(`Forking ${repo.owner}/${repo.name} onto your own account`, () => host.fork(repo, hostCtx));

    if ((await git.remoteUrl(FORK_REMOTE)) === undefined) {
        await doStep(`Adding the remote '${FORK_REMOTE}' for ${fork.owner}/${fork.name}`, async () => {
            try {
                await git.run(["remote", "add", FORK_REMOTE, fork.httpsUrl]);
            } catch (error) {
                throw new ConfigError(`Could not add the remote '${FORK_REMOTE}'.\n  ${describeError(error)}`);
            }
        });
    }

    return fork.owner;
}

/** A failure partway, saying what had already been done. */
function partialStateError(failedStep: string, completed: readonly string[], error: unknown): ConfigError {
    const done = completed.length === 0 ? "    nothing had been sent yet" : completed.map((entry) => `    ${entry}`).join("\n");

    return new ConfigError(
        `${failedStep}: this step failed.\n\n  ${describeError(error)}\n\n  What had already been done:\n${done}\n\n` +
            `  Nothing after that step ran. Fix the problem above and run the command again; sous starts from where the ` +
            `repository actually is, so a step that already succeeded is not repeated.`,
        { cause: error },
    );
}

function reportStatus(tools: AuthoringTools, noun: string, status: ProposalStatus): void {
    const { proposal } = status;
    const state =
        proposal.state === "open" ? (proposal.draft ? "open, as a draft" : "open") : proposal.state === "merged" ? "merged" : "closed without being merged";
    const lines = [`The ${noun}: ${proposal.title}`, `State: ${state}`];

    if (status.review !== undefined) {
        lines.push(`Review: ${status.review}`);
    }

    if (status.checks !== undefined) {
        lines.push(`Checks: ${status.checks.passed} passed, ${status.checks.failed} failed, ${status.checks.pending} still running`);
    }

    if (status.mergeable !== undefined) {
        lines.push(`Mergeable: ${status.mergeable ? "yes" : "no, it conflicts with its target branch"}`);
    }

    if (proposal.url !== undefined) {
        lines.push(`Address: ${proposal.url}`);
    }

    tools.reporter.log("info", lines.join("\n"), { status });
}

function blankToUndefined(value: string | undefined): string | undefined {
    const trimmed = value?.trim();

    return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function safely<T>(read: () => T): T | undefined {
    try {
        return read();
    } catch {
        return undefined;
    }
}
