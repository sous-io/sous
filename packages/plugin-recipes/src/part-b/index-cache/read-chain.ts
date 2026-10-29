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

/** The error a read throws when every strategy failed; it carries the failure. */
export class IndexReadError extends ConfigError {
    constructor(readonly failure: IndexReadFailure) {
        super(`Could not read ${failure.repo}.`, {
            details: [...failure.attempts.map((attempt) => `${attempt.strategy.padEnd(20)} ${attempt.reason}`), "Fix one of these:", ...failure.fixes.map((fix) => `  ${fix}`)],
        });
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

/** The fixes the error names: a token from a source the host reads, or git access. */
function fixesFor(read: ChainRead): string[] {
    const fixes: string[] = [];
    const sources = read.host.tokenSources ?? [];

    if (sources.length > 0) {
        fixes.push(`provide a token through ${sources.map((source) => source.label).join(", or ")}`);
    }

    fixes.push(`set up git access to ${read.repository.host} (an SSH key, or a credential helper)`);

    return fixes;
}

/** A copy of an object with its keys sorted. */
function sortObject<T>(value: Record<string, T>): Record<string, T> {
    const sorted: Record<string, T> = {};

    for (const key of Object.keys(value).sort()) {
        sorted[key] = value[key];
    }

    return sorted;
}
