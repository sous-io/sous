/**
 * Reading one file from a repository: each read strategy of
 * the repository's host in order, a token tried when a token source finds one, the strategy that
 * worked remembered per repository, and one error listing every attempt when all fail.
 */

import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "@sous-io/plugin-api";
import type { CanonicalRepository } from "@sous-io/plugin-refs/types";
import type {
    IndexReadFailure,
    RepositoryHostContext,
    RepositoryHostEntity,
    RepositoryReadOutcome,
    RepositoryReadStrategy,
    RepositoryToken,
} from "../../types.js";
import { messageOf } from "../support.js";

/** What sous remembers about reading one repository (`read-strategies.json`). */
export interface RememberedStrategy {
    strategy: string;
    tokenSource: string | null;
    lastSuccess: string;
    lastDurationMs: number;
}

/** The remembered strategies, by repository identity. */
export type StrategyMemory = Record<string, RememberedStrategy>;

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

    remember(identity: string, entry: RememberedStrategy | undefined): void {
        const memory = this.read();

        if (entry === undefined) {
            if (!Object.hasOwn(memory, identity)) {
                return;
            }

            delete memory[identity];
        } else {
            memory[identity] = entry;
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
export type ChainOutcome = Extract<RepositoryReadOutcome, { ok: true }> & { readonly strategy: string };

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
 * A token reads only the index. Recipe files are downloaded with git, so building also needs git access.
 * ```
 *
 * Any one fix reads the index, but only git access downloads recipe files, so the last line says so
 * whenever the fixes offer a token.
 */
export function formatReadFailure(failure: IndexReadFailure): string {
    const lines = [`could not read ${failure.repo}.`, ...failure.attempts.map((attempt) => `  ${attempt.strategy.padEnd(ATTEMPT_LABEL_WIDTH)}  ${attempt.reason}`)];

    if (failure.fixes.length > 0) {
        lines.push("Fix one of these:", ...failure.fixes.map((fix) => `  ${fix}`));
    }

    if (failure.fixes.some((fix) => /token|auth login/i.test(fix))) {
        lines.push("A token reads only the index. Recipe files are downloaded with git, so building also needs git access.");
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

/** Reads one file through the host's chain of strategies. Throws an {@link IndexReadError} when all fail. */
export async function readThroughChain(read: ChainRead, memory: StrategyMemoryFile, ctx: RepositoryHostContext, now: () => Date = () => new Date()): Promise<ChainOutcome> {
    const remembered = memory.read()[read.identity];
    const strategies = ordered(read.host.readStrategies, remembered?.strategy, read.current === true);
    const attempts: Array<{ strategy: string; reason: string }> = [];
    /** Each failed attempt's strategy, with whether it sent a token, for the fixes. */
    const failed: Array<{ strategy: RepositoryReadStrategy; reason: string; withToken: boolean }> = [];
    let token: TokenSearch | undefined;

    for (const strategy of strategies) {
        let found: RepositoryToken | undefined;

        if (strategy.usesToken) {
            token ??= await findToken(read, ctx);
            found = token.found;

            if (found === undefined) {
                const reason = `no token found (${token.tried.join("; ") || "no token sources"})`;

                attempts.push({ strategy: strategy.label, reason });
                failed.push({ strategy, reason, withToken: false });
                continue;
            }
        }

        const started = now().getTime();
        let outcome: RepositoryReadOutcome;

        try {
            outcome = await strategy.read(
                {
                    repository: read.repository,
                    path: read.path,
                    ref: read.ref ?? "HEAD",
                    ...(read.etag === undefined ? {} : { etag: read.etag }),
                    ...(found === undefined ? {} : { token: found }),
                },
                ctx,
            );
        } catch (error) {
            outcome = { ok: false, reason: messageOf(error) };
        }

        if (outcome.ok) {
            // A strategy used only for current reads is not what ordinary reads should try first.
            if (strategy.onlyForCurrentReads !== true) {
                memory.remember(read.identity, {
                    strategy: strategy.id,
                    tokenSource: found?.source ?? null,
                    lastSuccess: now().toISOString(),
                    lastDurationMs: Math.max(0, now().getTime() - started),
                });
            }

            return { ...outcome, strategy: strategy.id };
        }

        attempts.push({ strategy: strategy.label, reason: outcome.reason });
        failed.push({ strategy, reason: outcome.reason, withToken: found !== undefined });
    }

    memory.remember(read.identity, undefined);

    throw new IndexReadError({ repo: read.identity, attempts, fixes: fixesFor(read, { failed, ...(token === undefined ? {} : { token }) }) });
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
}

/** The first token a token source finds, and what each source said. */
async function findToken(read: ChainRead, ctx: RepositoryHostContext): Promise<TokenSearch> {
    const tried: string[] = [];
    const empty: string[] = [];

    for (const source of read.host.tokenSources ?? []) {
        try {
            if (source.find !== undefined) {
                const lookup = await source.find(read.repository, ctx);

                if ("token" in lookup && lookup.token.value.length > 0) {
                    return { found: lookup.token, foundBy: source.id, tried, empty };
                }

                // A source that says nothing (a CLI that is not installed) is left out of the error.
                if ("missing" in lookup && lookup.missing !== undefined) {
                    tried.push(lookup.missing);
                    empty.push(source.id);
                }

                continue;
            }

            const found = await source.token(read.repository, ctx);

            if (found !== undefined && found.value.length > 0) {
                return { found, foundBy: source.id, tried, empty };
            }

            tried.push(`${source.label}: none`);
            empty.push(source.id);
        } catch (error) {
            tried.push(`${source.label}: ${messageOf(error)}`);
            empty.push(source.id);
        }
    }

    return { tried, empty };
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
    readonly token?: Pick<TokenSearch, "found" | "foundBy" | "empty">;
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

    if (refused && token?.found !== undefined) {
        add(`replace the token in ${token.found.source} with one that can read ${where}: ${read.repository.host} refused it`);
    }

    const before = fixes.length;

    for (const source of sources) {
        // The source of a refused token is set already; a source that never looked (a CLI that is
        // not installed) has nothing to offer.
        if (token !== undefined && (source.id === token.foundBy || !token.empty.includes(source.id))) {
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
