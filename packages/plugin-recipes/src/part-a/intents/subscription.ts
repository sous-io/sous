/**
 * The subscription intents: `subscription.add`, `.remove`, `.enable`, `.disable`, `.list`,
 * `.update`, and `recipe.update`, which plans an update and writes nothing (ported from
 * `subscription-service.ts` and `src/commands/subscription/`).
 *
 * Subscribing asks nothing about variables itself: it subscribes, then runs `vars.ask` and `build`
 * through `ctx.run`. `enable` and `disable` overwrite only `enabled` in
 * `conf.d/510-subscriptions.jsonc`, keeping every other field. Sous always reads the merged
 * config, so a later layer that sets `enabled: false` switches a subscription off.
 */

import { LogLevel, SousError, type BuiltConfig, type Context, type Reporter, type Sous } from "@sous-io/plugin-api";
import type { Lockfile } from "@sous-io/plugin-formats/types";
import type { NamedRef, SousRef } from "@sous-io/plugin-refs/types";
import semver from "semver";
import type {
    BrowsingFlags,
    LockDiff,
    MissingRepo,
    RecipeUpdateInput,
    RecipeUpdatePlan,
    ResolvedRecipe,
    SubscriptionAddInput,
    SubscriptionAddResult,
    SubscriptionListing,
    SubscriptionRemoveInput,
    SubscriptionRemoveResult,
    SubscriptionToggleInput,
    SubscriptionToggleResult,
    SubscriptionUpdateInput,
    SubscriptionUpdateResult,
} from "../../types.js";
import { findInCatalog, latestVersion } from "../catalog.js";
import { identityOf, loadCatalog, pickMatch, readingsOf, readUpstream, type CatalogContext } from "../catalog-context.js";
import { USER_ADDED_BY } from "../defaults.js";
import { askFollowUp, buildFollowUp } from "../followups.js";
import { applyResolution, keysHeldBySubscription, PROJECT_HOLDER, type LockRepoInput } from "../lock-holds.js";
import { configuredSubscriptions, contributorLabel, managedContributor, setSubscriptionEnabled, SUBSCRIPTIONS_LAYER, trustedRepos, writeSubscriptionEntry } from "../project.js";
import { isShortNamed, planSubscriptionRemoval, subscriptionKeyFor, writeSubscriptionRemoval } from "../subscriptions.js";
import { checkProvidedAnswers } from "../provided-answers.js";
import { planQuestions } from "../questions.js";
import { ensureRequiredPlugins, recipeDirectory } from "../required-plugins.js";
import { needUrlError } from "../trust.js";
import { describeUpdateScope, isEmptyUpdate, planUpdate } from "../update-plan.js";
import { describeError, nowIso, proposeRepoName, sortBytewise } from "../util.js";
import { acceptFirst, answer, answersFile, browsing, dryRun, inputSchema, latestFlag, noBuild, yes, yesFlag } from "./schema.js";

/** The most rounds of "resolve, trust what is missing, resolve again" one command runs. */
const MAX_TRUST_ROUNDS = 10;

/**
 * Rebuilds the config for the rest of this chain (`ctx.refreshConfig()`), so the steps after it,
 * `vars.ask` and `build` included, see what was just written. Returns the same context, which now
 * reads the new config.
 */
async function refreshed(ctx: Context): Promise<Context> {
    await ctx.refreshConfig();

    return ctx;
}

/** The repository records the lockfile writes, for the trusted repositories of a config. */
function lockRepoInputs(ctx: Context): Record<string, LockRepoInput> {
    const inputs: Record<string, LockRepoInput> = {};

    for (const [name, entry] of Object.entries(trustedRepos(ctx.config))) {
        const identity = identityOf(ctx, entry.url);

        inputs[name] = { url: entry.url, ...(identity === undefined ? {} : { identity }) };
    }

    return inputs;
}

/**
 * Builds the config again from the files as they are now, for the rest of this chain, which also
 * downloads what is newly pinned.
 */
async function rebuild(ctx: Context): Promise<Context | undefined> {
    try {
        return await refreshed(ctx);
    } catch (error) {
        ctx.reporter.warning(`The lockfile was written, but the recipes it pins could not all be downloaded yet: ${describeError(error)}`);

        return undefined;
    }
}

// --- subscription.add -----------------------------------------------------------------------------

