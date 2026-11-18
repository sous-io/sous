/**
 * The recipe manifest: `sous.recipe.yaml` (or `.yml`, or `.json`) in each
 * recipe folder. It is HAND-WRITTEN and is the complete, executable-free
 * description of one publishable unit: what it is called, what version it is,
 * what it depends on, what files it contributes, and what variables it needs
 * answered.
 *
 * Two dependency lists exist, and they mean different things:
 *
 * - `depends` is a build dependency. The target is fetched, pinned and trust
 *   gated, and is addressable from this recipe's own files, but its files do
 *   NOT enter the subscribing project's output.
 * - `subscribes` is a co-subscription. Subscribing to this recipe subscribes
 *   the project to the target too, with full semantics: its questions run and
 *   its files DO enter the output. A curated bundle is simply a recipe made
 *   mostly of `subscribes` entries.
 *
 * Both lists name their targets BY LOCATION:
 *
 *     workflow/sat                                  a sibling in this repository
 *     github://sous-io/sous-recipes/workflow/sat    a recipe in another one
 *
 * Every other location form works too (an HTTPS or SSH URL, a browser URL); a
 * short name such as `sous-recipes:` is a consuming project's own label, so it
 * never appears in a published manifest. See `RefResolverService.parse` with
 * `RefSource.Manifest`.
 */

import { z } from "zod";
import {
  extensibleObject,
  formatVersionSchema,
  namespaceNameSchema,
  parseFormat,
  recipeNameSchema,
  relativePathSchema,
  semverVersionSchema,
  submissionsSchema,
} from "./common.js";
import { variableDefinitionSchema } from "./variable-definition.js";
import { recipeHandlersSchema } from "./recipe-handlers.js";

// Variable definitions live in their own module, so the index can read them
// without importing the ref parser this manifest needs; they are re-exported
// here because a definition is part of the manifest.
export * from "./variable-definition.js";

// --- Dependency refs ----------------------------------------------------------------------------

/**
 * Checks one dependency ref as a manifest may write it; throws an error whose
 * message says what is wrong. `sous-plugin-formats` hands in `refs.resolver`'s
 * manifest parse, so a manifest and the rest of sous never disagree about what
 * a dependency means.
 */
export type DependencyRefChecker = (ref: string) => void;

/** A dependency in `depends` or `subscribes`, checked with the given checker. */
function dependencyRefSchema(check: DependencyRefChecker) {
  return z.string().superRefine((value, ctx) => {
    try {
      check(value);
    } catch (error) {
      ctx.addIssue({ code: "custom", message: (error as Error).message });
    }
  });
}

/** Builds a list-of-refs schema that also rejects the same target listed twice. */
function refListSchema(label: string, check: DependencyRefChecker) {
  return z.array(dependencyRefSchema(check)).superRefine((refs, ctx) => {
    const seen = new Set<string>();
    refs.forEach((entry, index) => {
      const trimmed = entry.trim();
      if (seen.has(trimmed)) {
        ctx.addIssue({
          code: "custom",
          path: [index],
          message: `'${trimmed}' is listed more than once in ${label}`,
        });
      }
      seen.add(trimmed);
    });
  });
}

// --- Contents -----------------------------------------------------------------------------------

/**
 * The content kinds sous itself registers. `skills`, `memories` and `prompts`
 * are compiled or copied into the subscribing project's agent directories;
 * `config` entries name config layer files that are merged into the
 * subscriber's config.
 *
 * Kinds are OPEN: a plugin adds one with a `content-kind` entity, so the
 * schema accepts any kind name, and whether anything registered it is judged
 * once a subscriber's config is built (and, more loosely, at release).
 */
export const CONTENT_KINDS = ["skills", "memories", "prompts", "config"] as const;

/**
 * The keys that make an object a config expression (`$expr`, `$if`, `$elseif`,
 * `$else`, each optionally qualified) or a value read from a file (`$file`).
 * The exact list lives in sous-plugin-expressions (specification S5); this copy only
 * lets a manifest carry them, since the manifest is evaluated as config.
 */
const EXPRESSION_KEY = /^\$(?:(?:expr|if|elseif)(?::.*)?|else|file)$/s;

/** Whether a value is an object holding at least one expression key: it is evaluated as config, later. */
export function isManifestExpression(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).some((key) => EXPRESSION_KEY.test(key))
  );
}

/** An expression object, accepted as it is wherever a manifest's `contents` takes a value. */
const expressionSchema = z.custom<ManifestExpression>(isManifestExpression, {
  message: "must be a value, or an expression object ($if, $expr, $file and the others)",
});

/** A value, or an expression that gives one when the subscriber's config is built. */
function expressible<T extends z.ZodTypeAny>(schema: T) {
  return z.union([expressionSchema, schema]);
}

/**
 * Content written in place of a file: `{ $inline: "...", path: "skills/x/SKILL.md" }`.
 * `path` is required, and is the path the content is treated as having.
 */
export const inlineContentSchema = z.strictObject({
  $inline: z.string(),
  path: relativePathSchema("the path of inline content"),
});

