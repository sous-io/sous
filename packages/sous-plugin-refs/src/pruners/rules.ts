/**
 * Pruners made of rules: the place a ref was written decides which readings of it count. A refused
 * reading carries its reason and what to write instead, so a refused ref is an error that says how
 * to fix it.
 */

import { ConfigError, type ServiceContext } from "@sous-io/plugin-api";
import { locationOf, repoOf } from "../parts.js";
import type { DroppedRef, RefPruneResult, RefPrunerEntity, RefSource, SousRef } from "../types.js";

/** What each built-in place is called in a sentence. */
export const SOURCE_LABELS: Readonly<Record<string, string>> = {
    commandLine: "on the command line",
    config: "as a subscription key in a config file",
    manifest: "in a recipe manifest's 'depends' or 'subscribes' list",
    lockfile: "as a key sous stores",
    include: "in an include line",
};

/** What a rule does with a reading it matches. */
export type RefPruneAction = "drop" | "warn" | "throw";

/** The text of a rule's message: fixed, or made from the reading, what was written and the context. */
export type RefRuleText = string | ((ref: SousRef, input: string, ctx: ServiceContext) => string);

/** One rule: when it matches a reading, what it does and why. */
export interface RefPruneRule {
    /** True when the rule applies to this reading. */
    matches(ref: SousRef, input: string): boolean;
    /** `drop` removes the reading, `warn` keeps it with a warning, `throw` fails at once. */
    action: RefPruneAction;
    /** Why the place refuses the reading, or what is wrong with it. */
    message: RefRuleText;
    /** What to write instead, as it would appear after "Write". */
    instead?: RefRuleText;
}

/** What a rule pruner is made of. */
export interface RulePrunerOptions {
    id: string;
    source: RefSource;
    /** Default: the built-in label for the place. */
    place?: string;
    /** Tried in order; the first that matches a reading decides, and a reading none matches is kept. */
    rules: readonly RefPruneRule[];
    /** Rewrites a kept reading (a manifest stores lowercase names). */
    normalize?: (ref: SousRef) => SousRef;
}

function textOf(text: RefRuleText, ref: SousRef, input: string, ctx: ServiceContext): string {
    return typeof text === "function" ? text(ref, input, ctx) : text;
}

/**
 * A `ref-pruner` entity from an ordered list of rules.
 *
 * ```ts
 * sous.entities.add("ref-pruner", rulePruner({
 *     id: "no-globs-in-reports",
 *     source: "report",
 *     place: "in a report filter",
 *     rules: [{ matches: (ref) => ref.glob === true, action: "drop", message: "a glob is not a name." }],
 * }));
 * ```
 */
export function rulePruner(options: RulePrunerOptions): RefPrunerEntity {
    const normalize = options.normalize ?? ((ref: SousRef) => ref);

    return {
        id: options.id,
        source: options.source,
        place: options.place ?? SOURCE_LABELS[options.source] ?? `as '${options.source}'`,
        prune(candidates, input, ctx): RefPruneResult {
            const kept: SousRef[] = [];
            const dropped: DroppedRef[] = [];
            const warnings: string[] = [];

            for (const ref of candidates) {
                const rule = options.rules.find((entry) => entry.matches(ref, input));

                if (rule === undefined) {
                    kept.push(normalize(ref));
                    continue;
                }

                const message = textOf(rule.message, ref, input, ctx);

                if (rule.action === "throw") {
                    throw new ConfigError(message);
                }

                if (rule.action === "warn") {
                    kept.push(normalize(ref));
                    warnings.push(message);
                    continue;
                }

                dropped.push(rule.instead === undefined ? { ref, reason: message } : { ref, reason: message, instead: textOf(rule.instead, ref, input, ctx) });
            }

            return { kept, dropped, warnings };
        },
    };
}

/** The reason a reading was dropped, with what to write instead on a line of its own. */
export function describeDropped(dropped: DroppedRef): string {
    return dropped.instead === undefined ? dropped.reason : `${dropped.reason}\n    Write ${dropped.instead} instead.`;
}

/** True when the ref names a repository on this machine. */
export function isLocal(ref: SousRef): boolean {
    return locationOf(ref)?.provider === "local";
}

/** True when the ref names where its repository lives. */
export function hasLocation(ref: SousRef): boolean {
    return locationOf(ref) !== undefined;
}

/** True when the ref is qualified by a repository short name (`repo:`). */
export function hasRepoName(ref: SousRef): boolean {
    return ref.kind !== "repo" && repoOf(ref)?.name !== undefined;
}

/** The sentence for a reading that is not a name a place can hold. */
export const KEBAB_REASON =
    "only a namespace or a recipe can be named here, and their names must be kebab-case: " +
    "a letter, then letters, digits or hyphens.";
