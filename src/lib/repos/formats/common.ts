/**
 * Shared building blocks for every Repositories on-disk format.
 *
 * Each format module (repo manifest, recipe manifest, index file, lockfile,
 * store entry marker, links map) composes the primitives defined here, so a
 * namespace name, a content hash or a timestamp means exactly the same thing
 * everywhere. This module also holds the canonical file names and the shared
 * `parseFormat` helper that turns a zod failure into a readable ConfigError.
 */

import { z } from "zod";
import semver from "semver";
import { ConfigError } from "../../errors.js";
import {
  CONTENT_HASH_PATTERN,
  ENV_VAR_NAME_PATTERN,
  ISO_TIMESTAMP_PATTERN,
  KEBAB_NAME_PATTERN,
  NAMESPACE_NAME_PATTERN,
  RECIPE_KEY_PATTERN,
  RECIPE_NAME_PATTERN,
  REF_KEY_PATTERN,
  REPO_NAME_PATTERN,
  VARIABLE_NAME_PATTERN,
} from "./patterns.js";

export {
  CONTENT_HASH_PATTERN,
  ENV_VAR_NAME_PATTERN,
  ISO_TIMESTAMP_PATTERN,
  KEBAB_NAME_PATTERN,
  NAMESPACE_NAME_PATTERN,
  RECIPE_KEY_PATTERN,
  RECIPE_NAME_PATTERN,
  REF_KEY_PATTERN,
  REPO_NAME_PATTERN,
  VARIABLE_NAME_PATTERN,
};

// --- Format version -----------------------------------------------------------------------------

/**
 * The only on-disk format version this sous understands. Every manifest, index,
 * lockfile, store entry marker and links map carries it as `formatVersion`, so
 * a future incompatible change can be detected instead of misread.
 */
export const SUPPORTED_FORMAT_VERSION = 1;

/** The `formatVersion` field, present in every Repositories format. */
export const formatVersionSchema = z.literal(SUPPORTED_FORMAT_VERSION, {
  message:
    `must be ${SUPPORTED_FORMAT_VERSION}; this version of sous understands no other ` +
    `on-disk format version`,
});

// --- Canonical file names -----------------------------------------------------------------------

/** Base name (without extension) of the repo manifest, at a repo's root. */
export const REPO_MANIFEST_BASENAME = "sous.repo";

/** Base name (without extension) of a recipe manifest, in each recipe folder. */
export const RECIPE_MANIFEST_BASENAME = "sous.recipe";

/** File name of the machine-written repo index, at a repo's root. */
export const INDEX_FILENAME = "sous.index.json";

/** File name of the project lockfile, inside the project's `.sous/` directory. */
export const LOCKFILE_FILENAME = "sous.lock.json";

/** File name of the marker written beside every store entry. */
export const STORE_ENTRY_FILENAME = ".sous.entry.json";

/** File name of the links map, in a project's `.sous/` directory or in `$SOUS_HOME`. */
export const LINKS_FILENAME = "sous.links.json";

/**
 * Extensions a hand-written manifest may use, in the order they are tried when
 * discovering one. Both `.json` and `.jsonc` are parsed permissively (comments
 * and trailing commas are allowed); see `load-manifest.ts`.
 */
export const MANIFEST_EXTENSIONS = [".yaml", ".yml", ".json", ".jsonc"] as const;

// --- Name primitives ----------------------------------------------------------------------------

/** Builds a kebab-case name schema with a message naming what is being named. */
function kebabName(label: string, example: string) {
  return z
    .string()
    .regex(
      KEBAB_NAME_PATTERN,
      `a ${label} must be lowercase kebab-case: a letter, then letters, digits or ` +
        `hyphens (for example '${example}')`
    );
}

/** A repo's short name, as used by the `repo:` qualifier on a ref. */
export const repoNameSchema = kebabName("repo name", "sous-recipes");

/** A namespace name. */
export const namespaceNameSchema = kebabName("namespace name", "tool-usage");