/** A kind name: lowercase words joined by hyphens (`skills`, `claude-code-plugin`). */
const contentKindSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, "must be a kind name: lowercase letters, digits and hyphens");

/**
 * One group of files this recipe contributes, all of the same kind, after its
 * expressions are evaluated: what a subscriber's config holds under
 * `recipes.contents`.
 */
export const recipeContentGroupSchema = extensibleObject({
  /** What the files are; the plugin that registered the kind decides where they land. */
  kind: contentKindSchema,
  /** Glob patterns, relative to the recipe folder, or inline content, naming the files to contribute. */
  include: z
    .array(z.union([relativePathSchema("an include pattern", true), inlineContentSchema]))
    .min(1, "must list at least one include pattern"),
  /** Glob patterns, relative to the recipe folder, removed from the include set. */
  exclude: z.array(relativePathSchema("an exclude pattern", true)).optional(),
});

/**
 * One group as a manifest may write it: the group itself, or any of its
 * values, may be an expression, evaluated when a subscriber's config is built.
 */
export const recipeContentSchema = expressible(
  extensibleObject({
    kind: expressible(contentKindSchema),
    include: z
      .array(expressible(z.union([relativePathSchema("an include pattern", true), inlineContentSchema])))
      .min(1, "must list at least one include pattern"),
    exclude: expressible(z.array(expressible(relativePathSchema("an exclude pattern", true)))).optional(),
  })
);

// --- Edits --------------------------------------------------------------------------------------

/**
 * One declared edit to a document file (specification S12): `file` and one or
 * more operation keys, or a file-less operation such as
 * `ensureDirectoryExists`. Only the outer shape is checked here; the editor
 * plugin checks the operations. An entry may be an expression.
 */
export const recipeEditSchema = expressible(
  z.record(z.string(), z.unknown()).superRefine((entry, ctx) => {
    if (entry.file !== undefined && (typeof entry.file !== "string" || entry.file.length === 0)) {
      if (!isManifestExpression(entry.file)) {
        ctx.addIssue({ code: "custom", path: ["file"], message: "must be a file path" });
      }
    }

    if (Object.keys(entry).filter((key) => key !== "file").length === 0) {
      ctx.addIssue({ code: "custom", message: "names no operation; an edit holds 'file' and at least one operation" });
    }
  })
);

// --- Recipe plugins and requirements -----------------------------------------------------------

/** The plugin a recipe ships: one bundled file, and optionally its types, loaded while the config is built. */
export const recipePluginSchema = extensibleObject({
  /** The bundle, relative to the recipe folder: `plugin/index.js`. */
  bundle: relativePathSchema("the plugin bundle"),
  /** Its `.d.ts`, relative to the recipe folder, copied to `.sous/types/`. */
  types: relativePathSchema("the plugin types file").optional(),
});

/** What a recipe needs that is not a recipe: npm plugins, each with a version range. */
export const recipeRequirementsSchema = extensibleObject({
  plugins: z
    .record(
      z.string().min(1, "a plugin name must not be empty"),
      z.string().min(1, "a version range must not be empty")
    )
    .optional(),
});

// --- The manifest -------------------------------------------------------------------------------

/**
 * Builds the recipe manifest schema around a dependency ref checker. The
 * default checker accepts any non-empty ref.
 */
export function createRecipeManifestSchema(check: DependencyRefChecker = acceptAnyRef) {
  return extensibleObject({
  formatVersion: formatVersionSchema,
  /** The namespace this recipe belongs to. Must be declared by the repo manifest. */
  namespace: namespaceNameSchema,
  /** The recipe's name, unique within its namespace. */
  name: recipeNameSchema,
  /**
   * The published version. Recipe metadata is the source of truth for versions;
   * a git tag of the shape `namespace/recipe@1.2.3` is a convenience ref that
   * `sous repo release` keeps consistent with this field.
   */
  version: semverVersionSchema,
  /** One-paragraph summary, shown by `sous repo search` and `sous repo list`. */
  description: z.string().optional(),
  /**
   * Whether this recipe takes proposed changes, winning over the repository's
   * own `submissions` block. A recipe whose files are copied in from somewhere
   * else sets `allowed: false` and says where to go instead.
   */
  submissions: submissionsSchema.optional(),
  /**
   * Build dependencies: fetched and addressable here, but not added to the
   * project. Each entry is a bare ref naming a sibling recipe in this same
   * repository, or a locator URL naming a recipe in another one.
   */
  depends: refListSchema("'depends'", check).optional(),
  /** Co-subscriptions: subscribing here subscribes the project to these too. */
  subscribes: refListSchema("'subscribes'", check).optional(),
  /**
   * The files this recipe contributes. A curated bundle contributes no files of
   * its own, so this may be omitted; it then defaults to an empty list.
   */
  contents: z.array(recipeContentSchema).default([]),
  /** Variable definitions this recipe publishes. */
  variables: z
    .array(variableDefinitionSchema)
    .superRefine((definitions, ctx) => {
      const seenNames = new Set<string>();
      const seenEnv = new Map<string, number>();
      definitions.forEach((definition, index) => {
        if (seenNames.has(definition.name)) {
          ctx.addIssue({
            code: "custom",
            path: [index, "name"],
            message: `the variable '${definition.name}' is defined more than once`,
          });
        }
        seenNames.add(definition.name);

        if (definition.env !== undefined) {
          const first = seenEnv.get(definition.env);
          if (first !== undefined) {
            ctx.addIssue({
              code: "custom",
              path: [index, "env"],
              message:
                `the environment variable '${definition.env}' is already claimed by ` +
                `variables[${first}]; two definitions cannot share one environment variable`,
            });
          } else {
            seenEnv.set(definition.env, index);
          }
        }
      });
    })
    .optional(),
  /** The plugin this recipe ships, loaded while the config is built. */
  plugin: recipePluginSchema.optional(),
  /** What this recipe needs that is not a recipe. */
  requires: recipeRequirementsSchema.optional(),
  /** Each purpose's handlers: exported functions in the recipe's own files, run in the order listed. */
  handlers: recipeHandlersSchema.optional(),
  /** Declared edits to document files, appended to the subscriber's `editor.edits`. */
  edits: z.array(recipeEditSchema).optional(),
  });
}

