/**
 * Publish-side validation for a recipe repository.
 *
 * `sous repo release` and `sous repo submit` both refuse to do anything until
 * the repository they are standing in describes itself consistently: every
 * folder the repo manifest lists exists and holds a recipe manifest, every
 * recipe belongs to a declared namespace, no two recipes share a key, and no
 * two variable definitions quietly claim the same environment variable.
 *
 * Nothing here runs git or touches the network; it reads files and reports.
 * Problems are collected rather than thrown, so one run tells an author
 * everything that is wrong instead of only the first thing.
 */

import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "../../errors.js";
import { MANIFEST_EXTENSIONS, REPO_MANIFEST_BASENAME } from "../formats/common.js";
import {
  parseRecipeManifest,
  recipeManifestKey,
  type RecipeManifest,
} from "../formats/recipe-manifest.js";
import { parseRepoManifest, type RepoManifest } from "../formats/repo-manifest.js";
import {
  findRecipeManifest,
  findRepoManifest,
  loadManifestFile,
  requireRepoManifest,
} from "../load-manifest.js";
import { bareName } from "../../vars/names.js";

/** How serious a validation finding is. An error stops a release; a warning does not. */
export type ProblemLevel = "error" | "warning";

/** One validation finding, with enough location to act on it. */
export type ValidationProblem = {
  /** Whether this stops a release or only deserves saying out loud. */
  level: ProblemLevel;
  /** Where it was found: a repo-relative file path, with a field path when there is one. */
  where: string;
  /** What is wrong, in plain language, and what to do about it. */
  message: string;
};

/** One recipe folder that was found, read and validated. */
export type ValidatedRecipe = {
  /** The recipe folder's path relative to the repository root, as the repo manifest lists it. */
  path: string;
  /** Absolute path to the recipe folder. */
  dir: string;
  /** Absolute path to the recipe manifest inside that folder. */
  manifestPath: string;
  /** The validated recipe manifest. */
  manifest: RecipeManifest;
  /** The recipe's key, `namespace/name`. */
  key: string;
  /** The manifest exactly as it was parsed, before the schema dropped its `x-` keys. */
  raw: unknown;
};

/** Everything one pass over a repository found. */
export type RepoValidation = {
  /** Absolute path to the repository root. */
  rootDir: string;
  /** Absolute path to the repo manifest at that root. */
  manifestPath: string;
  /** The validated repo manifest. */
  manifest: RepoManifest;
  /** Every recipe that could be read, in the order the repo manifest lists them. */
  recipes: ValidatedRecipe[];
  /** Everything found wrong, errors and warnings together. */
  problems: ValidationProblem[];
};

/**
 * Environment variable names a recipe should not claim without saying it meant
 * to: the ones an operating system, a shell or a well-known tool already owns.
 * Claiming one is legal and occasionally correct (binding an existing
 * `GITHUB_TOKEN` is the motivating case), so this is a warning, silenced by
 * setting `x-intentional: true` on the definition.
 */
export const WELL_KNOWN_ENV_NAMES: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "NPM_TOKEN",
];

/**
 * Prefixes treated the same way as the names above. `SOUS_VAR_` is deliberately
 * exempt: every name sous derives for an answer starts with it, so warning on
 * it would fire on every well-behaved definition in every repository.
 */
export const WELL_KNOWN_ENV_PREFIXES: readonly string[] = ["AWS_", "SOUS_"];

/** The extension key that silences the well-known environment name warning. */
export const INTENTIONAL_EXTENSION_KEY = "x-intentional";

/**
 * Walks up from a directory to the repository root: the first directory at or
 * above it holding a repo manifest.
 *
 * @param startDir - Where to start looking, normally the working directory.
 * @returns The absolute path of the repository root.
 */