/** What the written ref names, fully qualified, and any repository trusted to settle it. */
async function resolveWrittenRef(input: SubscriptionAddInput, ctx: Context): Promise<{ ref: NamedRef; trusted: string[]; ctx: Context }> {
    const readings = readingsOf(ctx, input.ref);
    const short = readings.find(isShortNamed);

    if (short !== undefined) {
        // A recipe ref spelled as published says what it names already.
        if (short.kind === "recipe" && short.namespace !== undefined) {
            const key = ctx.services.get("refs.format").key(short);

            if (key === key.toLowerCase()) {
                return { ref: short, trusted: [], ctx };
            }
        }

        const catalog = await loadCatalog(ctx);

        return { ref: await pickNamed(ctx, catalog, readings.filter(isShortNamed), input, short), trusted: [], ctx };
    }

    const located = readings.filter((reading): reading is NamedRef => (reading.kind === "namespace" || reading.kind === "recipe") && locationOf(reading) !== undefined);

    if (located.length === 0) {
        throw new SousError(`'${input.ref}' does not name a namespace or a recipe.`, {
            details: ["Write 'namespace', 'namespace/recipe', either with '@<range>', or either as 'repository:ref' or a repository URL."],
        });
    }

    const trust = ctx.services.get("recipes.trust");
    let current = ctx;
    const trusted: string[] = [];

    if (!located.some((reading) => trust.isTrusted(locationOf(reading)!.identity))) {
        let chosen: NamedRef = located[0]!;

        if (new Set(located.map((reading) => locationOf(reading)!.identity)).size > 1) {
            chosen = (await ctx.services.get("refs.picker").pick(located, {
                search: input.ref.trim(),
                prompt: `'${input.ref.trim()}' can be read as more than one repository. Which one?`,
                ...(input.acceptFirst === undefined ? {} : { acceptFirst: input.acceptFirst }),
            }, ctx)) as NamedRef;
        }

        const location = locationOf(chosen)!;
        const name = proposeRepoName(Object.keys(trustedRepos(ctx.config)), location.identity);
        const done = await trust.confirm(
            [{ name, url: location.url, identity: location.identity, provider: location.provider, requiredBy: [{ ref: input.ref.trim(), requestedBy: PROJECT_HOLDER }] }],
            { ...(input.yes === undefined ? {} : { yes: input.yes }), ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }) },
            ctx,
        );

        trusted.push(...done.added);

        if (input.dryRun === true) {
            return { ref: chosen, trusted, ctx };
        }

        ctx.configChanged();
        current = await refreshed(ctx);
    }

    const catalog = await loadCatalog(current, { latest: trusted.length > 0 });

    return { ref: await pickNamed(current, catalog, located, input, located[0]!), trusted, ctx: current };
}

/** Where a named ref says its repository lives. */
function locationOf(ref: NamedRef): { identity: string; url: string; provider: string } | undefined {
    const repo = ref.kind === "namespace" ? ref.repo : (ref.namespace?.repo ?? ref.repo);

    return repo?.location;
}

/** The one namespace or recipe the readings name in the catalog; a recipe keeps the range it was written with. */
async function pickNamed(ctx: Context, catalog: CatalogContext, readings: readonly SousRef[], input: SubscriptionAddInput, written: NamedRef): Promise<NamedRef> {
    const matches = findInCatalog(catalog.inputs, readings, ["namespace", "recipe"]);
    const match = await pickMatch(ctx, matches, input.ref.trim(), input.acceptFirst, () => {
        const searched = catalog.inputs.repos.map((repo) => repo.name);

        return new SousError(`Nothing called '${input.ref.trim()}' was found: no namespace has that name, and no recipe does either.`, {
            details: [
                searched.length === 0 ? "No repository index could be read, so there was nothing to search." : `Searched the namespaces and recipes of: ${searched.join(", ")}.`,
                ...(catalog.notFetched.length === 0 ? [] : [`Trusted, but their index has not been read, so nothing in them was searched: ${catalog.notFetched.join(", ")}.`]),
                `Run 'sous repo search ${input.ref.trim()}' to look for something like it, or 'sous repo add <url>' to add the repository that publishes it.`,
            ],
        });
    }, { announce: true });

    return match.ref.kind === "recipe" && written.kind === "recipe" && written.range !== undefined ? { ...match.ref, range: written.range } : match.ref;
}

