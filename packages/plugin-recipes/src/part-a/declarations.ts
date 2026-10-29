/**
 * How one recipe brings in another (S6, `recipes.declarations`; ported from
 * `src/lib/repos/declarations.ts`).
 *
 * A manifest lists what it brings in under `depends` and `subscribes`, and one recipe can be covered
 * by more than one entry: `subscribes: [workflow]` covers every recipe of `workflow`, and
 * `depends: [workflow/task-files]` names one of them again. Every reader applies the one rule here:
 *
 * - an entry naming the recipe wins over a namespace entry covering it;
 * - between two entries naming it, the later one (in `depends`, then `subscribes` order) wins, and
 *   between two namespace entries, the first;
 * - the kind is `subscribes` when any covering entry is a co-subscription.
 */

import type { DependencyKind } from "@sous-io/plugin-formats/types";
import type { NamedRef, RefsFormat, RefsResolver, SousRef } from "@sous-io/plugin-refs/types";
import type { DependencyDeclaration, RecipesDeclarations } from "../types.js";

/** A manifest's or published version's two lists. */
export interface DependencySource {
    readonly depends?: readonly string[];
    readonly subscribes?: readonly string[];
}

/** One entry covering a recipe, as the fold sees it. */
export interface CoveringEntry {
    readonly written: string;
    readonly kind: DependencyKind;
    readonly named: boolean;
    readonly ref: NamedRef;
}

/**
 * Folds one more covering entry into what earlier entries said, by the rule above.
 *
 * ```ts
 * foldDeclaration(undefined, { written: "workflow", kind: "subscribes", named: false, ref });
 * // { declared: "workflow", kind: "subscribes", named: false, ref }
 * ```
 */
export function foldDeclaration(before: DependencyDeclaration | undefined, entry: CoveringEntry): DependencyDeclaration {
    const keepBefore = before !== undefined && !entry.named;

    return {
        declared: keepBefore ? before.declared : entry.written.trim(),
        ref: keepBefore ? before.ref : entry.ref,
        kind: before?.kind === "subscribes" || entry.kind === "subscribes" ? "subscribes" : "depends",
        named: entry.named || before?.named === true,
    };
}

function isNamed(ref: SousRef): ref is NamedRef {
    return ref.kind === "namespace" || ref.kind === "recipe";
}

/** `recipes.declarations`: reads entries through the ref services of the config it is made for. */
export class Declarations implements RecipesDeclarations {
    constructor(
        private readonly resolver: () => RefsResolver,
        private readonly format: () => RefsFormat,
    ) {}

    of(source: DependencySource): DependencyDeclaration[] {
        const found: DependencyDeclaration[] = [];

        for (const [kind, entries] of this.lists(source)) {
            for (const written of entries) {
                const ref = this.readings(written)[0];

                if (ref) {
                    found.push({ declared: written.trim(), kind, ref, named: ref.kind === "recipe" });
                }
            }
        }

        return found;
    }

    covering(source: DependencySource, key: string): DependencyDeclaration | undefined {
        const format = this.format();
        let gathered: DependencyDeclaration | undefined;

        // The fold reads depends first, then subscribes, so the later list wins between named entries.
        for (const [kind, entries] of [...this.lists(source)].reverse()) {
            for (const written of entries) {
                for (const ref of this.readings(written)) {
                    const named = ref.kind === "recipe";
                    const covers = named ? format.key(ref) === key : format.namespaceOfKey(key) === ref.name;

                    if (covers) {
                        gathered = foldDeclaration(gathered, { written, kind, named, ref });
                        break;
                    }
                }
            }
        }

        return gathered;
    }

    /** `subscribes` first, as `of` lists them. */
    private lists(source: DependencySource): Array<[DependencyKind, readonly string[]]> {
        return [
            ["subscribes", source.subscribes ?? []],
            ["depends", source.depends ?? []],
        ];
    }

    /** Every namespace or recipe reading of an entry; an entry that does not parse covers nothing. */
    private readings(written: string): NamedRef[] {
        try {
            return this.resolver().parse(written, "manifest").refs.filter(isNamed);
        } catch {
            return [];
        }
    }
}

/**
 * Says how a declaration brings a recipe in, the way a person would.
 *
 * ```ts
 * describeDeclaration({ declared: "workflow", ref: { kind: "namespace", name: "workflow" } });
 * // "the whole 'workflow' namespace"
 * ```
 */
export function describeDeclaration(declaration: Pick<DependencyDeclaration, "declared" | "ref">): string {
    if (declaration.ref.kind === "namespace") {
        const identity = declaration.ref.repo?.location?.identity;

        return identity === undefined
            ? `the whole '${declaration.ref.name}' namespace`
            : `the whole '${declaration.ref.name}' namespace of ${identity}`;
    }

    return declaration.declared;
}
