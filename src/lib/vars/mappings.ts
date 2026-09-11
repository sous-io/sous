/**
 * Mapping records: the universal conflict resolver for variable answers.
 *
 * A mapping record binds one environment variable, of any name at all, to one
 * fully qualified variable:
 *
 *     SOME_VAR -> sous-recipes:misc/stuff/apiUrl
 *
 * It is the top rung of the resolution ladder, and it exists because generated
 * names can collide: two recipes may both declare `apiUrl`, or an author may
 * bind an existing name such as `GITHUB_TOKEN` that something else already
 * uses. Rather than inventing a name grammar that sous would have to parse back
 * into scopes, a record simply states the binding.
 *
 * Records live under the top-level `varMappings` config key. sous writes the
 * ones it creates into the machine-written `conf.d/520-var-mappings.jsonc`
 * layer; a user may also hand-write `varMappings` in the primary config, and
 * the layers merge like anything else.
 */

import fs from "node:fs";
import path from "node:path";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { ConfigError } from "../errors.js";
import {
  managedLayerHeader,
  updateManagedLayer,
} from "../repos/managed-layer.js";
import {
  NAMESPACE_NAME_PATTERN,
  RECIPE_NAME_PATTERN,
  REPO_NAME_PATTERN,
  VARIABLE_NAME_PATTERN,
} from "../repos/formats/patterns.js";
import type { DefinedVariable } from "./definition-source.js";

/** File name of the machine-written mapping record layer. */
export const VAR_MAPPINGS_LAYER_FILENAME = "520-var-mappings.jsonc";

/** What the mapping record layer holds, written into its header comment. */
export const VAR_MAPPINGS_DESCRIPTION = [
  "Each entry under 'varMappings' binds an environment variable to one recipe",
  "variable, so an answer can be stored under a name of your choosing when the",
  "usual names are taken. Run 'sous vars' to see which name answered what.",
];

/** The header comment sous writes at the top of the mapping record layer. */
export const VAR_MAPPINGS_COMMENT = managedLayerHeader(
  VAR_MAPPINGS_LAYER_FILENAME,
  VAR_MAPPINGS_DESCRIPTION
);

/** A mapping record's target: one variable, named in full. */
export interface MappingTarget {
  /** The repository's short name, when the record names one. */
  repo?: string;
  /** The recipe's namespace. */
  namespace: string;
  /** The recipe's name. */
  recipe: string;
  /** The variable's camelCase name. */
  variable: string;
}

/** The one-line reminder appended to every mapping error. */
const TARGET_HELP =
  "A mapping target is written as 'namespace/recipe/variableName', optionally " +
  "qualified with a repository as 'repo:namespace/recipe/variableName'.";

/**
 * Parses a mapping target string into its parts, throwing a ConfigError that
 * quotes the input and shows the grammar when it does not fit.
 *
 * @param input - The target as written in the config.
 */
export function parseMappingTarget(input: string): MappingTarget {
  const fail = (problem: string): never => {
    throw new ConfigError(
      `Invalid variable mapping target '${input}': ${problem}\n  ${TARGET_HELP}`
    );
  };

  const trimmed = typeof input === "string" ? input.trim() : "";
  if (trimmed.length === 0) fail("a target must not be empty.");

  let body = trimmed;
  let repo: string | undefined;

  const colon = body.indexOf(":");
  if (colon !== -1) {
    repo = body.slice(0, colon);
    body = body.slice(colon + 1);
    if (!REPO_NAME_PATTERN.test(repo)) {
      fail(
        `the repository qualifier '${repo}' must be lowercase kebab-case: a letter, ` +
          "then letters, digits or hyphens."
      );
    }
  }

  const segments = body.split("/");
  if (segments.length !== 3) {
    fail("a target names a namespace, a recipe and a variable, joined by slashes.");
  }

  const [namespace, recipe, variable] = segments as [string, string, string];
  if (!NAMESPACE_NAME_PATTERN.test(namespace)) {
    fail(`the namespace '${namespace}' must be lowercase kebab-case.`);
  }
  if (!RECIPE_NAME_PATTERN.test(recipe)) {
    fail(`the recipe name '${recipe}' must be lowercase kebab-case.`);
  }
  if (!VARIABLE_NAME_PATTERN.test(variable)) {
    fail(
      `the variable name '${variable}' must be camelCase: a lowercase letter, then ` +
        "letters or digits."
    );
  }

  const parsed: MappingTarget = { namespace, recipe, variable };
  if (repo !== undefined) parsed.repo = repo;
  return parsed;
}

/**
 * Renders a mapping target back into its written form, which round-trips with
 * `parseMappingTarget`.
 *
 * @param target - The target parts.
 */
