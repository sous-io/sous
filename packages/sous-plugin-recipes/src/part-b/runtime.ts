/**
 * What part B's code reaches through the engine, gathered in one place: the services of other
 * plugins, the `repository-host` entities, the index cache core and the context a host's methods
 * get. Contributors run while the config is built, when only singletons exist, so everything
 * here reaches singletons only.
 */

import type { BuiltConfig, EntityReader, Reporter, RunPlan, ServiceReader, Sous } from "@sous-io/sous-plugin-api";
import { nullReporter } from "@sous-io/sous-plugin-api";
import type {} from "@sous-io/sous-plugin-formats/types";
import type {} from "@sous-io/sous-plugin-git/types";
import type { SousHomePaths } from "@sous-io/sous-plugin-host/types";
import type {} from "@sous-io/sous-plugin-refs/types";
import type { RepositoryHostContext, RepositoryHostEntity, StoreSettings } from "../types.js";
import { DEFAULT_STRATEGY_MEMORY_SECONDS, RECIPES_PLUGIN } from "./constants.js";
import { IndexCacheCore } from "./index-cache/index-cache.js";
import { hostFor } from "./support.js";

/** The parts of `Sous` part B uses; tests hand in stand-ins. */
export type RuntimeHost = Pick<Sous, "services" | "entities" | "env" | "project" | "reporter" | "emit"> & {
    readonly engine: { readonly config: BuiltConfig };
};

/** Shared machinery for part B. */
export class PartBRuntime {
    private core: IndexCacheCore | undefined;
    private readonly fetched = new Set<string>();
    /** Set once an intent that needs recipe files runs: from then on, builds download what is missing. */
    private recipeFilesWanted = false;
    /** How many reached recipes the latest build left out, because their files were not on this machine. */
    private leftOut = 0;

    constructor(readonly host: RuntimeHost) {}

    /**
     * Records the recipes the `recipes.fetch` contributor downloaded while the config was built. No
     * event reaches a listener then, so the next `recipes.lock` restore reports them as restored,
     * which is how a build says what it fetched.
     */
    noteFetched(keys: readonly string[]): void {
        for (const key of keys) {
            this.fetched.add(key);
        }
    }

    /**
     * Whether a build may download recipe files: always, unless the front end said the command it
     * runs reads none (`RunPlan`), and no intent that reads them has run since.
     */
    downloadsRecipeFiles(plan: RunPlan | undefined): boolean {
        return this.recipeFilesWanted || plan === undefined || plan.intent?.needsRecipeFiles === true;
    }

    /** Records how many reached recipes the latest build left out for want of their files. */
    noteLeftOut(count: number): void {
        this.leftOut = count;
    }

    /** Whether the latest build left out recipes whose files are not on this machine. */
    leftOutRecipeFiles(): boolean {
        return this.leftOut > 0;
    }

    /** Lets every later build download the recipe files this machine lacks. */
    wantRecipeFiles(): void {
        this.recipeFilesWanted = true;
    }

    /**
     * The recipes downloaded while the config was built, or by a resolve that read their
     * manifests, and not reported yet; reading them forgets them. With `among`, only those labels
     * are read and forgotten.
     */
    takeFetched(among?: readonly string[]): string[] {
        const keys = [...this.fetched].filter((key) => among === undefined || among.includes(key));

        for (const key of keys) {
            this.fetched.delete(key);
        }

        return keys;
    }

    /** The services of every loaded plugin (singletons while the config is built). */
    get services(): ServiceReader {
        return this.host.services;
    }

    /** The entities. */
    get entities(): EntityReader {
        return this.host.entities;
    }

    /** Sous home's paths. */
    homePaths(): SousHomePaths {
        return this.services.get("host.sous-home").paths(this.host.env);
    }

    /** Every `repository-host` entity. */
    hosts(): RepositoryHostEntity[] {
        return this.entities.list("repository-host");
    }

    /** The canonical identity of a repository URL. */
    identity(url: string): string {
        return this.services.get("refs.locations").identity(url);
    }

    /**
     * The identity of a URL, or `undefined` when no host reads it. While the config is built,
     * `refs.locations` (a `config` service) does not exist yet, so the identity is read from the
     * host's canonical form, in the form `refs.locations` gives: `host/owner/name`, lowercased.
     */
    tryIdentity(url: string, hosts?: readonly RepositoryHostEntity[]): string | undefined {
        try {
            return this.identity(url);
        } catch {
            // Not available while building; fall through.
        }

        try {
            const host = hostFor(hosts ?? this.hosts(), url);

            if (host === undefined) {
                return undefined;
            }

            const canonical = host.canonicalize(url);

            return `${canonical.host}/${canonical.owner}/${canonical.name.replace(/\.git$/i, "")}`
                .split("/")
                .filter((segment) => segment.length > 0)
                .map((segment) => segment.toLowerCase())
                .join("/");
        } catch {
            return undefined;
        }
    }

    /** The one index cache core of this process. */
    indexCore(): IndexCacheCore {
        if (this.core === undefined) {
            const paths = this.homePaths();

            this.core = new IndexCacheCore({
                directory: paths.indexCache,
                strategiesFile: paths.readStrategies,
                parser: this.services.get("formats.index-file"),
                hosts: () => this.hosts(),
                // Reads report what the user should know (a refused token, a GitLab sub-path found).
                hostContext: () => this.hostContext(this.host.reporter),
                strategyMemorySeconds: () => this.host.engine.config.get<Partial<StoreSettings>>("store")?.strategyMemorySeconds ?? DEFAULT_STRATEGY_MEMORY_SECONDS,
            });
        }

        return this.core;
    }

    /** What a host's methods get. */
    hostContext(reporter: Reporter = nullReporter, signal?: AbortSignal): RepositoryHostContext {
        return {
            plugin: RECIPES_PLUGIN,
            config: this.host.engine.config,
            services: this.services,
            entities: this.entities,
            project: this.host.project,
            env: this.host.env,
            // `Sous` carries no working directory; a host method only runs commands in it.
            cwd: this.host.project?.root ?? process.cwd(),
            reporter,
            ...(signal === undefined ? {} : { signal }),
        };
    }

    /** Fires an event, never failing the caller over a listener. */
    async emit(name: string, payload: unknown): Promise<void> {
        try {
            await this.host.emit(name, payload as never);
        } catch {
            // A listener's failure is the listener's to report.
        }
    }
}