/** Reports what subscribing does to this project, before the subscribe question. */
export function reportSubscriptionPlan(reporter: Reporter, key: string, ref: NamedRef): void {
    reporter.list(
        [
            "The files it ships are compiled into this project's agent directories on the next build.",
            "Any scripts it ships can be run on this machine when an agent uses them. Sous does not run them itself, and cannot vouch for what they do.",
            "The variables it publishes are asked about afterwards, and the answers are written to this project's env files.",
            "Its dependencies are pinned in this project's lockfile at the versions resolved now. A dependency in a repository this project does not trust is asked about by name first.",
        ],
        {
            title:
                ref.kind === "namespace"
                    ? `Subscribing to '${key}' subscribes this project to the whole namespace '${ref.name}': every recipe in it, including ones published later.`
                    : `Subscribing to '${key}' installs the recipe '${ref.name}' from the namespace '${ref.namespace?.name ?? "?"}'.`,
        },
        LogLevel.Notice,
    );
}

/** Resolves a ref and everything beneath it, trusting new repositories as often as resolution turns them up. */
async function resolveClosure(input: SubscriptionAddInput, ref: NamedRef, start: Context): Promise<{ resolved: ResolvedRecipe[]; unreadable: string[]; cycles: string[][]; trusted: string[]; ctx: Context }> {
    const trusted: string[] = [];
    const tried = new Set<string>();
    let ctx = start;

    for (let round = 0; ; round++) {
        const result = await ctx.services.get("recipes.resolver").resolve(
            [
                {
                    ref,
                    ...(ref.kind === "recipe" && ref.range !== undefined ? { range: ref.range } : {}),
                    ...(input.prerelease === true ? { prerelease: true } : {}),
                    requestedBy: PROJECT_HOLDER,
                    kind: "subscribes",
                },
            ],
            { ...(input.prerelease === true ? { prerelease: true } : {}) },
        );
        const missing: MissingRepo[] = result.missingRepos;

        // The index does not always say what a version depends on; then its manifest is read from
        // the store, so a recipe not downloaded yet is downloaded and the closure resolved again.
        if (missing.length === 0 && round < MAX_TRUST_ROUNDS && input.dryRun !== true && (await downloadUnreadable(ctx, result.resolved, result.unreadable, tried))) {
            continue;
        }

        if (missing.length === 0 || round >= MAX_TRUST_ROUNDS) {
            if (missing.length > 0) {
                throw new SousError(`Resolving '${input.ref}' kept turning up repositories to trust: ${missing.map((repo) => repo.name).join(", ")}.`);
            }

            return { resolved: result.resolved, unreadable: result.unreadable, cycles: result.cycles, trusted, ctx };
        }

        const done = await ctx.services.get("recipes.trust").confirm(missing, { ...(input.yes === undefined ? {} : { yes: input.yes }), ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }) }, ctx);

        if (done.needUrl.length > 0) {
            throw needUrlError(done.needUrl);
        }

        trusted.push(...done.added);

        if (input.dryRun === true) {
            ctx.reporter.dryRun(`A dry run trusts nothing, so what ${sortBytewise(done.added).join(", ")} would add is not resolved.`);

            return { resolved: result.resolved, unreadable: result.unreadable, cycles: result.cycles, trusted, ctx };
        }

        ctx.configChanged();
        ctx = await refreshed(ctx);
    }
}

/**
 * Downloads the resolved recipes whose manifests could not be read, so the next resolve can read
 * what they declare. True when any of them is in the store now. Each recipe is tried once: `tried`
 * holds the keys tried before.
 */
export async function downloadUnreadable(ctx: Context, resolved: readonly ResolvedRecipe[], unreadable: readonly string[], tried: Set<string>): Promise<boolean> {
    let downloaded = false;

    for (const key of unreadable) {
        const recipe = resolved.find((entry) => entry.key === key);

        if (tried.has(key)) {
            continue;
        }

        tried.add(key);

        if (recipe !== undefined && (await recipeDirectory(ctx, recipe, true)) !== undefined) {
            downloaded = true;
        }
    }

    return downloaded;
}

