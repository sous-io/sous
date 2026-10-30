/**
 * `repo.unlink`: stops reading a repository from a working copy and goes back to the versions the
 * lockfile pins. The checkout stays unless `--remove` asks to delete one sous cloned. Everything
 * that can refuse is settled before anything is written, so a refusal leaves the link in place.
 */

import fs from "node:fs";
import path from "node:path";
import { ConfigError, isSousError, isSousErrorOfKind, type Context } from "@sous-io/plugin-api";
import type { IntentFollowUp, LinkScope, RepoUnlinkInput, RepoUnlinkResult, ResolvedLink, SubscriptionEntry, UnlinkPublishedReport } from "../../types.js";
import { PROJECT_REPOS_DIRNAME } from "../constants.js";
import { effectiveRangeForHolders, findNewerInRange, NEWER_VERSION_CHECK_TIMEOUT_MS, withDeadline } from "../index-cache/freshness.js";
import { trustedRepos } from "../lock/lock-service.js";
import { plainSubscriptionKey } from "../lock/reachable.js";
import type { PartBRuntime } from "../runtime.js";
import { messageOf } from "../support.js";
import { hasNoUnsavedWork, unsavedWork, type UnsavedWork } from "./checkout.js";
import type { LinksFiles } from "./links-service.js";

/** The handler of `repo.unlink`. */
export async function unlinkRepo(input: RepoUnlinkInput, ctx: Context, runtime: PartBRuntime): Promise<RepoUnlinkResult> {
    const links = ctx.services.get("recipes.links") as LinksFiles;
    const scope: LinkScope = input.global ? "global" : "project";
    const name = input.repo;
    const dryRun = input.dryRun === true;
    const entry = links.getIn(name, scope);

    if (entry === undefined) {
        throw new ConfigError(notLinkedMessage(links, name, scope));
    }

    if (input.update && trustedRepos(ctx)[name] === undefined) {
        throw new ConfigError(`'${name}' is linked, but this project does not trust a repository by that name, so it has no pins to update.`, {
            details: ["Nothing was changed; the link is still in place."],
        });
    }

    if (input.remove) {
        assertRemovable(name, entry, scope, runtime, ctx);
    }

    const git = ctx.services.get("git.runner");
    const work = input.remove ? await unsavedWork(git, entry.path) : undefined;
    const followUps: IntentFollowUp[] = [];

    if (dryRun) {
        const wouldDo = [`would unlink '${name}', which points at ${entry.path}`, input.remove ? "the checkout would be deleted" : "the checkout itself would be left where it is"];

        if (work !== undefined && !hasNoUnsavedWork(work)) {
            describeUnsavedWork(work, ctx);
        }

        if (input.update) {
            followUps.push({ intent: "subscription.update", result: await ctx.run("subscription.update", { ref: name, dryRun: true, noBuild: true }) });
        }

        return { repo: name, path: entry.path, scope, removedCheckout: false, dryRun, followUps, wouldDo };
    }

    if (work !== undefined) {
        await confirmRemoval(entry.path, work, input.yes === true, ctx);
    }

    await links.remove(name, scope);
    ctx.configChanged();

    let diff: RepoUnlinkResult["diff"];
    let published: UnlinkPublishedReport | undefined;

    if (input.update) {
        try {
            const result = await ctx.run("subscription.update", {
                ref: name,
                noBuild: true,
                ...(input.yes === undefined ? {} : { yes: input.yes }),
                ...(input.answer === undefined ? {} : { answer: input.answer }),
                ...(input.answersFile === undefined ? {} : { answersFile: input.answersFile }),
            });

            diff = result.plan.diff;
            followUps.push({ intent: "subscription.update", result });
        } catch (error) {
            const message = `'${name}' was unlinked, but its pins were not updated. ${messageOf(error)}`;

            throw isSousErrorOfKind(error, "non-interactive") ? Object.assign(error, { message }) : new ConfigError(message, { cause: error });
        }
    } else {
        published = await newerVersions(name, ctx);
    }

    let checkoutNote: string;

    if (input.remove) {
        fs.rmSync(entry.path, { recursive: true, force: true });
        checkoutNote = `The checkout sous cloned at ${entry.path} was deleted.`;
    } else {
        checkoutNote = entry.origin === "clone" ? `The checkout sous cloned is still at ${entry.path}.` : `The checkout at ${entry.path} was yours to begin with, and has not been touched.`;
    }

    if (input.noBuild) {
        followUps.push({ intent: "build", skipped: "--no-build" });
    } else {
        followUps.push(await rebuild(name, ctx));
    }

    return {
        repo: name,
        path: entry.path,
        scope,
        removedCheckout: input.remove === true,
        ...(diff === undefined ? {} : { diff }),
        dryRun,
        followUps,
        recordedIn: links.path(scope),
        ...(published === undefined ? {} : { published }),
        checkoutNote,
    };
}

/** Runs the build afterwards; a missing build intent is recorded as skipped. */
async function rebuild(name: string, ctx: Context): Promise<IntentFollowUp> {
    if (ctx.engine.intents.get("build") === undefined) {
        return { intent: "build", skipped: "no plugin provides the build intent" };
    }

    try {
        return { intent: "build", result: await ctx.run("build", {}) };
    } catch (error) {
        throw new ConfigError(`'${name}' was unlinked, but the build that followed failed, so this project's outputs may still hold what the checkout contributed.`, {
            cause: error,
            details: [isSousError(error) ? error.message : messageOf(error), "The unlink itself is recorded; fix what the build reported and run 'sous build' again."],
        });
    }
}

