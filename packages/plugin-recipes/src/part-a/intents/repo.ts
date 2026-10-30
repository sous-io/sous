/**
 * The repository intents part A owns: `repo.add`, `repo.remove`, `repo.trust`, `repo.list`
 * and `repo.search` (ported from `subscription-service.ts` and `src/commands/repo/`).
 *
 * Adding a repository trusts it, and nothing is fetched from it before that. Removing one is
 * informed consent: everything that goes is reported first, then one question is asked, which
 * `--yes` answers ahead of time (L4).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigError, SousError, type Context, type Sous } from "@sous-io/plugin-api";
import type { Lockfile } from "@sous-io/plugin-formats/types";
import type { VariableRef } from "@sous-io/plugin-refs/types";
import type {
    RepoAddInput,
    RepoAddResult,
    RepoListInput,
    RepoListing,
    RepoRemoveInput,
    RepoRemoveResult,
    RepoSearchInput,
    RepoTrustInput,
    RepoTrustResult,
    SearchMatch,
} from "../../types.js";
import { latestVersion, publishedNamespaceRef, publishedRecipeRef, splitRecipeKey } from "../catalog.js";
import { identityOf, loadCatalog } from "../catalog-context.js";
import { isBuiltInEntry, USER_ADDED_BY } from "../defaults.js";
import { buildFollowUp } from "../followups.js";
import { keysHeldBySubscription, stayedAfter } from "../lock-holds.js";
import { configuredRepos, configuredSubscriptions, deleteRepoEntry, managedEntries, REPOS_LAYER, SUBSCRIPTIONS_LAYER, writeRepoEntry } from "../project.js";
import { planSubscriptionRemoval, writeSubscriptionRemoval } from "../subscriptions.js";
import { describeError, nowIso, proposeRepoName, REPO_NAME_PATTERN, sortBytewise } from "../util.js";
import { dryRun, inputSchema, latest, latestFlag, installed, noBuild, yes, yesFlag, yesFlagNoTrust } from "./schema.js";

/** The hosts built in for `--provider`; any loaded `repository-host` entity's id is accepted too. */
export const BUILT_IN_PROVIDERS = ["github", "gitlab", "local"] as const;

/** Whether what was typed is a path on this machine rather than a URL. */
export function looksLikeLocalPath(typed: string): boolean {
    return typed.startsWith("/") || typed.startsWith("./") || typed.startsWith("../") || typed === "." || typed === ".." || typed.startsWith("~");
}

/** A typed path made absolute: `~` expanded, a relative path resolved against `base`. */
export function resolveLocalPath(typed: string, base: string, home: string | undefined): string {
    const expanded = typed === "~" || typed.startsWith("~/") ? path.join(home ?? os.homedir(), typed.slice(1)) : typed;

    return path.resolve(base, expanded);
}

// --- repo.add -------------------------------------------------------------------------------------

