/**
 * Where variable definitions come from.
 *
 * A definition is a published specification, not a value: it says what a
 * variable is called, what shape an answer takes, and what question to ask.
 * Definitions ship inside recipe manifests, so the real source is the set of
 * recipes a project's lockfile pins. Every consumer goes through ONE seam,
 * `loadProjectDefinitions`; nothing else in the variables layer knows where
 * definitions came from, which is what lets `sous vars ask --file` read a
 * standalone file through the same machinery.
 */

import path from "node:path";
import { z } from "zod";
import { parseFormat } from "../repos/formats/common.js";
import {
  variableDefinitionSchema,
  type VariableDefinition,
} from "../repos/formats/recipe-manifest.js";
import { loadManifestFile } from "../repos/load-manifest.js";
import {
  listLockedRecipes,
  readProjectLockfile,
  readRecipeManifestIn,
} from "../repos/locked-recipes.js";
import type { Settings } from "../settings.js";

/** Which recipe published a definition, spelled out for display and for naming. */
export interface DefiningRecipe {
  /** The short name of the repository the recipe came from. */
  repo: string;
  /** The recipe's namespace. */
  namespace: string;
  /** The recipe's name. */
  name: string;
  /** The exact version of the recipe in play. */
  version: string;
  /**
   * Where the repository lives: a URL for a hosted repository, or an absolute
   * path for one read through the `local` provider. Used to show a recipe as a
   * link rather than as a bare name.
   */
  url?: string;
  /** The recipe's folder inside the repository, when it is known. */
  path?: string;
  /** The recipe's directory on this machine, when it is present. */
  dir?: string;
}

/** One variable definition together with the recipe that published it. */
export interface DefinedVariable {
  /** The published specification. */
  definition: VariableDefinition;
  /** The recipe the definition came from. */
  recipe: DefiningRecipe;
  /**
   * How this variable came to be in play: the subscribed recipe first, then
   * each recipe it depends on, ending with the recipe that declares the
   * definition. A direct subscription has one entry; an indirect one shows the
   * whole chain. Absent when nothing recorded it, in which case the defining
   * recipe stands for itself.
   */
  requiredBy?: DefiningRecipe[];
}

/** Anything that can produce the variable definitions in play for a project. */
export interface VariableDefinitionSource {
  /** Loads every definition this source knows about. */
  load(): Promise<DefinedVariable[]>;
}

/**
 * A source backed by a fixed array. Used by tests and by any caller that has
 * already assembled its definitions.
 */
export class StaticDefinitionSource implements VariableDefinitionSource {
  /**
   * @param defined - The definitions this source returns.
   */
  constructor(private readonly defined: DefinedVariable[]) {}

  /** Returns the definitions handed to the constructor. */
  async load(): Promise<DefinedVariable[]> {
    return this.defined;
  }
}

/**
 * The project's own definitions: every variable declared by every recipe the
 * lockfile pins, whether the project subscribed to it directly or a dependency
 * pulled it in.
 *
 * Both kinds count, deliberately. A recipe may `depends` on another purely to
 * reuse its published variable definitions, and a build that cannot answer
 * those variables is just as broken as one that cannot answer a subscription's.
 *
 * A recipe the store does not hold yet contributes nothing rather than failing:
 * a fresh clone lists what it can until `sous build` restores the rest.
 */
