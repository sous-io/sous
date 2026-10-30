/**
 * `repo.release`: publishes new versions of a recipe repository's recipes. It runs inside a recipe
 * repository, which is not a sous project, so it needs no project config.
 *
 * One run does the whole job, in one order, after showing what it will do and asking once:
 *
 *   1. Validate the repository, and settle the dependencies that read more than one way.
 *   2. Raise the version of every changed recipe in scope (a patch step unless `--bump` says).
 *   3. Regenerate the index, each new version's dependencies resolved.
 *   4. Commit the manifests and the index together.
 *   5. Tag that commit, dependency-first.
 *   6. Push, only when asked.
 *
 * `--check` is the read-only form a pull request runs; `--ci` the form a merge runs: it bumps
 * nothing, accepts the plan, and asks nothing.
 */

import fs from "node:fs";
import { ConfigError, type Context } from "@sous-io/plugin-api";
import type { IndexFile } from "@sous-io/plugin-formats/types";
import type { ReleasePlanEntry, ReleaseProblem, RepoReleaseInput, RepoReleaseResult } from "../types.js";
import { toolsFrom, type AuthoringTools } from "../tools.js";
import { RepoGit, UPSTREAM_REMOTE } from "../shared/git.js";
import { describeCount, describeError, errorsIn, hasErrors, warningsIn } from "../shared/problems.js";
import { findRepoRoot, INDEX_FILE, validateRepo, type RepoValidation } from "../shared/repository.js";
import { bumpRecipeVersion } from "./bump.js";
import { buildIndex, describeIndexDrift, indexFilePath, readIndexFile } from "./index-builder.js";
import { buildReleasePlan, describeScope, releaseScope, scopeProblems, type PlannedRelease, type ReleasePlan } from "./plan.js";
import { settleDependencyLocations, type SettledDependency } from "./settle.js";
import { checkSubmissions } from "./submissions.js";

/** Where `repo.release` runs: the chain's working directory (`ctx.cwd`), or a test's. */
export interface ReleaseOptions {
    readonly cwd: string;
    readonly now?: Date;
}

/** The intent's handler. */
export async function handleRelease(input: RepoReleaseInput, ctx: Context): Promise<RepoReleaseResult> {
    const result = await runRelease(toolsFrom(ctx), input, { cwd: ctx.cwd });

    if (!result.dryRun && result.cancelled !== true && result.plan.length > 0) {
        await ctx.emit("authoring.released", {
            repository: result.repository,
            recipes: result.plan.map((entry) => ({ key: entry.key, version: entry.to, tag: entry.tag })),
            pushed: result.pushed,
        });
    }

    return result;
}

