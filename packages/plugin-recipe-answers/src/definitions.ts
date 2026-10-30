/**
 * Which variables the active recipes define (S6, `recipe-answers.definitions`).
 *
 * A definition is a published specification, not a value: what a variable is called, what an
 * answer looks like and what question to ask. Definitions ship inside recipe manifests, and only
 * active recipes count (S4, 3): a recipe switched off on this machine asks nothing. Both
 * subscribed recipes and the recipes they depend on count, since a recipe may depend on another
 * only to reuse its variables.
 *
 * A standalone definitions file (`--file`) holds the same `variables:` list a manifest does, so a
 * project can ask questions no recipe publishes yet.
 */

import path from "node:path";
import { ConfigError, type ServiceContext } from "@sous-io/plugin-api";
import type { FormatParser, VariableDefinition } from "@sous-io/plugin-formats/types";
import type { ActiveRecipeEntity, RepoEntry } from "@sous-io/plugin-recipes/types";
import type { VariableRef } from "@sous-io/plugin-refs/types";
import { resolveUserPath } from "./paths.js";
import type { DefinedVariable, DefiningRecipe, DefinitionOptions, RecipeAnswersDefinitions } from "./types.js";

/** The repository name recorded for definitions read from a file. */
export const LOCAL_FILE_REPO = "local";

/** The namespace recorded for definitions read from a file. */
export const LOCAL_FILE_NAMESPACE = "local";

/** A recipe's key: `namespace/recipe`. */
export function recipeKey(recipe: Pick<DefiningRecipe, "namespace" | "name">): string {
    return `${recipe.namespace}/${recipe.name}`;
}

/** A variable's key: `namespace/recipe.variableName`. */
export function variableKey(recipe: Pick<DefiningRecipe, "namespace" | "name">, variable: string): string {
    return `${recipeKey(recipe)}.${variable}`;
}

/** A variable's key with its repository in front: `repo:namespace/recipe.variableName`. */
export function qualifiedKey(defined: DefinedVariable): string {
    return `${defined.recipe.repo}:${defined.key}`;
}

/**
 * The ref a defined variable is known as: its name, with its recipe, namespace and repository
 * nested as parents.
 */
export function variableRefOf(recipe: DefiningRecipe, definition: VariableDefinition): VariableRef {
    return {
        kind: "variable",
        name: definition.name,
        description: definition.prompt,
        recipe: {
            kind: "recipe",
            name: recipe.name,
            namespace: { kind: "namespace", name: recipe.namespace, repo: { kind: "repo", name: recipe.repo } },
        },
    };
}

/** One defined variable, its ref and key filled in. */
export function defineVariable(recipe: DefiningRecipe, definition: VariableDefinition, requiredBy?: readonly DefiningRecipe[]): DefinedVariable {
    return {
        definition,
        recipe,
        ref: variableRefOf(recipe, definition),
        key: variableKey(recipe, definition.name),
        ...(requiredBy === undefined || requiredBy.length === 0 ? {} : { requiredBy }),
    };
}

/**
 * Fills in `requiredBy`: for each variable, the other recipes that define the same name and so
 * share its answer on the shared rung.
 */
export function linkSharedNames(variables: readonly DefinedVariable[]): DefinedVariable[] {
    const byName = new Map<string, DefiningRecipe[]>();

    for (const entry of variables) {
        const recipes = byName.get(entry.definition.name) ?? [];

        recipes.push(entry.recipe);
        byName.set(entry.definition.name, recipes);
    }

    return variables.map((entry) => {
        const others = (byName.get(entry.definition.name) ?? []).filter((recipe) => recipe !== entry.recipe);

        return others.length === 0 ? entry : defineVariable(entry.recipe, entry.definition, others);
    });
}

/**
 * Every variable the active recipes define, in recipe order, then declaration order.
 *
 * @param recipes - The `active-recipe` entities.
 * @param repos - The `repos` config key, which lends each recipe its repository's URL.
 */
export function definitionsFromRecipes(recipes: readonly ActiveRecipeEntity[], repos: Readonly<Record<string, RepoEntry>> = {}): DefinedVariable[] {
    const defined: DefinedVariable[] = [];

    for (const active of recipes) {
        const url = repos[active.repo]?.url;
        const recipe: DefiningRecipe = {
            repo: active.repo,
            namespace: active.namespace,
            name: active.name,
            version: active.version,
            dir: active.dir,
            identity: active.identity,
            direct: active.requestedBy.includes("project"),
            ...(url === undefined ? {} : { url }),
        };

        for (const definition of active.manifest.variables ?? []) {
            defined.push(defineVariable(recipe, definition));
        }
    }

    return linkSharedNames(defined);
}

