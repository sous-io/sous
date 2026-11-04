/**
 * Which variables the active recipes define.
 *
 * A definition is a published specification, not a value: what a variable is called, what an
 * answer looks like and what question to ask. Definitions ship inside recipe manifests, and only
 * active recipes count: a recipe switched off on this machine asks nothing. Both
 * subscribed recipes and the recipes they depend on count, since a recipe may depend on another
 * only to reuse its variables.
 *
 * A standalone definitions file (`--file`) holds the same `variables:` list a manifest does, so a
 * project can ask questions no recipe publishes yet.
 *
 * Several definitions of one name are combined into one (`combineSharedNames`), so every reader of
 * a `DefinedVariable` sees the definition its answer is asked and checked with.
 */

import path from "node:path";
import { ConfigError, type ServiceContext } from "@sous-io/plugin-api";
import type { FormatParser, VariableDefinition } from "@sous-io/plugin-formats/types";
import type { ActiveRecipeEntity, RepoEntry } from "@sous-io/plugin-recipes/types";
import type { VariableRef } from "@sous-io/plugin-refs/types";
import { combineDefinitions, type Definer } from "./combine.js";
import { resolveUserPath } from "./paths.js";
import type { AnswerDefinition, DefinedVariable, DefiningRecipe, DefinitionOptions, RecipeAnswersDefinitions } from "./types.js";

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

/** What combining a definition with the others of its name added to it. */
export interface SharedNameFacts {
    /** The other recipes defining the same name. */
    readonly requiredBy?: readonly DefiningRecipe[];
    /** The combined definition, in place of the published one. */
    readonly combined?: AnswerDefinition;
    /** Why it could not be combined. */
    readonly separate?: string;
    /** Why this version is not asked at all: another version of its recipe is (see `DefinedVariable.unanswerable`). */
    readonly unanswerable?: string;
}

/** One defined variable, its ref and key filled in. */
export function defineVariable(recipe: DefiningRecipe, definition: VariableDefinition, shared: SharedNameFacts = {}): DefinedVariable {
    const { requiredBy, combined, separate, unanswerable } = shared;

    return {
        definition: combined ?? definition,
        recipe,
        ref: variableRefOf(recipe, definition),
        key: variableKey(recipe, definition.name),
        ...(requiredBy === undefined || requiredBy.length === 0 ? {} : { requiredBy }),
        ...(combined === undefined || combined === definition ? {} : { published: definition }),
        ...(separate === undefined ? {} : { separate }),
        ...(unanswerable === undefined ? {} : { unanswerable }),
    };
}

/** The definitions of one name as `combineDefinitions` takes them, each labeled with its version when its recipe appears twice. */
function definersOf(group: readonly DefinedVariable[]): Definer[] {
    const keys = group.map((entry) => recipeKey(entry.recipe));

    return group.map((entry, index) => {
        const key = keys[index]!;

        return { definition: entry.published ?? entry.definition, label: keys.indexOf(key) === keys.lastIndexOf(key) ? key : `${key} ${entry.recipe.version}` };
    });
}

/**
 * "lib/one and lib/two", for the holders of one version; "this project" for the project itself.
 */
function holderList(holders: readonly string[]): string {
    const named = holders.map((holder) => (holder === "project" ? "this project" : holder));

    return named.length < 2 ? (named[0] ?? "") : `${named.slice(0, -1).join(", ")} and ${named.at(-1)!}`;
}

/**
 * The warning for a version of a recipe that is not asked a variable, because its definition cannot
 * be combined with the version that is.
 *
 * ```ts
 * versionConflictWarning("tone", base200, base100, "support/base 1.0.0 defines tone as a string, and ...");
 * // -> "The variable tone of support/base 2.0.0 cannot be answered alongside support/base 1.0.0, so it is not
 * //     asked and gets no answer: where support/base 2.0.0 is used, tone renders empty. support/base 2.0.0 is
 * //     used by lib/two, and support/base 1.0.0 by lib/one. support/base 1.0.0 defines tone as a string, and ..."
 * ```
 */
export function versionConflictWarning(name: string, skipped: DefiningRecipe, asked: DefiningRecipe, reason: string): string {
    const key = recipeKey(skipped);
    const skippedAt = `${key} ${skipped.version}`;
    const askedAt = `${key} ${asked.version}`;
    const users = [
        ...(skipped.holders === undefined || skipped.holders.length === 0 ? [] : [`${skippedAt} is used by ${holderList(skipped.holders)}`]),
        ...(asked.holders === undefined || asked.holders.length === 0 ? [] : [`${askedAt} by ${holderList(asked.holders)}`]),
    ];
    const used = users.length === 0 ? "" : ` ${users.join(", and ")}.`;

    return `The variable ${name} of ${skippedAt} cannot be answered alongside ${askedAt}, so it is not asked and gets no answer: where ${skippedAt} is used, ${name} renders empty.${used} ${reason}`;
}

/** How one name several definitions share was settled, per definition. */
type Settled = Map<DefinedVariable, Omit<SharedNameFacts, "requiredBy">>;