/** `repo.add`: trusts a repository, then reads exactly one file from it, its index. */
export async function addRepo(input: RepoAddInput, ctx: Context): Promise<RepoAddResult> {
    const locations = ctx.services.get("refs.locations");
    const typed = input.url.trim();
    let url = typed;

    if (looksLikeLocalPath(typed)) {
        url = resolveLocalPath(typed, ctx.cwd ?? ctx.project?.root ?? ".", ctx.env.HOME);

        // The host that reads the path explains a path mistake (plugin-local: nothing there, a
        // file, no repository manifest); without one, sous checks only that it is a directory.
        const id = input.provider ?? locations.hostFor(url)?.id;
        const host = ctx.entities.list("repository-host").find((entry) => entry.id === id);

        if (host?.checkTypedPath !== undefined) {
            await host.checkTypedPath(typed, url, ctx);
        } else if (!fs.existsSync(url) || !fs.statSync(url).isDirectory()) {
            throw new SousError(`'${typed}' is not a directory on this machine, so it cannot be added as a repository.`, {
                details: [`Sous looked at ${url}.`],
            });
        }
    }

    if (input.provider !== undefined && locations.host(input.provider) === undefined) {
        throw new SousError(`'${input.provider}' is not a repository host sous knows.`, {
            details: [`The hosts loaded now: ${sortBytewise(locations.hosts().map((host) => host.id)).join(", ") || "none"}. A plugin can add another.`],
        });
    }

    const canonical = locations.canonicalize(url, input.provider);
    const provider = input.provider ?? locations.hostFor(url)?.id ?? "unknown";
    const name = input.name ?? canonical.name.toLowerCase();

    if (!REPO_NAME_PATTERN.test(name)) {
        throw new SousError(`'${name}' is not a usable short name for a repository.`, {
            details: [
                "A short name is lowercase kebab case: a letter, then letters, digits or hyphens. Refs use it as the 'repo:' qualifier.",
                `Choose one with --name, for example 'sous repo add ${typed} --name my-recipes'.`,
            ],
        });
    }

    const existing = configuredRepos(ctx.config)[name];
    const wanted = locations.identityOf(canonical);
    const sameRepository = existing !== undefined && identityOf(ctx, existing.url) === wanted;
    const alreadyTrusted = sameRepository && existing.enabled !== false;

    if (existing !== undefined && !sameRepository) {
        throw new SousError(`This project already has a repository called '${name}', and it is a different one.`, {
            details: [`Already added: ${existing.url}`, `Being added:   ${url}`, `Give this one a name of its own with --name, for example --name ${name}-2.`],
        });
    }

    const result = { name, url, provider, alreadyTrusted, namespaces: [] as string[], recipeCount: 0, dryRun: input.dryRun === true };

    if (input.dryRun === true) {
        return result;
    }

    // Trust first, fetch second: this is the last gate before its recipes can put files on this machine.
    if (!alreadyTrusted) {
        await ctx.services.get("recipes.trust").confirm(
            [{ name, url, identity: wanted, provider, requiredBy: [{ ref: name, requestedBy: "project" }] }],
            { ...(input.yes === undefined ? {} : { yes: input.yes }) },
            ctx,
        );
    }

    // Written again, so the entry records that a person added it on purpose.
    await writeRepoEntry(ctx.services.get("confd.managed"), name, {
        url,
        ...(input.provider === undefined ? {} : { provider: input.provider }),
        addedAt: nowIso(),
        addedBy: USER_ADDED_BY,
    });
    ctx.configChanged();

    try {
        // The running config predates the entry, so it is rebuilt from the files as they are now, for the rest of this chain.
        const fresh = await ctx.refreshConfig();
        const cached = await fresh.services.get("recipes.index-cache").get(name, { latest: true });

        result.namespaces = sortBytewise(Object.keys(cached.index.namespaces));
        result.recipeCount = Object.keys(cached.index.recipes).length;
    } catch (error) {
        ctx.reporter.warning(`Trusted ${name}, but its index could not be read yet: ${describeError(error)}`);
    }

    return result;
}

// --- repo.remove ----------------------------------------------------------------------------------

/** The subscriptions that resolve into one repository, split by whether sous may remove them. */
async function subscriptionsInto(ctx: Context, name: string, lock: Lockfile): Promise<{ removable: string[]; kept: string[] }> {
    const fromRepo = new Set(Object.entries(lock.recipes).filter(([, recipe]) => recipe.repo === name).map(([key]) => key));
    const subscriptions = configuredSubscriptions(ctx.config);
    const managed = await managedEntries(ctx.services.get("confd.managed"), SUBSCRIPTIONS_LAYER, "subscriptions");
    const format = ctx.services.get("refs.format");
    const removable: string[] = [];
    const kept: string[] = [];

    for (const key of sortBytewise(Object.keys(subscriptions))) {
        if (subscriptions[key]?.enabled === false) {
            continue;
        }

        let qualifier: string | undefined;

        try {
            qualifier = format.partsOf(format.parseNamedRef(key, "config")).repo?.name;
        } catch {
            continue;
        }

        if (qualifier !== name && !keysHeldBySubscription(lock, key).some((held) => fromRepo.has(held))) {
            continue;
        }

        if (Object.hasOwn(managed, key) || isBuiltInEntry(subscriptions[key])) {
            removable.push(key);
        } else {
            kept.push(key);
        }
    }

    return { removable, kept };
}

