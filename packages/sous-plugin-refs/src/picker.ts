/**
 * `refs.picker`: settling on one of the things a ref could have meant.
 *
 * Resolving is separate from choosing on purpose: the resolver says everything a ref could mean,
 * and this is the one place that decides which the run proceeds with, so a word that means two
 * things behaves the same in every command:
 *
 *   - one match proceeds, and what it resolved to is reported;
 *   - several matches are offered through the chain's prompter;
 *   - `--accept-first` takes the first one in the listing order;
 *   - a run that cannot ask fails, naming the question and the flag that answers it.
 */

import { ConfigError, NonInteractiveError } from "@sous-io/plugin-api";
import { formatter, refKey } from "./format.js";
import { KIND_LABELS, namespaceOf, recipeOf, repoOf } from "./parts.js";
import type { RefPickIo, RefPickOptions, RefsLocations, RefsPicker, ResolvedRefFacts, SousRef } from "./types.js";

/** The flag that answers "which one did you mean?" ahead of time. */
export const ACCEPT_FIRST_FLAG = "--accept-first";

/**
 * The facts one resolved ref carries. What a ref resolves to is its fully qualified key; for an
 * environment variable name, the key of the variable it answers, which is what the run proceeds
 * with. A repository's own name is the resolved spelling already, so it is not repeated.
 */
export function resolvedRefFacts(ref: SousRef, search: string, reason?: string): ResolvedRefFacts {
    const subject = ref.kind === "envVar" ? (ref.variables?.[0] ?? ref) : ref;
    const resolvedTo = refKey(subject);
    const repoName = repoOf(subject)?.name;
    const recipe = recipeOf(subject);
    const namespace = namespaceOf(subject);

    return {
        search,
        resolvedTo,
        kind: KIND_LABELS[ref.kind],
        ...(subject.kind === "variable" ? { variable: subject.name } : {}),
        ...(recipe === undefined || subject.kind === "namespace" ? {} : { recipe: recipe.name }),
        ...(namespace === undefined ? {} : { namespace: namespace.name }),
        ...(repoName === undefined || repoName === resolvedTo ? {} : { repository: repoName }),
        ...(ref.kind === "repo" && ref.location !== undefined ? { location: ref.location.url } : {}),
        ...(ref.kind !== "repo" && subject.description !== undefined ? { description: subject.description } : {}),
        ...(reason === undefined ? {} : { reason }),
    };
}

/** The sentence closing a report: why this candidate won. */
export function reasonOf(facts: ResolvedRefFacts): string {
    return facts.reason ?? `'${facts.search}' named one ${facts.kind}, and nothing else, so that is what is being used.`;
}

/** Makes `refs.picker`, writing refs with the hosts `locations` knows. */
export function createRefsPicker(locations: () => RefsLocations): RefsPicker {
    const { spelling, describe } = formatter(locations);

    const announce = (io: RefPickIo, ref: SousRef, search: string, reason?: string): void => {
        const facts = resolvedRefFacts(ref, search, reason);

        io.reporter.resolvedReference(reasonOf(facts), facts);
    };

    return {
        facts: resolvedRefFacts,

        async pick(matches, options, io) {
            const { search } = options;
            const shouldAnnounce = options.announce ?? true;

            if (matches.length === 0) {
                throw new ConfigError(`Nothing called '${search}' was found.`, { details: options.details ?? [] });
            }

            const first = matches[0]!;

            if (matches.length === 1) {
                if (shouldAnnounce) {
                    announce(io, first, search);
                }

                return first;
            }

            if (options.acceptFirst === true) {
                const reason = `'${search}' named ${matches.length} things, and '${ACCEPT_FIRST_FLAG}' was passed, so the first one listed is being used.`;

                // A caller that reports the resolution itself is still told the word was ambiguous.
                if (shouldAnnounce) {
                    announce(io, first, search, reason);
                } else {
                    io.reporter.notice(reason);
                }

                return first;
            }

            const message = options.prompt ?? `Which '${search}' did you mean?`;

            if (!io.prompter.interactive) {
                // The example says more than what was typed, so a ref that is its own fully
                // qualified name is not offered back unchanged.
                const example = spelling(matches.find((match) => spelling(match) !== search) ?? first);

                throw new NonInteractiveError(message, ACCEPT_FIRST_FLAG, {
                    details: [
                        `'${search}' matched ${matches.length} things:`,
                        ...matches.map((match) => `  ${describe(match)}`),
                        `Write the full reference (for example '${example}'), or pass '${ACCEPT_FIRST_FLAG}' to take the first one listed.`,
                    ],
                });
            }

            return io.prompter.askChoice({
                message,
                answeredBy: ACCEPT_FIRST_FLAG,
                choices: matches.map((match) => ({ label: describe(match), value: match })),
            });
        },
    };
}
