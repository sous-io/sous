/**
 * `refs.resolver`: parses a written ref, prunes it by where it was written, and narrows it to what
 * exists.
 *
 * It runs three parts that know nothing of one another: `refs.parser` (every reading of the
 * text), the `ref-pruner` entities for the place (which readings count there) and the `ref-lookup`
 * entities a caller selects (which readings exist). Settling a ref that is still ambiguous is
 * `refs.picker`'s job.
 */

import { ConfigError, type ServiceContext } from "@sous-io/plugin-api";
import { refIdentity } from "./format.js";
import { parseError } from "./parser/parser.js";
import { qualificationOf, REF_KINDS } from "./parts.js";
import { describeDropped } from "./pruners/rules.js";
import type {
    DroppedRef,
    RefInString,
    RefKind,
    RefLookupEntity,
    RefLookupSelection,
    RefMatch,
    RefResolution,
    RefResolveRequest,
    RefSource,
    RefsResolver,
    SousRef,
} from "./types.js";

/** What pruning a ref in a place gave. */
interface Pruned {
    kept: SousRef[];
    dropped: DroppedRef[];
    warnings: string[];
    place: string;
}

/** A match, with the reading that found it, which decides where it is listed. */
interface Found {
    ref: SousRef;
    rank: SousRef;
}

/** True when a browsed repository may still settle into a namespace or recipe a caller accepts. */
function browsedFits(ref: SousRef, kinds: readonly RefKind[]): boolean {
    return ref.kind === "repo" && ref.browsed !== undefined && (kinds.includes("namespace") || kinds.includes("recipe"));
}

/** Whether a lookup answers for a reading. */
function answersFor(lookup: RefLookupEntity, candidate: SousRef): boolean {
    return lookup.kinds === undefined || lookup.kinds.includes(candidate.kind) || browsedFits(candidate, lookup.kinds);
}

/**
 * Sorts refs into the listing order and drops any found twice: by how qualified the spelling that
 * produced each was, then by kind, then in the order they came.
 */
export function orderRefs(entries: readonly Found[]): SousRef[] {
    const seen = new Set<string>();

    return entries
        .map((entry, position) => ({ ...entry, position }))
        .sort(
            (left, right) =>
                qualificationOf(left.rank) - qualificationOf(right.rank) ||
                REF_KINDS.indexOf(left.ref.kind) - REF_KINDS.indexOf(right.ref.kind) ||
                left.position - right.position,
        )
        .map((entry) => entry.ref)
        .filter((ref) => {
            const identity = `${refIdentity(ref)} ${JSON.stringify(ref.vars ?? {})}`;

            if (seen.has(identity)) {
                return false;
            }

            seen.add(identity);

            return true;
        });
}

/** The lookups a selection names, in the order it names them. */
export function selectLookups(all: readonly RefLookupEntity[], selection: RefLookupSelection | undefined): RefLookupEntity[] {
    if (selection === undefined || selection === true) {
        return all.filter((lookup) => lookup.optIn !== true);
    }

    if (selection === false) {
        return [];
    }

    const chosen: RefLookupEntity[] = [];

    for (const selector of selection) {
        for (const lookup of all) {
            if ((lookup.id === selector || lookup.tags?.includes(selector) === true) && !chosen.includes(lookup)) {
                chosen.push(lookup);
            }
        }
    }

    return chosen;
}

