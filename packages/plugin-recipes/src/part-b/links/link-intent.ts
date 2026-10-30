/**
 * `repo.link`: points this project (or this machine) at a working copy of a repository instead of
 * a published version, which is how a maintainer edits recipes.
 *
 * - `sous repo link <path>` links the checkout already at that path, where it is.
 * - `sous repo link <name-or-url>` clones the repository into `.sous/repos/<owner>/<name>` (or
 *   `$SOUS_HOME/repos/...` with `--global`) and links the clone.
 * - `sous repo link <name-or-url> <path>` links the checkout at that path, cloning nothing.
 *
 * A linked repository's recipes are read with no version, lockfile or hash check, so naming one the
 * project does not trust runs `repo.add`'s trust question first. The command never changes a
 * checkout on its own: every change to it is a flag, carried out by git.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigError, LogLevel, type Context } from "@sous-io/plugin-api";
import type { GitRunner } from "@sous-io/plugin-git/types";
import type { LinkOrigin } from "@sous-io/plugin-formats/types";
import type { RepoLinkInput, RepoLinkResult, UpstreamComparison } from "../../types.js";
import { PROJECT_REPOS_DIRNAME } from "../constants.js";
import { trustedRepos } from "../lock/lock-service.js";
import type { PartBRuntime } from "../runtime.js";
import { messageOf } from "../support.js";
import * as checkout from "./checkout.js";
import { ensureLocalFilesIgnored, type LinksFiles } from "./links-service.js";

/** Where a link will point, and how the working copy got there. */
interface LinkPlan {
    directory: string;
    origin: LinkOrigin;
    kind: "cloned" | "reused" | "path";
    notes: string[];
}

/** What the branch flags asked for, a generated name already chosen. */
interface BranchRequest {
    switchTo?: string;
    create?: string;
    generated: boolean;
    from?: string;
    latest: boolean;
}

/** The handler of `repo.link`. */
export async function linkRepo(input: RepoLinkInput, ctx: Context, runtime: PartBRuntime): Promise<RepoLinkResult> {
    const git = ctx.services.get("git.runner");
    const links = ctx.services.get("recipes.links") as LinksFiles;
    const scope = input.global ? "global" : "project";
    const dryRun = input.dryRun === true;
    const trusted = trustedRepos(ctx);
    const inSlot = trusted[input.repo] === undefined && checkout.looksLikeLocalPath(input.repo) ? await requireRepoDirectory(ctx, input.repo) : undefined;

    if (inSlot !== undefined && input.path !== undefined) {
        throw new ConfigError(`'${input.repo}' is the path of a checkout on this machine, so it already says which checkout to link, and a second path cannot say it again.`, {
            details: [
                `Link a checkout where it already is:   sous repo link ${input.repo}`,
                `Link a checkout to a named repository: sous repo link <name-or-url> ${input.path}`,
            ],
        });
    }

    const { name, url, added } = await resolveRepo(input, ctx, inSlot);
    const existing = inSlot ?? (input.path === undefined ? undefined : await requireRepoDirectory(ctx, input.path));
    const plan = existing !== undefined ? { directory: existing, origin: "path" as const, kind: "path" as const, notes: [`Linked the checkout already at ${existing}.`] } : await planClone(ctx, runtime, git, name, url, scope, dryRun);
    const request = branchRequest(input);

    if (dryRun) {
        const wouldDo = [
            `would link '${name}' to ${plan.directory}`,
            ...plan.notes.filter((note) => note.startsWith("Would")).map((note) => `w${note.slice(1).replace(/\.$/, "")}`),
            ...describeBranchRequest(request),
            `would record it in ${scope === "global" ? "the machine-wide" : "this project's"} links map`,
        ];

        return { repo: name, path: plan.directory, origin: plan.origin, scope, cloned: false, trusted: added, dryRun, wouldDo };
    }

    if (request.switchTo !== undefined || request.create !== undefined || request.latest) {
        if (scope === "global") {
            ctx.reporter.warn(`This checkout is SHARED by every project on this machine that links '${name}' with --global. Changing its branch changes what all of them build from.`);
        }

        plan.notes.push(...(await applyBranchRequest(git, plan.directory, request, input.yes === true, ctx)));
    }

    const previous = links.getIn(name, scope);
    const link = await links.set(name, { path: plan.directory, origin: plan.origin }, scope);

    if (ctx.project !== undefined) {
        try {
            await ensureLocalFilesIgnored(ctx.project.sousDir, ctx.services.get("host.gitignore"), ctx.services.get("host.directories"));
        } catch (error) {
            ctx.reporter.warn(`Sous could not update .sous/.gitignore, so git may see the links map: ${messageOf(error)}`);
        }
    }

    const branch = (await checkout.isGitCheckout(git, plan.directory)) ? await checkout.currentBranch(git, plan.directory) : undefined;
    // A checkout sous has just cloned is as current as upstream by definition; any other may be months old.
    const upstream = plan.kind === "cloned" ? {} : await compareUpstream(git, plan.directory, ctx);

    ctx.reporter.problem(`The repository '${name}' is now LINKED. Its recipes are read from the checkout above, so versions, the lockfile and freshness checks no longer apply to it.`, {
        hint: `Run 'sous repo unlink ${name}${scope === "global" ? " --global" : ""}' to go back to published versions.`,
    });

    return {
        repo: name,
        path: link.path,
        origin: plan.origin,
        scope,
        cloned: plan.kind === "cloned",
        ...(branch === undefined ? {} : { branch }),
        trusted: added,
        dryRun,
        notes: plan.notes,
        recordedIn: links.path(scope),
        ...(previous !== undefined && previous.path !== link.path ? { replaced: previous.path } : {}),
        ...upstream,
    };
}

