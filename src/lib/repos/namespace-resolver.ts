import path from "node:path";
import { escape as escapeGlob } from "glob";
import {
  RefResolveArguments,
  RefSource,
  namespaceOfKey,
  splitRecipeKey,
  sharedRefResolver,
  splitSegments,
  type RecipeFileRef,
} from "../../services/ref-resolver/index.js";
import { LockedRecipeFileLookup } from "./locked-recipe-lookup.js";

/**
 * Namespace addressability for templates: the reserved `~` include sigil.
 *
 * An include line of the form `@~<namespace>/<recipe>/<path>` (and the
 * equivalent `{% render "~<namespace>/<recipe>/<path>" %}`) addresses a recipe
 * rather than the filesystem. The reference is read by the ref resolver service
 * (`RefSource.Include`) and matched against the recipes the project pins, so any
 * form that service allows works: a glob in any name or in the path, a `repo:`
 * qualifier, a name in any case. For example
 *
 *     @~workflow/task-files/_partials/resume.md
 *
 * means "the file `_partials/resume.md` inside recipe `workflow/task-files`".
 * A namespace holds many recipes and each recipe is a directory at its pinned
 * version, so resolution is a lookup from (namespace, recipe) to a directory.
 *
 * A bare `@path` (no `~`) never consults a namespace; it stays a relative path
 * or a declared alias.
 *
 * This module defines only the CONTRACT plus a static, in-memory implementation
 * used by tests. The real implementation (backed by the repository store, the
 * lockfile and linked checkouts) is supplied by the repositories layer and is
 * injected into the compiler, so nothing here reads configuration or disk.
 *
 * Scoping is the resolver's responsibility, which is why every request carries
 * the including file:
 *   - a file that lives inside a recipe may address only that recipe's declared
 *     dependencies (`depends` plus `subscribes`) at their pinned versions;
 *   - a file in the project's own templates may address every recipe the
 *     project's lockfile pins, whatever holds it.
 */

/**
 * Why a recipe a project template asked for is not pinned any more, when that
 * can be known. Only ever attached to an answer for a project template.
 */
export type DroppedRecipe =
  /**
   * Another version of a pinned recipe declares it (in `depends` or
   * `subscribes`), and the version the lockfile pins does not: the usual story
   * of a set that dropped one of its members.
   */
  | {
      by: "recipe";
      recipe: string;
      declaredAt: string;
      pinned: string;
      /** The recipes, no longer pinned either, that the chain ran through, in order. */
      through?: string[];
    }
  /** The project subscribes to it, but the subscription is switched off. */
  | { by: "disabled-subscription"; subscription: string };

/** A single `~` reference resolution request. */
export type NamespaceRequest = {
  /**
   * The reference with its `~` sigil taken off: namespace, recipe and the path
   * inside the recipe (e.g. `workflow/task-files/_partials/resume.md`), as
   * written, possibly with a `repo:` qualifier, globs and a `?name=value` query.
   */
  reference: string;
  /**
   * Absolute path of the file performing the include, used to decide which
   * recipe (if any) is asking. A directory path is accepted for callers that
   * only know the including directory, such as the `{% render %}` filesystem.
   */
  fromFile: string;
};

/**
 * The outcome of a namespace lookup. `candidates` is the success case; the
 * other members carry enough detail to build a precise error message.
 *
 * Implementations may only return these members. Callers should treat any
 * unrecognized `kind` as "no candidates, no specific advice" so the union can
 * grow without breaking older callers.
 */
export type NamespaceResolution =
  /**
   * Ordered absolute paths to try, most preferred first. An empty list means
   * the lookup produced nothing. When `glob` is true the reference was a glob:
   * every candidate is a pattern (the recipe's own directory escaped), and ALL
   * of them are included, in order, not just the first that exists.
   */
  | { kind: "candidates"; candidates: string[]; glob?: true }
  /**
   * No such namespace is known at all. `known` lists the namespaces that are.
   * `dropped` says why a project template's recipe is no longer pinned, when
   * that can be known.
   */
  | { kind: "unknown-namespace"; namespace: string; recipe: string; known: string[]; dropped?: DroppedRecipe }
  /**
   * The namespace exists but holds no such recipe. `recipe` is the fully
   * qualified ref that was asked for; `known` lists the recipe refs the
   * namespace does hold; `dropped` is as above.
   */
  | { kind: "unknown-recipe"; recipe: string; known: string[]; dropped?: DroppedRecipe }
  /**
   * The recipe exists but the including file is not allowed to address it.
   * `recipe` is the fully qualified ref that was asked for. `includingRecipe`
   * is the ref of the recipe the including file belongs to, or `null` when the
   * including file is one of the project's own templates (which only happens
   * when the resolver was given a narrower `projectScope`).
   */
  | { kind: "not-a-dependency"; recipe: string; includingRecipe: string | null }
  /**
   * The reference tried to leave the recipe directory: it carried a `.` or `..`
   * segment, or an absolute inner path. A `~namespace` reference addresses a
   * recipe's own files and nothing else, so this is refused rather than
   * resolved. `reference` is the reference as it was written.
   */
  | { kind: "escapes-recipe"; recipe: string; reference: string }
  /**
   * The reference is not one an include line may hold (it names no file inside
   * a recipe, carries a version range, and so on). `message` is the ref
   * service's own sentence, which says what to write instead.
   */
  | { kind: "invalid"; reference: string; message: string };