export function formatMappingTarget(target: MappingTarget): string {
  const qualifier = target.repo === undefined ? "" : `${target.repo}:`;
  return `${qualifier}${target.namespace}/${target.recipe}/${target.variable}`;
}

/**
 * The fully qualified target for one defined variable, repository qualifier
 * included, which is what a new record is written with.
 *
 * @param defined - The definition and the recipe that published it.
 */
export function mappingTargetFor(defined: DefinedVariable): MappingTarget {
  return {
    repo: defined.recipe.repo,
    namespace: defined.recipe.namespace,
    recipe: defined.recipe.name,
    variable: defined.definition.name,
  };
}

/**
 * True when a mapping record's target names this variable. A record without a
 * repository qualifier matches the variable in any repository; one with a
 * qualifier must name the same repository.
 *
 * @param target - The record's parsed target.
 * @param defined - The definition and the recipe that published it.
 */
export function mappingMatches(target: MappingTarget, defined: DefinedVariable): boolean {
  if (target.repo !== undefined && target.repo !== defined.recipe.repo) return false;
  return (
    target.namespace === defined.recipe.namespace &&
    target.recipe === defined.recipe.name &&
    target.variable === defined.definition.name
  );
}

/**
 * Every environment variable name bound to this variable by a mapping record,
 * sorted so the order never depends on config layer order.
 *
 * @param mappings - The merged `varMappings` block.
 * @param defined - The definition and the recipe that published it.
 */
export function mappedNamesFor(
  mappings: Record<string, string>,
  defined: DefinedVariable
): string[] {
  const names: string[] = [];
  for (const [envName, rawTarget] of Object.entries(mappings)) {
    if (mappingMatches(parseMappingTarget(rawTarget), defined)) names.push(envName);
  }
  return names.sort();
}

/**
 * Records a mapping in the machine-written `conf.d/520-var-mappings.jsonc`
 * layer, editing only that one entry's bytes so any comments, key order and
 * formatting already in the file survive.
 *
 * The edit stages to a temporary name and renames over the layer, like every
 * other file sous writes for a machine. A layer truncated by an interrupt would
 * fail to parse and break every later command until someone deleted it by hand;
 * a rename either happens or does not, so the previous layer survives.
 *
 * @param confDir - The project's `conf.d/` directory (`configContext.confDir`).
 * @param envName - The environment variable the answer is stored under.
 * @param target - The variable the name is bound to.
 * @returns The path of the layer file that was written.
 */
export function writeMappingRecord(
  confDir: string,
  envName: string,
  target: MappingTarget | string
): string {
  const rendered = typeof target === "string" ? target : formatMappingTarget(target);
  // Parse before writing, so a bad target is refused rather than persisted.
  parseMappingTarget(rendered);

  return updateManagedLayer(
    path.dirname(confDir),
    VAR_MAPPINGS_LAYER_FILENAME,
    [{ path: ["varMappings", envName], value: rendered }],
    { confDir, header: VAR_MAPPINGS_COMMENT }
  );
}

/**
 * Reads the records already in the mapping layer file, returning an empty
 * object when the file is missing. A layer still under the old
 * `520-var-mappings.json` name is read as a fallback; the next write migrates
 * it.
 *
 * @param filePath - Path to the mapping record layer file.
 */
export function readMappingRecords(filePath: string): Record<string, string> {
  let readPath = filePath;
  if (!fs.existsSync(readPath)) {
    const legacy = filePath.endsWith(".jsonc") ? filePath.slice(0, -1) : undefined;
    if (legacy === undefined || !fs.existsSync(legacy)) return {};
    readPath = legacy;
  }

  const errors: ParseError[] = [];
  const parsed = parseJsonc(fs.readFileSync(readPath, "utf8"), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    throw new ConfigError(
      `Could not read the variable mapping records at ${readPath}:\n` +
        `  The file is not valid JSON with comments.\n` +
        `  This file is written by sous; deleting it removes every mapping record.`
    );
  }

  const block =
    parsed !== null && typeof parsed === "object"
      ? (parsed as { varMappings?: unknown }).varMappings
      : undefined;
  if (block === undefined) return {};
  if (block === null || typeof block !== "object" || Array.isArray(block)) {
    throw new ConfigError(
      `The variable mapping records at ${readPath} are malformed: 'varMappings' must ` +
        `be an object of environment variable names to targets.`
    );
  }

  const records: Record<string, string> = {};
  for (const [key, value] of Object.entries(block as Record<string, unknown>)) {
    if (typeof value === "string") records[key] = value;
  }
  return records;
}
