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
 *
 * Every object in it is a `forwardCompatibleObject`: a field a later sous adds is
 * kept and ignored rather than refused, so an index published by a newer sous
 * still reads here. The fields this version defines are validated in full.
 */

import { z } from "zod";
import {
  contentHashSchema,
  dependencyKindSchema,
  formatVersionSchema,
  forwardCompatibleObject,
  isoTimestampSchema,
  namespaceNameSchema,
  parseFormat,
  recipeKeySchema,
  relativePathSchema,
  repoIdentitySchema,
  repoNameSchema,
  semverRangeSchema,
  semverVersionSchema,
  stableJsonStringify,
} from "./common.js";
import { publishedVariableDefinitionSchema } from "./variable-definition.js";
import { namespaceOfKey } from "../../../services/ref-resolver/index.js";

/**
 * One dependency of one published version, as the release resolved it.
 *
 * A SIBLING (a recipe in this same repository) always resolves to an exact
 * version, because the release that wrote this entry cut that sibling's tag or
 * found it already cut. A CROSS-REPOSITORY dependency carries the identity of
 * the repository it lives in, which is what a consumer needs in order to add
 * that repository and find the recipe in the store; the version it resolves to
 * belongs to that repository's own index, so this entry carries the range the
 * manifest declared instead.
 */
export const indexDependencySchema = forwardCompatibleObject({
  /** The exact version this dependency resolved to, when the release could resolve one. */
  version: semverVersionSchema.optional(),
  /** The range the manifest declared, recorded when no exact version could be resolved. */
  range: semverRangeSchema.optional(),
  /**
   * The canonical identity of the repository publishing it
   * (`github.com/sous-io/sous-recipes`). Omitted for a sibling, which lives in
   * this same repository.
   */
  repo: repoIdentitySchema.optional(),
  /**
   * The entry of the version's manifest that brings this dependency in, exactly
   * as it was written: a recipe (`workflow/task-files`, with its range when it
   * has one), a whole namespace of this repository (`workflow`), or a locator
   * naming a recipe in another repository. When several entries cover the same
   * recipe, the one naming it wins over a namespace. Absent on an entry recorded
   * before sous described recipes in the index (ADR 0010).
   */
  declared: z.string().min(1, "must not be empty").optional(),
  /**
   * Whether that brings it in as a co-subscription (`subscribes`: its files
   * land in the project and its questions are asked) or as a build dependency
   * (`depends`: a library only); `subscribes` when any entry covering it is a
   * co-subscription. Recorded alongside `declared`.
   */
  kind: dependencyKindSchema.optional(),
}).refine((entry) => entry.version !== undefined || entry.range !== undefined, {
  message:
    "must record either the exact version this dependency resolved to or the range " +
    "the recipe declared",
});

/** One published version of one recipe. */
export const indexVersionSchema = forwardCompatibleObject({
  /** Content hash of the recipe folder at this version, verified after every fetch. */
  hash: contentHashSchema,
  /**
   * The git tag carrying this version, shaped `namespace/recipe@version`. The
   * index's `superRefine` checks it against the key and version it sits under,
   * so a version can never point at a branch or at another recipe's tag.
   */
  tag: z.string().min(1, "must not be empty"),
  /** True when the version is a prerelease, which ranges skip unless opted in. */
  prerelease: z.boolean(),
  /**
   * True when this version is not one the repository published, but the copy of
   * the recipe that ships inside the installed sous package, folded into the
   * index in memory so it can be resolved like anything else.
   *
   * Sous never writes this onto a copy of an index it fetched; a cached index
   * stays exactly what upstream served. The field exists so that a listing can
   * say the version came packaged with sous rather than from the repository, and
   * so a reader of the stand-in index sous writes for itself can tell.
   */
  seeded: z.boolean().optional(),
  /** When the version was released. */
  releasedAt: isoTimestampSchema.optional(),
  /**
   * What this exact version depends on, resolved at release time and keyed
   * `namespace/recipe`. A consumer installing this version installs these
   * versions rather than re-resolving the ranges its manifest declared, so a
   * published version means one thing forever.
   *
   * The field is additive: an index written before it existed still parses, and
   * a consumer that finds no entry falls back to the manifest's ranges. A
   * version described in full (ADR 0010) carries this field even when it is
   * empty, so "depends on nothing" and "not recorded" read differently.
   */
  dependencies: z.record(recipeKeySchema, indexDependencySchema).optional(),
  /**
   * The variable definitions this version's manifest publishes, in manifest
   * order: the questions subscribing to it asks. An empty list means it asks
   * none; an absent field means the release that recorded the version did not
   * record them (a release made before ADR 0010), and only the recipe's own
   * files can say.
   */
  variables: z.array(publishedVariableDefinitionSchema).optional(),
  /**
   * The version's manifest `depends` and `subscribes` lists, exactly as
   * written, so a consumer walks a recipe whose files it has not fetched the
   * same way it walks its manifest: a namespace still expands to what the
   * namespace holds, including a namespace of another repository, which no
   * key of `dependencies` can record. Written, even when empty, beside
   * `variables`; absent on a version recorded before ADR 0010. Kept as plain
   * strings, so a ref form a later sous accepts never breaks this reader.
   */
  depends: z.array(z.string().min(1, "must not be empty")).optional(),
  subscribes: z.array(z.string().min(1, "must not be empty")).optional(),
});

/** One recipe, with every version the repo publishes of it. */
export const indexRecipeSchema = forwardCompatibleObject({
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
export const indexNamespaceSchema = forwardCompatibleObject({
  description: z.string().optional(),
});

/** The repo index schema. */
export const indexFileSchema = forwardCompatibleObject({
  /**
   * A plain-language note about where this copy of the index came from. JSON
   * has no comment syntax and an index is machine-written, so this is the one
   * place a writer can say something to whoever opens the file. Sous ignores
   * the value everywhere except one place: the seed index it writes for its
   * own built-in repository carries `SEED_INDEX_COMMENT`, which is how a
   * later run recognizes its own placeholder and is willing to replace it.
   */
  $comment: z.string().optional(),
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
}).superRefine((index, ctx) => {
  // A recipe whose namespace is not declared could never be resolved, so a
  // release that produced one is broken; say which recipe and which namespace.
  for (const key of Object.keys(index.recipes)) {
    const namespace = namespaceOfKey(key);
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

  // A version's tag is what the provider fetches, so a tag that does not
  // name this exact recipe and version is a version pointing somewhere else.
  // Nothing on the consumer side could otherwise tell: an index publishing
  // `1.0.0` with `tag: "main"` would hand `git clone --branch main` a moving
  // target, whose content changes on every push and whose pinned hash then
  // simply starts failing. Sous writes these tags itself, so requiring the
  // shape it writes costs a correct index nothing.
  for (const [key, recipe] of Object.entries(index.recipes)) {
    for (const [version, published] of Object.entries(recipe.versions)) {
      const expected = `${key}@${version}`;
      if (published.tag === expected) continue;
      ctx.addIssue({
        code: "custom",
        path: ["recipes", key, "versions", version, "tag"],
        message:
          `is '${published.tag}', but a published version's tag names the recipe and ` +
          `the version it carries, so this one must be '${expected}'`,
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

/** One resolved dependency of one published version. */
export type IndexDependency = z.infer<typeof indexDependencySchema>;

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
