/**
 * The index cache (S6, `recipes.index-cache`): one copy of each repository's `sous.index.json`
 * under `$SOUS_HOME/cache/_indexes/<identity>.json`, beside a sidecar recording when it was
 * fetched and checked. A failed upstream check never breaks a build: when a cached copy exists it
 * is used, marked `stale`.
 *
 * An overlay folds facts sous knows (the core recipe it ships) into every copy it hands out, never
 * into the file on disk, so the cached copy stays an honest record of what the repository served.
 *
 * {@link IndexCacheCore} is keyed by identity and needs no config, so the `recipes.fetch`
 * contributor uses it while the config is built; {@link IndexCacheService} is the contract, keyed
 * by the project's short names.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ConfigError, NotFoundError } from "@sous-io/plugin-api";
import type { ContentHash, IndexFile, WritableFormatParser } from "@sous-io/plugin-formats/types";
import type {
    CachedIndex,
    GetIndexOptions,
    IndexMeta,
    IndexReadFailure,
    RecipesIndexCache,
    RepoEntry,
    RepositoryHostContext,
    RepositoryHostEntity,
} from "../../types.js";
import { DEFAULT_FRESHNESS_SECONDS } from "../constants.js";
import { hostFor, identitySegments, messageOf } from "../support.js";
import { shouldCheckUpstream } from "./freshness.js";
import { IndexReadError, readThroughChain, StrategyMemoryFile } from "./read-chain.js";

/** The file every index is read from. */
export const INDEX_FILE_NAME = "sous.index.json";

/** The suffix of the sidecar beside each cached index. */
export const INDEX_SIDECAR_SUFFIX = ".meta.json";

/** A fact folded into every copy of an index the cache hands out. Must be pure. */
export type IndexOverlay = (identity: string, index: IndexFile) => IndexFile;

/** One repository, as the cache needs it. */
export interface IndexTarget {
    /** The project's short name. */
    readonly name: string;
    readonly url: string;
    readonly identity: string;
    /** The `repository-host` entity id, when the entry names one. */
    readonly provider?: string;
}

/** What the core is built from. */
export interface IndexCacheCoreOptions {
    /** The directory cached indexes live in (`host.sous-home` `indexCache`). */
    readonly directory: string;
    /** `read-strategies.json`. */
    readonly strategiesFile: string;
    readonly parser: WritableFormatParser<IndexFile>;
    /** The `repository-host` entities, read on every fetch. */
    readonly hosts: () => readonly RepositoryHostEntity[];
    /** What a host's methods get. */
    readonly hostContext: () => RepositoryHostContext;
    readonly now?: () => Date;
}

/** An index read, its sidecar, and whether it came from upstream. */
export type CacheLookup = CachedIndex & {
    /** Why upstream could not be read, when the copy is stale. */
    readonly problem?: string;
    readonly failure?: IndexReadFailure;
};

/** How the core is asked for an index. */
export interface CoreGetOptions extends GetIndexOptions {
    /** How long a check stays good. Default 300 seconds. */
    freshnessSeconds?: number;
    /** The hosts to read through, while the config is built and the engine's entities are not settled. */
    hosts?: readonly RepositoryHostEntity[];
}

/** The identity-keyed index cache. */
export class IndexCacheCore {
    private overlay: IndexOverlay | undefined;
    private readonly memory: StrategyMemoryFile;
    private readonly now: () => Date;

    constructor(private readonly options: IndexCacheCoreOptions) {
        this.memory = new StrategyMemoryFile(options.strategiesFile);
        this.now = options.now ?? (() => new Date());
    }

    /** The directory cached indexes live in. */
    get directory(): string {
        return this.options.directory;
    }

    /** Installs an overlay only when none is installed yet. */
    setOverlayIfNone(overlay: IndexOverlay): void {
        this.overlay ??= overlay;
    }

    /** Installs the overlay folded into every index handed out from now on. */
    setOverlay(overlay: IndexOverlay | undefined): void {
        this.overlay = overlay;
    }

    /** Where a repository's cached index is written: `_indexes/github.com/sous-io/sous-recipes.json`. */
    indexPath(identity: string): string {
        return this.fileFor(identity, ".json");
    }