/** `subscription.add`. */
export async function addSubscription(input: SubscriptionAddInput, ctx: Context): Promise<SubscriptionAddResult> {
    const written = await resolveWrittenRef(input, ctx);
    const format = ctx.services.get("refs.format");
    const key = format.key(written.ref);
    const canonical = format.format(written.ref);

    reportSubscriptionPlan(ctx.reporter, key, written.ref);

    if (input.dryRun !== true && input.yes !== true) {
        const proceed = await ctx.prompter.confirm({ message: `Subscribe to '${canonical}'?`, answeredBy: "--yes", default: true });

        if (!proceed) {
            throw new SousError(`Nothing was written: the subscription to '${canonical}' was declined.`);
        }
    }

    const closure = await resolveClosure(input, written.ref, written.ctx);
    const current = closure.ctx;
    const lockService = current.services.get("recipes.lock");
    const before = lockService.read();
    const after = applyResolution(before, closure.resolved, lockRepoInputs(current));
    const result = {
        ref: canonical,
        key,
        ...(input.ref.trim() === canonical ? {} : { resolvedFrom: input.ref.trim() }),
        resolved: closure.resolved,
        trusted: [...written.trusted, ...closure.trusted],
        unreadable: closure.unreadable,
        cycles: closure.cycles,
        dryRun: input.dryRun === true,
    };

    // Before anything is written: a recipe requiring a plugin that is not installed is refused,
    // unless it is installed now.
    const installed = await ensureRequiredPlugins(current, closure.resolved, input, input.ref.trim());
    const installFollowUp = installed === undefined ? [] : [installed];

    // An answer given up front that names nothing, or does not fit, fails before anything is written.
    await checkProvidedAnswers(current, closure.resolved, input, input.dryRun !== true);

    if (input.dryRun === true) {
        return {
            ...result,
            diff: lockService.diff(before, after),
            followUps: [...installFollowUp, { intent: "vars.ask", skipped: "--dry-run" }, { intent: "build", skipped: "--dry-run" }],
            questions: await planQuestions(current, closure.resolved),
        };
    }

    const range = written.ref.kind === "recipe" ? written.ref.range : undefined;

    await writeSubscriptionEntry(current.services.get("confd.managed"), key, {
        ...(range === undefined ? {} : { range }),
        ...(input.prerelease === true ? { prerelease: true } : {}),
        ...(input.alwaysPull === true ? { alwaysPull: true } : {}),
        addedAt: nowIso(),
        addedBy: USER_ADDED_BY,
    });

    const diff = await writeLock(current, after);

    ctx.configChanged();
    await rebuild(current);

    // A recipe whose index does not record its questions may ask some, so vars.ask runs for it too.
    const asking = closure.resolved.filter((recipe) => recipe.variables === undefined || recipe.variables.length > 0).map((recipe) => recipe.key);

    return { ...result, diff, followUps: [...installFollowUp, await askFollowUp(ctx, input, asking), await buildFollowUp(ctx, input)] };
}

/** Writes the lockfile and fires `recipes.locked`. */
async function writeLock(ctx: Context, lockfile: Lockfile): Promise<LockDiff> {
    const lock = ctx.services.get("recipes.lock");
    const diff = await lock.write(lockfile);

    await ctx.emit("recipes.locked", { path: lock.path(), diff });

    return diff;
}

// --- subscription.remove ----------------------------------------------------------------------------

/** `subscription.remove`: removes one subscription and everything only it held, refcounted. */
export async function removeSubscription(input: SubscriptionRemoveInput, ctx: Context): Promise<SubscriptionRemoveResult> {
    const key = await subscriptionKeyFor(ctx, input.ref, Object.keys(configuredSubscriptions(ctx.config)));
    const lockService = ctx.services.get("recipes.lock");
    const before = lockService.read();
    const removal = await planSubscriptionRemoval(ctx, key, before);
    const planned = { key, stayed: removal.stayed, optedOut: removal.optedOut, dryRun: input.dryRun === true };

    for (const stayed of removal.stayed) {
        ctx.reporter.note(`The recipe '${stayed.key}' stays, because ${stayed.heldBy.join(", ")} still holds it.`);
    }

    if (input.dryRun === true) {
        return { ...planned, diff: lockService.diff(before, removal.after), followUps: [{ intent: "build", skipped: "--dry-run" }] };
    }

    await writeSubscriptionRemoval(ctx, removal);

    const diff = await writeLock(ctx, removal.after);

    ctx.configChanged();

    // The build that follows must see the subscription gone, or it would lock it again.
    if (input.noBuild !== true) {
        await rebuild(ctx);
    }

    return { ...planned, diff, followUps: [await buildFollowUp(ctx, input)] };
}