/** Works out which repository is being linked, running `repo.add`'s trust question for one the project does not trust. */
async function resolveRepo(input: RepoLinkInput, ctx: Context, inSlot: string | undefined): Promise<{ name: string; url: string; added: string[] }> {
    const trusted = trustedRepos(ctx);
    const configured = trusted[input.repo];

    if (configured !== undefined) {
        return { name: input.repo, url: configured.url, added: [] };
    }

    if (inSlot !== undefined || checkout.looksLikeRepoUrl(input.repo)) {
        const suggested = inSlot === undefined ? undefined : await suggestedName(ctx, inSlot);
        const outcome = await ctx.run("repo.add", {
            url: inSlot ?? input.repo,
            ...(suggested === undefined ? {} : { name: suggested }),
            ...(input.yes === undefined ? {} : { yes: input.yes }),
            ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
        });

        return { name: outcome.name, url: outcome.url, added: outcome.alreadyTrusted ? [] : [outcome.name] };
    }

    const known = Object.keys(trusted).sort();

    throw new ConfigError(`'${input.repo}' is not a repository this project knows about, and it is neither a URL nor the path of a checkout on this machine.`, {
        details: [known.length > 0 ? `This project knows about: ${known.join(", ")}.` : "This project has no repositories configured yet.", "Add the repository first with 'sous repo add <url>', then link it by its short name."],
    });
}

/** The short name a checkout's own manifest suggests. */
async function suggestedName(ctx: Context, directory: string): Promise<string | undefined> {
    try {
        return (await ctx.services.get("formats.manifests").readRepo(directory))?.manifest.name;
    } catch {
        return undefined;
    }
}