/** The lines reported before the question: everything that goes with the repository. */
export function removalPlan(result: Omit<RepoRemoveResult, "followUps">): string[] {
    const lines = [
        result.optedOut
            ? `The repository '${result.name}' at ${result.url} is one sous provides itself, so it is switched off instead, by recording '${result.name}: { enabled: false }' in conf.d/500-repos.jsonc.`
            : `The entry for '${result.name}' at ${result.url} is removed from conf.d/500-repos.jsonc, so sous stops reading anything from it.`,
    ];

    lines.push(
        result.subscriptions.length === 0
            ? "Nothing this project subscribes to resolves into it."
            : `${result.subscriptions.length === 1 ? "One subscription resolves into it and is" : `${result.subscriptions.length} subscriptions resolve into it and are`} removed: ${result.subscriptions.join(", ")}.`,
    );

    if (result.removedRecipes.length > 0) {
        lines.push(`These locked recipes were held only through those subscriptions and leave the lockfile: ${result.removedRecipes.join(", ")}.`);
    }

    for (const stayed of result.stayed) {
        lines.push(`The recipe '${stayed.key}' stays, because ${stayed.heldBy.join(", ")} still holds it.`);
    }

    if (result.outputs.length > 0) {
        lines.push(`Removing ${result.name} deletes ${result.outputs.length} built ${result.outputs.length === 1 ? "file" : "files"} on the next build:`, ...result.outputs.map((file) => `  ${file}`));
    }

    if (result.linkedPath !== undefined) {
        lines.push(
            result.linkIsGlobal
                ? `A machine-wide link points this repository at ${result.linkedPath}. Other projects share it, so it is left as it is.`
                : `This project links the repository to ${result.linkedPath}. The link is removed; the checkout stays on disk.`,
        );
    }

    for (const key of result.keptSubscriptions) {
        lines.push(`The subscription to '${key}' resolves into it and is written in this project's own config, which sous never edits, so it stays.`);
    }

    return lines;
}

