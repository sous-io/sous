/**
 * How one recipe brings in another: which entry of its manifest names it, and
 * whether that entry is a co-subscription or a build dependency.
 *
 * A manifest lists what it brings in under `depends` and `subscribes`, and one
 * recipe can be covered by more than one entry: `subscribes: [workflow]` covers
 * every recipe of the `workflow` namespace, and `depends: [workflow/task-files]`
 * names one of them again. Three places need one answer per recipe, and they
 * must agree: a release recording the answer in the index, `sous recipe show`
 * describing a recipe whose manifest it can read, and the resolver walking a
 * recipe whose manifest it cannot. This module is that one answer, and its
 * reverse.
 */

import type { DependencyKind } from "./formats/common.js";
import type { IndexVersion } from "./formats/index-file.js";
import {
  RefSource,
  isNamedRef,
  locationOf,
  namespaceOfKey,
  settleDependency,
  shortKey,
  sharedRefResolver,
  type RecordedDependencies,
} from "../../services/ref-resolver/index.js";

/** A manifest's two dependency lists, each entry exactly as it was written. */
export type DependencyLists = {
  /** Build dependencies: fetched and addressable, never in the project's output. */
  depends: string[];
  /** Co-subscriptions: their files land and their questions are asked. */
  subscribes: string[];
};

/** How one recipe is brought in by the manifest that declares it. */
export type DependencyDeclaration = {
  /**
   * The manifest entry that brings it in, as written. An entry naming the
   * recipe wins over a namespace entry that also covers it; between two
   * entries naming it, the later one (in `depends`, then `subscribes` order)
   * wins, and between two namespace entries, the first.
   */
  declared: string;
  /** `subscribes` when any entry covering the recipe is a co-subscription. */
  kind: DependencyKind;
};

/** A declaration being gathered, entry by entry. */
export type GatheredDeclaration = DependencyDeclaration & {
  /** True when an entry named the recipe itself rather than its namespace. */
  named: boolean;
};

/** One manifest entry covering a recipe. */
export type CoveringEntry = {
  /** The entry as written. */
  written: string;
  /** The list it sits in. */
  kind: DependencyKind;
  /** True when it names the recipe itself rather than a namespace holding it. */
  named: boolean;
};

/**
 * Folds one more manifest entry covering a recipe into what is known about the
 * recipe's declaration, by the rule `DependencyDeclaration` states. Every
 * reader applies this one function, entry by entry in manifest order
 * (`depends` first, then `subscribes`).
 *
 * foldDeclaration(undefined, { written: "workflow", kind: "subscribes", named: false })
 * // -> { declared: "workflow", kind: "subscribes", named: false }
 *
 * @param before - What the earlier entries said, when any covered the recipe.
 * @param entry - The next entry covering it.
 */
export function foldDeclaration(
  before: GatheredDeclaration | undefined,
  entry: CoveringEntry
): GatheredDeclaration {
  const keepBefore = before !== undefined && !entry.named;
  return {
    declared: keepBefore ? before.declared : entry.written.trim(),
    kind: before?.kind === "subscribes" || entry.kind === "subscribes" ? "subscribes" : "depends",
    named: entry.named || before?.named === true,
  };
}

/**
 * The declaration that brings one recipe in, or undefined when no entry of the
 * lists covers it. An entry that reads more than one way is settled from what
 * the version's index entry recorded, and one that cannot be settled, or does
 * not parse, covers nothing.
 *
 * declarationFor({ depends: ["workflow/a"], subscribes: ["workflow"] }, "workflow/a")
 * // -> { declared: "workflow/a", kind: "subscribes" }
 *
 * @param lists - The declaring recipe's `depends` and `subscribes` lists.
 * @param key - The recipe being asked about, `namespace/recipe`.
 * @param recorded - What the declaring version's index entry records, for settling.
 */
export function declarationFor(
  lists: Partial<DependencyLists>,
  key: string,
  recorded?: RecordedDependencies
): DependencyDeclaration | undefined {
  let gathered: GatheredDeclaration | undefined;

  for (const [kind, entries] of [
    ["depends", lists.depends ?? []],
    ["subscribes", lists.subscribes ?? []],
  ] as Array<[DependencyKind, string[]]>) {
    for (const written of entries) {
      let reading;
      try {
        reading = settleDependency(written, recorded === undefined ? {} : { recorded });
      } catch {
        // An entry that does not parse is reported wherever the manifest is
        // validated; here it simply covers nothing.
        continue;
      }
      if (reading === undefined || !isNamedRef(reading)) continue;

      const named = reading.kind === "recipe";
      const covers = named
        ? shortKey(reading) === key
        : namespaceOfKey(key) === reading.name;
      if (covers) gathered = foldDeclaration(gathered, { written, kind, named });
    }
  }

  return gathered === undefined ? undefined : { declared: gathered.declared, kind: gathered.kind };
}

/**
 * The manifest lists a version's index entry records, or undefined when it
 * records neither (a version recorded before the index described recipes).
 * That is what lets the resolver walk a recipe whose files are not on this
 * machine exactly as it would walk its manifest.
 *
 * indexDependencyLists({ subscribes: ["workflow"], depends: [] , ... })
 * // -> { depends: [], subscribes: ["workflow"] }
 *
 * @param version - The version's index entry.
 */
export function indexDependencyLists(
  version: Pick<IndexVersion, "depends" | "subscribes">
): DependencyLists | undefined {
  if (version.depends === undefined && version.subscribes === undefined) return undefined;
  return { depends: [...(version.depends ?? [])], subscribes: [...(version.subscribes ?? [])] };
}

/**
 * Says how a declaration brings a recipe in, the way a person would: a whole
 * namespace is named as one, and anything else is shown as it was written.
 *
 * describeDeclaration("workflow")             // -> "the whole 'workflow' namespace"
 * describeDeclaration("workflow/task-files")  // -> "workflow/task-files"
 *
 * @param declared - The manifest entry, as written.
 */
export function describeDeclaration(declared: string): string {
  try {
    const { refs } = sharedRefResolver().parse(declared, RefSource.Manifest);
    const only = refs[0]!;
    if (refs.length === 1 && only.kind === "namespace") {
      const location = locationOf(only);
      return location === undefined
        ? `the whole '${only.name}' namespace`
        : `the whole '${only.name}' namespace of ${location.identity}`;
    }
  } catch {
    // Shown as it was written; the reader sees the bad entry.
  }
  return declared;
}

/**
 * Plain-language wording for a dependency kind.
 *
 * @param kind - The kind, when it is known.
 */
export function describeDependencyKind(kind: DependencyKind | undefined): string {
  if (kind === "depends") return "build dependency";
  if (kind === "subscribes") return "co-subscription";
  return "not recorded";
}