/** The absolute path of an existing repository checkout, or a `ConfigError` saying what is wrong with it. */
async function requireRepoDirectory(ctx: Context, given: string): Promise<string> {
    const home = ctx.env.HOME ?? os.homedir();
    const expanded = given === "~" ? home : given.startsWith("~/") ? path.join(home, given.slice(2)) : given;
    const directory = path.resolve(ctx.cwd ?? ctx.project?.root ?? ".", expanded);

    if (!fs.existsSync(directory)) {
        throw new ConfigError(`There is no directory at ${directory}.`, { details: ["Pass the path of a checkout that already exists, or leave the path off to have sous clone the repository for you."] });
    }

    if (!fs.statSync(directory).isDirectory()) {
        throw new ConfigError(`${directory} is a file, not a directory.`, { details: ["Pass the root directory of a repository checkout."] });
    }

    if (ctx.services.get("formats.manifests").find(directory, "repo") === undefined) {
        throw new ConfigError(`${directory} is not a sous repository.`, {
            details: ["A repository declares itself with a 'sous.repo.yaml' file at its root, and there is none there.", "Check the path, or create a repository with 'sous repo init'."],
        });
    }

    return directory;
}

/** Plans a link backed by a clone, reusing a checkout of the same repository already in place. */
async function planClone(ctx: Context, runtime: PartBRuntime, git: GitRunner, name: string, url: string, scope: "project" | "global", dryRun: boolean): Promise<LinkPlan> {
    const slug = checkout.repoSlugFromUrl(url);
    const base = scope === "global" ? runtime.homePaths().repos : path.join(requireProject(ctx).sousDir, PROJECT_REPOS_DIRNAME);
    const directory = path.join(base, slug.owner, slug.name);

    if (await checkout.isGitCheckout(git, directory)) {
        const existing = await checkout.remoteUrlOf(git, directory);

        if (existing !== undefined && !checkout.sameRemote(existing, url)) {
            throw new ConfigError(`${directory} is already a checkout of a different repository.`, {
                details: [`It points at ${existing}, but '${name}' is ${url}.`, "Move or delete that directory, or pass an explicit path to link the checkout you meant."],
            });
        }

        return { directory, origin: "clone", kind: "reused", notes: [`Reused the checkout already at ${directory}; nothing was cloned.`] };
    }

    if (dryRun) {
        return { directory, origin: "clone", kind: "cloned", notes: [`Would clone ${url} into ${directory}.`] };
    }

    try {
        await ctx.services.get("host.directories").ensureKnown(scope === "global" ? "global-repos" : "project-repos", base);
    } catch {
        fs.mkdirSync(base, { recursive: true });
    }

    ctx.reporter.progress({ label: `Cloning ${url}`, item: directory });

    const clone = await checkout.cloneRepo(git, url, directory);

    ctx.reporter.progress({ label: `Cloning ${url}`, item: directory, finished: true });

    if (ctx.services.get("formats.manifests").find(directory, "repo") === undefined) {
        throw new ConfigError(`${url} was cloned into ${directory}, but it is not a sous repository.`, {
            details: ["A repository declares itself with a 'sous.repo.yaml' file at its root, and there is none there.", "The checkout has been left in place so you can look at it."],
        });
    }

    return {
        directory,
        origin: "clone",
        kind: "cloned",
        notes: [`Cloned ${url} into ${directory}.`, ...(clone.fellBackToFullClone ? ["That remote would not serve a shallow clone, so the full history was fetched."] : [])],
    };
}

/** The project, or a `ConfigError`. */
function requireProject(ctx: Context): NonNullable<Context["project"]> {
    if (ctx.project === undefined) {
        throw new ConfigError("There is no sous project here to link a repository into.", { details: ["Link with --global, or run sous from inside a project."] });
    }

    return ctx.project;
}

/** Reads the branch flags into one request. */
function branchRequest(input: RepoLinkInput): BranchRequest {
    const generated = input.generateBranch === true;
    const create = generated ? checkout.generatedBranchName() : input.createBranch;
    const chosen = [
        input.branch === undefined ? undefined : "--branch",
        input.createBranch === undefined ? undefined : "--create-branch",
        generated ? "--generate-branch" : undefined,
    ].filter((flag) => flag !== undefined);

    if (chosen.length > 1) {
        throw new ConfigError(`${chosen[0]} cannot also be provided when using ${chosen.slice(1).join(" and ")}.`, {
            details: ["--branch, --create-branch and --generate-branch each say which branch to work on; pass only one of them."],
        });
    }

    if (input.from !== undefined && create === undefined) {
        throw new ConfigError("--from says where a new branch starts, so it needs --create-branch or --generate-branch.");
    }

    return {
        ...(input.branch === undefined ? {} : { switchTo: input.branch }),
        ...(create === undefined ? {} : { create }),
        generated,
        ...(input.from === undefined ? {} : { from: input.from }),
        latest: input.latest === true,
    };
}