/** `repo.remove`: stops trusting a repository, removing the subscriptions that resolve into it. */
export async function removeRepo(input: RepoRemoveInput, ctx: Context): Promise<RepoRemoveResult> {
    const name = input.repo;
    const trusted = ctx.services.get("recipes.trust").trusted();
    const entry = trusted[name];

    if (entry === undefined) {
        const known = sortBytewise(Object.keys(trusted));

        throw new SousError(`This project does not trust a repository called '${name}'.`, {
            details: [known.length > 0 ? `It trusts: ${known.join(", ")}.` : "It trusts no repositories yet."],
        });
    }

    const managedRepos = await managedEntries(ctx.services.get("confd.managed"), REPOS_LAYER, "repos");
    const builtIn = !Object.hasOwn(managedRepos, name) && isBuiltInEntry(entry);

    if (!Object.hasOwn(managedRepos, name) && !builtIn) {
        throw new SousError(`The repository '${name}' is written in one of this project's own config files, not in the file sous manages.`, {
            details: ["Remove its entry from the 'repos' block of that file; sous never deletes what you wrote."],
        });
    }

    const lockService = ctx.services.get("recipes.lock");
    const before = lockService.read();
    const { removable, kept } = await subscriptionsInto(ctx, name, before);
    const removals = [];
    let after = before;
    const held: string[] = [];

    for (const key of removable) {
        const removal = await planSubscriptionRemoval(ctx, key, after);

        held.push(...keysHeldBySubscription(after, key));
        after = removal.after;
        removals.push(removal);
    }

    const diff = lockService.diff(before, after);
    const outputs = ctx.services.has("compiler.state")
        ? sortBytewise(new Set(ctx.services.get("compiler.state").filesFrom({ repository: name }).map((file) => file.dest)))
        : [];
    const link = ctx.services.has("recipes.links") ? ctx.services.get("recipes.links").get(name) : undefined;
    const planned = {
        name,
        url: entry.url,
        optedOut: builtIn,
        subscriptions: removable,
        keptSubscriptions: kept,
        removedRecipes: diff.removed.map((change) => change.key),
        stayed: stayedAfter(after, held),
        outputs,
        diff,
        ...(link === undefined ? {} : { linkedPath: link.path }),
        linkIsGlobal: link?.scope === "global",
        dryRun: input.dryRun === true,
    };

    for (const line of removalPlan(planned)) {
        ctx.reporter.note(line);
    }

    if (input.dryRun === true) {
        return { ...planned, followUps: [{ intent: "build", skipped: "--dry-run" }] };
    }

    if (input.yes !== true) {
        const proceed = await ctx.prompter.confirm({ message: `Stop trusting '${name}'?`, answeredBy: "--yes", default: false });

        if (!proceed) {
            throw new SousError(`Nothing was written: the repository '${name}' is still trusted.`);
        }
    }

    for (const removal of removals) {
        await writeSubscriptionRemoval(ctx, removal);
    }

    const written = await lockService.write(after);

    if (link !== undefined && link.scope === "project") {
        await ctx.services.get("recipes.links").remove(name, "project");
    }

    const managed = ctx.services.get("confd.managed");

    if (builtIn) {
        await writeRepoEntry(managed, name, { enabled: false });
    } else {
        await deleteRepoEntry(managed, name);
    }

    ctx.configChanged();

    return { ...planned, diff: written, followUps: [await buildFollowUp(ctx, input)] };
}

// --- repo.trust -----------------------------------------------------------------------------------

/** `repo.trust`: trusts a repository by name, URL or identity, or switches a switched-off one back on. */
export async function trustRepo(input: RepoTrustInput, ctx: Context): Promise<RepoTrustResult> {
    const trust = ctx.services.get("recipes.trust");
    const already = trust.nameOf(input.repo);
    const dry = input.dryRun === true;

    if (already !== undefined) {
        return { name: already, url: trust.trusted()[already]!.url, trusted: true, alreadyTrusted: true, dryRun: dry };
    }

    const configured = configuredRepos(ctx.config);
    const off = configured[input.repo];

    if (off !== undefined && off.enabled === false && input.url === undefined) {
        // Naming a switched-off repository in `repo trust` is the consent; nothing else is asked.
        if (!dry) {
            await ctx.services.get("confd.managed").edit(REPOS_LAYER, (root) => root.atPath(["repos", input.repo, "enabled"]).set(true));
            ctx.configChanged();
        }

        return { name: input.repo, url: off.url, trusted: !dry, alreadyTrusted: false, dryRun: dry };
    }

    const url = input.url ?? (REPO_NAME_PATTERN.test(input.repo) ? undefined : input.repo);

    if (url === undefined) {
        throw new ConfigError(`Sous does not know where the repository '${input.repo}' lives.`, {
            details: [`Pass its URL: 'sous repo trust ${input.repo} --url <url>', or add it with 'sous repo add <url> --name ${input.repo}'.`],
        });
    }

    const identity = identityOf(ctx, url);
    const name = REPO_NAME_PATTERN.test(input.repo) ? input.repo : proposeRepoName(Object.keys(configured), identity ?? url);
    const provider = ctx.services.get("refs.locations").hostFor(url)?.id;
    const done = await trust.confirm(
        [{ name, url, ...(identity === undefined ? {} : { identity }), ...(provider === undefined ? {} : { provider }), requiredBy: [{ ref: input.repo, requestedBy: "project" }] }],
        { ...(input.yes === undefined ? {} : { yes: input.yes }), dryRun: dry },
        ctx,
    );

    if (!dry) {
        ctx.configChanged();
    }

    return { name, url, trusted: done.added.includes(name) && !dry, alreadyTrusted: false, dryRun: dry };
}