// --- subscription.enable and .disable ---------------------------------------------------------------

/** `subscription.enable` and `.disable`: overwrite only `enabled`, in the managed file. */
export async function toggleSubscription(input: SubscriptionToggleInput, ctx: Context, enabled: boolean): Promise<SubscriptionToggleResult> {
    const configured = configuredSubscriptions(ctx.config);
    const key = await subscriptionKeyFor(ctx, input.ref, Object.keys(configured));
    const managed = ctx.services.get("confd.managed");
    const file = managed.path(SUBSCRIPTIONS_LAYER);

    if (!Object.hasOwn(configured, key)) {
        const known = sortBytewise(Object.keys(configured));

        throw new SousError(`This project does not subscribe to '${key}'.`, {
            details: [known.length > 0 ? `It subscribes to: ${known.join(", ")}.` : "It has no subscriptions yet.", `Subscribe with 'sous subscription add ${key}'.`],
        });
    }

    const changed = (configured[key]?.enabled !== false) !== enabled;
    const edit = await setSubscriptionEnabled(managed, key, enabled, input.dryRun === true);

    // A layer after 510 that sets `enabled` still wins: say so, and let it.
    const later = laterSetters(ctx.config, key);

    if (later.length > 0) {
        ctx.reporter.warning(`${later[later.length - 1]} also sets subscriptions.${key}.enabled and is applied after conf.d/${SUBSCRIPTIONS_LAYER}, so its value still wins.`);
    }

    if (input.dryRun === true || !edit.changed) {
        return { key, enabled, file, changed, dryRun: input.dryRun === true, followUps: [{ intent: "build", skipped: input.dryRun === true ? "--dry-run" : "nothing changed" }] };
    }

    ctx.configChanged();

    // The build that follows must see the subscription switched.
    if (changed && input.noBuild !== true) {
        await rebuild(ctx);
    }

    return { key, enabled, file, changed, dryRun: false, followUps: changed ? [await buildFollowUp(ctx, input)] : [{ intent: "build", skipped: "nothing changed" }] };
}

/**
 * The files that set `subscriptions.<key>.enabled` after the managed file: those applied after its
 * own layer, and every `conf.d` file that sorts after it.
 */
export function laterSetters(config: BuiltConfig, key: string): string[] {
    const own = managedContributor(SUBSCRIPTIONS_LAYER);
    const contributors = config.layers(["subscriptions", key, "enabled"]).map((layer) => layer.contributor);
    const ownIndex = contributors.lastIndexOf(own);
    const later = contributors.filter(
        (contributor, index) => contributor !== own && (index > ownIndex && ownIndex !== -1 ? true : contributor.startsWith("confd/") && contributor > own),
    );

    return [...new Set(later)].map(contributorLabel);
}

// --- subscription.list ------------------------------------------------------------------------------

/** The cached index of a repository, or nothing when there is none or the repository is unknown. */
function safeCached<T>(cache: { cached(repo: string): T | undefined }, repo: string): T | undefined {
    try {
        return cache.cached(repo);
    } catch {
        return undefined;
    }
}

/** `subscription.list`: every subscription the config declares, switched-off ones included, with its pins. */
export async function listSubscriptions(input: BrowsingFlags, ctx: Context): Promise<SubscriptionListing[]> {
    const lock = ctx.services.get("recipes.lock").read();
    const configured = configuredSubscriptions(ctx.config);
    const cache = ctx.services.get("recipes.index-cache");
    const fresh = new Map<string, Awaited<ReturnType<typeof cache.get>> | undefined>();

    const indexOf = async (repo: string) => {
        if (!fresh.has(repo)) {
            try {
                fresh.set(repo, input.latest === true ? await readUpstream(ctx, repo) : cache.cached(repo));
            } catch {
                fresh.set(repo, safeCached(cache, repo));
            }
        }

        return fresh.get(repo);
    };

    const listings: SubscriptionListing[] = [];

    for (const key of sortBytewise(Object.keys(configured))) {
        const entry = configured[key]!;
        const pinned = keysHeldBySubscription(lock, key).map((held) => ({ key: held, version: lock.recipes[held]!.version }));
        const newer: Array<{ key: string; version: string }> = [];

        if (input.latest === true) {
            for (const pin of pinned) {
                const index = (await indexOf(lock.recipes[pin.key]!.repo))?.index;
                const versions = index?.recipes[pin.key]?.versions ?? {};
                const inRange = Object.fromEntries(
                    Object.entries(versions).filter(([version]) => semver.satisfies(version, entry.range ?? "*", { includePrerelease: entry.prerelease === true, loose: true })),
                );
                const best = latestVersion(inRange);

                if (best !== undefined && semver.valid(pin.version, { loose: true }) !== null && semver.gt(best, pin.version, { loose: true })) {
                    newer.push({ key: pin.key, version: best });
                }
            }
        }

        const latest: Array<{ key: string; version?: string }> = [];

        for (const pin of pinned) {
            const best = latestVersion((await indexOf(lock.recipes[pin.key]!.repo))?.index.recipes[pin.key]?.versions ?? {});

            latest.push({ key: pin.key, ...(best === undefined ? {} : { version: best }) });
        }

        listings.push({
            key,
            range: entry.range,
            enabled: entry.enabled !== false,
            addedBy: entry.addedBy,
            pinned,
            latest,
            ...(input.latest === true ? { newer } : {}),
        });
    }

    return listings;
}

