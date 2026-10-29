/**
 * Reading one file from a repository (S4, "How Sous Reads Repositories"): each read strategy of
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
}

/** What a successful read gave, and how. */
export type ChainOutcome = Extract<RepositoryReadOutcome, { ok: true }> & { readonly strategy: string };

/** The column an attempt's reason starts in, after its strategy's label. */
const ATTEMPT_LABEL_WIDTH = 19;

/**
 * The combined error, worded as S4 ("When everything fails") prints it. The whole text is the
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
 */
export function formatReadFailure(failure: IndexReadFailure): string {
    const lines = [`could not read ${failure.repo}.`, ...failure.attempts.map((attempt) => `  ${attempt.strategy.padEnd(ATTEMPT_LABEL_WIDTH)}  ${attempt.reason}`)];

    if (failure.fixes.length > 0) {
        lines.push("Fix one of these:", ...failure.fixes.map((fix) => `  ${fix}`));
    }

    return lines.join("\n");
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
    const strategies = ordered(read.host.readStrategies, remembered?.strategy);
    const attempts: Array<{ strategy: string; reason: string }> = [];
    let token: { found?: RepositoryToken; tried: string[] } | undefined;

    for (const strategy of strategies) {
        let found: RepositoryToken | undefined;

        if (strategy.usesToken) {
            token ??= await findToken(read, ctx);
            found = token.found;

            if (found === undefined) {
                attempts.push({ strategy: strategy.label, reason: `no token found (${token.tried.join("; ") || "no token sources"})` });
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
            memory.remember(read.identity, {
                strategy: strategy.id,
                tokenSource: found?.source ?? null,
                lastSuccess: now().toISOString(),
                lastDurationMs: Math.max(0, now().getTime() - started),
            });

            return { ...outcome, strategy: strategy.id };
        }

        attempts.push({ strategy: strategy.label, reason: outcome.reason });
    }

    memory.remember(read.identity, undefined);

    throw new IndexReadError({ repo: read.identity, attempts, fixes: fixesFor(read) });
}

/** The strategies, the remembered one first. */
function ordered(strategies: readonly RepositoryReadStrategy[], first: string | undefined): RepositoryReadStrategy[] {
    const remembered = strategies.find((strategy) => strategy.id === first);

    return remembered ? [remembered, ...strategies.filter((strategy) => strategy !== remembered)] : [...strategies];
}

/** The first token a token source finds, and what each source said. */
async function findToken(read: ChainRead, ctx: RepositoryHostContext): Promise<{ found?: RepositoryToken; tried: string[] }> {
    const tried: string[] = [];

    for (const source of read.host.tokenSources ?? []) {
        try {
            if (source.find !== undefined) {
                const lookup = await source.find(read.repository, ctx);

                if ("token" in lookup && lookup.token.value.length > 0) {
                    return { found: lookup.token, tried };
                }

                // A source that says nothing (a CLI that is not installed) is left out of the error.
                if ("missing" in lookup && lookup.missing !== undefined) {
                    tried.push(lookup.missing);
                }

                continue;
            }

            const found = await source.token(read.repository, ctx);

            if (found !== undefined && found.value.length > 0) {
                return { found, tried };
            }

            tried.push(`${source.label}: none`);
        } catch (error) {
            tried.push(`${source.label}: ${messageOf(error)}`);
        }
    }

    return { tried };
}

/**
 * The fixes the error names: each token source's and read strategy's own `fix`, in chain order.
 * A host that names none gets the general ones: a token from a source it reads, or git access.
 */
export function fixesFor(read: Pick<ChainRead, "host" | "repository">): string[] {
    const fixes: string[] = [];
    const add = (fix: string | undefined): void => {
        if (fix !== undefined && fix.length > 0 && !fixes.includes(fix)) {
            fixes.push(fix);
        }
    };
    const sources = read.host.tokenSources ?? [];

    for (const source of sources) {
        add(safely(() => source.fix?.(read.repository)));
    }

    for (const strategy of read.host.readStrategies) {
        add(safely(() => strategy.fix?.(read.repository)));
    }

    if (fixes.length > 0) {
        return fixes;
    }

    if (sources.length > 0) {
        fixes.push(`provide a token through ${sources.map((source) => source.label).join(", or ")}`);
    }

    fixes.push(`set up git access to ${read.repository.host} (an SSH key, or a credential helper)`);

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