/** Runs a release with the given tools. */
export async function runRelease(tools: AuthoringTools, input: RepoReleaseInput, options: ReleaseOptions): Promise<RepoReleaseResult> {
    const reporter = tools.reporter;
    const dryRun = input.dryRun === true;
    const ci = input.ci === true;
    // The CI preset: never raise a version, accept the plan, never ask. It does not imply --push.
    const noBump = input.noBump === true || ci;
    const accepted = input.yes === true || ci;

    assertFlagsAgree(input, noBump);

    const rootDir = findRepoRoot(tools, input.directory ?? options.cwd);
    const git = new RepoGit(tools.git, rootDir);
    const scope = releaseScope(input.namespace ?? [], input.recipe ?? []);
    const base = { repository: rootDir, indexPath: indexFilePath(rootDir), dryRun };

    reporter.log("info", `Repository: ${rootDir}`, { repository: rootDir });
    reporter.log("info", `Mode: ${describeMode(input)}`);
    reporter.log("info", `Scope: ${describeScope(scope)}`);

    // --- Validate ---------------------------------------------------------------------------

    reporter.log("info", "Checking the repository");

    let validation = await validateRepo(tools, rootDir);
    const scoping = [...validation.problems, ...scopeProblems(validation, scope)];

    reportProblems(tools, scoping);
    stopOnErrors(scoping);
    reporter.log("info", `  Read ${describeCount(validation.recipes.length, "recipe")}.`);

    // Settled before anything is planned or written, so an unreachable repository changes nothing.
    const settling = await settleDependencyLocations(tools, validation);

    reportProblems(tools, settling.problems);
    stopOnErrors(settling.problems);

    const problems: ReleaseProblem[] = [...scoping, ...settling.problems];

    if (input.check === true) {
        return runCheck(tools, git, validation, settling.settled, problems, base, options.now);
    }

    // --- Plan ---------------------------------------------------------------------------------

    const branch = await git.currentBranch();
    const mainBranch = await git.defaultBranch();
    const onDefaultBranch = mainBranch === undefined || branch === undefined || branch === mainBranch;
    const willTag = onDefaultBranch || input.tag === true;

    const plan = await buildReleasePlan(tools, git, {
        validation,
        scope,
        ...(input.bump === undefined ? {} : { bump: input.bump }),
        noBump,
        includeUnchanged: input.includeUnchanged === true,
    });

    reportProblems(tools, plan.problems);
    stopOnErrors(plan.problems);
    problems.push(...plan.problems);
    reportPlan(tools, plan, { willTag, branch, push: input.push === true });

    const empty = {
        ...base,
        ok: true,
        problems,
        indexChanged: false,
        tagged: [],
        pushed: false,
        skipped: plan.skipped,
    };

    if (plan.releases.length === 0) {
        return { ...empty, plan: [] };
    }

    const entries = (hashes: Map<string, string>) => plan.releases.map((release) => planEntry(release, hashes.get(release.key) ?? ""));

    if (dryRun) {
        reporter.note("Nothing was written; this was a dry run.");

        return { ...empty, plan: entries(await workingHashes(tools, validation)) };
    }

    // --- Confirm ------------------------------------------------------------------------------

    if (!accepted) {
        const answer = await tools.prompter.confirm({ message: "Publish these versions?", answeredBy: "--yes", default: true });

        if (!answer) {
            reporter.log("info", "  Nothing was written.");

            return { ...empty, plan: entries(await workingHashes(tools, validation)), cancelled: true };
        }
    }

    // --- Carry it out ---------------------------------------------------------------------------

    await assertNothingUncommitted(git);
    await assertCommitIdentity(git);
    reporter.log("info", "Publishing");

    const changedPaths: string[] = [];

    for (const release of plan.releases) {
        if (release.bump === undefined) {
            reporter.log("info", `  ${release.key}: publishing version ${release.to}.`);
            continue;
        }

        const bumped = bumpRecipeVersion(release.manifestPath, release.bump);

        reporter.log("info", `  ${release.key}: ${bumped.from} becomes ${bumped.to}.`);
        changedPaths.push(release.manifestPath);
    }

    // The manifests changed, so everything after this works from what the files now say.
    validation = await validateRepo(tools, rootDir);
    reportProblems(tools, validation.problems);
    stopOnErrors(validation.problems);

    const publishing: Record<string, string> = {};

    for (const release of plan.releases) {
        publishing[release.key] = release.to;
    }

    const existing = readExistingIndex(tools, rootDir);
    const rebuilt = await buildIndex(tools, git, {
        validation,
        ...(existing === undefined ? {} : { existing }),
        sousVersion: tools.sousVersion,
        publishing,
        settled: settling.settled,
        ...(options.now === undefined ? {} : { now: options.now }),
    });

    reportProblems(tools, rebuilt.problems);
    stopOnErrors(rebuilt.problems);
    problems.push(...rebuilt.problems);

    if (rebuilt.stale) {
        fs.writeFileSync(indexFilePath(rootDir), rebuilt.text, "utf8");
        reporter.log("info", `  Wrote ${INDEX_FILE}.`);
        changedPaths.push(indexFilePath(rootDir));
    } else {
        reporter.log("info", `  The committed ${INDEX_FILE} was already current.`);
    }

    const message = `Release ${plan.releases.map((release) => `${release.key}@${release.to}`).join(", ")}`;
    let committed = false;

    if (await git.anythingToCommit(changedPaths)) {
        await git.commitPaths(changedPaths, message);
        committed = true;
        reporter.log("info", `  Committed: ${message}`);
    } else {
        reporter.log("info", "  Nothing to commit; the manifests and the index were already current.");
    }

    const tagged: string[] = [];

    if (willTag) {
        for (const release of plan.releases) {
            await git.createAnnotatedTag(release.tag, `Release ${release.key} version ${release.to}`);
            tagged.push(release.tag);
            reporter.log("info", `  Created the tag ${release.tag}.`);
        }
    } else {
        reporter.note(
            `No tags were cut: this is the branch '${branch}', and tags are cut on the default branch '${mainBranch}'. ` +
                `Continuous integration does that after the merge, or pass '--tag' to cut them here.`,
        );
    }

    // --- Push -----------------------------------------------------------------------------------

    let pushed = false;

    if (input.push === true) {
        if ((await git.remoteUrl(UPSTREAM_REMOTE)) === undefined) {
            throw new ConfigError(
                `The release was made, but this repository has no '${UPSTREAM_REMOTE}' remote to push it to.\n` +
                    `  Add one with 'git remote add ${UPSTREAM_REMOTE} <url>', then push the commit and its tags yourself.`,
            );
        }

        if (branch !== undefined) {
            await git.pushBranch(UPSTREAM_REMOTE, branch);
            reporter.log("info", `  Pushed the branch '${branch}' to ${UPSTREAM_REMOTE}.`);
        }

        if (tagged.length > 0) {
            await git.pushTags(UPSTREAM_REMOTE, tagged);
            reporter.log("info", `  Pushed ${describeCount(tagged.length, "tag")} to ${UPSTREAM_REMOTE}.`);
        }

        pushed = true;
    } else {
        reporter.log("info", "What to do next");
        reporter.log("info", `  Push the commit with 'git push ${UPSTREAM_REMOTE} ${branch ?? "<branch>"}'.`);

        if (tagged.length > 0) {
            reporter.log("info", `  Push the tags with 'git push ${UPSTREAM_REMOTE} --tags'.`);
        }

        reporter.log("info", "  Or run this command again with '--push', which does both.");
    }

    const hashes = new Map(plan.releases.map((release) => [release.key, rebuilt.index.recipes[release.key]?.versions[release.to]?.hash ?? ""]));

    return {
        ...base,
        ok: true,
        problems,
        plan: entries(hashes),
        index: rebuilt.index,
        indexChanged: rebuilt.stale,
        tagged,
        pushed,
        committed,
        skipped: plan.skipped,
    };
}