/** Refuses to delete a checkout sous did not clone, or one outside where sous clones. */
function assertRemovable(name: string, entry: ResolvedLink, scope: LinkScope, runtime: PartBRuntime, ctx: Context): void {
    if (entry.origin !== "clone") {
        throw new ConfigError(`Sous did not create the checkout at ${entry.path}, so it will not delete it.`, {
            details: [`'${name}' was linked to a checkout that was already there. Nothing was changed; unlink without '--remove' to keep the checkout, and delete it yourself if you want it gone.`],
        });
    }

    const root = scope === "global" ? runtime.homePaths().repos : path.join(ctx.project?.sousDir ?? "", PROJECT_REPOS_DIRNAME);
    const relative = path.relative(root, entry.path);

    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new ConfigError(`The checkout at ${entry.path} is not inside ${root}, where sous clones checkouts, so sous will not delete it.`, {
            details: ["Nothing was changed; unlink without '--remove' and delete it yourself if you want it gone."],
        });
    }
}

/** Asks once before deleting work that exists nowhere else; `--yes` answers ahead of time (L4). */
async function confirmRemoval(checkoutPath: string, work: UnsavedWork, yes: boolean, ctx: Context): Promise<void> {
    if (hasNoUnsavedWork(work)) {
        return;
    }

    describeUnsavedWork(work, ctx);

    if (yes) {
        return;
    }

    const proceed = await ctx.prompter.confirm({ message: "Delete the checkout, and this work with it?", default: false, answeredBy: "--yes" });

    if (!proceed) {
        throw new ConfigError(`Nothing was changed: the checkout at ${checkoutPath} was not deleted, and the link is still in place.`);
    }
}

/** Reports the work a deletion would lose. */
function describeUnsavedWork(work: UnsavedWork, ctx: Context): void {
    const lines = ["The checkout holds work that exists nowhere else, and deleting it loses that work."];
    const group = (title: string, items: readonly string[]): void => {
        if (items.length > 0) {
            lines.push("", title, ...items.map((item) => `  • ${item}`));
        }
    };

    if (work.unknown !== undefined) {
        group("Sous could not inspect it, so it may hold anything:", [work.unknown]);
    }

    group("Uncommitted changes:", work.uncommitted);
    group("Commits no remote has:", work.unpushed);
    group("Stashes:", work.stashes);
    ctx.reporter.warning(lines.join("\n"));
}

/** Which pins of the repository have newer versions within range, without changing any; `undefined` for a repository the project does not trust. */
async function newerVersions(name: string, ctx: Context): Promise<UnlinkPublishedReport | undefined> {
    if (trustedRepos(ctx)[name] === undefined) {
        return undefined;
    }

    const newer: Array<{ key: string; from: string; to: string }> = [];

    try {
        const index = (await withDeadline((signal) => ctx.services.get("recipes.index-cache").get(name, { signal, latest: true }), NEWER_VERSION_CHECK_TIMEOUT_MS)).index;
        const lockfile = ctx.services.get("recipes.lock").read();
        const subscriptions = ctx.config.get<Record<string, SubscriptionEntry>>("subscriptions") ?? {};

        for (const [key, entry] of Object.entries(lockfile.recipes)) {
            if (entry.repo !== name) {
                continue;
            }

            const range = effectiveRangeForHolders(key, entry.requestedBy, {
                subscriptionRange: (recipe) => subscriptionRange(recipe, subscriptions),
                dependencyRange: (holder, recipe) => {
                    const pinned = lockfile.recipes[holder];
                    const recorded = pinned === undefined ? undefined : index.recipes[holder]?.versions[pinned.version]?.dependencies?.[recipe];

                    return recorded === undefined ? undefined : (recorded.range ?? "*");
                },
            });
            const found = range === undefined ? undefined : findNewerInRange({ index, key, lockedVersion: entry.version, range });

            if (found !== undefined) {
                newer.push({ key: found.key, from: found.from, to: found.to });
            }
        }
    } catch (error) {
        return { checked: false, reason: (messageOf(error).split("\n")[0] ?? "").trim(), newer: [] };
    }

    return { checked: true, newer };
}

/** The range the project's subscription declares for a key: its own entry, else its namespace's. */
function subscriptionRange(key: string, subscriptions: Readonly<Record<string, SubscriptionEntry>>): string | undefined {
    const namespace = key.slice(0, key.indexOf("/"));

    for (const [subscription, entry] of Object.entries(subscriptions)) {
        const stored = plainSubscriptionKey(subscription);

        if (stored === key || stored === namespace) {
            return entry?.range ?? "*";
        }
    }

    return undefined;
}

/** The message for a repository that is not linked in the scope asked about. */
function notLinkedMessage(links: LinksFiles, name: string, scope: LinkScope): string {
    const other: LinkScope = scope === "global" ? "project" : "global";
    const searched = scope === "global" ? "the machine-wide links map" : "this project's links map";
    let elsewhere: ResolvedLink | undefined;

    try {
        elsewhere = links.getIn(name, other);
    } catch {
        elsewhere = undefined;
    }

    if (elsewhere !== undefined) {
        return `'${name}' is not linked in ${searched}. It is linked in the ${other === "project" ? "project" : "machine-wide"} map, at ${elsewhere.path}. Run the same command ${scope === "global" ? "without" : "with"} --global to remove that one.`;
    }

    const linked = Object.keys(links.read(scope).links).sort();

    return `'${name}' is not linked in ${searched}. ${linked.length > 0 ? `Linked there: ${linked.join(", ")}.` : "Nothing is linked there."} Run 'sous repo link ${name}' to link it.`;
}
