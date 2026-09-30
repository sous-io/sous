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
import type { IndexDependency } from "./formats/index-file.js";
import { dependencyRefKey, parseDependencyRef } from "./ref.js";

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
   * entries of the same form, the later one (in `depends`, then `subscribes`
   * order) wins.
   */
  declared: string;
  /** `subscribes` when any entry covering the recipe is a co-subscription. */
  kind: DependencyKind;
};

/**
 * The declaration that brings one recipe in, or undefined when no entry of the
 * lists covers it.
 *
 * declarationFor({ depends: ["workflow/a"], subscribes: ["workflow"] }, "workflow/a")
 * // -> { declared: "workflow/a", kind: "subscribes" }
 *
 * @param lists - The declaring recipe's `depends` and `subscribes` lists.
 * @param key - The recipe being asked about, `namespace/recipe`.
 */
export function declarationFor(
  lists: Partial<DependencyLists>,
  key: string
): DependencyDeclaration | undefined {
  let named: string | undefined;
  let namespace: string | undefined;
  let subscribed = false;

  for (const [kind, entries] of [
    ["depends", lists.depends ?? []],
    ["subscribes", lists.subscribes ?? []],
  ] as Array<[DependencyKind, string[]]>) {
    for (const written of entries) {
      let parsed;
      try {
        parsed = parseDependencyRef(written);
      } catch {
        // An entry that does not parse is reported wherever the manifest is
        // validated; here it simply covers nothing.
        continue;
      }

      if (parsed.recipe !== undefined) {
        if (dependencyRefKey(parsed) !== key) continue;
        named = written.trim();
      } else {
        if (!key.startsWith(`${parsed.namespace}/`)) continue;
        namespace ??= written.trim();
      }
      if (kind === "subscribes") subscribed = true;
    }
  }

  const declared = named ?? namespace;
  if (declared === undefined) return undefined;
  return { declared, kind: subscribed ? "subscribes" : "depends" };
}

/**
 * The dependency lists a version's index entry stands for, rebuilt from the
 * `declared` and `kind` each recorded dependency carries, or undefined when
 * the entry does not record them. That is what lets the resolver walk a recipe
 * whose files are not on this machine exactly as it would walk its manifest.
 *
 * indexDependencyLists({
 *   "workflow/a": { version: "1.0.0", declared: "workflow", kind: "subscribes" },
 *   "workflow/b": { version: "1.2.0", declared: "workflow", kind: "subscribes" },
 * })
 * // -> { depends: [], subscribes: ["workflow"] }
 *
 * @param dependencies - The version's recorded dependencies, when it records any.
 */
export function indexDependencyLists(
  dependencies: Record<string, IndexDependency> | undefined
): DependencyLists | undefined {
  if (dependencies === undefined) return undefined;

  const lists: DependencyLists = { depends: [], subscribes: [] };
  for (const entry of Object.values(dependencies)) {
    if (entry.declared === undefined || entry.kind === undefined) return undefined;
    const list = lists[entry.kind];
    if (!list.includes(entry.declared)) list.push(entry.declared);
  }
  return lists;
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
    const parsed = parseDependencyRef(declared);
    if (parsed.recipe === undefined) return `the whole '${parsed.namespace}' namespace`;
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