/** What a dry run says the branch flags would do. */
function describeBranchRequest(request: BranchRequest): string[] {
    const lines: string[] = [];
    const from = request.switchTo ?? request.from;
    const quoted = from === undefined ? "the default branch" : `'${from}'`;

    if (request.latest) {
        lines.push(`would fetch ${quoted}, list any local work on it that would be discarded, and make it match upstream's`);
    } else if (request.switchTo !== undefined) {
        lines.push(`would switch the checkout to the branch '${request.switchTo}'`);
    }

    if (request.create !== undefined) {
        lines.push(`would create the branch '${request.create}' from upstream's ${request.from === undefined ? "the default branch" : `'${request.from}'`} and switch to it`);
    }

    return lines;
}

/**
 * Carries out the branch flags: `--latest` first (switch to the branch worked from and make it match
 * upstream's), then `--branch`, then the new branch. Git decides whether each step may happen; the
 * one thing checked here is what `--latest` would discard.
 */
async function applyBranchRequest(git: GitRunner, directory: string, request: BranchRequest, yes: boolean, ctx: Context): Promise<string[]> {
    if (!(await checkout.isGitCheckout(git, directory))) {
        throw new ConfigError(`${directory} is not a git checkout, so it has no branches to switch or create.`, { details: ["Link it without the branch flags, or turn it into a git repository first."] });
    }

    for (const name of [request.switchTo, request.create, request.from]) {
        if (name !== undefined) {
            await checkout.assertBranchName(git, directory, name);
        }
    }

    const hasUpstream = (await checkout.remoteUrlOf(git, directory)) !== undefined;
    const needsDefault = (request.create !== undefined && request.from === undefined) || (request.latest && request.switchTo === undefined && request.from === undefined);
    const fallback = needsDefault ? await requireDefaultBranch(git, directory) : undefined;
    const notes: string[] = [];

    if (request.latest) {
        const target = (request.switchTo ?? request.from ?? fallback) as string;

        if (!hasUpstream) {
            throw new ConfigError(`--latest makes '${target}' match upstream's, and this checkout has no '${checkout.UPSTREAM_REMOTE}' remote to be upstream.`, {
                details: [`Add one with 'git remote add ${checkout.UPSTREAM_REMOTE} <url>' in ${directory}, or link without --latest.`],
            });
        }

        await checkout.fetchBranch(git, directory, target);
        await confirmDiscard(target, await checkout.discardableWork(git, directory, target), yes, ctx);
        await checkout.resetBranchToUpstream(git, directory, target);
        notes.push(`Made the branch '${target}' match ${checkout.UPSTREAM_REMOTE}/${target}.`);
    } else if (request.switchTo !== undefined) {
        if (hasUpstream && !(await checkout.localBranchExists(git, directory, request.switchTo))) {
            await checkout.fetchBranch(git, directory, request.switchTo);
        }

        await checkout.switchBranch(git, directory, request.switchTo);
        notes.push(`Switched to the branch '${request.switchTo}'.`);
    }

    if (request.create !== undefined) {
        const base = (request.from ?? fallback) as string;
        let startPoint = base;

        if (hasUpstream) {
            if (!request.latest) {
                await checkout.fetchBranch(git, directory, base);
            }

            startPoint = `${checkout.UPSTREAM_REMOTE}/${base}`;
        }

        await checkout.createBranch(git, directory, request.create, startPoint);
        notes.push(`Created the branch '${request.create}'${request.generated ? " (a generated name)" : ""} from ${startPoint}, and switched to it.`);
    }

    return notes;
}