/**
 * A kebab-case recipe name made from a file name, so definitions read from a file still have a
 * recipe to belong to and still get the usual scoped names.
 *
 * ```ts
 * pseudoRecipeName("/x/Team Questions.yaml"); // -> "team-questions"
 * pseudoRecipeName("/x/2024.yaml");           // -> "file-2024"
 * ```
 */
export function pseudoRecipeName(filePath: string): string {
    const base = path.basename(filePath).replace(/\.[^.]+$/, "");
    const slug = base
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

    return slug.length === 0 || !/^[a-z]/.test(slug) ? `file-${slug}` : slug;
}

/** What reading a definitions file needs. */
export interface DefinitionsFileReader {
    /** Reads and parses a YAML, JSON or JSONC file (`formats.manifests.readFile`). */
    readFile(path: string): Promise<unknown>;
    /** Checks one definition (`formats.variable-definition`). */
    definition: FormatParser<VariableDefinition>;
}

/**
 * Reads a definitions file and gives every definition in it to a pseudo-recipe named after the
 * file. Throws a `ConfigError` naming the file and the problem.
 */
export async function loadDefinitionsFile(filePath: string, reader: DefinitionsFileReader): Promise<DefinedVariable[]> {
    const raw = await reader.readFile(filePath);
    const variables = (raw as { variables?: unknown } | null)?.variables;

    if (raw === null || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray(variables) || variables.length === 0) {
        throw new ConfigError(`The variable definitions file at ${filePath} is not valid.`, {
            details: ["variables: must list at least one variable, in the form a recipe manifest uses."],
        });
    }

    const recipe: DefiningRecipe = {
        repo: LOCAL_FILE_REPO,
        namespace: LOCAL_FILE_NAMESPACE,
        name: pseudoRecipeName(filePath),
        version: "0.0.0",
        dir: filePath,
        direct: true,
    };

    // Every problem in the file is reported at once, each named by its place in the list.
    const problems: string[] = [];
    const defined: DefinedVariable[] = [];

    for (const [index, value] of variables.entries()) {
        const checked = reader.definition.check(value, `${filePath}, variables[${index}]`);

        if (checked.issues === undefined) {
            defined.push(defineVariable(recipe, checked.value));
        } else {
            // The parser's own heading ("Invalid variable definition at ...:") gives way to the file's.
            const issues = checked.issues.filter((issue) => !/^Invalid .*:$/.test(issue));

            problems.push(...issues.map((issue) => placeIssue(issue, index)));
        }
    }

    if (problems.length > 0) {
        throw new ConfigError(`Invalid variable definitions file at ${filePath}:`, { details: problems });
    }

    return linkSharedNames(defined);
}

/**
 * One problem the parser found in a definition, named by the definition's place in the file.
 *
 * ```ts
 * placeIssue("  - type: Invalid option", 0);   // -> "- variables[0].type: Invalid option"
 * placeIssue("  - unknown key 'x'", 2);        // -> "- variables[2]: unknown key 'x'"
 * ```
 */
export function placeIssue(issue: string, index: number): string {
    const text = issue.replace(/^\s*-\s*/, "");
    const field = /^([\w.[\]]+): /.exec(text);

    return field === null ? `- variables[${index}]: ${text}` : `- variables[${index}].${text}`;
}

/** Whether a written name names a variable: by its name, its key, or its key with the repository. */
export function namesVariable(defined: DefinedVariable, name: string): boolean {
    return defined.definition.name === name || defined.key === name || qualifiedKey(defined) === name;
}

/** The `recipe-answers.definitions` service. */
export class DefinitionsService implements RecipeAnswersDefinitions {
    constructor(private readonly ctx: ServiceContext) {}

    listSync(): DefinedVariable[] {
        const recipes = this.ctx.entities.kinds().includes("active-recipe") ? this.ctx.entities.list("active-recipe") : [];

        return definitionsFromRecipes(recipes, this.ctx.config.get<Record<string, RepoEntry>>("repos") ?? {});
    }

    async list(options: DefinitionOptions = {}): Promise<DefinedVariable[]> {
        if (options.file === undefined) {
            return this.listSync();
        }

        return loadDefinitionsFile(resolveUserPath(options.file, this.ctx), {
            readFile: (file) => this.ctx.services.get("formats.manifests").readFile(file),
            definition: this.ctx.services.get("formats.variable-definition"),
        });
    }

    async find(nameOrRef: string, options: DefinitionOptions = {}): Promise<DefinedVariable[]> {
        return (await this.list(options)).filter((entry) => namesVariable(entry, nameOrRef));
    }
}
