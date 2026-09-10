/**
 * Reading Repositories files off disk.
 *
 * Manifests are HAND-WRITTEN, and deliberately never JavaScript: trust in the
 * Repositories system rests on being able to read a repo's whole surface
 * without executing any of its code. So a manifest is YAML (`.yaml`, `.yml`) or
 * JSON (`.json`), and the JSON dialect is permissive, allowing line comments,
 * block comments and trailing commas, so a manifest can explain itself.
 *
 * Machine-written files (the index, the lockfile, store entry markers, the
 * links map) are strict JSON; nothing writes a comment into them, so nothing
 * needs to tolerate one.
 *
 * Every function here returns raw, unvalidated data. Pass the result to the
 * matching `parseX` helper in `formats/` to validate it.
 */

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import { ConfigError } from "../errors.js";
import {
  MANIFEST_EXTENSIONS,
  RECIPE_MANIFEST_BASENAME,
  REPO_MANIFEST_BASENAME,
} from "./formats/common.js";

/** Reads a file as UTF-8, raising a ConfigError naming it when that fails. */
function readFileText(filePath: string, label: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === "ENOENT" ? "does not exist" : "could not be read";
    throw new ConfigError(
      `The ${label} at ${filePath} ${reason}.\n` +
        `  ${(error as Error).message}`
    );
  }
}

/** Turns a jsonc-parser error offset into a `line N, column N` string. */
function describeOffset(text: string, offset: number): string {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - before.lastIndexOf("\n");
  return `line ${line}, column ${column}`;
}

/**
 * Parses permissive JSON: standard JSON plus line comments, block comments and
 * trailing commas. Used for hand-written `.json` manifests only.
 *
 * @param text - The file's contents.
 * @param sourceLabel - The file path, named in error messages.
 */
export function parseJsoncText(text: string, sourceLabel: string): unknown {
  const errors: ParseError[] = [];
  const value = parseJsonc(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  if (errors.length > 0) {
    const first = errors[0]!;
    throw new ConfigError(
      `Could not parse ${sourceLabel} as JSON:\n` +
        `  ${printParseErrorCode(first.error)} at ${describeOffset(text, first.offset)}.\n` +
        `  Comments and trailing commas are allowed; anything else must be valid JSON.`
    );
  }

  return value;
}

/**
 * Parses YAML, raising a ConfigError that carries the parser's own message.
 *
 * @param text - The file's contents.
 * @param sourceLabel - The file path, named in error messages.
 */
export function parseYamlText(text: string, sourceLabel: string): unknown {
  try {
    return YAML.parse(text);
  } catch (error) {
    throw new ConfigError(
      `Could not parse ${sourceLabel} as YAML:\n  ${(error as Error).message}`
    );
  }
}

/**
 * Loads a hand-written manifest, picking the parser by extension: `.yaml` and
 * `.yml` are YAML, `.json` is permissive JSON. Returns raw, unvalidated data.
 *
 * @param filePath - Absolute path to the manifest file.
 */
export function loadManifestFile(filePath: string): unknown {
  const extension = path.extname(filePath).toLowerCase();
  const text = readFileText(filePath, "manifest");

  if (extension === ".yaml" || extension === ".yml") {
    return parseYamlText(text, filePath);
  }
  if (extension === ".json") {
    return parseJsoncText(text, filePath);
  }

  throw new ConfigError(
    `Cannot read the manifest at ${filePath}: '${extension}' is not a manifest format.\n` +
      `  A manifest is written as ${MANIFEST_EXTENSIONS.join(", ")}. Manifests are never ` +
      `JavaScript, because sous must be able to read a repository without running its code.`
  );
}

/**
 * Loads a machine-written JSON file (the index, a lockfile, a store entry
 * marker, a links map) with strict JSON parsing. Returns raw, unvalidated data.
 *
 * @param filePath - Absolute path to the file.
 * @param label - Plain-language name of the file, used in error messages.
 */
export function loadJsonFile(filePath: string, label: string): unknown {
  const text = readFileText(filePath, label);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ConfigError(
      `Could not parse the ${label} at ${filePath} as JSON:\n  ${(error as Error).message}\n` +
        `  This file is written by sous; if it has been edited by hand, restoring it from ` +
        `version control is usually the quickest fix.`
    );
  }
}

/** True when the path exists and is a regular file. */
function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Finds the one manifest with the given base name in a directory, trying each
 * supported extension. Returns undefined when there is none.
 *
 * Two manifests in one directory is a hard error rather than a first-match-win,
 * mirroring how sous treats two primary configs in one `.sous/` directory: a
 * silent winner would make the repo's behavior depend on an implementation
 * detail.
 *
 * @param directory - The directory to look in.
 * @param baseName - The manifest base name, without an extension.
 * @param label - Plain-language name of the manifest, used in error messages.
 */
export function findManifest(
  directory: string,
  baseName: string,
  label: string
): string | undefined {
  const found: string[] = [];
  for (const extension of MANIFEST_EXTENSIONS) {
    const candidate = path.join(directory, `${baseName}${extension}`);
    if (isFile(candidate)) found.push(candidate);
  }

  if (found.length > 1) {
    const names = found.map((entry) => path.basename(entry)).join(", ");
    throw new ConfigError(
      `Found more than one ${label} in ${directory}: ${names}.\n` +
        `  A directory holds exactly one ${label}. Remove the copies you do not want, ` +
        `so it is never ambiguous which one sous reads.`
    );
  }

  return found[0];
}

/**
 * Finds the repo manifest at the root of a repository.
 *
 * @param repoRoot - The repository's root directory.
 */
export function findRepoManifest(repoRoot: string): string | undefined {
  return findManifest(repoRoot, REPO_MANIFEST_BASENAME, "repo manifest");
}

/**
 * Finds the recipe manifest in a recipe folder.
 *
 * @param recipeDir - The recipe's directory.
 */
export function findRecipeManifest(recipeDir: string): string | undefined {
  return findManifest(recipeDir, RECIPE_MANIFEST_BASENAME, "recipe manifest");
}

/**
 * Finds the repo manifest and raises a ConfigError naming the directory when
 * there is none, for callers that require one.
 *
 * @param repoRoot - The repository's root directory.
 */
export function requireRepoManifest(repoRoot: string): string {
  const found = findRepoManifest(repoRoot);
  if (found === undefined) {
    throw new ConfigError(
      `No repo manifest in ${repoRoot}.\n` +
        `  A sous repository declares itself with a '${REPO_MANIFEST_BASENAME}${MANIFEST_EXTENSIONS[0]}' ` +
        `file at its root.`
    );
  }
  return found;
}

/**
 * Finds the recipe manifest and raises a ConfigError naming the directory when
 * there is none, for callers that require one.
 *
 * @param recipeDir - The recipe's directory.
 */
export function requireRecipeManifest(recipeDir: string): string {
  const found = findRecipeManifest(recipeDir);
  if (found === undefined) {
    throw new ConfigError(
      `No recipe manifest in ${recipeDir}.\n` +
        `  Every directory listed under 'recipes' in a repo manifest holds a ` +
        `'${RECIPE_MANIFEST_BASENAME}${MANIFEST_EXTENSIONS[0]}' file.`
    );
  }
  return found;
}