// --- repo.list ------------------------------------------------------------------------------------

/** `repo.list`: every repository the config names, switched-off ones included. */
export async function listRepos(input: RepoListInput, ctx: Context): Promise<RepoListing[]> {
    const cache = ctx.services.get("recipes.index-cache");
    const links = ctx.services.has("recipes.links") ? ctx.services.get("recipes.links").all() : {};
    const locations = ctx.services.get("refs.locations");
    const listings: RepoListing[] = [];

    for (const [name, entry] of Object.entries(configuredRepos(ctx.config))) {
        const enabled = entry.enabled !== false;
        let problem: string | undefined;
        let cached = cache.cached(name);

        if (enabled && input.latest === true && input.installed !== true) {
            try {
                cached = await cache.get(name, { latest: true });
            } catch (error) {
                problem = describeError(error);
                cached = cache.cached(name);
            }
        }

        let provider = entry.provider;

        try {
            provider ??= locations.hostFor(entry.url)?.id;
        } catch {
            // A URL no host reads is still listed; its problem shows when anything reads it.
        }

        listings.push({
            name,
            url: entry.url,
            provider: provider ?? "unknown",
            enabled,
            alwaysPull: entry.alwaysPull === true,
            ...(entry.addedBy === undefined ? {} : { addedBy: entry.addedBy }),
            ...(entry.addedAt === undefined ? {} : { addedAt: entry.addedAt }),
            ...(cached === undefined
                ? {}
                : {
                      namespaces: sortBytewise(Object.keys(cached.index.namespaces)),
                      recipeCount: Object.keys(cached.index.recipes).length,
                      indexSource: cached.source,
                      ...(cached.meta?.lastCheckedAt === undefined ? {} : { lastCheckedAt: cached.meta.lastCheckedAt }),
                  }),
            ...(links[name] === undefined ? {} : { linkedPath: links[name]!.path }),
            ...(problem === undefined ? {} : { problem }),
        });
    }

    const repos = configuredRepos(ctx.config);

    return listings.sort(
        (left, right) => Number(isBuiltInEntry(repos[right.name])) - Number(isBuiltInEntry(repos[left.name])) || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
    );
}

// --- repo.search ----------------------------------------------------------------------------------

/** How well a text matches a name: exact 100, prefix 75, inside 50; in a description 20; else 0. */
export function matchScore(text: string, name: string, description?: string): number {
    const wanted = text.toLowerCase();
    const candidate = name.toLowerCase();

    if (candidate === wanted) {
        return 100;
    }

    if (candidate.startsWith(wanted)) {
        return 75;
    }

    if (candidate.includes(wanted)) {
        return 50;
    }

    return description?.toLowerCase().includes(wanted) === true ? 20 : 0;
}

