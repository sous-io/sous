/**
 * Reading one file from a repository: each read strategy of
 * the repository's host in order, a token tried when a token source finds one, the strategy that
 * worked remembered per repository, and one error listing every attempt when all fail.
 */

import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "@sous-io/sous-plugin-api";
import type { CanonicalRepository } from "@sous-io/sous-plugin-refs/types";
import type {
    IndexReadFailure,
    RepositoryHostContext,
    RepositoryHostEntity,
    RepositoryReadOutcome,
    RepositoryReadStrategy,
    RepositoryToken,
    RepositoryTokenSource,
} from "../../types.js";
import { DEFAULT_STRATEGY_MEMORY_SECONDS } from "../constants.js";
import { messageOf } from "../support.js";

export { DEFAULT_STRATEGY_MEMORY_SECONDS };

/** What sous remembers about reading one repository (`read-strategies.json`). */
export interface RememberedStrategy {
    strategy: string;
    tokenSource: string | null;
    lastSuccess: string;
    lastDurationMs: number;
    /**
     * When this strategy became the one tried first. It stays first until `store.strategyMemorySeconds`
     * after this, however often it works since; then the better-ranked ones are tried first again.
     */
    since?: string;
}

/** What sous remembers about downloading one repository's recipes: the clone URL that worked. */
export interface RememberedDownload {
    url: string;
    lastSuccess: string;
    /** When this URL became the one tried first; it stays first as long as a read strategy does. */
    since: string;
}

/** Everything remembered about one repository: how its index was read, and how its recipes were downloaded. */
export type RememberedRepository = Partial<RememberedStrategy> & { download?: RememberedDownload };

/** The remembered strategies, by repository identity. */
export type StrategyMemory = Record<string, RememberedRepository>;

/**
 * Whether a choice remembered `since` then still goes first `now`.
 *
 * ```ts
 * stillFirst("2026-11-01T00:00:00Z", new Date("2026-11-05T00:00:00Z"), 7 * 86400); // true
 * stillFirst("2026-11-01T00:00:00Z", new Date("2026-11-09T00:00:00Z"), 7 * 86400); // false
 * stillFirst(undefined, new Date(), 7 * 86400);                                     // false
 * ```
 */
export function stillFirst(since: string | undefined, now: Date, memorySeconds: number): boolean {
    const at = since === undefined ? Number.NaN : Date.parse(since);

    return Number.isFinite(at) && now.getTime() - at < memorySeconds * 1000;
}

/** Reads and writes `$SOUS_HOME/cache/read-strategies.json`. A missing or damaged file is an empty memory. */
export class StrategyMemoryFile {
    constructor(readonly file: string) {}

    read(): StrategyMemory {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown;

            return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as StrategyMemory) : {};
        } catch {
            return {};
        }
    }

    /** The read strategy remembered for a repository, or `undefined`. */
    strategy(identity: string): RememberedStrategy | undefined {
        const entry = this.read()[identity];

        return typeof entry?.strategy === "string" ? (entry as RememberedStrategy) : undefined;
    }

    /** Records the read strategy that worked, or with `undefined` forgets it; the download stays. */
    remember(identity: string, entry: RememberedStrategy | undefined): void {
        this.update(identity, (current) => {
            const download = current?.download;

            if (entry === undefined) {
                return download === undefined ? undefined : { download };
            }

            return download === undefined ? { ...entry } : { ...entry, download };
        });
    }

    /** Records the clone URL that worked, or with `undefined` forgets it; the read strategy stays. */
    rememberDownload(identity: string, download: RememberedDownload | undefined): void {
        this.update(identity, (current) => {
            const rest: RememberedRepository = { ...current };

            delete rest.download;

            const next = download === undefined ? rest : { ...rest, download };

            return Object.keys(next).length === 0 ? undefined : next;
        });
    }

    private update(identity: string, change: (current: RememberedRepository | undefined) => RememberedRepository | undefined): void {
        const memory = this.read();
        const next = change(memory[identity]);

        if (next === undefined) {
            if (!Object.hasOwn(memory, identity)) {
                return;
            }

            delete memory[identity];
        } else {
            memory[identity] = next;
        }

        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.writeFileSync(this.file, `${JSON.stringify(sortObject(memory), null, 4)}\n`, "utf8");
        } catch {
            // The memory only saves time; losing it costs one slower read.
        }
    }
}