function acceptAnyRef(ref: string): void {
  if (ref.trim().length === 0) throw new Error("a ref must not be empty");
}

/** The recipe manifest schema, with the default dependency checker. */
export const recipeManifestSchema = createRecipeManifestSchema();

/** A validated recipe manifest. */
export type RecipeManifest = z.infer<typeof recipeManifestSchema>;

/** One validated content group from a recipe manifest, as written (it may hold expressions). */
export type RecipeContent = z.infer<typeof recipeContentSchema>;

/** One content group after its expressions are evaluated. */
export type RecipeContentGroup = z.infer<typeof recipeContentGroupSchema>;

/** An object holding a config expression key, evaluated when a subscriber's config is built. */
export type ManifestExpression = { readonly [key: `$${string}`]: unknown };

/** What a content group contributes: a built-in kind, or one a plugin registers. */
export type ContentKind = (typeof CONTENT_KINDS)[number] | (string & {});

/**
 * Checks one evaluated content group, throwing a ConfigError that names the
 * label and the path of every bad field.
 *
 * @param value - The group after its expressions were evaluated.
 * @param sourceLabel - Where it came from: `acme/widget contents[0]`.
 */
export function parseRecipeContentGroup(value: unknown, sourceLabel: string): RecipeContentGroup {
  return parseFormat(recipeContentGroupSchema, value, sourceLabel, "content group");
}

/**
 * Every kind a manifest's `contents` may give, as written: each literal kind,
 * and each kind inside an expression's branches. Used where the manifest
 * cannot be evaluated (a release), so every branch counts.
 *
 * ```ts
 * possibleContentKinds([{ kind: "skills", include: ["a"] }, { $if: { expr: "x", then: { kind: "notes", include: ["b"] } } }]);
 * // -> ["skills", "notes"]
 * ```
 */
export function possibleContentKinds(contents: readonly unknown[]): string[] {
  const found = new Set<string>();
  const kindsOf = (value: unknown): void => {
    if (typeof value === "string") {
      found.add(value);
    } else if (isManifestExpression(value)) {
      branchValues(value).forEach(kindsOf);
    }
  };
  const groupsOf = (value: unknown): void => {
    if (isManifestExpression(value)) {
      branchValues(value).forEach(groupsOf);
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      kindsOf((value as Record<string, unknown>).kind);
    }
  };

  contents.forEach(groupsOf);

  return [...found];
}

/**
 * Every value an expression object could give, as written: each branch's
 * `then` and the `$else`. A `$expr` or a `$file` gives nothing knowable here.
 */
export function branchValues(expression: Record<string, unknown>): unknown[] {
  const values: unknown[] = [];
  const branch = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(branch);
    } else if (typeof value === "object" && value !== null) {
      const block = value as Record<string, unknown>;

      if ("then" in block) values.push(block.then);
      if ("$then" in block) values.push(block.$then);
    }
  };

  for (const [key, value] of Object.entries(expression)) {
    if (/^\$(?:if|elseif)(?::.*)?$/s.test(key)) {
      branch(value);
    } else if (key === "$else") {
      values.push(value);
    }
  }

  return values;
}

/**
 * Validates a parsed recipe manifest, throwing a ConfigError that names the
 * file and the path of every bad field.
 *
 * @param value - The parsed contents of the manifest file.
 * @param sourceLabel - The manifest's file path, named in error messages.
 */
export function parseRecipeManifest(
  value: unknown,
  sourceLabel: string,
  check?: DependencyRefChecker
): RecipeManifest {
  const schema = check === undefined ? recipeManifestSchema : createRecipeManifestSchema(check);
  return parseFormat(schema, value, sourceLabel, "recipe manifest");
}

/**
 * The recipe's key (`namespace/name`), which is how it is stored in an index,
 * a lockfile and a project's subscriptions.
 *
 * @param manifest - A validated recipe manifest.
 */
export function recipeManifestKey(manifest: RecipeManifest): string {
  return `${manifest.namespace}/${manifest.name}`;
}