/** `repo.search`: namespaces, recipes and variables whose name or description holds the text. */
export async function searchRepos(input: RepoSearchInput, ctx: Context): Promise<SearchMatch[]> {
    const catalog = await loadCatalog(ctx, input);
    const matches: SearchMatch[] = [];

    for (const repo of catalog.inputs.repos) {
        for (const [namespace, declared] of Object.entries(repo.index.namespaces)) {
            const score = matchScore(input.text, namespace, declared.description);

            if (score > 0) {
                matches.push({ ref: publishedNamespaceRef(repo, namespace), key: namespace, kind: "namespace", repo: repo.name, ...(declared.description === undefined ? {} : { description: declared.description }), score });
            }
        }

        for (const [key, recipe] of Object.entries(repo.index.recipes)) {
            const score = Math.max(matchScore(input.text, splitRecipeKey(key).name, recipe.description), matchScore(input.text, key));

            if (score > 0) {
                matches.push({ ref: publishedRecipeRef(repo, key), key, kind: "recipe", repo: repo.name, ...(recipe.description === undefined ? {} : { description: recipe.description }), score });
            }

            const version = latestVersion(recipe.versions);

            for (const variable of (version === undefined ? undefined : recipe.versions[version]?.variables) ?? []) {
                const variableScore = matchScore(input.text, variable.name, variable.description);

                if (variableScore > 0) {
                    const ref: VariableRef = { kind: "variable", name: variable.name, recipe: publishedRecipeRef(repo, key), description: variable.description };

                    matches.push({ ref, key: `${key}.${variable.name}`, kind: "variable", repo: repo.name, description: variable.description, score: variableScore - 5 });
                }
            }
        }
    }

    return matches.sort((left, right) => right.score - left.score || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)).slice(0, input.limit ?? 20);
}

/** Registers the repository intents. */
export function registerRepoIntents(sous: Sous): void {
    sous.intents.add({
        intent: "repo.add",
        summary: "Add a recipe repository, which trusts it",
        input: inputSchema<RepoAddInput>(
            {
                url: { type: "string", description: "The repository's URL, or a path on this machine" },
                name: { type: "string", description: "The short name refs use for it; default from the URL" },
                provider: {
                    type: "string",
                    minLength: 1,
                    description: `The repository host, when the URL does not give it away: ${BUILT_IN_PROVIDERS.join(", ")}, or any host a plugin adds`,
                },
                yes,
                dryRun,
            },
            ["url"],
        ),
        changesConfig: true,
        cli: { aliases: [["repos", "add"]], positional: ["url"], flags: { yes: yesFlag } },
        handle: addRepo,
    });

    sous.intents.add({
        intent: "repo.remove",
        summary: "Stop trusting a repository, removing the subscriptions that resolve into it",
        input: inputSchema<RepoRemoveInput>({ repo: { type: "string", description: "The repository's short name" }, yes, dryRun, noBuild }, ["repo"]),
        changesConfig: true,
        cli: { aliases: [["repos", "remove"]], positional: ["repo"], flags: { yes: yesFlagNoTrust } },
        handle: removeRepo,
    });

    sous.intents.add({
        intent: "repo.trust",
        summary: "Trust a repository by name, URL or identity",
        input: inputSchema<RepoTrustInput>(
            { repo: { type: "string", description: "A short name, URL or identity" }, url: { type: "string", description: "Its URL, when the name has none recorded" }, yes, dryRun },
            ["repo"],
        ),
        changesConfig: true,
        cli: { aliases: [["repos", "trust"]], positional: ["repo"], flags: { yes: yesFlag } },
        handle: trustRepo,
    });

    sous.intents.add({
        intent: "repo.list",
        summary: "List the repositories this project trusts",
        input: inputSchema<RepoListInput>({ latest, installed, verbose: { type: "boolean", description: "Show more about each repository" } }),
        parallel: true,
        cli: { aliases: [["repos", "list"]], flags: { latest: latestFlag } },
        handle: listRepos,
    });

    sous.intents.add({
        intent: "repo.search",
        summary: "Search the trusted repositories for namespaces, recipes and variables",
        input: inputSchema<RepoSearchInput>(
            { text: { type: "string", description: "What to look for" }, latest, installed, limit: { type: "integer", description: "At most this many matches (default 20)" } },
            ["text"],
        ),
        parallel: true,
        cli: { aliases: [["search"], ["repos", "search"]], positional: ["text"], flags: { latest: latestFlag } },
        handle: searchRepos,
    });
}
