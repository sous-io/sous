import { describe, it, expect } from "vitest";
import * as repos from "./index.js";

/**
 * Guards the Repositories layer's public surface. Later phases (the store, the
 * providers, the resolver, the CLI surface) import from this barrel, so an
 * accidental rename or a dropped export should fail here rather than in a
 * command months later.
 */

/** Every name the barrel is expected to expose, in alphabetical order. */
const EXPECTED_EXPORTS = [
  "CONTENT_HASH_PATTERN",
  "CONTENT_KINDS",
  "ENV_VAR_NAME_PATTERN",
  "INDEX_FILENAME",
  "ISO_TIMESTAMP_PATTERN",
  "KEBAB_NAME_PATTERN",
  "LINKS_FILENAME",
  "LINK_ORIGINS",
  "LOCKFILE_FILENAME",
  "LOCK_KINDS",
  "MANIFEST_EXTENSIONS",
  "NAMESPACE_NAME_PATTERN",
  "PROJECT_HOLDER",
  "RECIPE_KEY_PATTERN",
  "RECIPE_MANIFEST_BASENAME",
  "RECIPE_NAME_PATTERN",
  "REF_KEY_PATTERN",
  "REPO_MANIFEST_BASENAME",
  "REPO_NAME_PATTERN",
  "STORE_ENTRY_FILENAME",
  "SUPPORTED_FORMAT_VERSION",
  "VARIABLE_NAME_PATTERN",
  "VARIABLE_SCOPES",
  "VARIABLE_TYPES",
  "absolutePathSchema",
  "byteCountSchema",
  "contentHashSchema",
  "createEmptyLinksMap",
  "createEmptyLockfile",
  "envVarNameSchema",
  "extensibleObject",
  "findManifest",
  "findRecipeManifest",
  "findRepoManifest",
  "formatIssuePath",
  "formatRef",
  "formatVersionSchema",
  "indexFileSchema",
  "indexNamespaceSchema",
  "indexRecipeSchema",
  "indexVersionSchema",
  "isNamespaceRef",
  "isValidRef",
  "isoTimestampSchema",
  "linksMapSchema",
  "loadJsonFile",
  "loadManifestFile",
  "lockedRecipeSchema",
  "lockedRepoSchema",
  "lockfileSchema",
  "mergeLinksMaps",
  "namespaceNameSchema",
  "parseFormat",
  "parseIndexFile",
  "parseJsoncText",
  "parseLinksMap",
  "parseLockfile",
  "parseRecipeManifest",
  "parseRef",
  "parseRepoManifest",
  "parseStoreEntry",
  "parseYamlText",
  "recipeContentSchema",
  "recipeKeySchema",
  "recipeManifestKey",
  "recipeManifestSchema",
  "recipeNameSchema",
  "refKey",
  "refKeySchema",
  "relativePathSchema",
  "repoLinkSchema",
  "repoManifestSchema",
  "repoNameSchema",
  "repoNamespaceSchema",
  "requireRecipeManifest",
  "requireRepoManifest",
  "semverRangeSchema",
  "semverVersionSchema",
  "stableJsonStringify",
  "storeEntryKey",
  "storeEntrySchema",
  "stringifyIndexFile",
  "stringifyLinksMap",
  "stringifyLockfile",
  "stringifyStoreEntry",
  "tryParseRef",
  "variableDefinitionSchema",
  "variableNameSchema",
  "variableValidationSchema",
];

describe("the repos barrel", () => {
  /**
   * The barrel exposes exactly the documented surface: nothing missing, and
   * nothing added without this list being updated alongside the docs.
   *
   * Object.keys(repos).sort();  // -> EXPECTED_EXPORTS
   */
  it("should export exactly the documented surface", () => {
    expect(Object.keys(repos).sort()).toEqual(EXPECTED_EXPORTS);
  });

  /**
   * The regular expressions defined in formats/patterns.ts reach the barrel
   * through formats/common.ts, so they are usable without a deep import.
   *
   * repos.REPO_NAME_PATTERN.test("sous-recipes");  // -> true
   */
  it("should re-export the shared patterns through common", () => {
    expect(repos.REPO_NAME_PATTERN.test("sous-recipes")).toBe(true);
    expect(repos.REF_KEY_PATTERN.test("workflow/task-files")).toBe(true);
  });

  /**
   * A ref parsed through the barrel is the same one the ref module produces, so
   * a caller never has to reach past it.
   *
   * repos.refKey(repos.parseRef("sous-recipes:workflow/task-files@^1.0.0"));
   * // -> "workflow/task-files"
   */
  it("should expose a working ref parser", () => {
    expect(repos.refKey(repos.parseRef("sous-recipes:workflow/task-files@^1.0.0"))).toBe(
      "workflow/task-files"
    );
  });
});
