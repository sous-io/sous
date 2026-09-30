import path from "node:path";

/**
 * Namespace addressability for templates: the reserved `~` include sigil.
 *
 * An include line of the form `@~<namespace>/<rest>` (and the equivalent
 * `{% render "~<namespace>/<rest>" %}`) addresses a recipe namespace rather
 * than the filesystem. `<rest>` begins with the recipe name and continues with
 * the path inside that recipe, so
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

/** A single `~namespace/rest` resolution request. */
export type NamespaceRequest = {
  /** The namespace name, with the leading `~` already stripped (e.g. `workflow`). */
  namespace: string;
  /**
   * Everything after the namespace segment: the recipe name, then the path
   * inside that recipe (e.g. `task-files/_partials/resume.md`). Never has a
   * leading separator.
   */
  rest: string;
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
  /** Ordered absolute paths to try, most preferred first. An empty list means the lookup produced nothing. */
  | { kind: "candidates"; candidates: string[] }
  /**
   * No such namespace is known at all. `known` lists the namespaces that are.
   * `dropped` says why a project template's recipe is no longer pinned, when
   * that can be known.
   */
  | { kind: "unknown-namespace"; known: string[]; dropped?: DroppedRecipe }
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
  | { kind: "escapes-recipe"; recipe: string; reference: string };

/** Resolves `~namespace/rest` references to candidate absolute paths. */
export interface NamespaceResolver {
  /**
   * Resolve one `~namespace/rest` reference.
   *
   * @param request - The namespace, the remainder of the reference, and the including file.
   * @returns Candidate absolute paths (most preferred first), or a reason the lookup failed.
   */
  resolve(request: NamespaceRequest): NamespaceResolution;
}

/**
 * Render a namespace lookup failure as human-readable lines for an error
 * message. Each line is indented by two spaces so it can be appended directly
 * to the compiler's "Include not found" block.
 *
 * @param opts.namespace - The namespace that was asked for.
 * @param opts.rest - The remainder of the reference (recipe name plus inner path).
 * @param opts.fromFile - The file (or directory) that performed the include.
 * @param opts.resolution - What the resolver returned.
 * @returns Indented, newline-joined explanation lines; an empty string when there is nothing to add.
 */
export function formatNamespaceProblem(opts: {
  namespace: string;
  rest: string;
  fromFile: string;
  resolution: NamespaceResolution;
}): string {
  const lines: string[] = [`in file: ${opts.fromFile}`, `namespace: ${opts.namespace}`];

  const resolution = opts.resolution;

  if (resolution.kind === "candidates") {
    return "";
  }

  if (resolution.kind === "unknown-namespace") {
    lines.push(`There is no recipe namespace named "${opts.namespace}" available here.`);
    lines.push(
      resolution.known.length > 0
        ? `Available namespaces: ${resolution.known.join(", ")}.`
        : "This project has no recipe namespaces available yet."
    );
    if (resolution.dropped) lines.push(...describeDropped(resolution.dropped, opts));
  } else if (resolution.kind === "unknown-recipe") {
    lines.push(`recipe: ${resolution.recipe}`);
    lines.push(`The namespace "${opts.namespace}" holds no recipe named "${resolution.recipe}".`);
    lines.push(
      resolution.known.length > 0
        ? `Recipes in this namespace: ${resolution.known.join(", ")}.`
        : `The namespace "${opts.namespace}" currently holds no recipes.`
    );
    if (resolution.dropped) lines.push(...describeDropped(resolution.dropped, opts));
  } else if (resolution.kind === "not-a-dependency") {
    lines.push(`recipe: ${resolution.recipe}`);
    if (resolution.includingRecipe) {
      lines.push(
        `The recipe "${resolution.includingRecipe}" does not declare "${resolution.recipe}" as a dependency.`
      );
      lines.push(
        `Add "${resolution.recipe}" to the "depends" list in that recipe's manifest before addressing it as "~${opts.namespace}".`
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
 * @param opts - The namespace and the rest of the reference, for the recipe's name.
 */
function describeDropped(
  dropped: DroppedRecipe,
  opts: { namespace: string; rest: string }
): string[] {
  const recipe = `${opts.namespace}/${opts.rest.split("/")[0] ?? ""}`;
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
   * What each recipe declares, mapping `<namespace>/<recipe>` to the refs it
   * may address. An entry may be a full ref (`workflow/task-files`) or a bare
   * namespace (`workflow`, meaning every recipe in it). A recipe with no entry
   * declares nothing and may address only itself.
   */
  dependencies?: Record<string, string[]>;
  /**
   * What the project's own templates may address, in the same ref forms as
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

  constructor(options: StaticNamespaceResolverOptions) {
    this.recipes = {};
    for (const [ref, dir] of Object.entries(options.recipes)) {
      this.recipes[ref] = path.resolve(dir);
    }
    this.dependencies = options.dependencies ?? {};
    this.projectScope = options.projectScope;
    this.explainMissing = options.explainMissing;
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

  /** Every namespace this resolver knows about, sorted. */
  private knownNamespaces(): string[] {
    const names = new Set<string>();
    for (const ref of Object.keys(this.recipes)) {
      names.add(ref.split("/")[0]);
    }
    return [...names].sort();
  }

  /** Every known recipe ref inside one namespace, sorted. */
  private recipesIn(namespace: string): string[] {
    return Object.keys(this.recipes)
      .filter((ref) => ref.split("/")[0] === namespace)
      .sort();
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

  resolve(request: NamespaceRequest): NamespaceResolution {
    const { namespace, rest, fromFile } = request;

    const segments = rest.split("/").filter((segment) => segment.length > 0);
    const recipeName = segments[0] ?? "";
    const ref = `${namespace}/${recipeName}`;

    if (!this.knownNamespaces().includes(namespace)) {
      return {
        kind: "unknown-namespace",
        known: this.knownNamespaces(),
        ...this.droppedFor(ref, fromFile),
      };
    }

    const recipeDir = this.recipes[ref];

    if (!recipeDir) {
      return {
        kind: "unknown-recipe",
        recipe: ref,
        known: this.recipesIn(namespace),
        ...this.droppedFor(ref, fromFile),
      };
    }

    const includingRecipe = this.includingRecipe(fromFile);
    const declared = includingRecipe
      ? [includingRecipe, ...(this.dependencies[includingRecipe] ?? [])]
      : this.projectScope;

    if (declared !== undefined && !declaresRef(declared, namespace, ref)) {
      return { kind: "not-a-dependency", recipe: ref, includingRecipe };
    }

    const inner = segments.slice(1).join("/");
    const resolved = path.resolve(recipeDir, inner);

    // A `~namespace` reference addresses a recipe's own files. Without this the
    // reference could walk out of the recipe with `..` segments and have the
    // compiler render anything on the machine into the project's output. The
    // segment check catches the written form, and the relative check catches
    // everything else, including an absolute inner path and any symlink-free
    // route out that normalisation would otherwise hide.
    if (escapesRecipe(recipeDir, segments.slice(1), inner, resolved)) {
      return { kind: "escapes-recipe", recipe: ref, reference: `${namespace}/${rest}` };
    }

    return { kind: "candidates", candidates: [resolved] };
  }
}

/**
 * Whether an inner path would address something outside the recipe directory.
 *
 * @param recipeDir - The recipe's absolute directory.
 * @param innerSegments - The inner path's segments, as they were written.
 * @param inner - Those segments rejoined.
 * @param resolved - What the inner path resolved to.
 */
function escapesRecipe(
  recipeDir: string,
  innerSegments: string[],
  inner: string,
  resolved: string
): boolean {
  if (innerSegments.some((segment) => segment === "." || segment === "..")) return true;
  if (inner !== "" && path.isAbsolute(inner)) return true;
  if (resolved === recipeDir) return false;

  const relative = path.relative(recipeDir, resolved);
  return relative === "" || relative.startsWith("..") || path.isAbsolute(relative);
}

/**
 * Strip the decorations a written reference may carry so it can be compared to
 * a plain `<namespace>/<recipe>` ref: a repository qualifier (a subscription's
 * `sous-public:misc/stuff`, or a manifest's
 * `github://owner/repo/misc/stuff` locator) and a trailing version range
 * (`misc/stuff@^1.2`).
 *
 * @param ref - A reference as written in a manifest or subscription entry.
 * @returns The bare `<namespace>` or `<namespace>/<recipe>` form.
 */
export function normalizeRef(ref: string): string {
  const trimmed = ref.trim();

  // A locator URL names the repository first and the recipe last, so the two
  // trailing segments are the ref; everything before them is where it lives.
  const scheme = trimmed.indexOf("://");
  const body =
    scheme === -1
      ? trimmed.includes(":")
        ? trimmed.slice(trimmed.indexOf(":") + 1)
        : trimmed
      : trimmed.slice(scheme + 3).split("/").slice(-2).join("/");

  const at = body.lastIndexOf("@");
  return (at > 0 ? body.slice(0, at) : body).trim();
}

/**
 * Whether a list of declared refs covers a recipe, either by naming the recipe
 * itself or by naming its whole namespace.
 *
 * @param declared - Declared refs (dependencies, or the project's subscriptions).
 * @param namespace - The namespace being addressed.
 * @param ref - The fully qualified recipe ref being addressed.
 * @returns True when the reference is in scope.
 */
function declaresRef(declared: string[], namespace: string, ref: string): boolean {
  return declared.some((entry) => {
    const normalized = normalizeRef(entry);
    return normalized === ref || normalized === namespace;
  });
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