/** The upstream default branch, or a `ConfigError` naming the flags that give one. */
async function requireDefaultBranch(git: GitRunner, directory: string): Promise<string> {
    const found = await checkout.defaultBranch(git, directory);

    if (found !== undefined) {
        return found;
    }

    throw new ConfigError(`Could not work out the default branch of the repository checked out at ${directory}.`, {
        details: [`git records it as '${checkout.UPSTREAM_REMOTE}/HEAD' when it clones, and this checkout has no such record, nor could '${checkout.UPSTREAM_REMOTE}' be asked for it.`, "Name the branch to work from with --from, or with --branch."],
    });
}

/** Lists what `--latest` would discard and asks once; `--yes` answers ahead of time. */
async function confirmDiscard(branch: string, work: checkout.DiscardableWork, yes: boolean, ctx: Context): Promise<void> {
    if (work.uncommitted.length === 0 && work.localCommits.length === 0) {
        return;
    }

    ctx.reporter.warn(`Making '${branch}' match ${checkout.UPSTREAM_REMOTE}/${branch} discards the local work below.`);

    if (work.uncommitted.length > 0) {
        ctx.reporter.list(work.uncommitted, { title: `Uncommitted changes: ${work.uncommitted.length}` }, LogLevel.Warning);
    }

    if (work.localCommits.length > 0) {
        ctx.reporter.list(work.localCommits, { title: `Commits ${checkout.UPSTREAM_REMOTE} does not have: ${work.localCommits.length}` }, LogLevel.Warning);
    }

    if (yes) {
        return;
    }

    const proceed = await ctx.prompter.confirm({ message: "Discard it?", default: false, answeredBy: "--yes" });

    if (!proceed) {
        throw new ConfigError(`Nothing was changed: the local work on '${branch}' was kept.`, { details: ["The checkout is on the branch it was on before, and no link was recorded."] });
    }
}

/**
 * How a checkout already on disk compares with upstream. A short fetch comes first; it updates only
 * the remote-tracking refs, never the files or branches. When upstream cannot be reached, the link
 * still stands and a warning says since when the checkout may have diverged.
 */
async function compareUpstream(git: GitRunner, directory: string, ctx: Context): Promise<{ upstream?: UpstreamComparison; upstreamNote?: string }> {
    if (!(await checkout.isGitCheckout(git, directory))) {
        return {};
    }

    if ((await checkout.remoteUrlOf(git, directory)) === undefined) {
        return { upstreamNote: `The checkout has no '${checkout.UPSTREAM_REMOTE}' remote, so there is no upstream to compare it with.` };
    }

    const fetched = await checkout.tryFetchUpstream(git, directory);
    const branch = await checkout.defaultBranch(git, directory);

    if (!fetched.ok) {
        const since = await checkout.lastFetchedAt(git, directory, branch);

        ctx.reporter.problem(
            `Could not reach upstream; the checkout may have diverged since ${since === undefined ? "it was last fetched, and git has no record of when that was." : `${formatWhen(since)}, when it was last fetched.`}`,
            { cause: `Git said: ${fetched.reason}`, hint: "The link was recorded all the same, and nothing in the checkout was changed." },
        );
        return {};
    }

    if (branch === undefined) {
        return { upstreamNote: "Upstream was fetched, but its default branch could not be worked out, so there is nothing to compare the checkout with." };
    }

    const comparison = await checkout.compareWithUpstream(git, directory, branch);

    return {
        upstream: {
            upstream: `${checkout.UPSTREAM_REMOTE}/${branch}`,
            ...(comparison.merged === undefined ? {} : { merged: comparison.merged }),
            ...(comparison.behind === undefined ? {} : { behind: comparison.behind }),
            ...(comparison.branch === undefined ? { detachedAt: comparison.commit ?? "an unknown commit" } : {}),
        },
    };
}

/** A moment as `YYYY-MM-DD HH:MM` in local time, which is how a person reads "since when". */
function formatWhen(when: Date): string {
    const pad = (value: number): string => String(value).padStart(2, "0");

    return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`;
}
