/**
 * Settling, at release time, the dependencies that read more than one way: a GitLab URL with nested
 * groups (where does the project path end?) and a browser URL copied from a host's file view (which
 * recipe is that folder?). Each is settled once, by reading the index of every candidate repository
 * through its `repository-host` entity, and keeping the reading whose index publishes what was named.
 * What it settled on is recorded in the index, so a consumer never probes.
 *
 * A failed read fails the release: it never falls through to the next reading, because that reading
 * could be the wrong one. Two readings that both publish it are a tie, and an error.
 */

import { ConfigError } from "@sous-io/plugin-api";
import type { IndexFile } from "@sous-io/plugin-formats/types";
import type { RefLocation, SousRef } from "@sous-io/plugin-refs/types";
import type { ReleaseProblem } from "../types.js";
import type { AuthoringTools } from "../tools.js";
import { describeError } from "../shared/problems.js";
import { keyOf, locationOf, namespaceNameOf, rangeOf, readingsOf } from "../shared/refs.js";
import { INDEX_FILE, type RepoValidation } from "../shared/repository.js";

/** What one dependency settled on. */
export interface SettledDependency {
    /** The canonical identity of the repository publishing it. */
    readonly identity: string;
    /** The recipe keys it reaches there: one for a recipe, every recipe of a namespace. */
    readonly keys: string[];
    /** The range the manifest wrote. */
    readonly range?: string;
}

/** What settling found. */
export interface SettleResult {
    /** Keyed by the dependency as written, trimmed. */
    readonly settled: Map<string, SettledDependency>;
    /** Every one is an error. */
    readonly problems: ReleaseProblem[];
}

/** Reads the index of the repository at a location. */
export type IndexReader = (location: RefLocation) => Promise<IndexFile>;

/** Whether readings need an index to settle: more than one, or a browser path. */
export function needsSettling(readings: readonly SousRef[]): boolean {
    return readings.length > 1 || readings.some((reading) => reading.kind === "repo" && reading.browsed !== undefined);
}

/**
 * Settles every dependency that reads more than one way. Nothing is read for the others, so a
 * repository that uses none of these forms releases offline.
 */
export async function settleDependencyLocations(tools: AuthoringTools, validation: RepoValidation, readIndex?: IndexReader): Promise<SettleResult> {
    const settled = new Map<string, SettledDependency>();
    const problems: ReleaseProblem[] = [];
    const indexes = new Map<string, Promise<IndexFile>>();
    const reader = readIndex ?? ((location: RefLocation) => readIndexThroughHost(tools, location));
    const indexAt = (location: RefLocation): Promise<IndexFile> => {
        let pending = indexes.get(location.identity);

        if (pending === undefined) {
            pending = reader(location);
            indexes.set(location.identity, pending);
        }

        return pending;
    };

    for (const recipe of validation.recipes) {
        for (const written of [...(recipe.manifest.depends ?? []), ...(recipe.manifest.subscribes ?? [])]) {
            const trimmed = written.trim();

            if (settled.has(trimmed)) {
                continue;
            }

            const readings = readingsOf(tools, trimmed);

            if (readings === undefined || !needsSettling(readings)) {
                continue;
            }

            try {
                settled.set(trimmed, await settleOne(tools, readings, indexAt));
            } catch (error) {
                problems.push({ level: "error", recipe: recipe.key, where: `${recipe.path} ('${trimmed}')`, message: describeError(error) });
            }
        }
    }

    return { settled, problems };
}

/** One match of a reading in a fetched index. */
interface IndexMatch {
    readonly reading: SousRef;
    readonly location: RefLocation;
    readonly keys: string[];
    readonly label: string;
}

