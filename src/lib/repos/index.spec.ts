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
  "DEFAULT_FRESHNESS_SECONDS",
  "DEFAULT_STORE_MAX_BYTES",
  "DEFAULT_WATCH_POLL_SECONDS",
  "DEPENDENCY_PROVIDER_HOSTS",
  "ENV_VAR_NAME_PATTERN",
  "GITHUB_HOST",
  "GITHUB_TOKEN_ENV",
  "GITLAB_HOST",
  "GITLAB_TOKEN_ENV",
  "GithubProvider",
  "GitlabProvider",
  "INDEX_CACHE_DIRNAME",
  "INDEX_FILENAME",
  "INDEX_SIDECAR_SUFFIX",
  "ISO_TIMESTAMP_PATTERN",
  "IndexCache",
  "KEBAB_NAME_PATTERN",
  "LINKS_FILENAME",
  "LINK_ORIGINS",
  "LOCKFILE_FILENAME",
  "LOCK_KINDS",
  "LockService",
  "MANAGED_LAYER_COMMENT",
  "MANIFEST_EXTENSIONS",
  "NAMESPACE_NAME_PATTERN",
  "OFFICIAL_REPO_IDENTITY",
  "PROJECT_HOLDER",
  "PROJECT_REQUESTER",
  "RECIPE_KEY_PATTERN",
  "RECIPE_MANIFEST_BASENAME",
  "RECIPE_NAME_PATTERN",
  "REF_KEY_PATTERN",
  "REPOS_LAYER_FILENAME",
  "REPO_IDENTITY_PATTERN",
  "REPO_MANIFEST_BASENAME",
  "REPO_NAME_PATTERN",
  "RecipeStore",
  "STORE_ENTRY_FILENAME",
  "SUBSCRIPTIONS_LAYER_FILENAME",
  "SUPPORTED_FORMAT_VERSION",
  "TrustService",
  "USER_ADDED_BY",
  "VARIABLE_NAME_PATTERN",
  "VARIABLE_SCOPES",
  "VARIABLE_TYPES",
  "absolutePathSchema",
  "buildCanonicalRepo",
  "builtInProviders",
  "byteCountSchema",
  "contentHashSchema",
  "createEmptyLinksMap",
  "createEmptyLockfile",
  "createIndexCache",
  "dependencyRefKey",
  "dependencyRepoUrl",
  "detectProvider",
  "detectProviderIn",
  "effectiveRangeForHolders",
  "envVarNameSchema",
  "extensibleObject",
  "fetchSubtree",
  "fetchText",
  "findGithubToken",
  "findGitlabToken",
  "findManifest",
  "findNewerInRange",
  "findRecipeManifest",
  "findRepoManifest",
  "formatDependencyRef",
  "formatIssuePath",
  "formatRef",
  "formatStoreKey",
  "formatVersionSchema",
  "hashDirectory",
  "hashesEqual",
  "identitySegments",
  "indexDependencySchema",
  "indexFileSchema",
  "indexNamespaceSchema",
  "indexRecipeSchema",
  "indexVersionSchema",
  "invalidRepoUrl",
  "isNamespaceRef",
  "isValidRef",
  "isoTimestampSchema",
  "keysHeldBySubscription",
  "linksMapSchema",
  "loadJsonFile",
  "loadManifestFile",
  "lockedRecipeSchema",
  "lockedRepoSchema",
  "lockfileSchema",
  "managedLayerDir",
  "managedLayerPath",
  "mergeLinksMaps",
  "namespaceNameSchema",
  "normalizeRepoUrl",
  "parseDependencyRef",
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
  "providerById",
  "providerByIdIn",
  "readManagedLayer",
  "recipeContentSchema",
  "recipeKeySchema",
  "recipeManifestKey",
  "recipeManifestSchema",
  "recipeNameSchema",
  "recordUpstreamCheck",
  "refKey",
  "refKeySchema",
  "relativePathSchema",
  "removeManagedLayer",
  "repoIdentity",
  "repoIdentitySchema",
  "repoLinkSchema",
  "repoManifestSchema",
  "repoNameSchema",
  "repoNamespaceSchema",
  "requireProvider",
  "requireProviderIn",
  "requireRecipeManifest",
  "requireRepoManifest",
  "resolveRefs",
  "resolveStoreSettings",
  "runGit",
  "sameRepoIdentity",
  "semverRangeSchema",
  "semverVersionSchema",
  "shortNameFromIdentity",
  "shouldCheckUpstream",
  "spawnCommand",
  "splitRepoUrl",
  "stableJsonStringify",
  "storeEntryKey",
  "storeEntrySchema",
  "storeKeyOf",
  "stringifyIndexFile",
  "stringifyLinksMap",
  "stringifyLockfile",
  "stringifyStoreEntry",
  "tryCommand",
  "tryParseDependencyRef",
  "tryParseRef",
  "variableDefinitionSchema",
  "variableNameSchema",
  "variableValidationSchema",
  "writeManagedLayer",
  "writeTrustNotice",
];

