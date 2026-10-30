/**
 * The lockfile (S6, `recipes.lock`): `.sous/sous.lock.json` records the exact version and content
 * hash of everything a project uses, so a fresh clone restores to the same bytes with no prompts.
 * Parsing never works out a repository identity (S6, "refs, formats and repos"); this service
 * fills in a missing one after parsing.
 */

import fs from "node:fs";
import path from "node:path";
import { ConfigError, NotFoundError, type ServiceContext } from "@sous-io/plugin-api";
import type { LockedRecipe, Lockfile } from "@sous-io/plugin-formats/types";
import type { LockDiff, RecipesLock, RepoEntry, ResolvedRecipe, RestoreReport, SubscriptionEntry } from "../../types.js";
import { LOCKFILE_NAME } from "../constants.js";
import { ensureInStore } from "../fetch/restore.js";
import type { PartBRuntime } from "../runtime.js";
import { messageOf, sortKeys, trustedWhileBuilding } from "../support.js";
import { applyResolution, diffLockfiles, emptyLockfile, lockedClosure, keysHeldBySubscription, removeHolder, sortRecipes, type LockRepoInput } from "./lockfile-ops.js";
import { plainSubscriptionKey, reachability } from "./reachable.js";

/** The repositories the project trusts now: `recipes.trust` when it exists, else the config. */
export function trustedRepos(ctx: Pick<ServiceContext, "services" | "config">): Record<string, RepoEntry> {
    if (ctx.services.has("recipes.trust")) {
        return ctx.services.get("recipes.trust").trusted();
    }

    return trustedWhileBuilding(ctx.config.get<Record<string, RepoEntry>>("repos"));
}

/** `recipes.lock`. */
export class LockService implements RecipesLock {
    constructor(
        private readonly ctx: ServiceContext,
        private readonly runtime: PartBRuntime,
    ) {}

    path(): string {
        const project = this.ctx.project;

        if (project === undefined) {
            throw new ConfigError("There is no sous project here, so there is no lockfile.", {
                details: ["Run 'sous init' to set one up, or run sous from inside a project."],
            });
        }

        return path.join(project.sousDir, LOCKFILE_NAME);
    }

    read(): Lockfile {
        const file = this.path();
        let text: string;

        try {
            text = fs.readFileSync(file, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return emptyLockfile();
            }

            throw new ConfigError(`Sous could not read the lockfile at ${file}.`, { details: [messageOf(error)] });
        }

        let parsed: unknown;

        try {
            parsed = JSON.parse(text);
        } catch (error) {
            throw new ConfigError(`Sous could not read the lockfile at ${file} as JSON.`, {
                details: [messageOf(error), "The lockfile is written by sous and committed with the project; restoring it from version control is usually the quickest fix."],
            });
        }

        return this.withIdentities(this.ctx.services.get("formats.lockfile").parse(parsed, file));
    }

    async write(lockfile: Lockfile, options: { dryRun?: boolean } = {}): Promise<LockDiff> {
        const before = this.read();
        const after = this.withIdentities({ ...lockfile, recipes: sortRecipes(lockfile.recipes) });
        const diff = this.diff(before, after);

        if (options.dryRun) {
            return diff;
        }

        const file = this.path();
        const temporary = path.join(path.dirname(file), `.${LOCKFILE_NAME}.tmp-${process.pid}`);

        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(temporary, this.ctx.services.get("formats.lockfile").stringify(after), "utf8");
            fs.renameSync(temporary, file);
        } catch (error) {
            fs.rmSync(temporary, { force: true });
            throw new ConfigError(`Sous could not write the lockfile at ${file}.`, { details: [messageOf(error)] });
        }

        await this.runtime.emit("recipes.locked", { path: file, diff });