/** One file to read. */
export interface ChainRead {
    readonly identity: string;
    /** The project's short name, for messages. */
    readonly label: string;
    readonly repository: CanonicalRepository;
    readonly host: RepositoryHostEntity;
    readonly path: string;
    /** Default `HEAD`. */
    readonly ref?: string;
    readonly etag?: string;
    /**
     * True when the read must see the current file (`--latest`, or a recipe missing from the cached
     * index): a strategy whose server may answer with a cached copy goes last, and a strategy used
     * only for such reads joins in.
     */
    readonly current?: boolean;
}

/** What a successful read gave, and how. */
export type ChainOutcome = Extract<RepositoryReadOutcome, { ok: true }> & {
    readonly strategy: string;
    /** The token the read sent, when it sent one. */
    readonly token?: RepositoryToken;
    /** The values of the tokens the host refused on the way. */
    readonly refusedTokens?: readonly string[];
};

/** The column an attempt's reason starts in, after its strategy's label. */
const ATTEMPT_LABEL_WIDTH = 19;

/**
 * The combined error, worded as the architecture spec on reading repositories prints it. The whole text is the
 * message, so the command layer's `Error: ` prefix gives exactly:
 *
 * ```text
 * Error: could not read gitlab.com/acme/private-recipes.
 *   HTTP with token      no token found (GITLAB_TOKEN unset; git has no stored credential for gitlab.com)
 *   HTTP without token   302 to sign-in page: the repository is private
 *   git                  Permission denied (publickey)
 * Fix one of these:
 *   export GITLAB_TOKEN=<a token with read_repository>
 *   set up git access to gitlab.com (an SSH key, or a credential helper)
 * ```
 *
 * Any one fix reads the index and downloads recipe files: a token found is handed to git for an
 * HTTPS download too (#213).
 */
export function formatReadFailure(failure: IndexReadFailure): string {
    const lines = [`could not read ${failure.repo}.`, ...failure.attempts.map((attempt) => `  ${attempt.strategy.padEnd(ATTEMPT_LABEL_WIDTH)}  ${attempt.reason}`)];

    if (failure.fixes.length > 0) {
        lines.push("Fix one of these:", ...failure.fixes.map((fix) => `  ${fix}`));
    }

    return lines.join("\n");
}

/**
 * A read failure as one sentence, each attempt's reason after its strategy, for a note that has one
 * line to give it.
 *
 * ```ts
 * readFailureSentence({ repo: "github.com/sous-io/sous-recipes", attempts: [{ strategy: "git", reason: "Could not resolve host: github.com" }], fixes: [] });
 * // -> "Sous could not read github.com/sous-io/sous-recipes (git: Could not resolve host: github.com)."
 * ```
 */
export function readFailureSentence(failure: IndexReadFailure): string {
    const attempts = failure.attempts.map((attempt) => `${attempt.strategy}: ${attempt.reason.replace(/[.\s]+$/, "")}`).join("; ");

    return attempts === "" ? `Sous could not read ${failure.repo}.` : `Sous could not read ${failure.repo} (${attempts}).`;
}

/** The error a read throws when every strategy failed; it carries the failure. */
export class IndexReadError extends ConfigError {
    constructor(readonly failure: IndexReadFailure) {
        super(formatReadFailure(failure));
    }
}

/** How a read through the chain behaves, besides the read itself. */
export interface ChainOptions {
    readonly now?: () => Date;
    /** How long a remembered strategy stays first (`store.strategyMemorySeconds`). Default seven days. */
    readonly memorySeconds?: number;
    /**
     * The refused tokens already warned about in this process, as `<identity> <source>`; a refused
     * token is warned about once per command.
     */
    readonly warned?: Set<string>;
}

/** Whether a failed attempt was the host refusing the token it was sent (401 or 403). */
function tokenRefused(outcome: RepositoryReadOutcome): boolean {
    return !outcome.ok && (outcome.status === 401 || outcome.status === 403);
}