/** Resolves `~` references to candidate absolute paths. */
export interface NamespaceResolver {
  /**
   * Resolve one `~` reference.
   *
   * @param request - The reference and the including file.
   * @returns Candidate absolute paths (most preferred first), or a reason the lookup failed.
   */
  resolve(request: NamespaceRequest): NamespaceResolution;
}

/**
 * Render a namespace lookup failure as human-readable lines for an error
 * message. Each line is indented by two spaces so it can be appended directly
 * to the compiler's "Include not found" block.
 *
 * @param opts.fromFile - The file (or directory) that performed the include.
 * @param opts.resolution - What the resolver returned.
 * @returns Indented, newline-joined explanation lines; an empty string when there is nothing to add.
 */
export function formatNamespaceProblem(opts: {
  fromFile: string;
  resolution: NamespaceResolution;
}): string {
  const resolution = opts.resolution;

  if (resolution.kind === "candidates") {
    return "";
  }

  if (resolution.kind === "invalid") {
    return [`in file: ${opts.fromFile}`, `reference: ~${resolution.reference}`, ...resolution.message.split("\n")]
      .map((line) => `  ${line}`)
      .join("\n");
  }

  const namespace =
    resolution.kind === "unknown-namespace"
      ? resolution.namespace
      : namespaceOfKey(resolution.recipe);
  const lines: string[] = [`in file: ${opts.fromFile}`, `namespace: ${namespace}`];

  if (resolution.kind === "unknown-namespace") {
    lines.push(`There is no recipe namespace named "${namespace}" available here.`);
    lines.push(
      resolution.known.length > 0
        ? `Available namespaces: ${resolution.known.join(", ")}.`
        : "This project has no recipe namespaces available yet."
    );
    if (resolution.dropped) lines.push(...describeDropped(resolution.dropped, resolution.recipe));
  } else if (resolution.kind === "unknown-recipe") {
    lines.push(`recipe: ${resolution.recipe}`);
    lines.push(`The namespace "${namespace}" holds no recipe named "${resolution.recipe}".`);
    lines.push(
      resolution.known.length > 0
        ? `Recipes in this namespace: ${resolution.known.join(", ")}.`
        : `The namespace "${namespace}" currently holds no recipes.`
    );
    if (resolution.dropped) lines.push(...describeDropped(resolution.dropped, resolution.recipe));
  } else if (resolution.kind === "not-a-dependency") {
    lines.push(`recipe: ${resolution.recipe}`);
    if (resolution.includingRecipe) {
      lines.push(
        `The recipe "${resolution.includingRecipe}" does not declare "${resolution.recipe}" as a dependency.`
      );
      lines.push(
        `Add "${resolution.recipe}" to the "depends" list in that recipe's manifest before addressing it as "~${namespace}".`
      );
    } else {
      lines.push(`The project's own templates may not address "${resolution.recipe}".`);
    }
  } else if (resolution.kind === "escapes-recipe") {
    lines.push(`recipe: ${resolution.recipe}`);
    lines.push(
      `The reference "~${resolution.reference}" points outside the recipe "${resolution.recipe}".`
    );
    lines.push(
      `A "~namespace" reference addresses a recipe's own files, so it may not contain ` +
        `"." or ".." segments and may not be an absolute path.`
    );
    lines.push(
      `Write the path of a file inside the recipe, or include the other file by a ` +
        `relative path or a declared alias.`
    );
  }

  return lines.map((line) => `  ${line}`).join("\n");
}

/**
 * The lines that say why a recipe a project template asked for is no longer
 * pinned, and what brings it back.
 *
 * @param dropped - What is known about how the recipe used to be pinned.
 * @param recipe - The `namespace/recipe` the template asked for.
 */
function describeDropped(dropped: DroppedRecipe, recipe: string): string[] {
  if (dropped.by === "disabled-subscription") {
    return [
      `This project subscribes to "${dropped.subscription}", but that subscription is ` +
        `switched off ("enabled: false"), so the lockfile does not pin "${recipe}".`,
      `Switch the subscription back on, or remove the include.`,
    ];
  }
  const through =
    dropped.through === undefined || dropped.through.length === 0
      ? ""
      : ` (through ${dropped.through.map((key) => `"${key}"`).join(", ")})`;
  return [
    `Version ${dropped.declaredAt} of "${dropped.recipe}" brought "${recipe}" in${through}, but ` +
      `the version this project pins, ${dropped.pinned}, does not, so the lockfile no longer ` +
      `pins it.`,
    `Subscribe to "${recipe}" directly to keep including it, or remove the include.`,
  ];
}