export class ProjectDefinitionSource implements VariableDefinitionSource {
  /**
   * @param settings - The merged project config, which holds the subscriptions.
   * @param sousDir - The project's `.sous/` directory, where the lockfile lives.
   * @param env - The environment to read; decides where the store is.
   */
  constructor(
    private readonly settings: Settings,
    private readonly sousDir: string,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  /** Every variable published by every recipe this project's lockfile pins. */
  async load(): Promise<DefinedVariable[]> {
    void this.settings;

    const defined: DefinedVariable[] = [];
    const lock = readProjectLockfile(this.sousDir);

    for (const located of listLockedRecipes({ sousDir: this.sousDir, env: this.env })) {
      if (!located.present) continue;

      const manifest = readRecipeManifestIn(located.dir);
      if (manifest === undefined) continue;

      const url = lock.repos[located.repo]?.url;
      const recipe: DefiningRecipe = {
        repo: located.repo,
        namespace: located.namespace,
        name: located.name,
        version: located.version,
        dir: located.dir,
        ...(url === undefined ? {} : { url }),
      };
      for (const definition of manifest.variables ?? []) {
        defined.push({ definition, recipe });
      }
    }

    return defined;
  }
}

/**
 * Builds the definition source for a project. This is the single injection
 * point every `sous vars` command uses.
 *
 * @param settings - The merged project config.
 * @param sousDir - The project's `.sous/` directory.
 * @param env - The environment to read; decides where the store is.
 */
export function loadProjectDefinitions(
  settings: Settings,
  sousDir: string,
  env: NodeJS.ProcessEnv = process.env
): VariableDefinitionSource {
  return new ProjectDefinitionSource(settings, sousDir, env);
}

// --- Standalone definition files ------------------------------------------------------------------

/**
 * A standalone definitions document: the same `variables:` array a recipe
 * manifest carries, in a file of its own. `sous vars ask --file` reads one of
 * these, which is how a project asks questions that are not published by any
 * recipe yet.
 *
 * It is the same schema, so the same rules apply: every definition must carry a
 * description and an example, and both are shown when the question is asked.
 */
export const definitionsFileSchema = z.object({
  /** The definitions to ask, in the recipe manifest's own shape. */
  variables: z.array(variableDefinitionSchema).min(1, "must list at least one variable"),
});

/** A validated standalone definitions document. */
export type DefinitionsFile = z.infer<typeof definitionsFileSchema>;

/** The repository name recorded for definitions that came from a local file. */
export const LOCAL_FILE_REPO = "local";

/** The namespace recorded for definitions that came from a local file. */
export const LOCAL_FILE_NAMESPACE = "local";

/**
 * Turns a file name into a kebab-case pseudo-recipe name, so definitions read
 * from a file still have a recipe to be attributed to and still generate the
 * usual scoped environment variable names.
 *
 * @param filePath - The definitions file's path.
 */
export function pseudoRecipeName(filePath: string): string {
  const base = path.basename(filePath).replace(/\.[^.]+$/, "");
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length === 0 || !/^[a-z]/.test(slug) ? `file-${slug}` : slug;
}

/**
 * Loads a standalone definitions file (YAML or JSON, with the same permissive
 * JSON dialect manifests use) and attributes every definition in it to a
 * pseudo-recipe named after the file.
 *
 * @param filePath - Absolute path to the definitions file.
 */
export function loadDefinitionsFile(filePath: string): DefinedVariable[] {
  const raw = loadManifestFile(filePath);
  const parsed = parseFormat(
    definitionsFileSchema,
    raw,
    filePath,
    "variable definitions file"
  );
  const recipe: DefiningRecipe = {
    repo: LOCAL_FILE_REPO,
    namespace: LOCAL_FILE_NAMESPACE,
    name: pseudoRecipeName(filePath),
    version: "0.0.0",
    dir: filePath,
  };
  return parsed.variables.map((definition) => ({ definition, recipe }));
}

/** A source backed by a standalone definitions file. */
export class FileDefinitionSource implements VariableDefinitionSource {
  /**
   * @param filePath - Absolute path to the definitions file.
   */
  constructor(private readonly filePath: string) {}

  /** Reads and validates the file, throwing a ConfigError when it does not fit. */
  async load(): Promise<DefinedVariable[]> {
    return loadDefinitionsFile(this.filePath);
  }
}

/**
 * The display key for a defined variable: `namespace/recipe.variableName`.
 * Sorting and lookups use it, so one variable never appears twice under two
 * spellings.
 *
 * @param defined - The definition and the recipe that published it.
 */
export function definedVariableKey(defined: DefinedVariable): string {
  return `${defined.recipe.namespace}/${defined.recipe.name}.${defined.definition.name}`;
}

/** The recipe's key (`namespace/recipe`), as shown in listings. */
export function definingRecipeKey(recipe: DefiningRecipe): string {
  return `${recipe.namespace}/${recipe.name}`;
}