/**
 * Reads one file through the host's chain of strategies. Throws an {@link IndexReadError} when all fail.
 *
 * A token the host refuses (401 or 403) sends the next token source's token to the same strategy.
 * When the read then works some other way, one warning names where the refused token came from and
 * how to replace it:
 *
 * ```text
 * GITLAB_TOKEN holds a token gitlab.com refused (401: the token was refused), so sous read
 * gitlab.com/acme/recipes with HTTP with token, using the token from git credential fill. Replace
 * the token in GITLAB_TOKEN with one that can read the repository (export GITLAB_TOKEN=<a token
 * with read_repository>), or unset GITLAB_TOKEN.
 * ```
 */
export async function readThroughChain(read: ChainRead, memory: StrategyMemoryFile, ctx: RepositoryHostContext, settings: ChainOptions = {}): Promise<ChainOutcome> {
    const now = settings.now ?? (() => new Date());
    const remembered = memory.strategy(read.identity);
    const first = remembered !== undefined && stillFirst(remembered.since, now(), settings.memorySeconds ?? DEFAULT_STRATEGY_MEMORY_SECONDS) ? remembered.strategy : undefined;
    const strategies = ordered(read.host.readStrategies, first, read.current === true);
    const attempts: Array<{ strategy: string; reason: string }> = [];
    /** Each failed attempt's strategy, with whether it sent a token, for the fixes. */
    const failed: Array<{ strategy: RepositoryReadStrategy; reason: string; withToken: boolean }> = [];
    const tokens = new TokenFinder(read, ctx);
    /** The token sent to token strategies until the host refuses it. */
    let token: RepositoryToken | undefined;
    let searched = false;

    for (const strategy of strategies) {
        let outcome: RepositoryReadOutcome | undefined;
        let sent: RepositoryToken | undefined;

        // A token strategy is tried with each token the host does not refuse, until one works.
        for (;;) {
            if (strategy.usesToken) {
                if (!searched) {
                    token = await tokens.next();
                    searched = true;
                }

                if (token === undefined) {
                    if (tokens.refused.length === 0) {
                        const reason = `no token found (${tokens.tried.join("; ") || "no token sources"})`;

                        attempts.push({ strategy: strategy.label, reason });
                        failed.push({ strategy, reason, withToken: false });
                    }

                    outcome = undefined;
                    break;
                }
            }

            sent = strategy.usesToken ? token : undefined;

            const started = now().getTime();

            outcome = await attempt(strategy, read, sent, ctx);

            if (outcome.ok) {
                // A strategy used only for current reads is not what ordinary reads should try first.
                if (strategy.onlyForCurrentReads !== true) {
                    const kept = remembered?.strategy === strategy.id && first === strategy.id && remembered.since !== undefined;

                    memory.remember(read.identity, {
                        strategy: strategy.id,
                        tokenSource: sent?.source ?? null,
                        lastSuccess: now().toISOString(),
                        lastDurationMs: Math.max(0, now().getTime() - started),
                        since: kept ? remembered.since! : now().toISOString(),
                    });
                }

                warnRefused(read, tokens, strategy, sent, ctx, settings.warned);

                return {
                    ...outcome,
                    strategy: strategy.id,
                    ...(sent === undefined ? {} : { token: sent }),
                    ...(tokens.refused.length === 0 ? {} : { refusedTokens: tokens.refused.map((one) => one.token.value) }),
                };
            }

            const reason = sent === undefined ? outcome.reason : `${outcome.reason} (the token from ${sent.source})`;

            attempts.push({ strategy: strategy.label, reason });
            failed.push({ strategy, reason: outcome.reason, withToken: sent !== undefined });

            if (sent !== undefined && tokenRefused(outcome)) {
                tokens.refuse(sent, outcome.reason);
                token = await tokens.next();
                continue;
            }

            break;
        }
    }

    memory.remember(read.identity, undefined);

    throw new IndexReadError({ repo: read.identity, attempts, fixes: fixesFor(read, { failed, token: tokens.summary() }) });
}

