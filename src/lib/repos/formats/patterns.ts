/**
 * Dependency-free regular expressions shared by the Repositories on-disk
 * formats, the ref parser and the sous config schema.
 *
 * This module deliberately imports nothing, so `config-schema.ts` can reuse the
 * patterns without pulling in zod schemas, semver, or the rest of the repos
 * layer. `formats/common.ts` re-exports everything here.
 */

/**
 * Lowercase kebab-case identifier: starts with a letter, then letters, digits
 * or hyphens. Used for repo short names, namespace names and recipe names
 * (`sous-recipes`, `tool-usage`, `automated-browser-tasks`).
 */
export const KEBAB_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/** A repo's configured short name, as used by the `repo:` ref qualifier. */
export const REPO_NAME_PATTERN = KEBAB_NAME_PATTERN;

/** A namespace name. */
export const NAMESPACE_NAME_PATTERN = KEBAB_NAME_PATTERN;

/** A recipe name, unique within its namespace. */
export const RECIPE_NAME_PATTERN = KEBAB_NAME_PATTERN;

/**
 * A ref key: either a bare namespace (`workflow`) or a fully qualified recipe
 * (`workflow/task-files`). Never carries a repo qualifier or a version range.
 */
export const REF_KEY_PATTERN = /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)?$/;

/** A recipe key, which always has both segments (`workflow/task-files`). */
export const RECIPE_KEY_PATTERN = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;

/**
 * A repository's canonical identity: the host, then the path it lives at, all
 * lowercase (`github.com/sous-io/sous-recipes`). It is what every machine-wide
 * key uses, because a project's short name for a repository is its own label
 * and no other project has to agree with it.
 */
export const REPO_IDENTITY_PATTERN = /^[^\s/]+(\/[^\s/]+)+$/;

/** A content hash, written as the algorithm name followed by lowercase hex. */
export const CONTENT_HASH_PATTERN = /^sha256-[0-9a-f]{64}$/;

/** An environment variable name, as declared by a recipe variable definition. */
export const ENV_VAR_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** A camelCase variable name, as declared by a recipe variable definition. */
export const VARIABLE_NAME_PATTERN = /^[a-z][a-zA-Z0-9]*$/;

/**
 * An ISO 8601 timestamp carrying an explicit offset (`Z` or `+hh:mm`). Machine
 * written timestamps come from `new Date().toISOString()`, which matches.
 */
export const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
