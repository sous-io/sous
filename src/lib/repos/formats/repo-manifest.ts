/**
 * The repo manifest: `sous.repo.yaml` (or `.yml`, or `.json`) at the root of a
 * repository. It is HAND-WRITTEN by the repo's maintainers and is the entry
 * point sous reads to learn what a repo publishes: its namespaces, and where
 * each recipe folder lives.
 *
 * The manifest is deliberately declarative and executable-free. Trust in the
 * Repositories system rests on being able to read a repo's whole surface
 * without running any of its code, so manifests are YAML or JSON only.
 */

import { z } from "zod";
import {
  extensibleObject,
  formatVersionSchema,
  namespaceNameSchema,
  parseFormat,
  relativePathSchema,
  repoNameSchema,
} from "./common.js";

/** A namespace declaration. Namespaces group recipes and are not versioned. */
export const repoNamespaceSchema = extensibleObject({
  /** One-line, plain-language summary of what the namespace holds. */
  description: z.string().optional(),
});

/** Path to a recipe folder, relative to the repo root. */
const recipePathSchema = relativePathSchema("a recipe path");

/**
 * The repo manifest schema.
 *
 * `name` is only a SUGGESTED short name. The short name a project actually uses
 * is recorded in its own config by `sous repo add`, which defaults to the last
 * URL segment and can be overridden, so two repos suggesting the same name
 * never collide in a project.
 */
export const repoManifestSchema = extensibleObject({
  formatVersion: formatVersionSchema,
  /** Suggested short name for the repo. */
  name: repoNameSchema,
  /** One-paragraph summary of the repo, shown by `sous repo list` and `sous repo search`. */
  description: z.string().optional(),
  /**
   * Where to send a contribution: a URL, or free text describing the process.
   * Surfaced when a provider does not support `sous repo submit`, so a
   * contributor is never left without a route.
   */
  contribute: z.string().min(1, "must not be empty").optional(),
  /** Every namespace the repo publishes, keyed by namespace name. */
  namespaces: z.record(namespaceNameSchema, repoNamespaceSchema),
  /**
   * Every recipe folder in the repo, as a path relative to the repo root. Each
   * folder must contain a recipe manifest (`sous.recipe.yaml` or a supported
   * variant); `sous repo release` verifies that and builds the index from it.
   */
  recipes: z.array(recipePathSchema).superRefine((paths, ctx) => {
    const seen = new Set<string>();
    paths.forEach((entry, index) => {
      if (seen.has(entry)) {
        ctx.addIssue({
          code: "custom",
          path: [index],
          message: `the recipe path '${entry}' is listed more than once`,
        });
      }
      seen.add(entry);
    });
  }),
});

/** A validated repo manifest. */
export type RepoManifest = z.infer<typeof repoManifestSchema>;

/** A validated namespace declaration from a repo manifest. */
export type RepoNamespace = z.infer<typeof repoNamespaceSchema>;

/**
 * Validates a parsed repo manifest, throwing a ConfigError that names the file
 * and the path of every bad field.
 *
 * @param value - The parsed contents of the manifest file.
 * @param sourceLabel - The manifest's file path, named in error messages.
 */
export function parseRepoManifest(value: unknown, sourceLabel: string): RepoManifest {
  return parseFormat(repoManifestSchema, value, sourceLabel, "repo manifest");
}