/** One strategy's read, a throw turned into a failed outcome. */
async function attempt(strategy: RepositoryReadStrategy, read: ChainRead, token: RepositoryToken | undefined, ctx: RepositoryHostContext): Promise<RepositoryReadOutcome> {
    try {
        return await strategy.read(
            {
                repository: read.repository,
                path: read.path,
                ref: read.ref ?? "HEAD",
                ...(read.etag === undefined ? {} : { etag: read.etag }),
                ...(token === undefined ? {} : { token }),
            },
            ctx,
        );
    } catch (error) {
        return { ok: false, reason: messageOf(error) };
    }
}

/** Warns once per command about each token the host refused before the read worked another way. */
function warnRefused(read: ChainRead, tokens: TokenFinder, strategy: RepositoryReadStrategy, sent: RepositoryToken | undefined, ctx: RepositoryHostContext, warned: Set<string> | undefined): void {
    for (const refused of tokens.refused) {
        const key = `${read.identity} ${refused.token.source}`;

        if (warned?.has(key)) {
            continue;
        }

        warned?.add(key);

        const how = sent === undefined ? `with ${strategy.label}` : `with ${strategy.label}, using the token from ${sent.source}`;
        const fix = safely(() => read.host.tokenSources?.find((source) => source.id === refused.sourceId)?.fix?.(read.repository));
        const variable = refused.sourceId === "env" ? `, or unset ${refused.token.source}` : "";

        ctx.reporter.warning(
            `${refused.token.source} holds a token ${read.repository.host} refused (${refused.reason}), so sous read ${read.identity} ${how}. ` +
                `Replace the token in ${refused.token.source} with one that can read the repository${fix === undefined ? "" : ` (${fix})`}${variable}.`,
        );
    }
}

/**
 * The strategies to try, in order: the remembered one first. An ordinary read leaves out the
 * strategies used only for current reads; a current read puts the strategies whose server may
 * answer with a cached copy last, so they answer only when nothing else can.
 *
 * ```ts
 * // GitHub: http-token, http (cached copies), http-api (current reads only), git
 * ordered(github, "http", false); // -> http, http-token, git
 * ordered(github, "http", true);  // -> http-token, http-api, git, http
 * ```
 */
export function ordered(strategies: readonly RepositoryReadStrategy[], first: string | undefined, current = false): RepositoryReadStrategy[] {
    const usable = strategies.filter((strategy) => current || strategy.onlyForCurrentReads !== true);
    const remembered = usable.find((strategy) => strategy.id === first && !(current && strategy.servesCachedCopies === true));
    const inOrder = remembered ? [remembered, ...usable.filter((strategy) => strategy !== remembered)] : usable;

    return current ? [...inOrder.filter((strategy) => strategy.servesCachedCopies !== true), ...inOrder.filter((strategy) => strategy.servesCachedCopies === true)] : inOrder;
}

/** What looking for a token found: the token and the source that found it, and what the other sources said. */
interface TokenSearch {
    found?: RepositoryToken;
    /** The id of the source that found the token. */
    foundBy?: string;
    tried: string[];
    /** The ids of the sources that looked and found nothing (a CLI that is not installed is not one). */
    empty: string[];
    /** The tokens the host refused, each with its source's id and the host's answer. */
    refused?: ReadonlyArray<RefusedToken>;
}

/** A token the host refused. */
interface RefusedToken {
    readonly token: RepositoryToken;
    readonly sourceId: string;
    readonly reason: string;
}

/**
 * The token sources, asked one at a time: `next()` gives the next token found, skipping a token
 * whose value the host already refused (glab hands back `GITLAB_TOKEN` when it is set).
 */
export class TokenFinder {
    readonly tried: string[] = [];
    readonly empty: string[] = [];
    readonly refused: RefusedToken[] = [];
    private index = 0;
    private current: { token: RepositoryToken; sourceId: string } | undefined;

    /**
     * @param skip - Token values already refused, which are passed over.
     */
    constructor(
        private readonly read: Pick<ChainRead, "host" | "repository">,
        private readonly ctx: RepositoryHostContext,
        private readonly skip: readonly string[] = [],
    ) {}

