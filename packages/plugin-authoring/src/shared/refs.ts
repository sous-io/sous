/**
 * Reading the `depends` and `subscribes` entries of a manifest through plugin-refs, and the few
 * facts a release needs from each reading.
 */

import type { DependencyKind } from "@sous-io/plugin-formats/types";
import type { DependencyDeclaration } from "@sous-io/plugin-recipes/types";
import type { NamedRef, RefLocation, SousRef } from "@sous-io/plugin-refs/types";
import type { AuthoringTools } from "../tools.js";

/** Every reading of one manifest entry, or `undefined` when it does not parse (validation reports it). */
export function readingsOf(tools: AuthoringTools, written: string): SousRef[] | undefined {
    try {
        return tools.refs.parse(written.trim(), "manifest").refs;
    } catch {
        return undefined;
    }
}

/** Whether a ref names a namespace or a recipe. */
export function isNamedRef(ref: SousRef): ref is NamedRef {
    return ref.kind === "namespace" || ref.kind === "recipe";
}

/** Where a ref says its repository lives, or `undefined` for one in this same repository. */
export function locationOf(tools: AuthoringTools, ref: SousRef): RefLocation | undefined {
    if (ref.kind === "repo") {
        return ref.location;
    }

    return tools.format.partsOf(ref).repo?.location;
}

/** The range a ref was written with. */
export function rangeOf(tools: AuthoringTools, ref: SousRef): string | undefined {
    if (ref.kind === "repo") {
        return ref.range;
    }

    return tools.format.partsOf(ref).range;
}

/** The namespace a ref sits in. */
export function namespaceNameOf(tools: AuthoringTools, ref: SousRef): string | undefined {
    if (ref.kind === "namespace") {
        return ref.name;
    }

    return tools.format.partsOf(ref).namespace?.name;
}

/** The stored `namespace/recipe` key of a recipe ref. */
export function keyOf(tools: AuthoringTools, ref: SousRef): string {
    return tools.format.key(ref);
}

/** One manifest entry covering a recipe. */
export interface CoveringEntry {
    readonly written: string;
    readonly kind: DependencyKind;
    /** True when it names the recipe itself, not a namespace holding it. */
    readonly named: boolean;
}

/** What is known so far about which entry brings a recipe in. */
export interface GatheredDeclaration {
    readonly declared: string;
    readonly kind: DependencyKind;
    readonly named: boolean;
}

/**
 * Folds one more entry covering a recipe into its declaration: an entry naming the recipe wins over a
 * namespace entry; between two naming it, the later one; between two namespace entries, the first. It
 * is a co-subscription when any covering entry is one.
 *
 * Used only where `recipes.declarations` cannot answer: an entry a release settled from several
 * readings, which the published index does not record yet.
 */
export function foldDeclaration(before: GatheredDeclaration | undefined, entry: CoveringEntry): GatheredDeclaration {
    const keepBefore = before !== undefined && !entry.named;

    return {
        declared: keepBefore ? before.declared : entry.written.trim(),
        kind: before?.kind === "subscribes" || entry.kind === "subscribes" ? "subscribes" : "depends",
        named: entry.named || before?.named === true,
    };
}

/**
 * The declaration that brings a recipe in, from `recipes.declarations` when it can say, and from the
 * entries gathered here otherwise.
 */
export function declarationFor(
    tools: AuthoringTools,
    source: { readonly depends?: readonly string[]; readonly subscribes?: readonly string[] },
    key: string,
    gathered: GatheredDeclaration | undefined,
): Pick<DependencyDeclaration, "declared" | "kind"> | undefined {
    const owned = tools.declarations?.covering(source, key);

    if (owned !== undefined) {
        return { declared: owned.declared, kind: owned.kind };
    }

    return gathered === undefined ? undefined : { declared: gathered.declared, kind: gathered.kind };
}
