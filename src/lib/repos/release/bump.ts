/**
 * Raising the version in a recipe manifest.
 *
 * A recipe manifest is HAND-WRITTEN, and the scaffold sous writes is mostly
 * comments, so a version bump must give the file back to its author looking the
 * way they left it. Both supported formats are edited in place rather than
 * re-serialized from a parsed object: YAML through the `yaml` package's
 * document model, which keeps comments and layout, and JSON through
 * `jsonc-parser`, which edits the exact byte range of the value and leaves
 * everything else, comments included, untouched.
 */

import fs from "node:fs";
import path from "node:path";
import semver from "semver";
import YAML from "yaml";
import { applyEdits, modify } from "jsonc-parser";
import { ConfigError } from "../../errors.js";
import { parseJsoncText } from "../load-manifest.js";

/** How far a version is being raised. */
export const BUMP_LEVELS = ["patch", "minor", "major", "prerelease"] as const;

/** One of the ways `sous repo release --bump` can raise a version. */
export type BumpLevel = (typeof BUMP_LEVELS)[number];

/** What one bump did. */
export type BumpResult = {
  /** The manifest that was rewritten. */
  manifestPath: string;
  /** The version it declared before. */
  from: string;
  /** The version it declares now. */
  to: string;
};

/**
 * The version one level up from the current one, using npm's own semantics.
 *
 * @param current - The version the manifest declares now.
 * @param level - How far to raise it.
 */
export function nextVersion(current: string, level: BumpLevel): string {
  const next = semver.inc(current, level);
  if (next === null) {
    throw new ConfigError(
      `Cannot raise the version '${current}' by a ${level} step.\n` +
        `  A recipe version is an exact semantic version, such as '1.4.0' or '2.0.0-beta.1'.`
    );
  }
  return next;
}

/**
 * Rewrites a recipe manifest's `version` field in place, preserving the rest of
 * the file as written.
 *
 * @param manifestPath - Absolute path to the recipe manifest.
 * @param level - How far to raise the version.
 */
export function bumpRecipeVersion(manifestPath: string, level: BumpLevel): BumpResult {
  const text = fs.readFileSync(manifestPath, "utf8");
  const extension = path.extname(manifestPath).toLowerCase();

  if (extension === ".json") return bumpJson(manifestPath, text, level);
  return bumpYaml(manifestPath, text, level);
}

/** Rewrites the version in a YAML manifest, keeping its comments and layout. */
function bumpYaml(manifestPath: string, text: string, level: BumpLevel): BumpResult {
  const document = YAML.parseDocument(text);
  const node = document.get("version", true);

  if (!YAML.isScalar(node) || typeof node.value !== "string") {
    throw missingVersion(manifestPath);
  }

  const from = node.value;
  const to = nextVersion(from, level);
  node.value = to;
  fs.writeFileSync(manifestPath, document.toString(), "utf8");

  return { manifestPath, from, to };
}

/** Rewrites the version in a JSON manifest, editing only that value's bytes. */
function bumpJson(manifestPath: string, text: string, level: BumpLevel): BumpResult {
  // The manifest dialect allows comments and trailing commas, so it is read
  // through the loader's own permissive parser rather than JSON.parse.
  const parsed = parseJsoncText(text, manifestPath);
  const from =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>).version
      : undefined;
  if (typeof from !== "string") throw missingVersion(manifestPath);

  const to = nextVersion(from, level);
  const edits = modify(text, ["version"], to, {});
  fs.writeFileSync(manifestPath, applyEdits(text, edits), "utf8");

  return { manifestPath, from, to };
}

/** The error for a manifest with no usable `version` field. */
function missingVersion(manifestPath: string): ConfigError {
  return new ConfigError(
    `The recipe manifest at ${manifestPath} has no 'version' field to raise.\n` +
      `  Every recipe declares an exact semantic version; add one, then bump it.`
  );
}