// --- subscription.update ----------------------------------------------------------------------------

/** Reports the update plan before the update question. */
export function reportUpdatePlan(reporter: Reporter, plan: RecipeUpdatePlan): void {
    const scope = describeUpdateScope(plan.scope);

    if (isEmptyUpdate(plan)) {
        reporter.notice(`Nothing to update: every pin in ${scope} is already the newest published version its range allows.`);
    } else {
        reporter.list(plan.diff.unchanged ? ["No pin moves until the repositories below are trusted and read."] : describeDiff(plan.diff), { title: `Updating ${scope} changes the lockfile:` }, LogLevel.Notice);
    }

    if (plan.missingRepos.length > 0) {
        reporter.list(
            plan.missingRepos.map((missing) => `${missing.name}${missing.url === undefined ? "" : ` at ${missing.url}`}, needed by ${missing.requiredBy.map((entry) => entry.requestedBy).join(", ")}`),
            {
                title: `A newer version needs ${plan.missingRepos.length === 1 ? "a repository" : "repositories"} this project does not trust yet. You are asked about each one by name before anything is fetched from it:`,
            },
            LogLevel.Notice,
        );
    }

    if (plan.newVariables.length > 0 || plan.unreadable.length > 0) {
        const questions = plan.newVariables.map((variable) => `${variable.recipe} asks ${variable.definition.name}: answer it with --answer ${variable.definition.name}=<value>`);

        if (plan.unreadable.length > 0) {
            questions.push(
                `Not on this machine yet, and their repository's index does not record their questions, so they cannot be listed: ${plan.unreadable.join(", ")}. A dry run downloads nothing; run this command again without '--dry-run' to install them and be asked.`,
            );
        }

        reporter.list(questions, { title: "Questions the new versions ask that nothing answers yet:" }, LogLevel.Notice);
    }

    const notes: string[] = [];

    if (plan.unreadable.length > 0) {
        notes.push(`A dry run downloads no recipe, so the dependencies of the versions not on this machine yet, and not described by their index, are not shown: ${plan.unreadable.join(", ")}.`);
    }

    for (const entry of plan.unreachable) {
        notes.push(`The index of '${entry.repo}' could not be fetched, so its pins stay where they are. ${firstLine(entry.reason)}`);
    }

    for (const entry of plan.failed) {
        notes.push(`The subscription to '${entry.key}' could not be resolved, so its pins stay where they are. ${firstLine(entry.reason)}`);
    }

    for (const repo of plan.linked) {
        notes.push(`The repository '${repo}' is linked to a working copy, so builds keep reading that checkout until it is unlinked; the pins above take effect then.`);
    }

    for (const entry of plan.builtIn) {
        notes.push(
            `The subscription to '${entry.key}' is one sous provides itself, and it stays at ${entry.version === undefined ? "the version" : `version ${entry.version}, the version`} this installation of sous ships.`,
        );
    }

    if (plan.switchedOff.length > 0) {
        notes.push(`Switched off, so left alone: ${plan.switchedOff.join(", ")}.`);
    }

    if (notes.length > 0) {
        reporter.list(notes, {}, LogLevel.Notice);
    }
}