/** Options for {@link StaticNamespaceResolver}. */
export type StaticNamespaceResolverOptions = {
  /**
   * Every known recipe, mapping the fully qualified ref `<namespace>/<recipe>`
   * to the absolute directory holding that recipe's files at its pinned
   * version. These directories double as the recipe roots used to decide which
   * recipe an including file belongs to.
   */
  recipes: Record<string, string>;
  /**
   * What each recipe declares, mapping `<namespace>/<recipe>` to the keys it
   * may address. An entry is a recipe key (`workflow/task-files`) or a bare
   * namespace (`workflow`, meaning every recipe in it), already settled from
   * however the manifest wrote it. A recipe with no entry declares nothing and
   * may address only itself.
   */
  dependencies?: Record<string, string[]>;
  /**
   * What the project's own templates may address, as the same kind of keys as
   * `dependencies`. Omit it to make every known recipe addressable from
   * project templates, which is the rule for a real project: its templates may
   * address everything its lockfile pins.
   */
  projectScope?: string[];
  /**
   * Says why a recipe a project template asked for is not among `recipes`,
   * when that can be known. Consulted only for a project template's reference
   * to a recipe the resolver does not know.
   */
  explainMissing?: (recipe: string) => DroppedRecipe | undefined;
  /**
   * The short name of the repository each recipe came from, keyed like
   * `recipes`. It is what a `repo:` qualifier in an include line is matched
   * against; a recipe with no entry matches no qualifier.
   */
  repos?: Record<string, string>;
};

/**
 * A dependency-free, in-memory {@link NamespaceResolver} built from a map of
 * recipe refs to directories.
 *
 * It implements the full scoping rule (recipe files see their declared
 * dependencies; project files see every known recipe, or `projectScope`) without knowing
 * anything about repositories, versions or the store, which makes it the
 * resolver used by tests and a usable core for the real implementation to wrap.
 */
export class StaticNamespaceResolver implements NamespaceResolver {
  private readonly recipes: Record<string, string>;
  private readonly dependencies: Record<string, string[]>;
  private readonly projectScope?: string[];
  private readonly explainMissing?: (recipe: string) => DroppedRecipe | undefined;
  private readonly lookup: LockedRecipeFileLookup;

  constructor(options: StaticNamespaceResolverOptions) {
    this.recipes = {};
    for (const [ref, dir] of Object.entries(options.recipes)) {
      this.recipes[ref] = path.resolve(dir);
    }
    this.dependencies = options.dependencies ?? {};
    this.projectScope = options.projectScope;
    this.explainMissing = options.explainMissing;
    this.lookup = new LockedRecipeFileLookup(
      Object.keys(this.recipes).map((key) => {
        const recipe = splitRecipeKey(key);
        const repo = options.repos?.[key];
        return {
          namespace: recipe.namespace,
          name: recipe.name ?? "",
          ...(repo === undefined ? {} : { repo }),
        };
      })
    );
  }

  /**
   * Why a project template's reference names a recipe this resolver does not
   * know, or undefined when the including file is a recipe's own or nothing is
   * known.
   */
  private droppedFor(recipe: string, fromFile: string): { dropped?: DroppedRecipe } {
    if (this.explainMissing === undefined || this.includingRecipe(fromFile) !== null) return {};
    const dropped = this.explainMissing(recipe);
    return dropped === undefined ? {} : { dropped };
  }

  /**
   * The ref of the recipe whose directory contains `fromFile`, or null when the
   * file lives outside every recipe (a project template). The deepest matching
   * recipe directory wins, so nested layouts resolve to the innermost recipe.
   */
  private includingRecipe(fromFile: string): string | null {
    const target = path.resolve(fromFile);
    let best: string | null = null;
    let bestLength = -1;

    for (const [ref, dir] of Object.entries(this.recipes)) {
      if (!isInside(dir, target)) continue;
      if (dir.length > bestLength) {
        best = ref;
        bestLength = dir.length;
      }
    }

    return best;
  }