export function findRepoRoot(startDir: string): string {
  let current = path.resolve(startDir);

  for (;;) {
    if (findRepoManifest(current) !== undefined) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new ConfigError(
    `${path.resolve(startDir)} is not inside a sous recipe repository.\n` +
      `  A recipe repository has a '${REPO_MANIFEST_BASENAME}${MANIFEST_EXTENSIONS[0]}' file at ` +
      `its root, and sous looked in that directory and in every directory above it.\n` +
      `  Run the command from inside a repository, or create one with 'sous repo init'.`
  );
}

/**
 * Reads and checks a whole recipe repository.
 *
 * The repo manifest itself must parse; there is nothing to report against when
 * it does not, so that failure is thrown as a ConfigError. Everything below it
 * is collected into `problems`, so one run surfaces every fault at once.
 *
 * @param rootDir - Absolute path to the repository root.
 */
export function validateRepo(rootDir: string): RepoValidation {
  const manifestPath = requireRepoManifest(rootDir);
  const manifest = parseRepoManifest(loadManifestFile(manifestPath), manifestPath);

  const problems: ValidationProblem[] = [];
  const recipes: ValidatedRecipe[] = [];
  const seenKeys = new Map<string, string>();
  const manifestName = path.basename(manifestPath);

  for (const recipePath of manifest.recipes) {
    const dir = path.join(rootDir, recipePath);
    const found = readRecipe(rootDir, recipePath, dir, manifestName, problems);
    if (found === undefined) continue;

    if (!Object.hasOwn(manifest.namespaces, found.manifest.namespace)) {
      problems.push({
        level: "error",
        where: `${relative(rootDir, found.manifestPath)} namespace`,
        message:
          `the recipe is in the namespace '${found.manifest.namespace}', which ` +
          `${manifestName} does not declare under 'namespaces'. Declare the namespace, or ` +
          `move the recipe into one that exists.`,
      });
    }

    const firstPath = seenKeys.get(found.key);
    if (firstPath !== undefined) {
      problems.push({
        level: "error",
        where: relative(rootDir, found.manifestPath),
        message:
          `the recipe '${found.key}' is also published by ${firstPath}. A namespace and a ` +
          `name together name exactly one recipe, so rename one of the two.`,
      });
    } else {
      seenKeys.set(found.key, relative(rootDir, found.manifestPath));
    }

    recipes.push(found);
  }

  problems.push(...checkVariableEnvNames(rootDir, recipes));

  return { rootDir, manifestPath, manifest, recipes, problems };
}

/** True when any problem in the list is an error. */
export function hasErrors(problems: ReadonlyArray<ValidationProblem>): boolean {
  return problems.some((problem) => problem.level === "error");
}

/** The errors in a problem list, in the order they were found. */
export function errorsIn(problems: ReadonlyArray<ValidationProblem>): ValidationProblem[] {
  return problems.filter((problem) => problem.level === "error");
}

/** The warnings in a problem list, in the order they were found. */
export function warningsIn(
  problems: ReadonlyArray<ValidationProblem>
): ValidationProblem[] {
  return problems.filter((problem) => problem.level === "warning");
}

/**
 * The reason an environment variable name deserves a warning, or undefined when
 * it is an ordinary name. Exported so a caller can explain the rule without
 * repeating the list.
 *
 * @param envName - The environment variable name a definition claims.
 */
export function wellKnownEnvReason(envName: string): string | undefined {
  if (WELL_KNOWN_ENV_NAMES.includes(envName)) {
    return `'${envName}' is a well-known name that the system or another tool already uses`;
  }
  if (envName.startsWith("SOUS_VAR_")) return undefined;
  for (const prefix of WELL_KNOWN_ENV_PREFIXES) {
    if (envName.startsWith(prefix)) {
      return (
        `'${envName}' starts with '${prefix}', a prefix reserved by the system or by ` +
        `another tool`
      );
    }
  }
  return undefined;
}

// --- Internals ----------------------------------------------------------------------------------

/**
 * The message a thrown value should be reported with. A ConfigError already
 * carries plain-language wording, and every other Error at least carries a
 * message; anything else is rendered as it stands.
 *
 * @param error - The value that was thrown.
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Renders an absolute path as a repository-relative one, with forward slashes. */
function relative(rootDir: string, target: string): string {
  return path.relative(rootDir, target).split(path.sep).join("/");
}

/**
 * Reads one recipe folder. Returns undefined, having recorded a problem, when
 * the folder is missing or its manifest cannot be read.
 */
function readRecipe(
  rootDir: string,
  recipePath: string,
  dir: string,
  manifestName: string,
  problems: ValidationProblem[]
): ValidatedRecipe | undefined {
  if (!isDirectory(dir)) {
    problems.push({
      level: "error",
      where: recipePath,
      message:
        `${manifestName} lists this recipe folder, but there is no directory there. Create ` +
        `it, or remove the path from the 'recipes' list.`,
    });
    return undefined;
  }

  let manifestPath: string | undefined;
  try {
    manifestPath = findRecipeManifest(dir);
  } catch (error) {
    problems.push({
      level: "error",
      where: recipePath,
      message: describeError(error),
    });
    return undefined;
  }

  if (manifestPath === undefined) {
    problems.push({
      level: "error",
      where: recipePath,
      message:
        "there is no recipe manifest in this folder. Every folder listed under 'recipes' " +
        "holds one 'sous.recipe.yaml'.",
    });
    return undefined;
  }

  let raw: unknown;
  let manifest: RecipeManifest;
  try {
    raw = loadManifestFile(manifestPath);
    manifest = parseRecipeManifest(raw, manifestPath);
  } catch (error) {
    problems.push({
      level: "error",
      where: relative(rootDir, manifestPath),
      message: describeError(error),
    });
    return undefined;
  }

  return {
    path: recipePath,
    dir,
    manifestPath,
    manifest,
    key: recipeManifestKey(manifest),
    raw,
  };
}

/** One definition's claim on an environment variable name. */
type EnvClaim = {
  envName: string;
  variableName: string;
  where: string;
};

/**
 * Checks every variable definition in the repository against every other one.
 *
 * Two definitions of the SAME variable name may share an environment variable:
 * that is the shared rung of the resolution ladder doing its job, and it is how
 * one answer serves every recipe that asks the same question. Two definitions
 * of DIFFERENT variable names sharing one name is a genuine collision, because
 * a single answer would silently satisfy both.
 */
function checkVariableEnvNames(
  rootDir: string,
  recipes: ReadonlyArray<ValidatedRecipe>
): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const byEnvName = new Map<string, EnvClaim>();
  const byVariableName = new Map<string, EnvClaim>();

  for (const recipe of recipes) {
    const definitions = recipe.manifest.variables ?? [];
    definitions.forEach((definition, index) => {
      const envName = bareName(definition);
      const where =
        `${relative(rootDir, recipe.manifestPath)} variables[${index}] ` +
        `('${definition.name}')`;
      const claim: EnvClaim = { envName, variableName: definition.name, where };

      const byEnv = byEnvName.get(envName);
      if (byEnv !== undefined && byEnv.variableName !== definition.name) {
        problems.push({
          level: "error",
          where,
          message:
            `claims the environment variable '${envName}', which ${byEnv.where} already ` +
            `claims for the different variable '${byEnv.variableName}'. Two definitions ` +
            `cannot share one environment variable; set 'env' explicitly on one of them.`,
        });
      } else if (byEnv === undefined) {
        byEnvName.set(envName, claim);
      }

      const byName = byVariableName.get(definition.name);
      if (byName !== undefined && byName.envName !== envName) {
        problems.push({
          level: "warning",
          where,
          message:
            `binds to '${envName}', while ${byName.where} binds the same variable name to ` +
            `'${byName.envName}'. One answer will not serve both; give them one 'env' value ` +
            `if they are meant to be the same question.`,
        });
      } else if (byName === undefined) {
        byVariableName.set(definition.name, claim);
      }

      const reason = wellKnownEnvReason(envName);
      if (reason !== undefined && !isIntentional(recipe.raw, index)) {
        problems.push({
          level: "warning",
          where,
          message:
            `${reason}. An answer written there is visible to every process this project ` +
            `starts. If that is what you meant, set '${INTENTIONAL_EXTENSION_KEY}: true' on ` +
            `the definition to say so.`,
        });
      }
    });
  }

  return problems;
}

/**
 * True when the raw manifest marks the variable definition at `index` as an
 * intentional claim on a well-known name.
 *
 * The flag is read from the RAW manifest rather than from the validated one
 * because the recipe manifest schema accepts and then drops every key in the
 * reserved `x-` extension namespace, so it never reaches the parsed object.
 */
function isIntentional(raw: unknown, index: number): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const variables = (raw as Record<string, unknown>).variables;
  if (!Array.isArray(variables)) return false;
  const entry = variables[index];
  if (typeof entry !== "object" || entry === null) return false;
  return (entry as Record<string, unknown>)[INTENTIONAL_EXTENSION_KEY] === true;
}

/** True when the path exists and is a directory. */
function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}