/**
 * `--check`: validate, regenerate the index in memory, and fail only on problems and on changes to
 * recipes that take no proposals. Index drift is reported as what merging will change: the release
 * after the merge rewrites the index before tagging.
 */
async function runCheck(
    tools: AuthoringTools,
    git: RepoGit,
    validation: RepoValidation,
    settled: Map<string, SettledDependency>,
    problems: ReleaseProblem[],
    base: { repository: string; indexPath: string; dryRun: boolean },
    now: Date | undefined,
): Promise<RepoReleaseResult> {
    const reporter = tools.reporter;

    reporter.log("info", "Checking the index");

    const existing = readExistingIndex(tools, validation.rootDir);
    const result = await buildIndex(tools, git, {
        validation,
        ...(existing === undefined ? {} : { existing }),
        sousVersion: tools.sousVersion,
        settled,
        ...(now === undefined ? {} : { now }),
    });

    reportProblems(tools, result.problems);
    stopOnErrors(result.problems);
    problems.push(...result.problems);

    const drift = result.stale ? describeIndexDrift(existing, result.index) : [];

    if (result.stale) {
        reporter.note(`Merging rewrites the committed ${INDEX_FILE}, because:\n${drift.map((line) => `  - ${line}`).join("\n")}`);
    } else {
        reporter.log("info", `  The committed ${INDEX_FILE} is current, and so are the dependencies it records for every version it publishes.`);
    }

    if (result.pending.length > 0) {
        reporter.log("info", "  These versions have no tag yet; they publish when this merges:");

        for (const entry of result.pending) {
            reporter.log("info", `    ${entry.key}: ${entry.version}  (the tag would be ${entry.tag})`);
        }
    }

    // A pull request can be opened without `repo submit`, so this is the one gate every change passes.
    reporter.log("info", "Checking the recipes that take no proposals");

    const submissions = await checkSubmissions(git, validation);

    if (submissions.refusing.length > 0) {
        const refused: ReleaseProblem[] = submissions.refusing.map((recipe) => ({
            level: "error",
            recipe: recipe.key,
            where: recipe.path,
            message:
                `this change touches '${recipe.key}', which does not take proposed changes ` +
                `(${recipe.declaredBy === "recipe" ? "its own manifest" : "the repository manifest"} says so). Merging it ` +
                `would break whatever publishes the recipe.` +
                (recipe.instead === undefined ? "" : ` Instead: ${recipe.instead}`),
        }));

        reportProblems(tools, refused);

        throw new ConfigError(
            `This change cannot be merged: it touches ${describeCount(refused.length, "recipe")} that ` +
                `${refused.length === 1 ? "does" : "do"} not take proposed changes, listed above.\n` +
                `  Take those edits out of the change, and send them where each recipe asks.`,
            { details: refused.map((problem) => `${problem.where}: ${problem.message}`) },
        );
    }

    const compared = submissions.comparedWith;

    if (compared.kind === "branch") {
        reporter.log("info", `  Compared with the branch '${compared.branch}': this change touches no recipe that declines proposals.`);
    } else if (compared.kind === "tags") {
        reporter.log("info", "  Compared with each recipe's last release tag: nothing that declines proposals changed.");
    } else if (compared.kind === "none declined") {
        reporter.log("info", "  No recipe in this repository declines proposed changes.");
    } else {
        reporter.note(
            "This checkout holds neither a copy of the default branch nor a release tag of any recipe that declines " +
                "proposed changes, so there was nothing to compare with.",
        );
    }

    const plan: ReleasePlanEntry[] = result.pending.map((entry) => ({
        key: entry.key,
        path: entry.path,
        to: entry.version,
        bump: "none",
        reason: "changed",
        tag: entry.tag,
        hash: entry.hash,
        changelog: [`${entry.key}: ${entry.version} publishes when this merges`],
    }));

    return {
        ...base,
        dryRun: true,
        ok: true,
        problems,
        plan,
        index: result.index,
        indexChanged: result.stale,
        tagged: [],
        pushed: false,
        drift,
    };
}