    /** Where its sidecar is written. */
    sidecarPath(identity: string): string {
        return this.fileFor(identity, INDEX_SIDECAR_SUFFIX);
    }

    /** What sous remembers about a cached index, or `undefined`; a damaged sidecar costs only a refetch. */
    readMeta(identity: string): IndexMeta | undefined {
        try {
            const raw = JSON.parse(fs.readFileSync(this.sidecarPath(identity), "utf8")) as IndexMeta;

            return typeof raw?.fetchedAt === "string" ? raw : undefined;
        } catch {
            return undefined;
        }
    }

    /** Writes a sidecar. */
    writeMeta(identity: string, meta: IndexMeta): void {
        const file = this.sidecarPath(identity);

        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(sorted(meta), null, 4)}\n`, "utf8");
    }

    /** The cached index, overlaid, or `undefined` when none is cached or it no longer parses. */
    readCached(identity: string): IndexFile | undefined {
        const raw = this.readRaw(identity);

        return raw === undefined ? undefined : this.applyOverlay(identity, raw);
    }

    /** The cached index as written, with no overlay. */
    readRaw(identity: string): IndexFile | undefined {
        const file = this.indexPath(identity);
        let text: string;

        try {
            text = fs.readFileSync(file, "utf8");
        } catch {
            return undefined;
        }

        try {
            return this.options.parser.parse(JSON.parse(text), file);
        } catch {
            return undefined;
        }
    }

    /** Writes an index as a repository served it. Returns its hash. */
    writeIndex(identity: string, index: IndexFile): ContentHash {
        const file = this.indexPath(identity);
        const text = this.options.parser.stringify(index);

        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text, "utf8");

        return hashText(text);
    }

    /** Checks a parsed index, naming where it came from in any error. */
    parse(value: unknown, label: string): IndexFile {
        return this.options.parser.parse(value, label);
    }

    /** Whether the cached copy was checked within the window. */
    isFresh(identity: string, freshnessSeconds = DEFAULT_FRESHNESS_SECONDS): boolean {
        const meta = this.readMeta(identity);

        return meta !== undefined && !shouldCheckUpstream({ lastCheckedAt: meta.lastCheckedAt ?? meta.fetchedAt, freshnessSeconds, now: this.now() });
    }

    /**
     * A repository's index: the cached copy while fresh, otherwise a read upstream. When the read
     * fails and a copy is cached, the copy is returned as `stale`; when none is, the failure is thrown.
     */
    async get(target: IndexTarget, options: CoreGetOptions = {}): Promise<CacheLookup> {
        const meta = this.readMeta(target.identity);
        const cached = this.readCached(target.identity);

        if (options.offline) {
            if (cached === undefined) {
                throw new ConfigError(`The index of '${target.name}' has never been fetched on this machine, so it cannot be read without going upstream.`, {
                    details: [`Run the command without --installed, or run 'sous repo list --latest' once with a network.`],
                });
            }

            return { repo: target.name, index: cached, source: "cache", ...(meta ? { meta } : {}) };
        }

        if (!options.latest && cached !== undefined && this.isFresh(target.identity, options.freshnessSeconds)) {
            return { repo: target.name, index: cached, source: "cache", ...(meta ? { meta } : {}) };
        }

        try {
            return await this.refresh(target, options.signal, cached === undefined ? undefined : meta?.etag, options.hosts);
        } catch (error) {
            this.recordCheck(target, meta);

            if (cached === undefined) {
                throw error;
            }

            const fresh = this.readMeta(target.identity);

            return {
                repo: target.name,
                index: cached,
                source: "stale",
                ...(fresh ? { meta: fresh } : {}),
                problem: messageOf(error),
                ...(error instanceof IndexReadError ? { failure: error.failure } : {}),
            };
        }
    }

    /** Reads a repository's index upstream, writing nothing. Throws when it cannot. */
    async fetchUpstream(target: IndexTarget, signal?: AbortSignal): Promise<IndexFile> {
        const outcome = await this.readUpstream(target, signal, undefined, undefined);

        if ("notModified" in outcome) {
            throw new ConfigError(`'${target.name}' answered "not modified" to a request that sent no cached copy.`);
        }

        return this.applyOverlay(target.identity, outcome.index);
    }

    /** Forgets a repository's cached index and sidecar. */
    forget(identity: string): void {
        fs.rmSync(this.indexPath(identity), { force: true });
        fs.rmSync(this.sidecarPath(identity), { force: true });
    }

    /** Reads upstream and writes the result. */
    private async refresh(target: IndexTarget, signal: AbortSignal | undefined, etag: string | undefined, hosts: readonly RepositoryHostEntity[] | undefined): Promise<CacheLookup> {
        const outcome = await this.readUpstream(target, signal, etag, hosts);
        const timestamp = this.now().toISOString();
        const previous = this.readMeta(target.identity);

        if ("notModified" in outcome) {
            const index = this.readCached(target.identity) as IndexFile;
            const meta: IndexMeta = {
                fetchedAt: previous?.fetchedAt ?? timestamp,
                hash: previous?.hash ?? hashText(this.options.parser.stringify(index)),
                url: target.url,
                identity: target.identity,
                lastCheckedAt: timestamp,
                strategy: outcome.strategy,
                ...(outcome.etag ?? previous?.etag ? { etag: outcome.etag ?? previous?.etag } : {}),
            };

            this.writeMeta(target.identity, meta);

            return { repo: target.name, index, source: "cache", meta };
        }

        const hash = this.writeIndex(target.identity, outcome.index);
        const meta: IndexMeta = {
            url: target.url,
            identity: target.identity,
            fetchedAt: timestamp,
            lastCheckedAt: timestamp,
            hash,
            strategy: outcome.strategy,
            ...(outcome.etag === undefined ? {} : { etag: outcome.etag }),
        };

        this.writeMeta(target.identity, meta);

        return { repo: target.name, index: this.applyOverlay(target.identity, outcome.index), source: "network", meta };
    }

    /** Reads the index file through the host's strategies and parses it. */
    private async readUpstream(
        target: IndexTarget,
        signal: AbortSignal | undefined,
        etag: string | undefined,
        hosts: readonly RepositoryHostEntity[] | undefined,
    ): Promise<{ index: IndexFile; etag?: string; strategy: string } | { notModified: true; etag?: string; strategy: string }> {
        const host = hostFor(hosts ?? this.options.hosts(), target.url, target.provider);

        if (host === undefined) {
            throw new ConfigError(`No repository host reads '${target.url}', so the index of '${target.name}' cannot be fetched.`, {
                details: ["A host plugin (GitHub, GitLab, local) adds a 'repository-host' entity for the URLs it reads."],
            });
        }

        const context = this.options.hostContext();
        const outcome = await readThroughChain(
            {
                identity: target.identity,
                label: target.name,
                repository: host.canonicalize(target.url),
                host,
                path: INDEX_FILE_NAME,
                ...(etag === undefined ? {} : { etag }),
            },
            this.memory,
            signal === undefined ? context : { ...context, signal },
            this.now,
        );

        if ("notModified" in outcome) {
            return { notModified: true, strategy: outcome.strategy, ...(outcome.etag === undefined ? {} : { etag: outcome.etag }) };
        }

        let parsed: unknown;

        try {
            parsed = JSON.parse(outcome.text);
        } catch (error) {
            throw new ConfigError(`The index that ${target.url} published is not valid JSON.`, {
                details: [messageOf(error), "A repository's index is written by 'sous repo release'; this one may be damaged or may not be a sous repository at all."],
            });
        }

        return {
            index: this.options.parser.parse(parsed, `${target.url} (${outcome.ref})`),
            strategy: outcome.strategy,
            ...(outcome.etag === undefined ? {} : { etag: outcome.etag }),
        };
    }

    /** Records that upstream was asked, so an unreachable host is not retried on every build. */
    private recordCheck(target: IndexTarget, meta: IndexMeta | undefined): void {
        if (meta === undefined) {
            return;
        }

        try {
            this.writeMeta(target.identity, { ...meta, lastCheckedAt: this.now().toISOString() });
        } catch {
            // Recording the check only saves time.
        }
    }

    /** Folds the overlay in; an overlay that throws is ignored. */
    private applyOverlay(identity: string, index: IndexFile): IndexFile {
        if (this.overlay === undefined) {
            return index;
        }

        try {
            return this.overlay(identity, index);
        } catch {
            return index;
        }
    }

    private fileFor(identity: string, suffix: string): string {
        const segments = identitySegments(identity);
        const last = segments.pop() ?? "repository";

        return path.join(this.options.directory, ...segments, `${last}${suffix}`);
    }
}

/** The hash of a text, in the content-hash form. */
export function hashText(text: string): ContentHash {
    return `sha256-${createHash("sha256").update(text).digest("hex")}`;
}

/** What the service reads on every call: the config in force now. */
export interface IndexCacheServiceSource {
    /** The trusted, enabled repositories by short name. */
    trusted(): Record<string, RepoEntry>;
    /** A repository's identity from its URL. */
    identity(url: string): string;
    /** `store.freshnessSeconds`. */
    freshnessSeconds(): number;
    /** The checkout a repository is linked to, if any. */
    linkedPath?(repo: string): string | undefined;
}

/** `recipes.index-cache`: the cache keyed by the project's short names. */
export class IndexCacheService implements RecipesIndexCache {
    constructor(
        readonly core: IndexCacheCore,
        private readonly source: IndexCacheServiceSource,
    ) {}

    async get(repo: string, options: GetIndexOptions = {}): Promise<CacheLookup> {
        const linked = this.fromLink(repo);

        if (linked !== undefined) {
            return linked;
        }

        return this.core.get(this.target(repo), { ...options, freshnessSeconds: this.source.freshnessSeconds() });
    }

    async getAll(options: GetIndexOptions = {}): Promise<{ indexes: CachedIndex[]; failed: IndexReadFailure[] }> {
        const indexes: CachedIndex[] = [];
        const failed: IndexReadFailure[] = [];

        for (const name of Object.keys(this.source.trusted()).sort()) {
            try {
                indexes.push(await this.get(name, options));
            } catch (error) {
                failed.push(error instanceof IndexReadError ? { ...error.failure, repo: name } : { repo: name, attempts: [{ strategy: "read", reason: messageOf(error) }], fixes: [] });
            }
        }

        return { indexes, failed };
    }

    cached(repo: string): CachedIndex | undefined {
        const linked = this.fromLink(repo);

        if (linked !== undefined) {
            return linked;
        }

        const target = this.target(repo);
        const index = this.core.readCached(target.identity);
        const meta = this.core.readMeta(target.identity);

        return index === undefined ? undefined : { repo, index, source: "cache", ...(meta ? { meta } : {}) };
    }

    isFresh(repo: string): boolean {
        return this.core.isFresh(this.target(repo).identity, this.source.freshnessSeconds());
    }

    meta(repo: string): IndexMeta | undefined {
        return this.core.readMeta(this.target(repo).identity);
    }

    async forget(repo: string): Promise<void> {
        const entry = this.source.trusted()[repo];

        if (entry !== undefined) {
            this.core.forget(this.source.identity(entry.url));
        }
    }

    /** The index a linked checkout holds, when it holds one. */
    private fromLink(repo: string): CacheLookup | undefined {
        const checkout = this.source.linkedPath?.(repo);

        if (checkout === undefined) {
            return undefined;
        }

        const file = path.join(checkout, INDEX_FILE_NAME);

        try {
            const index = this.core.parse(JSON.parse(fs.readFileSync(file, "utf8")), file);

            return { repo, index, source: "link" };
        } catch {
            return undefined;
        }
    }

    private target(repo: string): IndexTarget {
        const entry = this.source.trusted()[repo];

        if (entry === undefined) {
            throw new NotFoundError("repository", repo, `This project does not trust a repository named '${repo}'.`, {
                details: ["Add it with 'sous repo add <url>'."],
            });
        }

        return {
            name: repo,
            url: entry.url,
            identity: this.source.identity(entry.url),
            ...(entry.provider === undefined ? {} : { provider: entry.provider }),
        };
    }
}

/** A copy of an object with its keys sorted. */
function sorted<T extends object>(value: T): T {
    const out: Record<string, unknown> = {};

    for (const key of Object.keys(value).sort()) {
        out[key] = (value as Record<string, unknown>)[key];
    }

    return out as T;
}
