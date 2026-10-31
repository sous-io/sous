/**
 * Variable mapping records: the way out when generated names clash.
 *
 * A record binds one environment variable, of any name, to one recipe variable:
 *
 * ```text
 * SOME_VAR -> sous-recipes:misc/stuff/apiUrl
 * ```
 *
 * It is the top rung of the answer ladder. Generated names can collide (two recipes may both
 * declare `apiUrl`, or a recipe binds `GITHUB_TOKEN`, which something else uses), and rather than
 * parse a generated name back into its parts, a record states the binding.
 *
 * Records live under the `varMappings` config key. Sous writes its own into the managed
 * `conf.d/520-var-mappings.jsonc`, surgically, through `confd.managed`; a user may write
 * `varMappings` in any config file, and the files merge like anything else.
 */

import { ConfigError, InputError, type ServiceContext } from "@sous-io/plugin-api";
import type { DefinedVariable, MappingTarget, RecipeAnswersMappings } from "./types.js";

/** The managed file the records are written to. */
export const VAR_MAPPINGS_FILE = "520-var-mappings.jsonc";

/** What the mapping file holds, written into its header comment. */
export const VAR_MAPPINGS_DESCRIPTION = [
    "Each entry under 'varMappings' binds an environment variable to one recipe",
    "variable, so an answer can be stored under a name of your choosing when the",
    "usual names are taken. The 'sous vars ask' and 'sous vars map' commands write",
    "them; run 'sous vars' to see which name answered what.",
];

/** The reminder added to every mapping error. */
const TARGET_HELP =
    "A mapping target is written as 'namespace/recipe/variableName', optionally " +
    "qualified with a repository as 'repo:namespace/recipe/variableName'.";

/** A repository, namespace or recipe name, as stored. */
const STORED_NAME = /^[a-z][a-z0-9-]*$/;

/** A variable name: camelCase. */
const VARIABLE_NAME = /^[a-z][a-zA-Z0-9]*$/;

/**
 * Parses a mapping target, throwing a `ConfigError` that quotes it and shows the form when it
 * does not fit.
 *
 * ```ts
 * parseMappingTarget("sous-recipes:misc/stuff/apiUrl");
 * // -> { repo: "sous-recipes", namespace: "misc", recipe: "stuff", variable: "apiUrl" }
 * ```
 */
export function parseMappingTarget(input: string): MappingTarget {
    const fail = (problem: string): never => {
        throw new ConfigError(`Invalid variable mapping target '${input}': ${problem}`, { details: [TARGET_HELP] });
    };

    const trimmed = typeof input === "string" ? input.trim() : "";

    if (trimmed.length === 0) {
        fail("a target must not be empty.");
    }

    const colon = trimmed.indexOf(":");
    const repo = colon === -1 ? undefined : trimmed.slice(0, colon);
    const parts = trimmed.slice(colon + 1).split("/");

    if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
        fail("a target names a namespace, a recipe and a variable, joined by slashes.");
    }

    const [namespace, recipe, variable] = parts as [string, string, string];
    const named = [...(repo === undefined ? [] : [repo]), namespace, recipe];

    for (const name of named) {
        if (!STORED_NAME.test(name)) {
            fail(
                name.toLowerCase() !== name && STORED_NAME.test(name.toLowerCase())
                    ? `the repository, namespace and recipe in '${trimmed.slice(0, trimmed.lastIndexOf("/"))}' must be lowercase.`
                    : `'${name}' is not a repository, namespace or recipe name: a lowercase letter, then lowercase letters, digits or dashes.`,
            );
        }
    }

    if (!VARIABLE_NAME.test(variable)) {
        fail(`the variable name '${variable}' must be camelCase: a lowercase letter, then letters or digits.`);
    }

    return { ...(repo === undefined ? {} : { repo }), namespace, recipe, variable };
}

/** Writes a target back out; round-trips with {@link parseMappingTarget}. */
export function formatMappingTarget(target: MappingTarget): string {
    const qualifier = target.repo === undefined ? "" : `${target.repo}:`;

    return `${qualifier}${target.namespace}/${target.recipe}/${target.variable}`;
}

/** The target a new record for a variable is written with, its repository included. */
export function mappingTargetFor(defined: DefinedVariable): MappingTarget {
    return {
        repo: defined.recipe.repo,
        namespace: defined.recipe.namespace,
        recipe: defined.recipe.name,
        variable: defined.definition.name,
    };
}

/**
 * Whether a target names a variable. A target with no repository matches the variable in any
 * repository; one with a repository must name the same one.
 */
export function mappingMatches(target: MappingTarget, defined: DefinedVariable): boolean {
    if (target.repo !== undefined && target.repo !== defined.recipe.repo) {
        return false;
    }

    return target.namespace === defined.recipe.namespace && target.recipe === defined.recipe.name && target.variable === defined.definition.name;
}

/**
 * Every environment name a record binds to a variable, sorted so the order never depends on the
 * order of the config files.
 */
export function mappedNamesFor(mappings: Readonly<Record<string, string>>, defined: DefinedVariable): string[] {
    const names: string[] = [];

    for (const [envName, target] of Object.entries(mappings)) {
        if (mappingMatches(parseMappingTarget(target), defined)) {
            names.push(envName);
        }
    }

    return names.sort();
}

/** The `recipe-answers.mappings` service. */
export class MappingsService implements RecipeAnswersMappings {
    constructor(private readonly ctx: ServiceContext) {}

    list(): Record<string, MappingTarget> {
        const records = this.ctx.config.get<Record<string, string>>("varMappings") ?? {};
        const parsed: Record<string, MappingTarget> = {};

        for (const [envName, target] of Object.entries(records)) {
            parsed[envName] = parseMappingTarget(target);
        }

        return parsed;
    }

    parseTarget(text: string): MappingTarget {
        return parseMappingTarget(text);
    }

    formatTarget(target: MappingTarget): string {
        return formatMappingTarget(target);
    }

    async set(envName: string, target: MappingTarget, options: { dryRun?: boolean } = {}): Promise<{ file: string; changed: boolean }> {
        this.checkEnvName(envName);

        // Parsed before writing, so a bad target is refused rather than stored.
        const written = formatMappingTarget(parseMappingTarget(formatMappingTarget(target)));
        const result = await this.ctx.services.get("confd.managed").set(VAR_MAPPINGS_FILE, `varMappings.${envName}`, written, {
            description: VAR_MAPPINGS_DESCRIPTION,
            ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
        });

        return { file: result.file, changed: result.changed };
    }

    async remove(envName: string, options: { dryRun?: boolean } = {}): Promise<{ file: string; changed: boolean }> {
        this.checkEnvName(envName);

        const result = await this.ctx.services.get("confd.managed").delete(VAR_MAPPINGS_FILE, `varMappings.${envName}`, {
            description: VAR_MAPPINGS_DESCRIPTION,
            ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
        });

        return { file: result.file, changed: result.changed };
    }

    private checkEnvName(envName: string): void {
        if (!this.ctx.services.get("variables.names").isEnvName(envName)) {
            throw new InputError("vars.map", [
                {
                    path: "envName",
                    message: `'${envName}' is not an environment variable name: a letter or underscore, then letters, digits or underscores.`,
                },
            ]);
        }
    }
}
