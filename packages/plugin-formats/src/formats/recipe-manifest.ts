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

// Variable definitions live in their own module, so the index can read them
// without importing the ref parser this manifest needs; they are re-exported
// here because a definition is part of the manifest.
export * from "./variable-definition.js";

// --- Dependency refs ----------------------------------------------------------------------------

/**
 * Checks one dependency ref as a manifest may write it; throws an error whose
 * message says what is wrong. `plugin-formats` hands in `refs.resolver`'s
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
 * What a content entry contributes. `skills`, `memories` and `prompts` are
 * compiled or copied into the subscribing project's agent directories; `config`
 * entries name config layer files that are merged into the subscriber's config.
 */
export const CONTENT_KINDS = ["skills", "memories", "prompts", "config"] as const;

/** One group of files this recipe contributes, all of the same kind. */
export const recipeContentSchema = extensibleObject({
  /** What the files are, which decides where they land in a subscribing project. */
  kind: z.enum(CONTENT_KINDS),
  /** Glob patterns, relative to the recipe folder, naming the files to contribute. */
  include: z
    .array(relativePathSchema("an include pattern", true))
    .min(1, "must list at least one include pattern"),
  /** Glob patterns, relative to the recipe folder, removed from the include set. */
  exclude: z.array(relativePathSchema("an exclude pattern", true)).optional(),
});

// --- Recipe plugins and requirements -----------------------------------------------------------

/** The plugin a recipe ships: one bundled file, and optionally its types (S1; C39, C40, C48). */
export const recipePluginSchema = extensibleObject({
  /** The bundle, relative to the recipe folder: `plugin/index.js`. */
  bundle: relativePathSchema("the plugin bundle"),
  /** Its `.d.ts`, relative to the recipe folder, copied to `.sous/types/`. */
  types: relativePathSchema("the plugin types file").optional(),
});

/** What a recipe needs that is not a recipe: npm plugins, each with a version range (S1). */
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
  });
}

function acceptAnyRef(ref: string): void {
  if (ref.trim().length === 0) throw new Error("a ref must not be empty");
}

/** The recipe manifest schema, with the default dependency checker. */
export const recipeManifestSchema = createRecipeManifestSchema();

/** A validated recipe manifest. */
export type RecipeManifest = z.infer<typeof recipeManifestSchema>;

/** One validated content group from a recipe manifest. */
export type RecipeContent = z.infer<typeof recipeContentSchema>;

/** What a content group contributes. */
export type ContentKind = (typeof CONTENT_KINDS)[number];

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