async function settleOne(tools: AuthoringTools, readings: readonly SousRef[], indexAt: (location: RefLocation) => Promise<IndexFile>): Promise<SettledDependency> {
    const matches: IndexMatch[] = [];

    for (const reading of readings) {
        const location = locationOf(tools, reading);

        if (location === undefined) {
            continue;
        }

        let index: IndexFile;

        try {
            index = await indexAt(location);
        } catch (error) {
            const folder = reading.kind === "repo" && reading.browsed !== undefined;

            throw new ConfigError(
                `the dependency reads ${folder ? "as a folder in" : "as something in"} the repository at ${location.url}, ` +
                    `and its index could not be read, so the release cannot settle what it means. A release never ` +
                    `guesses past an index it could not read.\n  ${describeError(error)}`,
            );
        }

        const keys = matchIndex(tools, reading, index);

        if (keys.length > 0) {
            matches.push({ reading, location, keys, label: tools.format.format(reading) });
        }
    }

    if (matches.length === 0) {
        throw new ConfigError(
            `no repository it could name publishes what it names. It was read as:\n` +
                readings.map((reading) => `    ${tools.format.format(reading)}`).join("\n"),
        );
    }

    if (matches.length > 1) {
        const namespace = matches.find((match) => match.reading.kind === "namespace") ?? matches[0]!;
        const written = namespace.reading.kind === "namespace" ? `${namespace.label}/*` : namespace.label;

        throw new ConfigError(
            `it names more than one thing, and each of these publishes it:\n` +
                matches.map((match) => `    ${match.label}`).join("\n") +
                `\n  Write the one you mean. A namespace is written with '/*' after it, as in '${written}', and a ` +
                `recipe as its canonical locator above.`,
        );
    }

    const [choice] = matches as [IndexMatch];
    const range = readings.map((reading) => rangeOf(tools, reading)).find((written) => written !== undefined);

    return { identity: choice.location.identity, keys: choice.keys, ...(range === undefined ? {} : { range }) };
}

/** The recipe keys a reading reaches in an index; empty when it publishes nothing of the kind. */
function matchIndex(tools: AuthoringTools, reading: SousRef, index: IndexFile): string[] {
    if (reading.kind === "recipe") {
        const key = keyOf(tools, reading);

        return Object.hasOwn(index.recipes, key) ? [key] : [];
    }

    if (reading.kind === "namespace") {
        const namespace = namespaceNameOf(tools, reading);
        const keys = Object.keys(index.recipes)
            .filter((key) => key.startsWith(`${namespace}/`))
            .sort();

        return keys.length > 0 || (namespace !== undefined && Object.hasOwn(index.namespaces, namespace)) ? keys : [];
    }

    if (reading.kind === "repo" && reading.browsed !== undefined) {
        const browsed = reading.browsed.replace(/\/+$/, "");

        return Object.entries(index.recipes)
            .filter(([, recipe]) => browsed === recipe.path || browsed.endsWith(`/${recipe.path.replace(/\/+$/, "")}`))
            .map(([key]) => key)
            .sort();
    }

    return [];
}

/**
 * Reads `sous.index.json` at `HEAD` through the location's `repository-host` entity: its token
 * sources in order, then its read strategies in order, the first that reads it winning.
 */
export async function readIndexThroughHost(tools: AuthoringTools, location: RefLocation): Promise<IndexFile> {
    const host = tools.entities.get("repository-host", location.provider);

    if (host === undefined) {
        throw new ConfigError(`No plugin reads repositories of the host '${location.provider}', so ${location.url} cannot be read.`);
    }

    const ctx = tools.hostContext();
    const repository = host.canonicalize(location.url);
    let token;

    for (const source of host.tokenSources ?? []) {
        token = await source.token(repository, ctx).catch(() => undefined);

        if (token !== undefined) {
            break;
        }
    }

    const attempts: string[] = [];

    for (const strategy of host.readStrategies) {
        if (strategy.usesToken === true && token === undefined) {
            continue;
        }

        const outcome = await strategy.read({ repository, path: INDEX_FILE, ref: "HEAD", ...(token === undefined ? {} : { token }) }, ctx);

        if (outcome.ok && "text" in outcome) {
            return tools.indexFile.parse(JSON.parse(outcome.text), `${location.url}/${INDEX_FILE}`);
        }

        attempts.push(`${strategy.label}: ${outcome.ok ? "the host answered without the file" : outcome.reason}`);
    }

    throw new ConfigError(`Sous could not read ${INDEX_FILE} from ${location.url}.\n${attempts.map((line) => `    ${line}`).join("\n")}`);
}