/**
 * The names Phase 6a added: the links map and its ignore hygiene, the git layer
 * `sous repo link` uses, and the scaffold `sous repo init` writes. Kept as its
 * own list so each phase's additions stay legible next to the surface that was
 * there before it.
 */
const PHASE_6A_EXPORTS = [
  "EXAMPLE_RECIPE_NAME",
  "IGNORE_BLOCK_END",
  "IGNORE_BLOCK_ENTRIES",
  "IGNORE_BLOCK_START",
  "REPOS_DIRNAME",
  "applyManagedIgnoreBlock",
  "buildExampleSkill",
  "buildGitignore",
  "buildIndexFile",
  "buildReadme",
  "buildRecipeManifest",
  "buildReleaseWorkflow",
  "buildRepoManifest",
  "cloneRepo",
  "describeLinkedRepos",
  "ensureReposIgnoreFiles",
  "exampleRecipePath",
  "globalLinksPath",
  "globalReposDir",
  "isGitCheckout",
  "linkedPathFor",
  "looksLikeRepoUrl",
  "normalizeRemoteUrl",
  "projectLinksPath",
  "projectReposDir",
  "readEffectiveLinks",
  "readGlobalLinks",
  "readLinksFile",
  "readProjectLinks",
  "remoteUrlOf",
  "repoNameFromUrl",
  "repoSlugFromUrl",
  "resolveSousHomeDir",
  "sameRemote",
  "scaffoldRepo",
  "writeGlobalLinks",
  "writeLinksFile",
  "writeProjectLinks",
];

/**
 * The names Phase 3 added: where a locked recipe's files are, the namespace
 * resolver built from that, the local provider, the paths nothing sous
 * deletes may reach into, and the service the consumer commands drive.
 */
const PHASE_3_EXPORTS = [
  "LOCAL_PROVIDER_ID",
  "LocalProvider",
  "SubscriptionService",
  "assertLocalRepoDirectory",
  "createProjectNamespaceResolver",
  "expandHomePath",
  "listLockedRecipes",
  "localRepoPath",
  "looksLikeLocalPath",
  "resolveRepoArgument",
  "mapLinkedRecipes",
  "projectSubscriptionRefs",
  "protectedRepoPaths",
  "readProjectLockfile",
  "readRecipeManifestIn",
  "readRepoManifestIn",
  "repoUrlSchema",
  "subscriptionServiceFor",
];

/**
 * The names Phase 7 added: the core recipe that ships inside the package, the
 * seed that puts it in the store, and the built-in repository and subscription
 * every project gets unless it opts out.
 */
const PHASE_7_EXPORTS = [
  "BUILT_IN_ADDED_BY",
  "CORE_NAMESPACE",
  "CORE_RECIPE_KEY",
  "CORE_RECIPE_NAME",
  "CORE_RECIPE_PATH",
  "OFFICIAL_REPO_NAME",
  "OFFICIAL_REPO_PROVIDER",
  "OFFICIAL_REPO_URL",
  "PACKAGED_RECIPES_DIRNAME",
  "SEED_INDEX_COMMENT",
  "applyRepoDefaults",
  "builtInCoreSubscription",
  "builtInRepoEntry",
  "coreIndexOverlay",
  "coreRecipeVersion",
  "enabledRepos",
  "enabledSubscriptions",
  "isBuiltInEntry",
  "packagedCoreRecipeDir",
  "readPackagedCoreManifest",
  "seedCoreRecipe",
];

/**
 * The names the managed-layer work added: the header comment every machine
 * written `conf.d/` layer opens with, the old `.json` path read during a
 * migration, and the key-path editor the writers use instead of replacing a
 * layer wholesale.
 */
const MANAGED_LAYER_EXPORTS = [
  "legacyManagedLayerPath",
  "managedLayerHeader",
  "updateManagedLayer",
];

/**
 * The names the provider write path added: the base class every provider
 * extends (and which refuses what a provider never promised), the helper that
 * reads an address out of a host tool's output, and the narrowing check that
 * asks a provider whether it really can propose a change.
 */
const PROVIDER_WRITE_EXPORTS = ["ProviderBase", "firstUrlIn", "supportsSubmit"];

describe("the repos barrel", () => {
  /**
   * The barrel exposes exactly the documented surface: nothing missing, and
   * nothing added without this list being updated alongside the docs.
   *
   * Object.keys(repos).sort();  // -> EXPECTED_EXPORTS
   */
  it("should export exactly the documented surface", () => {
    const expected = [
      ...EXPECTED_EXPORTS,
      ...PHASE_6A_EXPORTS,
      ...PHASE_3_EXPORTS,
      ...PHASE_7_EXPORTS,
      ...MANAGED_LAYER_EXPORTS,
      ...PROVIDER_WRITE_EXPORTS,
    ].sort();
    expect(Object.keys(repos).sort()).toEqual(expected);
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