/** Refuses flag combinations that would mean two things at once. */
export function assertFlagsAgree(input: RepoReleaseInput, noBump: boolean): void {
    if (input.check === true && input.ci === true) {
        throw new ConfigError(
            "'--check' and '--ci' cannot be used together.\n" +
                "  '--check' only reads, and reports whether a release is needed; '--ci' makes one.\n" +
                "  A pull request runs 'sous repo release --check'; a merge runs 'sous repo release --ci --push'.",
        );
    }

    if (input.check === true && (input.bump !== undefined || input.push === true || input.tag === true)) {
        throw new ConfigError(
            "'--check' changes nothing, so it cannot be combined with '--bump', '--tag' or '--push'.\n" +
                "  Run 'sous repo release --check' on its own, or drop '--check' to make a release.",
        );
    }

    if (input.bump !== undefined && noBump) {
        throw new ConfigError(
            "'--bump' and '--no-bump' cannot be used together.\n" +
                "  '--bump' says how far to raise a version; '--no-bump' says to raise none. '--ci' implies '--no-bump'.",
        );
    }
}

function describeMode(input: RepoReleaseInput): string {
    if (input.check === true) {
        return "Check only";
    }

    if (input.dryRun === true) {
        return "Plan only";
    }

    return input.ci === true ? "Publish (continuous integration)" : "Publish";
}

/** The committed index, or a fresh start with a warning when it cannot be read. */
function readExistingIndex(tools: AuthoringTools, rootDir: string): IndexFile | undefined {
    try {
        return readIndexFile(tools, rootDir);
    } catch (error) {
        tools.reporter.warning(
            `The committed ${INDEX_FILE} could not be read, so it will be regenerated from the recipe manifests and the ` +
                `release tags.\n${describeError(error)}`,
        );

        return undefined;
    }
}

function reportProblems(tools: AuthoringTools, problems: readonly ReleaseProblem[]): void {
    for (const problem of errorsIn(problems)) {
        tools.reporter.log("error", `${problem.where}:\n  ${problem.message}`, { problem });
    }

    for (const problem of warningsIn(problems)) {
        tools.reporter.warning(`${problem.where}:\n${problem.message}`, { problem });
    }
}

/** Ends the run when any problem is an error; the problems were reported already. */
function stopOnErrors(problems: readonly ReleaseProblem[]): void {
    if (!hasErrors(problems)) {
        return;
    }

    const count = errorsIn(problems).length;

    throw new ConfigError(
        `This repository cannot be released yet: ${describeCount(count, "problem")} ${count === 1 ? "is" : "are"} listed above.\n` +
            `  Fix them and run the command again.`,
        { details: errorsIn(problems).map((problem) => `${problem.where}: ${problem.message}`) },
    );
}