        return diff;
    }

    diff(before: Lockfile, after: Lockfile): LockDiff {
        return diffLockfiles(before, after);
    }

    /**
     * The lockfile resolved recipes make. Entries reached from a switched-off subscription, or from
     * a repository switched off here, keep their pins (S4, 2), so one developer switching a recipe
     * off never removes it for the others.
     */
    fromResolved(resolved: readonly ResolvedRecipe[], previous: Lockfile = this.read()): Lockfile {
        const trusted = trustedRepos(this.ctx);
        const repos: Record<string, LockRepoInput> = {};

        for (const recipe of resolved) {
            const url = trusted[recipe.repo]?.url ?? previous.repos[recipe.repo]?.url;

            if (url !== undefined && repos[recipe.repo] === undefined) {
                const indexHash = this.indexHash(recipe.repo) ?? previous.repos[recipe.repo]?.indexHash;

                repos[recipe.repo] = { url, identity: recipe.identity, ...(indexHash === undefined ? {} : { indexHash }) };
            }
        }

        const fresh = applyResolution(emptyLockfile(), resolved, repos, (url) => this.runtime.tryIdentity(url));
        const kept = this.keptPins(previous, fresh);

        if (kept.length === 0) {
            return fresh;
        }

        const recipes: Record<string, LockedRecipe> = { ...fresh.recipes };
        const lockedRepos = { ...fresh.repos };

        for (const key of kept) {
            const entry = previous.recipes[key];

            recipes[key] = entry;
            lockedRepos[entry.repo] ??= previous.repos[entry.repo];
        }

        return { formatVersion: 1, repos: sortObject(lockedRepos), recipes: sortRecipes(recipes) };
    }

    /** Drops one holder, refcounted (used by unsubscribing and removing a repository). */
    removeHolder(lockfile: Lockfile, holder: string): Lockfile {
        return removeHolder(lockfile, holder, this.safePath());
    }

    async restore(options: { keys?: readonly string[]; signal?: AbortSignal } = {}): Promise<RestoreReport> {
        const lockfile = this.read();
        // By default only the pins in force here (S4, 3): a switched-off subscription keeps its pin
        // for the others, and this machine downloads nothing for it.
        const wanted =
            options.keys === undefined
                ? reachability({ lockfile, subscriptions: this.ctx.config.get("subscriptions"), repos: this.ctx.config.get("repos"), keyOf: (key) => this.keyOf(key) }).reached
                : options.keys.filter((key) => Object.hasOwn(lockfile.recipes, key));
        const trusted = trustedRepos(this.ctx);
        const restored: string[] = [];
        const alreadyPresent: string[] = [];
        const failed: Array<{ key: string; reason: string }> = [];
        const deps = {
            store: this.ctx.services.get("recipes.store"),
            cache: this.runtime.indexCore(),
            hosts: this.ctx.entities.list("repository-host"),
            context: this.runtime.hostContext(undefined, options.signal),
            freshnessSeconds: this.ctx.config.get<{ freshnessSeconds?: number }>("store")?.freshnessSeconds,
        };

        for (const key of sortKeys(wanted)) {
            const entry = lockfile.recipes[key];
            const repo = lockfile.repos[entry.repo];
            const identity = repo?.identity;

            if (repo === undefined || identity === undefined) {
                failed.push({ key, reason: `The lockfile does not say where the repository '${entry.repo}' lives.` });
                continue;
            }

            if (trusted[entry.repo] === undefined) {
                failed.push({ key, reason: `The repository '${entry.repo}' is not trusted in this project, so nothing is downloaded from it.` });
                continue;
            }

            try {
                const provider = trusted[entry.repo].provider;
                const outcome = await ensureInStore({ key, entry, repo: entry.repo, url: repo.url, identity, ...(provider === undefined ? {} : { provider }) }, deps);

                (outcome.downloaded ? restored : alreadyPresent).push(key);
            } catch (error) {
                failed.push({ key, reason: messageOf(error) });
            }
        }

        // What the config build downloaded a moment ago was restored too, just earlier.
        const fetched = options.keys === undefined ? this.runtime.takeFetched() : [];
        const earlier = alreadyPresent.filter((key) => fetched.includes(key));

        return { restored: sortKeys([...restored, ...earlier]), alreadyPresent: alreadyPresent.filter((key) => !fetched.includes(key)), failed };
    }

    get(key: string): LockedRecipe | undefined {
        return this.read().recipes[key];
    }

    /** The same as {@link get}, throwing when the key is not pinned. */
    require(key: string): LockedRecipe {
        const entry = this.get(key);

        if (entry === undefined) {
            throw new NotFoundError("pinned recipe", key, `The lockfile does not pin '${key}'.`);
        }

        return entry;
    }

    /** Pins the new lockfile lacks that the previous one keeps for switched-off subscriptions and repositories. */
    private keptPins(previous: Lockfile, fresh: Lockfile): string[] {
        const subscriptions = this.ctx.config.get<Record<string, SubscriptionEntry>>("subscriptions") ?? {};
        const repos = this.ctx.config.get<Record<string, RepoEntry>>("repos") ?? {};
        const roots: string[] = [];

        for (const [key, entry] of Object.entries(subscriptions)) {
            if (entry?.enabled === false) {
                roots.push(...keysHeldBySubscription(previous, this.keyOf(key)));
            }
        }

        for (const [key, entry] of Object.entries(previous.recipes)) {
            if (repos[entry.repo]?.enabled === false && entry.requestedBy.length > 0) {
                roots.push(key);
            }
        }

        return lockedClosure(previous, roots).filter((key) => !Object.hasOwn(fresh.recipes, key));
    }

    /** The stored key a subscription key names. */
    private keyOf(subscription: string): string {
        try {
            const format = this.ctx.services.get("refs.format");

            return format.key(format.parseNamedRef(subscription, "config"));
        } catch {
            return plainSubscriptionKey(subscription);
        }
    }

    /** The hash of the cached index a resolution in this repository used. */
    private indexHash(repo: string): Lockfile["repos"][string]["indexHash"] {
        const entry = trustedRepos(this.ctx)[repo];
        const identity = entry === undefined ? undefined : this.runtime.tryIdentity(entry.url);

        return identity === undefined ? undefined : this.runtime.indexCore().readMeta(identity)?.hash;
    }

    /** Fills in a missing identity from the URL. */
    private withIdentities(lockfile: Lockfile): Lockfile {
        let changed = false;
        const repos: Lockfile["repos"] = {};

        for (const [name, entry] of Object.entries(lockfile.repos)) {
            if (entry.identity === undefined) {
                const identity = this.runtime.tryIdentity(entry.url);

                if (identity !== undefined) {
                    repos[name] = { ...entry, identity };
                    changed = true;
                    continue;
                }
            }

            repos[name] = entry;
        }

        return changed ? { ...lockfile, repos } : lockfile;
    }

    private safePath(): string {
        try {
            return this.path();
        } catch {
            return "the lockfile";
        }
    }
}

/** A copy of an object with its keys sorted. */
function sortObject<T>(value: Record<string, T>): Record<string, T> {
    const sorted: Record<string, T> = {};

    for (const key of sortKeys(Object.keys(value))) {
        sorted[key] = value[key];
    }

    return sorted;
}
