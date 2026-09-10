/**
 * Where variable definitions come from.
 *
 * A definition is a published specification, not a value: it says what a
 * variable is called, what shape an answer takes, and what question to ask.
 * Definitions ship inside recipe manifests, so the real source is the set of
 * recipes a project subscribes to. That set is assembled by the resolver, which
 * arrives in a later phase, so every consumer here goes through ONE seam:
 * `loadProjectDefinitions`. Replacing what that factory returns is the whole
 * wiring job; nothing else in the variables layer knows where definitions came
 * from.
 */

import path from "node:path";
import { z } from "zod";
import { parseFormat } from "../repos/formats/common.js";
import {
  variableDefinitionSchema,
  type VariableDefinition,
} from "../repos/formats/recipe-manifest.js";
import { loadManifestFile } from "../repos/load-manifest.js";
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
}

/** One variable definition together with the recipe that published it. */
export interface DefinedVariable {
  /** The published specification. */
  definition: VariableDefinition;
  /** The recipe the definition came from. */
  recipe: DefiningRecipe;
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
 * project is subscribed to, plus the recipes those pull in.
 *
 * WIRING POINT. Subscriptions are resolved to concrete recipe versions by the
 * resolver and the store, which land in a later phase; until then this source
 * loads nothing and every `sous vars` command reports an empty project. When
 * the resolver exists, `load()` walks the resolved recipe set, reads each
 * recipe manifest's `variables:` array, and returns one DefinedVariable per
 * entry. No caller needs to change.
 */
export class ProjectDefinitionSource implements VariableDefinitionSource {
  /**
   * @param settings - The merged project config, which holds the subscriptions.
   * @param sousDir - The project's `.sous/` directory, where the lockfile lives.
   */
  constructor(
    private readonly settings: Settings,
    private readonly sousDir: string
  ) {}

  /** The project's definitions; empty until the resolver is wired in. */
  async load(): Promise<DefinedVariable[]> {
    void this.settings;
    void this.sousDir;
    return [];
  }
}

/**
 * Builds the definition source for a project. This is the single injection
 * point every `sous vars` command uses; a later phase replaces the body with
 * the resolved subscription set and the commands keep working unchanged.
 *
 * @param settings - The merged project config.
 * @param sousDir - The project's `.sous/` directory.
 */
export function loadProjectDefinitions(
  settings: Settings,
  sousDir: string
): VariableDefinitionSource {
  return new ProjectDefinitionSource(settings, sousDir);
}

// --- Standalone definition files ------------------------------------------------------------------

/**
 * A standalone definitions document: the same `variables:` array a recipe
 * manifest carries, in a file of its own. `sous vars ask --file` reads one of
 * these, which is how a project asks questions that are not published by any
 * recipe yet.
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