/** The first line of a message, trimmed. */
function firstLine(text: string): string {
    return (text.split("\n")[0] ?? "").trim();
}

/**
 * A lockfile change as lines, one per change, worded as the lockfile report words them.
 *
 * ```ts
 * describeDiff(diff); // -> ["Updating workflow/a from version 1.0.0 to version 1.1.0"]
 * ```
 */
export function describeDiff(diff: LockDiff): string[] {
    const byKey = (left: { key: string }, right: { key: string }) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);

    return [
        ...diff.reposAdded.map((name) => `Repository added: ${name}`),
        ...[...diff.added].sort(byKey).map((change) => `Adding ${change.key} version ${change.to}`),
        ...[...diff.updated].sort(byKey).map((change) => `Updating ${change.key} from version ${change.from} to version ${change.to}`),
        ...[...diff.removed].sort(byKey).map((change) => `Removing ${change.key}, which nothing needs any more`),
        ...diff.reposRemoved.map((name) => `Repository no longer needed: ${name}`),
    ];
}

/** The recipes a planned lockfile pins under some keys, in the shape downloading takes. */
function plannedRecipes(lockfile: Lockfile, keys: readonly string[]): ResolvedRecipe[] {
    return keys.flatMap((key) => {
        const entry = lockfile.recipes[key];
        const identity = entry === undefined ? undefined : lockfile.repos[entry.repo]?.identity;
        const slash = key.indexOf("/");

        if (entry === undefined || identity === undefined || slash < 0) {
            return [];
        }

        return [{ key, namespace: key.slice(0, slash), name: key.slice(slash + 1), repo: entry.repo, identity, version: entry.version, hash: entry.hash, tag: "", path: "", kind: entry.kind, requestedBy: entry.requestedBy, ranges: [], prerelease: false }];
    });
}

/** `subscription.update`: plans with `recipe.update`, asks once, trusts what a newer version needs, then writes the lockfile. */
export async function updateSubscriptions(input: SubscriptionUpdateInput, ctx: Context): Promise<SubscriptionUpdateResult> {
    const planInput: RecipeUpdateInput = { ...(input.ref === undefined ? {} : { ref: input.ref }), ...(input.acceptFirst === undefined ? {} : { acceptFirst: input.acceptFirst }) };
    let plan = await ctx.run("recipe.update", planInput);
    const base = { trusted: [] as string[], dryRun: input.dryRun === true };
    const tried = new Set<string>();

    // The index does not always say what a new version depends on: download those versions and plan
    // again, so their dependencies are in the plan. A dry run downloads nothing.
    while (input.dryRun !== true && (await downloadUnreadable(ctx, plannedRecipes(plan.lockfile, plan.unreadable), plan.unreadable, tried))) {
        plan = await planUpdate(planInput, ctx);
    }

    reportUpdatePlan(ctx.reporter, plan);

    if (isEmptyUpdate(plan)) {
        return { ...base, plan, applied: false, nothingToUpdate: true, followUps: [] };
    }

    if (input.dryRun === true) {
        return { ...base, plan, applied: false, nothingToUpdate: false, followUps: [{ intent: "vars.ask", skipped: "--dry-run" }, { intent: "build", skipped: "--dry-run" }] };
    }

    if (input.yes !== true) {
        const proceed = await ctx.prompter.confirm({ message: "Update the lockfile?", answeredBy: "--yes", default: true });

        if (!proceed) {
            throw new SousError("Nothing was written: the update was declined.");
        }
    }

    let current = ctx;

    for (let round = 0; plan.missingRepos.length > 0; round++) {
        if (round >= MAX_TRUST_ROUNDS) {
            throw new SousError(`The update kept turning up repositories to trust: ${plan.missingRepos.map((repo) => repo.name).join(", ")}.`);
        }

        const done = await current.services.get("recipes.trust").confirm(plan.missingRepos, { ...(input.yes === undefined ? {} : { yes: input.yes }) }, current);

        if (done.needUrl.length > 0) {
            throw needUrlError(done.needUrl);
        }

        base.trusted.push(...done.added);
        ctx.configChanged();
        current = await refreshed(ctx);
        plan = await planUpdate(planInput, current);

        while (await downloadUnreadable(current, plannedRecipes(plan.lockfile, plan.unreadable), plan.unreadable, tried)) {
            plan = await planUpdate(planInput, current);
        }
    }

    await writeLock(current, plan.lockfile);
    ctx.configChanged();
    await rebuild(current);

    const asking = sortBytewise(new Set(plan.newVariables.map((variable) => variable.recipe)));

    return {
        ...base,
        plan,
        applied: true,
        nothingToUpdate: false,
        followUps: [await askFollowUp(ctx, input, asking), await buildFollowUp(ctx, input)],
    };
}