/** Makes `refs.resolver` for a build. */
export function createRefsResolver(ctx: ServiceContext): RefsResolver {
    const prune = (input: string, from: RefSource): Pruned => {
        const pruners = ctx.entities.list("ref-pruner").filter((pruner) => pruner.source === from);

        if (pruners.length === 0) {
            throw new ConfigError(`No pruner is registered for a ref written as '${from}'.`, {
                details: ["A plugin that adds a place to write refs adds a 'ref-pruner' entity for it."],
            });
        }

        const parsed = ctx.services.get("refs.parser").parse(input);

        if (parsed.readings.length === 0) {
            throw parseError(parsed);
        }

        let kept = parsed.readings;
        const dropped: DroppedRef[] = [];
        const warnings: string[] = [];

        for (const pruner of pruners) {
            const result = pruner.prune(kept, input.trim(), ctx);

            kept = result.kept;
            dropped.push(...result.dropped);
            warnings.push(...result.warnings);
        }

        return { kept, dropped, warnings, place: pruners[0]!.place };
    };

    const refusal = (input: string, place: string, dropped: readonly DroppedRef[]): ConfigError => {
        const reasons = [...new Set(dropped.map(describeDropped))];

        if (reasons.length === 1) {
            return new ConfigError(`The ref '${input.trim()}' cannot be written ${place}: ${reasons[0]}`);
        }

        return new ConfigError(
            `The ref '${input.trim()}' cannot be written ${place}. Every way it reads is refused:\n` +
                reasons.map((reason) => `  - ${reason}`).join("\n"),
        );
    };

    const resolution = (input: string, refs: SousRef[], pruned: Pick<Pruned, "dropped" | "warnings">, usedLookup: boolean): RefResolution => ({
        input,
        refs,
        dropped: pruned.dropped,
        warnings: pruned.warnings,
        usedLookup,
    });

    const parse = (input: string, from: RefSource = "commandLine"): RefResolution => {
        const pruned = prune(input, from);

        if (pruned.kept.length === 0) {
            throw refusal(input, pruned.place, pruned.dropped);
        }

        return resolution(input, orderRefs(pruned.kept.map((ref) => ({ ref, rank: ref }))), pruned, false);
    };

    /** Everything a resolve does before asking a lookup, or the answer when it needs none. */
    const begin = (request: RefResolveRequest): { result: RefResolution } | { kept: SousRef[]; pruned: Pruned; lookups: RefLookupEntity[] } => {
        let pruned: Pruned;

        try {
            pruned = prune(request.input, request.from ?? "commandLine");
        } catch (error) {
            // A text no reading exists for (empty, say) is refused the same way.
            if (request.refusedIsEmpty === true) {
                return { result: resolution(request.input, [], { dropped: [], warnings: [] }, true) };
            }

            throw error;
        }

        if (pruned.kept.length === 0) {
            if (request.refusedIsEmpty === true) {
                return { result: resolution(request.input, [], pruned, true) };
            }

            throw refusal(request.input, pruned.place, pruned.dropped);
        }

        const kinds = request.kinds;
        const kept = kinds === undefined ? pruned.kept : pruned.kept.filter((ref) => kinds.includes(ref.kind) || browsedFits(ref, kinds));
        const selected = selectLookups(ctx.entities.list("ref-lookup"), request.lookups);
        const lookups = [...(request.extraLookups ?? []), ...selected];

        if (Array.isArray(request.lookups) && request.lookups.length > 0 && selected.length === 0 && request.extraLookups === undefined) {
            throw new ConfigError(`No ref lookup answers to ${request.lookups.map((name) => `'${name}'`).join(", ")}.`, {
                details: ["The plugin that adds it may be disabled or missing."],
            });
        }

        if (lookups.length === 0) {
            return { result: resolution(request.input, orderRefs(kept.map((ref) => ({ ref, rank: ref }))), pruned, false) };
        }

        return { kept, pruned, lookups };
    };

    /** Everything a resolve does with what the lookups found. */
    const finish = (request: RefResolveRequest, pruned: Pruned, found: Array<{ match: RefMatch; rank: SousRef }>): RefResolution => {
        const kinds = request.kinds;
        const matching = found.filter((entry) => kinds === undefined || kinds.includes(entry.match.ref.kind));
        const exact = matching.filter((entry) => entry.match.exactSpelling);
        const chosen = exact.length > 0 ? exact : matching;

        return resolution(request.input, orderRefs(chosen.map((entry) => ({ ref: entry.match.ref, rank: entry.rank }))), pruned, true);
    };

    return {
        parse,

        async resolve(request) {
            const early = begin(request);

            if ("result" in early) {
                return early.result;
            }

            const found: Array<{ match: RefMatch; rank: SousRef }> = [];

            for (const candidate of early.kept) {
                for (const lookup of early.lookups) {
                    if (answersFor(lookup, candidate)) {
                        for (const match of await lookup.find(candidate, ctx)) {
                            found.push({ match, rank: candidate });
                        }
                    }
                }
            }

            return finish(request, early.pruned, found);
        },

        resolveSync(request) {
            const early = begin(request);

            if ("result" in early) {
                return early.result;
            }

            const found: Array<{ match: RefMatch; rank: SousRef }> = [];

            for (const candidate of early.kept) {
                for (const lookup of early.lookups) {
                    if (lookup.findSync !== undefined && answersFor(lookup, candidate)) {
                        for (const match of lookup.findSync(candidate, ctx)) {
                            found.push({ match, rank: candidate });
                        }
                    }
                }
            }

            return finish(request, early.pruned, found);
        },

        isValid(input, from = "commandLine") {
            try {
                parse(input, from);

                return true;
            } catch {
                return false;
            }
        },

        findInString(text, from = "commandLine") {
            const found: RefInString[] = [];

            for (const word of text.matchAll(/\S+/g)) {
                const bare = word[0].replace(/^[`"'([<{]+/, "").replace(/[`"')\]>},.;:!]+$/, "");

                if (bare.length === 0) {
                    continue;
                }

                try {
                    found.push({ text: bare, index: word.index + word[0].indexOf(bare), result: parse(bare, from) });
                } catch {
                    // Not a ref; the words around it may be.
                }
            }

            return found;
        },
    };
}
