/**
 * The subscription intents: `subscription.add`, `.remove`, `.enable`, `.disable`, `.list`,
 * `.update`, and `recipe.update`, which plans an update and writes nothing (ported from
 * `subscription-service.ts` and `src/commands/subscription/`).
 *
 * Subscribing asks nothing about variables itself: it subscribes, then runs `vars.ask` and `build`
 * through `ctx.run` (S6, "vars and repos"). `enable` and `disable` overwrite only `enabled` in
 * `conf.d/510-subscriptions.jsonc`, keeping every other field (S2). Sous always reads the merged
 * config, so a later layer that sets `enabled: false` switches a subscription off (S4, 4).
 */

import { SousError, type BuiltConfig, type Context, type Sous } from "@sous-io/plugin-api";
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
import { identityOf, loadCatalog, pickMatch, readingsOf, type CatalogContext } from "../catalog-context.js";
import { USER_ADDED_BY } from "../defaults.js";
import { askFollowUp, buildFollowUp } from "../followups.js";
import { applyResolution, keysHeldBySubscription, PROJECT_HOLDER, type LockRepoInput } from "../lock-holds.js";
import { configuredSubscriptions, contributorLabel, managedContributor, setSubscriptionEnabled, SUBSCRIPTIONS_LAYER, trustedRepos, writeSubscriptionEntry } from "../project.js";
import { isShortNamed, planSubscriptionRemoval, subscriptionKeyFor, writeSubscriptionRemoval } from "../subscriptions.js";
import { needUrlError } from "../trust.js";
import { describeUpdateScope, isEmptyUpdate, planUpdate } from "../update-plan.js";
import { describeError, nowIso, proposeRepoName, sortBytewise } from "../util.js";
import { acceptFirst, answer, answersFile, browsing, dryRun, inputSchema, latestFlag, noBuild, yes, yesFlag } from "./schema.js";

/** The most rounds of "resolve, trust what is missing, resolve again" one command runs. */
const MAX_TRUST_ROUNDS = 10;

/** A context whose config and services are a newer build's: after a managed file was written. */
export function withConfig(ctx: Context, config: BuiltConfig): Context {
    return { ...ctx, config, services: config.services, entities: config.entities };
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

/** Builds the config again from the files as they are now, which also downloads what is newly pinned. */
async function rebuild(ctx: Context): Promise<Context | undefined> {
    try {
        return withConfig(ctx, await ctx.engine.buildConfig());
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
        current = withConfig(ctx, await ctx.engine.buildConfig());
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
    });

    return match.ref.kind === "recipe" && written.kind === "recipe" && written.range !== undefined ? { ...match.ref, range: written.range } : match.ref;
}

/** The lines reported before the subscribe question: what subscribing does to this project. */
export function subscriptionPlan(key: string, ref: NamedRef): string[] {
    return [
        ref.kind === "namespace"
            ? `Subscribing to '${key}' subscribes this project to the whole namespace '${ref.name}': every recipe in it, including ones published later.`
            : `Subscribing to '${key}' installs the recipe '${ref.name}' from the namespace '${ref.namespace?.name ?? "?"}'.`,
        "The files it ships are compiled into this project's agent directories on the next build.",
        "Any scripts it ships can be run on this machine when an agent uses them. Sous does not run them itself, and cannot vouch for what they do.",
        "The variables it publishes are asked about afterwards, and the answers are written to this project's env files.",
        "Its dependencies are pinned in this project's lockfile at the versions resolved now. A dependency in a repository this project does not trust is asked about by name first.",
    ];
}

/** Resolves a ref and everything beneath it, trusting new repositories as often as resolution turns them up. */
async function resolveClosure(input: SubscriptionAddInput, ref: NamedRef, start: Context): Promise<{ resolved: ResolvedRecipe[]; unreadable: string[]; cycles: string[][]; trusted: string[]; ctx: Context }> {
    const trusted: string[] = [];
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
            ctx.reporter.note(`A dry run trusts nothing, so what ${sortBytewise(done.added).join(", ")} would add is not resolved.`);

            return { resolved: result.resolved, unreadable: result.unreadable, cycles: result.cycles, trusted, ctx };
        }

        ctx.configChanged();
        ctx = withConfig(ctx, await ctx.engine.buildConfig());
    }
}