    /** The next token a source finds, or `undefined` when no source is left. */
    async next(): Promise<RepositoryToken | undefined> {
        const sources = this.read.host.tokenSources ?? [];

        while (this.index < sources.length) {
            const source = sources[this.index++]!;
            const found = await this.ask(source);

            if (found !== undefined && !this.skip.includes(found.value) && !this.refused.some((refused) => refused.token.value === found.value)) {
                this.current = { token: found, sourceId: source.id };

                return found;
            }
        }

        this.current = undefined;

        return undefined;
    }

    /** Records that the host refused a token. */
    refuse(token: RepositoryToken, reason: string): void {
        const sourceId = this.current?.token === token ? this.current.sourceId : (this.read.host.tokenSources ?? []).find((source) => source.label === token.source)?.id ?? token.source;

        this.refused.push({ token, sourceId, reason });
    }

    /** What the search found, for the fixes. */
    summary(): TokenSearch {
        return {
            ...(this.current === undefined ? {} : { found: this.current.token, foundBy: this.current.sourceId }),
            tried: this.tried,
            empty: this.empty,
            refused: this.refused,
        };
    }

    /** One source's token, recording why it has none. */
    private async ask(source: RepositoryTokenSource): Promise<RepositoryToken | undefined> {
        try {
            if (source.find !== undefined) {
                const lookup = await source.find(this.read.repository, this.ctx);

                if ("token" in lookup && lookup.token.value.length > 0) {
                    return lookup.token;
                }

                // A source that says nothing (a CLI that is not installed) is left out of the error.
                if ("missing" in lookup && lookup.missing !== undefined) {
                    this.tried.push(lookup.missing);
                    this.empty.push(source.id);
                }

                return undefined;
            }

            const found = await source.token(this.read.repository, this.ctx);

            if (found !== undefined && found.value.length > 0) {
                return found;
            }

            this.tried.push(`${source.label}: none`);
            this.empty.push(source.id);
        } catch (error) {
            this.tried.push(`${source.label}: ${messageOf(error)}`);
            this.empty.push(source.id);
        }

        return undefined;
    }
}

/** The first token a token source finds, passing over the values in `skip`, or `undefined`. */
export async function findToken(read: Pick<ChainRead, "host" | "repository">, ctx: RepositoryHostContext, skip: readonly string[] = []): Promise<RepositoryToken | undefined> {
    return new TokenFinder(read, ctx, skip).next();
}

/** What an attempt's reason says went wrong, for choosing the fixes. */
export type AttemptKind = "network" | "missing-file" | "refused" | "no-token" | "other";

/**
 * What an attempt's reason says went wrong:
 *
 * - `network`: the host could not be reached (DNS, connection refused, timed out).
 * - `missing-file`: git reached the repository, and the file is not in it.
 * - `refused`: the host answered and refused (a token refused, a private repository, a denied key).
 * - `no-token`: the strategy needs a token and no source found one.
 * - `other`: anything else.
 *
 * ```ts
 * attemptKind("Could not resolve host: gitlab.com"); // "network"
 * attemptKind("path 'sous.index.json' does not exist in 'FETCH_HEAD'"); // "missing-file"
 * attemptKind("401: the token was refused"); // "refused"
 * ```
 */
export function attemptKind(reason: string): AttemptKind {
    if (/^no token found\b/i.test(reason)) {
        return "no-token";
    }

    if (
        /could not connect|could not reach|could not resolve|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|connection refused|connection timed out|connection reset|network is unreachable|no route to host|failed to connect|operation timed out|did not finish within/i.test(
            reason,
        )
    ) {
        return "network";
    }

    if (/does not exist in|exists on disk, but not in/i.test(reason)) {
        return "missing-file";
    }

    if (/\b40[134]\b|refused|denied|authentication failed|could not read username|terminal prompts disabled|sign-in page|private|not found/i.test(reason)) {
        return "refused";
    }

    return "other";
}

/** What the attempts of a failed read saw, for choosing the fixes. */
export interface ReadAttempts {
    readonly failed: ReadonlyArray<{ readonly strategy: RepositoryReadStrategy; readonly reason: string; readonly withToken: boolean }>;
    readonly token?: Pick<TokenSearch, "found" | "foundBy" | "empty" | "refused">;
}

