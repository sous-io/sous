import { splitSegments } from "../glob.js";
import { makeInjectable } from "../injectable.js";
import { rangeOf } from "../parts.js";
import { RefSource, SOURCE_LABELS } from "../source.js";
import type { SousRef } from "../types.js";
import { RuleRefPruner, type RefPruneRule } from "./ref-pruner.js";
import { hasLocation } from "./rule-helpers.js";

/** The path of a recipe file ref, or an empty string for any other ref. */
function pathOf(ref: SousRef): string {
  return ref.kind === "recipeFile" ? ref.path : "";
}

/** The spelling a refused include is told to use: `namespace/recipe/path`. */
function instead(ref: SousRef): string {
  if (ref.kind !== "recipeFile") return "'namespace/recipe/path/to/file.md'";
  const namespace = ref.recipe.namespace?.name ?? "namespace";
  return `'${namespace}/${ref.recipe.name}/${ref.path}'`;
}

/**
 * The path of a template include line, once its sigil is taken off. Only a
 * file inside a recipe is allowed, and its path, namespace and recipe name may
 * be globs. A `repo:` qualifier may name the repository by the short name this
 * project gave it. A location never counts, and neither does a version range
 * (the version is the one the project pins).
 */
export class IncludePruner extends RuleRefPruner {
  readonly source = RefSource.Include;
  readonly place = SOURCE_LABELS[RefSource.Include];

  protected rules(): RefPruneRule[] {
    return [
      {
        matches: (ref) => ref.kind !== "recipeFile",
        action: "drop",
        message:
          "an include line names a file inside a recipe: its namespace, its recipe and the " +
          "path inside it.",
        instead,
      },
      {
        matches: hasLocation,
        action: "drop",
        message: "an include line never names a location; it reads the recipes this project pins.",
        instead,
      },
      {
        matches: (ref) => rangeOf(ref) !== undefined,
        action: "drop",
        message:
          "an include line takes no version range; the version of a recipe is the one this " +
          "project pins.",
        instead,
      },
      {
        matches: (ref) => splitSegments(pathOf(ref)).some((part) => part === "." || part === ".."),
        action: "drop",
        message: "the path inside a recipe may not contain '.' or '..' segments.",
        instead,
      },
    ];
  }
}

makeInjectable(IncludePruner);
