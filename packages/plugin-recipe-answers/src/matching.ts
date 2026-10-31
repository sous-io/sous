/**
 * Matching refs against the variables in play: the one place a written ref is narrowed to the
 * variables it names. The `ref-lookup` entities answer from it, and `vars.ask` narrows its pool
 * with it, step by step.
 *
 * A name matches in its exact spelling first, then ignoring case, and may be a glob pattern. A
 * match is returned in the spelling the recipe publishes.
 */

import type { NamespaceRef, RecipeRef, RefMatch, RepoRef, SousRef, VariableRef } from "@sous-io/plugin-refs/types";
import type { Ladder } from "./ladder.js";
import type { DefinedVariable } from "./types.js";

/** How a written name matched a known one. */
export type NameMatch = "exact" | "folded" | undefined;

/** The characters that make a name a glob pattern. */
const GLOB_CHARS = /[*?[\]{}]/;

/** A glob pattern as a regular expression: `*`, `?`, `[...]` and `{a,b}`. */
function globToRegExp(pattern: string, ignoreCase: boolean): RegExp {
    let source = "";
    let braces = 0;

    for (let index = 0; index < pattern.length; index += 1) {
        const character = pattern[index]!;

        if (character === "*") {
            source += ".*";
        } else if (character === "?") {
            source += ".";
        } else if (character === "[") {
            const end = pattern.indexOf("]", index + 1);

            if (end === -1) {
                source += "\\[";
            } else {
                const body = pattern.slice(index + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\");

                source += `[${body}]`;
                index = end;
            }
        } else if (character === "{") {
            braces += 1;
            source += "(?:";
        } else if (character === "}" && braces > 0) {
            braces -= 1;
            source += ")";
        } else if (character === "," && braces > 0) {
            source += "|";
        } else {
            source += character.replace(/[.+^$()|\\]/g, "\\$&");
        }
    }

    return new RegExp(`^${source}$`, ignoreCase ? "i" : "");
}

/**
 * Whether a written name (or glob pattern) matches a known one: exactly, only ignoring case, or
 * not at all.
 *
 * ```ts
 * matchName("Workflow", "workflow"); // -> "folded"
 * matchName("work*", "workflow");    // -> "exact"
 * ```
 */
export function matchName(written: string, known: string): NameMatch {
    if (GLOB_CHARS.test(written)) {
        if (globToRegExp(written, false).test(known)) {
            return "exact";
        }

        return globToRegExp(written, true).test(known) ? "folded" : undefined;
    }

    if (written === known) {
        return "exact";
    }

    return written.toLowerCase() === known.toLowerCase() ? "folded" : undefined;
}

/** The weaker of two matches: one folded part makes the whole thing folded. */
function both(left: NameMatch, right: NameMatch): NameMatch {
    if (left === undefined || right === undefined) {
        return undefined;
    }

    return left === "folded" || right === "folded" ? "folded" : "exact";
}

/** How a repository qualifier matches a variable's repository; no qualifier matches every one. */
function qualifies(qualifier: RepoRef | undefined, variable: DefinedVariable): NameMatch {
    if (qualifier === undefined) {
        return "exact";
    }

    let result: NameMatch = "exact";

    if (qualifier.name !== undefined) {
        result = matchName(qualifier.name, variable.recipe.repo);
    }

    if (qualifier.location !== undefined && qualifier.location.identity !== variable.recipe.identity) {
        return undefined;
    }

    return result;
}

/** The repository ref a variable's repository is known as. */
function repoRef(variable: DefinedVariable): RepoRef {
    return { kind: "repo", name: variable.recipe.repo };
}

/** The namespace ref a variable's namespace is known as. */
function namespaceRef(variable: DefinedVariable): NamespaceRef {
    return { kind: "namespace", name: variable.recipe.namespace, repo: repoRef(variable) };
}

/** The recipe ref a variable's recipe is known as. */
function recipeRef(variable: DefinedVariable): RecipeRef {
    return { kind: "recipe", name: variable.recipe.name, namespace: namespaceRef(variable) };
}

/** A ref's key, for sorting and removing repeats. */
function keyOf(ref: SousRef): string {
    switch (ref.kind) {
        case "repo":
            return `repo ${ref.name ?? ""}`;
        case "namespace":
            return `namespace ${ref.repo?.name ?? ""}:${ref.name}`;
        case "recipe":
            return `recipe ${ref.namespace?.repo?.name ?? ""}:${ref.namespace?.name ?? ""}/${ref.name}`;
        case "variable":
            return `variable ${ref.recipe?.namespace?.repo?.name ?? ""}:${ref.recipe?.namespace?.name ?? ""}/${ref.recipe?.name ?? ""}.${ref.name}`;
        default:
            return `${ref.kind} ${"name" in ref ? String(ref.name) : ""}`;
    }
}

/** Adds the candidate's query values to a known ref. */
function carry<T extends SousRef>(candidate: SousRef, known: T): T {
    return candidate.vars === undefined ? known : { ...known, vars: candidate.vars };
}

/**
 * Every environment name that names a variable: the one its definition declares, plus each
 * generated name on the ladder that is set in `.sous/.env` or `.sous/.env.local`. Generated names
 * count only when in use, since every variable generates several.
 */
export function envNamesOf(variable: DefinedVariable, ladder: Ladder): Set<string> {
    const inUse = ladder.namesInFiles();
    const names = new Set<string>([ladder.bareName(variable)]);

    for (const candidate of ladder.candidates(variable)) {
        if (inUse.has(candidate.envName)) {
            names.add(candidate.envName);
        }
    }

    return names;
}

/**
 * Every known ref a candidate reading names among the variables in play: variables (by name, or
 * qualified by recipe, namespace and repository), the repositories, namespaces and recipes that
 * publish them, and environment names (held whole, exact spelling only), with the variables each
 * answers.
 *
 * @param pool - The variables in play.
 * @param candidate - One reading of a written ref.
 * @param ladder - The ladder, for environment names; without it no `envVar` matches.
 */
export function matchVariables(pool: readonly DefinedVariable[], candidate: SousRef, ladder?: Ladder): RefMatch[] {
    const found = new Map<string, RefMatch>();
    const add = (ref: SousRef, spelling: NameMatch): void => {
        if (spelling === undefined) {
            return;
        }

        const key = keyOf(ref);
        const known = found.get(key);

        if (known === undefined || (!known.exactSpelling && spelling === "exact")) {
            found.set(key, { ref, exactSpelling: spelling === "exact" });
        }
    };

    if (candidate.kind === "envVar") {
        if (ladder === undefined) {
            return [];
        }

        const variables: VariableRef[] = pool.filter((entry) => envNamesOf(entry, ladder).has(candidate.name)).map((entry) => entry.ref);

        return variables.length === 0 ? [] : [{ ref: carry(candidate, { kind: "envVar", name: candidate.name, variables }), exactSpelling: true }];
    }

    for (const variable of pool) {
        switch (candidate.kind) {
            case "repo":
                if (candidate.name !== undefined || candidate.location !== undefined) {
                    add(carry(candidate, repoRef(variable)), qualifies(candidate, variable));
                }

                break;
            case "namespace":
                add(carry(candidate, namespaceRef(variable)), both(qualifies(candidate.repo, variable), matchName(candidate.name, variable.recipe.namespace)));
                break;
            case "recipe": {
                const inNamespace = candidate.namespace === undefined ? "exact" : matchName(candidate.namespace.name, variable.recipe.namespace);
                const spelling = both(both(qualifies(candidate.namespace?.repo ?? candidate.repo, variable), inNamespace), matchName(candidate.name, variable.recipe.name));

                add(carry(candidate, { ...recipeRef(variable), ...(candidate.range === undefined ? {} : { range: candidate.range }) }), spelling);
                break;
            }
            case "variable": {
                let spelling = qualifies(candidate.recipe?.namespace?.repo ?? candidate.recipe?.repo ?? candidate.repo, variable);

                if (candidate.recipe !== undefined) {
                    spelling = both(spelling, matchName(candidate.recipe.name, variable.recipe.name));

                    if (candidate.recipe.namespace !== undefined) {
                        spelling = both(spelling, matchName(candidate.recipe.namespace.name, variable.recipe.namespace));
                    }
                }

                add(carry(candidate, variable.ref), both(spelling, matchName(candidate.name, variable.definition.name)));
                break;
            }
            default:
                break;
        }
    }

    return [...found.values()].sort((left, right) => (keyOf(left.ref) < keyOf(right.ref) ? -1 : keyOf(left.ref) > keyOf(right.ref) ? 1 : 0));
}

/** The repository, namespace and recipe names a ref sits in, whatever its kind. */
function partsOf(ref: SousRef): { repo?: string; namespace?: string; recipe?: string } {
    switch (ref.kind) {
        case "repo":
            return { ...(ref.name === undefined ? {} : { repo: ref.name }) };
        case "namespace":
            return { ...(ref.repo?.name === undefined ? {} : { repo: ref.repo.name }), namespace: ref.name };
        case "recipe": {
            const repo = ref.namespace?.repo?.name ?? ref.repo?.name;

            return { ...(repo === undefined ? {} : { repo }), ...(ref.namespace === undefined ? {} : { namespace: ref.namespace.name }), recipe: ref.name };
        }
        case "variable":
            return ref.recipe === undefined ? { ...(ref.repo?.name === undefined ? {} : { repo: ref.repo.name }) } : partsOf(ref.recipe);
        default:
            return {};
    }
}

/**
 * The variables one ref covers: a whole repository, namespace or recipe, one variable, or the
 * variable an environment name answers (its first).
 */
export function narrowTo(pool: readonly DefinedVariable[], match: SousRef): DefinedVariable[] {
    const target = match.kind === "envVar" ? match.variables?.[0] : match;

    if (target === undefined || target.kind === "recipeFile") {
        return [];
    }

    const { repo, namespace, recipe } = partsOf(target);

    return pool.filter((entry) => {
        if (repo !== undefined && entry.recipe.repo !== repo) return false;
        if (target.kind === "repo") return true;
        if (namespace !== undefined && entry.recipe.namespace !== namespace) return false;
        if (target.kind === "namespace") return true;
        if (recipe !== undefined && entry.recipe.name !== recipe) return false;
        if (target.kind === "recipe") return true;

        return entry.definition.name === target.name;
    });
}