/** Registers the subscription intents and `recipe.update`. */
export function registerSubscriptionIntents(sous: Sous): void {
    const ref = { type: "string", description: "A namespace or a recipe: 'namespace', 'namespace/recipe', either with '@<range>' or as 'repository:ref'" } as const;
    const toggleInput = inputSchema<SubscriptionToggleInput>({ ref, dryRun, noBuild }, ["ref"]);

    sous.intents.add({
        intent: "subscription.add",
        requiresProject: true,
        summary: "Subscribe this project to a recipe, or to a whole namespace of them",
        input: inputSchema<SubscriptionAddInput>(
            {
                ref,
                prerelease: { type: "boolean", description: "Let prerelease versions take part in range matching" },
                alwaysPull: { type: "boolean", description: "Install a newer in-range version whenever one exists" },
                yes,
                acceptFirst,
                dryRun,
                noBuild,
                answer,
                answersFile,
                installPlugins: { type: "boolean", description: "Install npm plugins the recipe requires" },
            },
            ["ref"],
        ),
        changesConfig: true,
        cli: {
            aliases: [["subscriptions", "add"], ["subscribe"]],
            positional: ["ref"],
            flags: { yes: yesFlag },
            examples: ["sous subscription add workflow/task-files", "sous subscription add workflow/task-files@^1.2.0 --yes --answer apiUrl=https://api.example.com"],
        },
        agent: { usage: "Run with --dry-run first to see what it installs and asks; pass --yes and --answer to subscribe without prompts." },
        handle: addSubscription,
    });

    sous.intents.add({
        intent: "subscription.remove",
        requiresProject: true,
        summary: "Remove a subscription and the recipes only it held",
        input: inputSchema<SubscriptionRemoveInput>({ ref, dryRun, noBuild }, ["ref"]),
        changesConfig: true,
        cli: { aliases: [["subscriptions", "remove"], ["unsubscribe"]], positional: ["ref"] },
        handle: removeSubscription,
    });

    sous.intents.add({
        intent: "subscription.enable",
        requiresProject: true,
        summary: "Switch a subscription back on, on this machine",
        input: toggleInput,
        changesConfig: true,
        cli: { aliases: [["subscriptions", "enable"]], positional: ["ref"] },
        handle: (input, ctx) => toggleSubscription(input, ctx, true),
    });

    sous.intents.add({
        intent: "subscription.disable",
        requiresProject: true,
        summary: "Switch a subscription off on this machine, keeping its pins",
        input: toggleInput,
        changesConfig: true,
        cli: { aliases: [["subscriptions", "disable"]], positional: ["ref"] },
        handle: (input, ctx) => toggleSubscription(input, ctx, false),
    });

    sous.intents.add({
        intent: "subscription.list",
        requiresProject: true,
        summary: "List what this project subscribes to",
        input: inputSchema<BrowsingFlags>(browsing),
        parallel: true,
        cli: { aliases: [["subscriptions", "list"]], flags: { latest: latestFlag } },
        handle: listSubscriptions,
    });

    sous.intents.add({
        intent: "subscription.update",
        requiresProject: true,
        summary: "Move pinned versions to the newest their ranges allow",
        input: inputSchema<SubscriptionUpdateInput>(
            { ref: { type: "string", description: "Only this repository, namespace or recipe" }, yes, acceptFirst, dryRun, noBuild, answer, answersFile },
        ),
        changesConfig: true,
        cli: { aliases: [["subscriptions", "update"]], positional: ["ref"], flags: { yes: yesFlag } },
        handle: updateSubscriptions,
    });

    sous.intents.add({
        intent: "recipe.update",
        requiresProject: true,
        summary: "Plan an update of pinned versions, writing nothing",
        input: inputSchema<RecipeUpdateInput>({ ref: { type: "string", description: "Only this repository, namespace or recipe" }, acceptFirst }),
        parallel: true,
        cli: { aliases: [["recipes", "update"]], positional: ["ref"] },
        handle: planUpdate,
    });
}