/**
 * The fixes the error names, chosen from what the attempts said (#204 bug 20):
 *
 * - git reached the repository and the file is not in it: check the URL. No token would help.
 * - every attempt that ran could not connect: check the connection or the proxy. No token would help.
 * - otherwise, in this order: the connection, when some attempt could not connect; a refused token,
 *   named by where it came from; the `fix` of each token source that looked and found nothing (a
 *   CLI that is not installed offers none); the `fix` of each strategy that reached its host.
 *
 * A host that names none gets the general ones: a token from a source it reads, or git access.
 * Without `attempts`, every token source's and strategy's `fix` is named.
 *
 * ```ts
 * // offline: http "could not connect: ... ENOTFOUND gitlab.com", git "Could not resolve host: gitlab.com"
 * fixesFor(read, attempts);
 * // -> ["check that this machine can reach gitlab.com, and set HTTPS_PROXY if this network needs a proxy"]
 * ```
 */
export function fixesFor(read: Pick<ChainRead, "host" | "repository"> & Partial<Pick<ChainRead, "identity" | "path">>, attempts?: ReadAttempts): string[] {
    const fixes: string[] = [];
    const add = (fix: string | undefined): void => {
        if (fix !== undefined && fix.length > 0 && !fixes.includes(fix)) {
            fixes.push(fix);
        }
    };
    const sources = read.host.tokenSources ?? [];
    const failed = attempts?.failed ?? [];
    const kinds = failed.map((attempt) => attemptKind(attempt.reason));
    const ran = kinds.filter((kind) => kind !== "no-token");
    const where = read.identity ?? read.repository.host;
    const network = `check that this machine can reach ${read.repository.host}, and set HTTPS_PROXY if this network needs a proxy`;

    if (kinds.includes("missing-file")) {
        return [`check the URL: git reached ${where}, but it has no ${read.path ?? "index"}, so it is not a sous recipe repository, or nothing in it has been released yet`];
    }

    if (ran.length > 0 && ran.every((kind) => kind === "network")) {
        return [network];
    }

    if (kinds.includes("network")) {
        add(network);
    }

    const token = attempts?.token;
    const refused = failed.some((attempt) => attempt.withToken && attemptKind(attempt.reason) === "refused");

    // Each token the host refused is named by where it came from, never as a variable to export.
    for (const one of token?.refused ?? []) {
        add(`replace the token in ${one.token.source} with one that can read ${where}: ${read.repository.host} refused it`);
    }

    if (refused && token?.found !== undefined) {
        add(`replace the token in ${token.found.source} with one that can read ${where}: ${read.repository.host} refused it`);
    }

    const before = fixes.length;

    for (const source of sources) {
        // The source of a refused token is set already; a source that never looked (a CLI that is
        // not installed) has nothing to offer.
        if (token !== undefined && (source.id === token.foundBy || token.refused?.some((one) => one.sourceId === source.id) === true || !token.empty.includes(source.id))) {
            continue;
        }

        add(safely(() => source.fix?.(read.repository)));
    }

    for (const strategy of read.host.readStrategies) {
        const tried = failed.find((attempt) => attempt.strategy === strategy);

        if (tried !== undefined && attemptKind(tried.reason) === "network") {
            continue;
        }

        add(safely(() => strategy.fix?.(read.repository)));
    }

    if (fixes.length > before || refused) {
        return fixes;
    }

    if (sources.length > 0) {
        add(`provide a token through ${sources.map((source) => source.label).join(", or ")}`);
    }

    add(`set up git access to ${read.repository.host} (an SSH key, or a credential helper)`);

    return fixes;
}

/** A host's answer, or `undefined` when it throws: a fix line never fails the error it explains. */
function safely(make: () => string | undefined): string | undefined {
    try {
        return make();
    } catch {
        return undefined;
    }
}

/** A copy of an object with its keys sorted. */
function sortObject<T>(value: Record<string, T>): Record<string, T> {
    const sorted: Record<string, T> = {};

    for (const key of Object.keys(value).sort()) {
        sorted[key] = value[key];
    }

    return sorted;
}