/** A recipe name, unique within its namespace. */
export const recipeNameSchema = kebabName("recipe name", "task-files");

/** A camelCase variable name, as declared by a recipe variable definition. */
export const variableNameSchema = z
  .string()
  .regex(
    VARIABLE_NAME_PATTERN,
    "a variable name must be camelCase: a lowercase letter, then letters or digits " +
      "(for example 'apiBaseUrl')"
  );

/** An explicit environment variable name for a variable definition. */
export const envVarNameSchema = z
  .string()
  .regex(
    ENV_VAR_NAME_PATTERN,
    "an environment variable name must be upper snake case: a capital letter, then " +
      "capitals, digits or underscores (for example 'GITHUB_TOKEN')"
  );

/** A ref key: a bare namespace, or `namespace/recipe`. Never repo-qualified or ranged. */
export const refKeySchema = z
  .string()
  .regex(
    REF_KEY_PATTERN,
    "a ref key must be a namespace ('workflow') or a namespace and recipe " +
      "('workflow/task-files'), with no repo qualifier and no version range"
  );

/** A recipe key: always `namespace/recipe`. */
export const recipeKeySchema = z
  .string()
  .regex(
    RECIPE_KEY_PATTERN,
    "a recipe key must be a namespace and recipe joined by a slash " +
      "(for example 'workflow/task-files')"
  );

// --- Value primitives ---------------------------------------------------------------------------

/** An exact semantic version, as published by a recipe. */
export const semverVersionSchema = z
  .string()
  .refine((value) => semver.valid(value) !== null, {
    message:
      "must be an exact semantic version, such as '1.4.0' or '2.0.0-beta.1'",
  });

/** A semantic version range, resolved with the same rules npm uses. */
export const semverRangeSchema = z
  .string()
  .refine((value) => semver.validRange(value) !== null, {
    message:
      "must be a semantic version range, such as '^1.2.0', '~2.1', '>=1.0.0 <2.0.0' or '*'",
  });

/** A content hash over a recipe's files, written as `sha256-` plus lowercase hex. */
export const contentHashSchema = z
  .string()
  .regex(
    CONTENT_HASH_PATTERN,
    "a content hash must be written as 'sha256-' followed by 64 lowercase hexadecimal characters"
  );

/** An ISO 8601 timestamp with an explicit offset. */
export const isoTimestampSchema = z
  .string()
  .regex(
    ISO_TIMESTAMP_PATTERN,
    "must be an ISO 8601 timestamp with an offset, such as '2026-09-09T14:03:11.482Z'"
  );

/** A byte count: a whole number, never negative. */
export const byteCountSchema = z
  .number()
  .int("must be a whole number of bytes")
  .min(0, "must not be negative");

/**
 * Where a repository lives. A hosted repository is named by a URL; a repository
 * on this machine, which the `local` provider reads, is named by an absolute
 * path or by the same path in `file:///...` form (which is already a URL).
 */
export const repoUrlSchema = z.union([
  z.url(),
  z
    .string()
    .min(1, "must not be empty")
    .refine((value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value), {
      message: "must be a repository URL, or an absolute path to one on this machine",
    }),
]);

/** An absolute filesystem path. */
export const absolutePathSchema = z
  .string()
  .min(1, "must not be empty")
  .refine((value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value), {
    message: "must be an absolute path",
  });

/**
 * Builds a schema for a path that stays inside the directory holding the file
 * that declares it. Rejects absolute paths, backslashes, `.` and `..` segments,
 * empty segments and trailing slashes, so a manifest can never reach outside
 * its own repo or recipe.
 *
 * @param label - What the path names, used in error messages.
 * @param allowGlobs - When true, `*`, `?`, `[...]`, `{...}` and a `**` segment are allowed.
 */
