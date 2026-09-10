/**
 * The repo index: `sous.index.json` at a repo's root.
 *
 * The index is MACHINE-WRITTEN by `sous repo release` and committed alongside
 * the recipes it describes. It is the portable contract across providers: every
 * provider, whatever its API looks like, can hand back this one file, and it is
 * all sous needs to resolve a ref, enumerate published versions and check
 * whether a cached copy is current.
 *
 * Adding a repo fetches only this file. Nothing else is downloaded until a
 * project subscribes to something inside it.
 */

import { z } from "zod";
import {
  contentHashSchema,
  formatVersionSchema,
  isoTimestampSchema,
  namespaceNameSchema,
  parseFormat,
  recipeKeySchema,
  relativePathSchema,
  repoNameSchema,
  semverVersionSchema,
  stableJsonStringify,
} from "./common.js";

/** One published version of one recipe. */
export const indexVersionSchema = z.strictObject({
  /** Content hash of the recipe folder at this version, verified after every fetch. */
  hash: contentHashSchema,
  /** The git tag carrying this version, shaped `namespace/recipe@version`. */
  tag: z.string().min(1, "must not be empty"),
  /** True when the version is a prerelease, which ranges skip unless opted in. */
  prerelease: z.boolean(),
  /** When the version was released. */
  releasedAt: isoTimestampSchema.optional(),
});

/** One recipe, with every version the repo publishes of it. */
export const indexRecipeSchema = z.strictObject({
  /** The recipe folder, relative to the repo root. */
  path: relativePathSchema("a recipe path"),
  /** One-paragraph summary, copied from the recipe manifest at release time. */
  description: z.string().optional(),
  /** Every published version, keyed by the exact version string. */
  versions: z
    .record(semverVersionSchema, indexVersionSchema)
    .refine((versions) => Object.keys(versions).length > 0, {
      message: "must list at least one published version",
    }),
});

/** One namespace declaration, copied from the repo manifest at release time. */
export const indexNamespaceSchema = z.strictObject({
  description: z.string().optional(),
});

/** The repo index schema. */
export const indexFileSchema = z
  .strictObject({
    formatVersion: formatVersionSchema,
    /** The repo's suggested short name, copied from its manifest. */
    name: repoNameSchema,
    /** When this index was generated. */
    generatedAt: isoTimestampSchema,
    /** The version of sous that generated it. */
    generator: semverVersionSchema,
    /** Every namespace the repo publishes. */
    namespaces: z.record(namespaceNameSchema, indexNamespaceSchema),
    /** Every recipe the repo publishes, keyed `namespace/recipe`. */
    recipes: z.record(recipeKeySchema, indexRecipeSchema),
  })
  .superRefine((index, ctx) => {
    // A recipe whose namespace is not declared could never be resolved, so a
    // release that produced one is broken; say which recipe and which namespace.
    for (const key of Object.keys(index.recipes)) {
      const namespace = key.slice(0, key.indexOf("/"));
      if (!Object.hasOwn(index.namespaces, namespace)) {
        ctx.addIssue({
          code: "custom",
          path: ["recipes", key],
          message:
            `belongs to the namespace '${namespace}', which this index does not ` +
            `declare under 'namespaces'`,
        });
      }
    }
  });

/** A validated repo index. */
export type IndexFile = z.infer<typeof indexFileSchema>;

/** One recipe entry in a repo index. */
export type IndexRecipe = z.infer<typeof indexRecipeSchema>;

/** One published version entry in a repo index. */
export type IndexVersion = z.infer<typeof indexVersionSchema>;

/** One namespace entry in a repo index. */
export type IndexNamespace = z.infer<typeof indexNamespaceSchema>;

/**
 * Validates a parsed repo index, throwing a ConfigError that names the file and
 * the path of every bad field.
 *
 * @param value - The parsed contents of the index file.
 * @param sourceLabel - The index's file path or URL, named in error messages.
 */
export function parseIndexFile(value: unknown, sourceLabel: string): IndexFile {
  return parseFormat(indexFileSchema, value, sourceLabel, "repo index");
}

/**
 * Serializes a repo index for writing, with every object key sorted so a
 * regenerated index produces a minimal diff.
 *
 * @param index - The index to write.
 */
export function stringifyIndexFile(index: IndexFile): string {
  return stableJsonStringify(index);
}