  /**
   * The answer for a reference the ref service refused: a path that climbs out
   * of the recipe is `escapes-recipe`, and anything else is `invalid`, with the
   * service's own sentence.
   */
  private refused(reference: string, error: unknown): NamespaceResolution {
    const resolver = sharedRefResolver();
    try {
      const { dropped } = resolver.inspect(reference, RefSource.Include);
      for (const entry of dropped) {
        if (entry.ref.kind !== "recipeFile") continue;
        if (splitSegments(entry.ref.path).some((part) => part === "." || part === "..")) {
          return {
            kind: "escapes-recipe",
            recipe: `${entry.ref.recipe.namespace?.name ?? ""}/${entry.ref.recipe.name}`,
            reference,
          };
        }
      }
    } catch {
      // Not a ref in any reading; the original refusal says why.
    }
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "invalid", reference, message };
  }

  resolve(request: NamespaceRequest): NamespaceResolution {
    const { reference, fromFile } = request;
    const resolver = sharedRefResolver();

    let result;
    try {
      result = resolver.resolveSync(new RefResolveArguments({
        input: reference,
        from: RefSource.Include,
        lookup: this.lookup,
        kinds: ["recipeFile"],
      }));
    } catch (error) {
      return this.refused(reference, error);
    }

    // The reading the caller meant: of a `?name=value` that could also be part
    // of a glob, the one that read it as values comes first.
    const { kept } = resolver.inspect(reference, RefSource.Include);
    const written = (kept.find((ref) => ref.vars !== undefined) ?? kept[0]) as RecipeFileRef;
    const namespaceName = written.recipe.namespace?.name ?? "";
    const wanted = `${namespaceName}/${written.recipe.name}`;

    const matched = result.refs.filter((ref): ref is RecipeFileRef => ref.kind === "recipeFile");
    if (matched.length === 0) {
      if (written.glob === true) return { kind: "candidates", candidates: [], glob: true };
      if (!this.lookup.knowsNamespace(namespaceName)) {
        return {
          kind: "unknown-namespace",
          namespace: namespaceName,
          recipe: wanted,
          known: this.lookup.namespaces(),
          ...this.droppedFor(wanted, fromFile),
        };
      }
      return {
        kind: "unknown-recipe",
        recipe: wanted,
        known: this.lookup.recipesInNamespace(namespaceName),
        ...this.droppedFor(wanted, fromFile),
      };
    }

    const includingRecipe = this.includingRecipe(fromFile);
    const declared = includingRecipe
      ? [includingRecipe, ...(this.dependencies[includingRecipe] ?? [])]
      : this.projectScope;

    const candidates: string[] = [];
    for (const ref of matched) {
      const key = `${ref.recipe.namespace?.name ?? ""}/${ref.recipe.name}`;
      const recipeDir = this.recipes[key];
      if (recipeDir === undefined) continue;

      if (declared !== undefined && !declaresRef(declared, ref.recipe.namespace?.name ?? "", key)) {
        if (written.glob === true) continue;
        return { kind: "not-a-dependency", recipe: key, includingRecipe };
      }

      if (written.glob === true) {
        candidates.push(`${escapeGlob(recipeDir)}/${ref.path}`);
        continue;
      }

      const resolved = path.resolve(recipeDir, ref.path);
      // A `~` reference addresses a recipe's own files. The ref service already
      // refuses `.` and `..` segments; this catches whatever else would leave
      // the recipe directory, so a reference can never have the compiler render
      // anything on the machine into the project's output.
      if (escapesRecipe(recipeDir, resolved)) {
        return { kind: "escapes-recipe", recipe: key, reference };
      }
      candidates.push(resolved);
    }

    return written.glob === true
      ? { kind: "candidates", candidates, glob: true }
      : { kind: "candidates", candidates };
  }
}

/**
 * Whether a resolved path sits outside the recipe directory.
 *
 * @param recipeDir - The recipe's absolute directory.
 * @param resolved - What the inner path resolved to.
 */
function escapesRecipe(recipeDir: string, resolved: string): boolean {
  if (resolved === recipeDir) return false;
  const relative = path.relative(recipeDir, resolved);
  return relative === "" || relative.startsWith("..") || path.isAbsolute(relative);
}

/**
 * Whether a list of declared keys covers a recipe, either by naming the recipe
 * itself or by naming its whole namespace. The keys are already settled
 * (`namespace` or `namespace/recipe`): whatever form a manifest wrote a
 * dependency in, the lockfile records the key it resolved to.
 *
 * @param declared - Declared keys (dependencies, or the project's subscriptions).
 * @param namespace - The namespace being addressed.
 * @param ref - The fully qualified recipe ref being addressed.
 * @returns True when the reference is in scope.
 */
function declaresRef(declared: string[], namespace: string, ref: string): boolean {
  return declared.some((entry) => entry === ref || entry === namespace);
}

/**
 * Whether `target` is the directory `dir` itself or sits underneath it.
 *
 * @param dir - An absolute directory path.
 * @param target - An absolute file or directory path.
 * @returns True when target is inside dir.
 */
function isInside(dir: string, target: string): boolean {
  return target === dir || target.startsWith(dir + path.sep);
}