/** `subscription.add`. */
export async function addSubscription(input: SubscriptionAddInput, ctx: Context): Promise<SubscriptionAddResult> {
    const written = await resolveWrittenRef(input, ctx);
    const format = ctx.services.get("refs.format");
    const key = format.key(written.ref);
    const canonical = format.format(written.ref);

    for (const line of subscriptionPlan(key, written.ref)) {
        ctx.reporter.note(line);
    }

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

    if (input.dryRun === true) {
        return { ...result, diff: lockService.diff(before, after), followUps: [{ intent: "vars.ask", skipped: "--dry-run" }, { intent: "build", skipped: "--dry-run" }] };
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

    const asking = closure.resolved.filter((recipe) => (recipe.variables ?? []).length > 0).map((recipe) => recipe.key);

    return { ...result, diff, followUps: [await askFollowUp(ctx, input, asking), await buildFollowUp(ctx, input)] };
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

    // A layer after 510 that sets `enabled` still wins: say so, and let it (L6).
    const later = laterSetters(ctx.config, key);

    if (later.length > 0) {
        ctx.reporter.warning(`${later[later.length - 1]} also sets subscriptions.${key}.enabled and is applied after conf.d/${SUBSCRIPTIONS_LAYER}, so its value still wins.`);
    }

    if (input.dryRun === true || !edit.changed) {
        return { key, enabled, file, changed, dryRun: input.dryRun === true, followUps: [{ intent: "build", skipped: input.dryRun === true ? "--dry-run" : "nothing changed" }] };
    }

    ctx.configChanged();

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

/** `subscription.list`: every subscription the config declares, switched-off ones included, with its pins. */
export async function listSubscriptions(input: BrowsingFlags, ctx: Context): Promise<SubscriptionListing[]> {
    const lock = ctx.services.get("recipes.lock").read();
    const configured = configuredSubscriptions(ctx.config);
    const cache = ctx.services.get("recipes.index-cache");
    const fresh = new Map<string, Awaited<ReturnType<typeof cache.get>> | undefined>();

    const indexOf = async (repo: string) => {
        if (!fresh.has(repo)) {
            try {
                fresh.set(repo, await cache.get(repo, { latest: true }));
            } catch {
                fresh.set(repo, cache.cached(repo));
            }
        }

        return fresh.get(repo);
    };

    const listings: SubscriptionListing[] = [];

    for (const key of sortBytewise(Object.keys(configured))) {
        const entry = configured[key]!;
        const pinned = keysHeldBySubscription(lock, key).map((held) => ({ key: held, version: lock.recipes[held]!.version }));
        const newer: Array<{ key: string; version: string }> = [];

        if (input.latest === true && input.installed !== true) {
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

        listings.push({
            key,
            range: entry.range,
            enabled: entry.enabled !== false,
            addedBy: entry.addedBy,
            pinned,
            ...(input.latest === true ? { newer } : {}),
        });
    }

    return listings;
}

// --- subscription.update ----------------------------------------------------------------------------

/** The lines reported before the update question. */
export function updatePlanLines(plan: RecipeUpdatePlan): string[] {
    const lines: string[] = [];

    if (isEmptyUpdate(plan)) {
        lines.push(`Nothing to update: every pin in ${describeUpdateScope(plan.scope)} is already the newest version its range allows.`);
    } else {
        lines.push(`Updating ${describeUpdateScope(plan.scope)} changes the lockfile:`);

        for (const change of plan.diff.updated) {
            lines.push(`  ${change.key}: ${change.from} → ${change.to}`);
        }

        for (const change of plan.diff.added) {
            lines.push(`  ${change.key}: added at ${change.to}`);
        }

        for (const change of plan.diff.removed) {
            lines.push(`  ${change.key}: removed (was ${change.from})`);
        }
    }

    for (const missing of plan.missingRepos) {
        lines.push(`A newer version needs ${missing.name}${missing.url === undefined ? "" : ` at ${missing.url}`}, which this project does not trust yet.`);
    }

    for (const variable of plan.newVariables) {
        lines.push(`${variable.recipe} asks a new question: ${variable.name}.`);
    }

    for (const entry of plan.unreachable) {
        lines.push(`The index of '${entry.repo}' could not be read, so its pins stay where they are. ${entry.reason.split("\n")[0]}`);
    }

    for (const entry of plan.failed) {
        lines.push(`The subscription to '${entry.key}' could not be resolved, so its pins stay where they are. ${entry.reason.split("\n")[0]}`);
    }

    for (const repo of plan.linked) {
        lines.push(`The repository '${repo}' is linked to a working copy, so builds keep reading that checkout until it is unlinked.`);
    }

    for (const entry of plan.builtIn) {
        lines.push(`The subscription to '${entry.key}' is one sous provides itself, and stays at ${entry.version ?? "the version"} this sous ships.`);
    }

    if (plan.switchedOff.length > 0) {
        lines.push(`Switched off, so left alone: ${plan.switchedOff.join(", ")}.`);
    }

    return lines;
}

/** `subscription.update`: plans with `recipe.update`, asks once, trusts what a newer version needs, then writes the lockfile. */
export async function updateSubscriptions(input: SubscriptionUpdateInput, ctx: Context): Promise<SubscriptionUpdateResult> {
    const planInput: RecipeUpdateInput = { ...(input.ref === undefined ? {} : { ref: input.ref }), ...(input.acceptFirst === undefined ? {} : { acceptFirst: input.acceptFirst }) };
    let plan = await ctx.run("recipe.update", planInput);
    const base = { trusted: [] as string[], dryRun: input.dryRun === true };

    for (const line of updatePlanLines(plan)) {
        ctx.reporter.note(line);
    }

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
        current = withConfig(ctx, await ctx.engine.buildConfig());
        plan = await planUpdate(planInput, current);
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
        summary: "Remove a subscription and the recipes only it held",
        input: inputSchema<SubscriptionRemoveInput>({ ref, dryRun, noBuild }, ["ref"]),
        changesConfig: true,
        cli: { aliases: [["subscriptions", "remove"], ["unsubscribe"]], positional: ["ref"] },
        handle: removeSubscription,
    });

    sous.intents.add({
        intent: "subscription.enable",
        summary: "Switch a subscription back on, on this machine",
        input: toggleInput,
        changesConfig: true,
        cli: { aliases: [["subscriptions", "enable"]], positional: ["ref"] },
        handle: (input, ctx) => toggleSubscription(input, ctx, true),
    });

    sous.intents.add({
        intent: "subscription.disable",
        summary: "Switch a subscription off on this machine, keeping its pins",
        input: toggleInput,
        changesConfig: true,
        cli: { aliases: [["subscriptions", "disable"]], positional: ["ref"] },
        handle: (input, ctx) => toggleSubscription(input, ctx, false),
    });

    sous.intents.add({
        intent: "subscription.list",
        summary: "List what this project subscribes to",
        input: inputSchema<BrowsingFlags>(browsing),
        parallel: true,
        cli: { aliases: [["subscriptions", "list"]], flags: { latest: latestFlag } },
        handle: listSubscriptions,
    });

    sous.intents.add({
        intent: "subscription.update",
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
        summary: "Plan an update of pinned versions, writing nothing",
        input: inputSchema<RecipeUpdateInput>({ ref: { type: "string", description: "Only this repository, namespace or recipe" }, acceptFirst }),
        parallel: true,
        cli: { aliases: [["recipes", "update"]], positional: ["ref"] },
        handle: planUpdate,
    });
}