/**
 * Settles one name whose definitions cannot all be combined (ADR 0023, decision 6, and the ruling
 * on two versions of one recipe). Within each recipe, the version asked is its shared version (the
 * one not `pinned`), else the first; every other version joins it when their definitions combine,
 * and is otherwise not asked at all (`unanswerable`), since every version of a recipe would store
 * its answer under the same recipe-scoped name. What remains is combined again across recipes; when
 * that fails too, each recipe is asked separately with the combination of its own versions.
 */
function settleConflict(group: readonly DefinedVariable[], settled: Settled): void {
    const name = group[0]!.definition.name;
    const byRecipe = new Map<string, DefinedVariable[]>();

    for (const entry of group) {
        byRecipe.set(recipeKey(entry.recipe), [...(byRecipe.get(recipeKey(entry.recipe)) ?? []), entry]);
    }

    const ownCombination = new Map<DefinedVariable, AnswerDefinition>();

    for (const versions of byRecipe.values()) {
        const asked = versions.find((entry) => entry.recipe.pinned !== true) ?? versions[0]!;
        const kept = [asked];

        for (const other of versions) {
            if (other === asked) {
                continue;
            }

            const combination = combineDefinitions(definersOf([...kept, other]));

            if (combination.ok) {
                kept.push(other);
            } else {
                settled.set(other, { unanswerable: versionConflictWarning(name, other.recipe, asked.recipe, combination.reason) });
            }
        }

        const own = combineDefinitions(definersOf(kept));

        for (const entry of kept) {
            ownCombination.set(entry, own.ok ? own.definition : (entry.published ?? entry.definition));
        }
    }

    const remaining = group.filter((entry) => !settled.has(entry));

    if (remaining.length < 2) {
        return;
    }

    const combination = combineDefinitions(definersOf(remaining));

    for (const entry of remaining) {
        settled.set(entry, combination.ok ? { combined: combination.definition } : { combined: ownCombination.get(entry)!, separate: combination.reason });
    }
}

/**
 * Settles every variable name several definitions share (ADR 0023, decision 6). Each variable gets
 * `requiredBy` (the other recipes defining its name) and either the strictest combination of every
 * definition of the name as its `definition`, keeping its own as `published`, or, when they cannot
 * be combined, `separate`: the reason, naming the definitions, said once each recipe is asked
 * separately under its recipe-scoped name.
 *
 * Two versions of one recipe count as two definitions, named with their versions. When they cannot
 * be combined, only one of them is asked (`settleConflict`); the other gets `unanswerable`.
 *
 * Definitions are combined in the order given, so the first one lends the question its prompt.
 */
export function combineSharedNames(variables: readonly DefinedVariable[]): DefinedVariable[] {
    const byName = new Map<string, DefinedVariable[]>();

    for (const entry of variables) {
        const group = byName.get(entry.definition.name) ?? [];

        group.push(entry);
        byName.set(entry.definition.name, group);
    }

    const settled: Settled = new Map();

    for (const group of byName.values()) {
        if (group.length < 2) {
            continue;
        }

        const combination = combineDefinitions(definersOf(group));

        if (combination.ok) {
            for (const entry of group) {
                settled.set(entry, { combined: combination.definition });
            }
        } else {
            settleConflict(group, settled);
        }
    }

    return variables.map((entry) => {
        const outcome = settled.get(entry);
        const group = byName.get(entry.definition.name) ?? [];

        if (group.length < 2) {
            return entry;
        }

        // A version that is not asked shares nobody's answer, so it is no other definition's company.
        const others = group.filter((other) => other !== entry && (outcome?.unanswerable !== undefined || settled.get(other)?.unanswerable === undefined)).map((other) => other.recipe);

        return defineVariable(entry.recipe, entry.published ?? entry.definition, { requiredBy: others, ...(outcome ?? {}) });
    });
}

/**
 * Every variable the active recipes define, in recipe order, then declaration order. A recipe's
 * versions pinned for single holders follow its shared version.
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

        // Each version pinned for some holders alone (ADR 0023, decision 4) is read at its own
        // version, so its definitions join the others of their names, labeled with that version.
        // The holders of a version are named when two versions of the recipe conflict.
        const pinnedFor = new Map<string, { version: string; dir: string; manifest: typeof active.manifest; holders: string[] }>();

        for (const pin of active.pins ?? []) {
            const same = pinnedFor.get(pin.version);

            if (same === undefined) {
                pinnedFor.set(pin.version, { version: pin.version, dir: pin.dir, manifest: pin.manifest, holders: [pin.holder] });
            } else {
                same.holders.push(pin.holder);
            }
        }

        const pinnedHolders = new Set((active.pins ?? []).map((pin) => pin.holder));
        const shared: DefiningRecipe = { ...recipe, holders: active.requestedBy.filter((holder) => !pinnedHolders.has(holder)) };

        for (const definition of active.manifest.variables ?? []) {
            defined.push(defineVariable(pinnedFor.size === 0 ? recipe : shared, definition));
        }

        for (const pin of pinnedFor.values()) {
            const pinned: DefiningRecipe = { ...recipe, version: pin.version, dir: pin.dir, direct: false, holders: pin.holders, pinned: true };

            for (const definition of pin.manifest.variables ?? []) {
                defined.push(defineVariable(pinned, definition));
            }
        }
    }

    return combineSharedNames(defined);
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

    return combineSharedNames(defined);
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

    combine(variables: readonly DefinedVariable[]): DefinedVariable[] {
        return combineSharedNames(variables);
    }
}