function reportPlan(tools: AuthoringTools, plan: ReleasePlan, context: { willTag: boolean; branch: string | undefined; push: boolean }): void {
    const reporter = tools.reporter;

    reporter.log("info", "The release this would make");

    if (plan.releases.length === 0) {
        reporter.log("info", "  Nothing in scope has changed since the tag that last published it.");

        for (const entry of plan.skipped) {
            reporter.log("info", `  ${entry.key}: ${entry.reason}`);
        }

        reporter.log("info", "  Pass '--include-unchanged' to release everything in scope anyway.");

        return;
    }

    for (const release of plan.releases) {
        reporter.log("info", `  ${describeRelease(release)}`, { release });
    }

    if (plan.skipped.length > 0) {
        reporter.log("info", "  Left alone:");

        for (const entry of plan.skipped) {
            reporter.log("info", `    ${entry.key}: ${entry.reason}`);
        }
    }

    reporter.log("info", "  This run would:");
    reporter.log("info", "    Raise the versions listed above, in the manifests that declare them.");
    reporter.log("info", `    Regenerate ${INDEX_FILE}, with each version's dependencies resolved.`);
    reporter.log("info", "    Commit the manifests and the index together.");
    reporter.log(
        "info",
        context.willTag ? "    Cut one annotated tag per version, dependency-first." : `    Cut no tags: this is the branch '${context.branch}', not the default one.`,
    );
    reporter.log(
        "info",
        context.push
            ? `    Push the commit${context.willTag ? " and the tags" : ""} to ${UPSTREAM_REMOTE}.`
            : "    Push nothing; pass '--push' to push what it makes.",
    );
}

function describeRelease(release: PlannedRelease): string {
    return release.bump === undefined
        ? `${release.key}: ${release.to}  (already raised; the tag would be ${release.tag})`
        : `${release.key}: ${release.from} becomes ${release.to}  (a ${release.bump} step; the tag would be ${release.tag})`;
}

function planEntry(release: PlannedRelease, hash: string): ReleasePlanEntry {
    return {
        key: release.key,
        path: release.path,
        ...(release.lastTagged === undefined ? {} : { from: release.lastTagged }),
        to: release.to,
        bump: release.bump ?? (release.reason === "first" ? "first" : "none"),
        reason: release.reason,
        tag: release.tag,
        hash,
        changelog: [describeRelease(release)],
    };
}

async function workingHashes(tools: AuthoringTools, validation: RepoValidation): Promise<Map<string, string>> {
    const hashes = new Map<string, string>();

    for (const recipe of validation.recipes) {
        hashes.set(recipe.key, await tools.hash.hashDirectory(recipe.dir));
    }

    return hashes;
}

/**
 * A tag names one commit, and the index records each folder as it stands, so an uncommitted edit would
 * be published by hash and absent from the tag. Sous commits its own bumps and index, nothing else.
 */
async function assertNothingUncommitted(git: RepoGit): Promise<void> {
    const changed = await git.uncommittedChanges();

    if (changed.length === 0) {
        return;
    }

    throw new ConfigError(
        "Cannot release while the working tree has uncommitted changes.\n\n" +
            `${changed.map((entry) => `  ${entry.path}`).join("\n")}\n\n` +
            "  A tag names one commit, and the index this writes records what each recipe folder holds right now, so " +
            "everything being published has to be committed first.\n" +
            "  Commit these, then run the command again; sous commits the version bumps and the index itself.",
    );
}

/** Checked before anything is written, so git never fails partway with "empty ident name". */
async function assertCommitIdentity(git: RepoGit): Promise<void> {
    if (await git.hasCommitIdentity()) {
        return;
    }

    throw new ConfigError(
        "Cannot release: git does not know who is making the commit.\n\n" +
            "  A release commits the version bumps and the index, and cuts an annotated tag for every version it " +
            "publishes; git refuses to do either without an author identity.\n" +
            "  Set one in this repository and run the command again:\n\n" +
            '    git config user.name "Your Name"\n' +
            '    git config user.email "you@example.com"\n\n' +
            "  In a continuous integration job, configure the identity of the account the release runs as before this " +
            "command; the workflow 'sous repo init' scaffolds already does.",
    );
}