export function relativePathSchema(label: string, allowGlobs = false) {
  return z.string().superRefine((value, ctx) => {
    const fail = (message: string) => {
      ctx.addIssue({ code: "custom", message: `${label} ${message}` });
    };

    if (value.length === 0) {
      fail("must not be empty");
      return;
    }
    if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) {
      fail("must be relative, not absolute");
      return;
    }
    if (value.includes("\\")) {
      fail("must use forward slashes, never backslashes");
      return;
    }
    if (value.endsWith("/")) {
      fail("must not end with a slash");
      return;
    }
    if (!allowGlobs && /[*?[\]{}]/.test(value)) {
      fail("must be a plain path, with no glob characters");
      return;
    }

    for (const segment of value.split("/")) {
      if (segment.length === 0) {
        fail("must not contain an empty path segment");
        return;
      }
      if (segment === "." || segment === "..") {
        fail("must not contain a '.' or '..' segment");
        return;
      }
    }
  });
}

// --- Object helpers -----------------------------------------------------------------------------

/** True when the value is a plain object (not null, not an array). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Drops keys in the reserved `x-` extension namespace from a plain object.
 * Anything that is not a plain object passes through untouched, so the wrapped
 * object schema still reports "expected object" for a string or an array.
 */
function stripExtensionKeys(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  let found = false;
  for (const key of Object.keys(value)) {
    if (key.startsWith("x-")) {
      found = true;
      break;
    }
  }
  if (!found) return value;

  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!key.startsWith("x-")) copy[key] = entry;
  }
  return copy;
}

/**
 * Builds a strict object schema for a HAND-WRITTEN format: unknown keys are
 * rejected so typos surface immediately, except keys in the reserved `x-`
 * extension namespace, which are accepted and ignored. Machine-written formats
 * use plain `z.strictObject` instead; nothing writes extension keys into them.
 */
export function extensibleObject<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.preprocess(stripExtensionKeys, z.strictObject(shape));
}

// --- Error reporting ----------------------------------------------------------------------------

/** Renders a zod issue path (`["variables",0,"name"]`) as `variables[0].name`. */
export function formatIssuePath(parts: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const part of parts) {
    if (typeof part === "number") out += `[${part}]`;
    else out += out.length > 0 ? `.${String(part)}` : String(part);
  }
  return out;
}

/**
 * Validates a value against a format schema, returning it typed. Throws a
 * ConfigError (never a raw ZodError) naming the format, the file it came from
 * and the path of every bad field.
 *
 * @param schema - The zod schema for the format.
 * @param value - The already-parsed file contents.
 * @param sourceLabel - The file path (or other label) named in error messages.
 * @param formatLabel - Plain-language name of the format, such as "recipe manifest".
 */
export function parseFormat<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  sourceLabel: string,
  formatLabel: string
): z.output<Schema> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  const lines: string[] = [`Invalid ${formatLabel} at ${sourceLabel}:`];
  for (const issue of result.error.issues) {
    const where = formatIssuePath(issue.path);
    if (issue.code === "unrecognized_keys") {
      const keys = issue.keys.map((key) => `'${key}'`).join(", ");
      const location = where.length > 0 ? `under '${where}'` : "at the top level";
      lines.push(
        `  - unknown key ${keys} ${location}. This is likely a typo; sous ignores ` +
          `only keys that start with 'x-'.`
      );
    } else if (issue.code === "invalid_key") {
      // zod reports a bad record KEY as a generic "Invalid key in record" and
      // hides the real reason in a nested issue list. Surface the reason, since
      // it is the part that tells the author how to fix the key.
      const reasons = issue.issues.map((inner) => inner.message).join("; ");
      lines.push(`  - ${where}: invalid key; ${reasons}`);
    } else {
      lines.push(`  - ${where.length > 0 ? where : "(root)"}: ${issue.message}`);
    }
  }

  throw new ConfigError(lines.join("\n"));
}

/**
 * Serializes a value as pretty-printed JSON with every object key sorted, so a
 * machine-written file produces a stable, minimal diff between runs.
 */
export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value), null, 2) + "\n";
}

/** Recursively rebuilds plain objects with their keys in sorted order. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (!isPlainObject(value)) return value;

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortKeysDeep(value[key]);
  }
  return sorted;
}
