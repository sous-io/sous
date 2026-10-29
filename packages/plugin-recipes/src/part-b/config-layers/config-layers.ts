/**
 * The `recipes.config-layers` contributor: `config` content of the active recipes the project
 * subscribes to, merged into the config as defaults the project's own files land on top of.
 *
 * A recipe layer is JSON, JSONC or YAML only: sous must read what a repository publishes without
 * running any of it, so a `.js` or `.ts` layer from a recipe is refused. Only the keys on the
 * allowlist survive: a recipe may not add a repository, a subscription, or a tool sous launches.
 * The plugin option `configLayers.allowedKeys` adds keys to the list (L6).
 */

import fs from "node:fs";
import path from "node:path";
import type { ConfigBuilder, ContributorDefinition } from "@sous-io/plugin-api";
import type { ActiveRecipeEntity } from "../../types.js";
import { CONTRIBUTORS } from "../constants.js";
import type { RecipesPluginOptions } from "../fetch/fetch-contributor.js";
import type { PartBRuntime } from "../runtime.js";
import { messageOf, sortKeys } from "../support.js";

/** The layer extensions a recipe may contribute. */
export const RECIPE_LAYER_EXTENSIONS = [".json", ".jsonc", ".yaml", ".yml"] as const;

/** Extensions sous will not take from a recipe, because they run. */
export const RECIPE_LAYER_EXECUTABLE_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"] as const;

/** The top-level keys a recipe's config layer may set by default. */
export const RECIPE_CONFIG_ALLOWED_KEYS = ["_aliases", "_vars", "compilation", "recipes", "runtimeContext", "store", "varMappings"] as const;

/** The keys under `recipes` it may set. */
export const RECIPE_CONFIG_ALLOWED_RECIPES_KEYS = ["skills"] as const;

/** Why the keys a recipe most often tries are refused. */
const REFUSAL_REASONS: Record<string, string> = {
    repos: "only you decide which repositories this project trusts, so a recipe may not add one",
    subscriptions: "only you decide what this project subscribes to, so a recipe may not subscribe on your behalf",
    tools: "a tool entry names a program sous launches, so a recipe may not add one or change one",
    plugins: "plugins run code, and a recipe ships its plugin through its manifest instead",
    _env: "an _env mapping decides which environment variables reach the build",
    version: "the config version is the project's own to declare",
    name: "the project's display name is the project's own to declare",
    $schema: "the schema binding is the project's own editor setting",
};

/**
 * Removes every top-level key a recipe may not set. Pure: give it what a layer parsed to, and it
 * returns what may be merged plus one sentence for each key removed.
 */
export function filterRecipeConfigLayer(recipeKey: string, layerPath: string, raw: unknown, extraKeys: readonly string[] = []): { config: Record<string, unknown>; warnings: string[] } {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        return {
            config: {},
            warnings: [`The recipe ${recipeKey} contributes a config layer that is not a set of configuration keys, so none of it was merged: ${layerPath}`],
        };
    }

    const allowed = new Set<string>([...RECIPE_CONFIG_ALLOWED_KEYS, ...extraKeys]);
    const config: Record<string, unknown> = {};
    const warnings: string[] = [];
    const source = raw as Record<string, unknown>;

    for (const key of Object.keys(source)) {
        if (key === "recipes" && !extraKeys.includes("recipes")) {
            const value = source[key];
            const kept: Record<string, unknown> = {};

            if (value !== null && typeof value === "object" && !Array.isArray(value)) {
                for (const sub of Object.keys(value)) {
                    if ((RECIPE_CONFIG_ALLOWED_RECIPES_KEYS as readonly string[]).includes(sub)) {
                        kept[sub] = (value as Record<string, unknown>)[sub];
                    } else {
                        warnings.push(
                            `The recipe ${recipeKey} tried to set 'recipes.${sub}' in a config layer, and sous removed it before merging anything (${layerPath}). Under 'recipes' a recipe may set only: ${RECIPE_CONFIG_ALLOWED_RECIPES_KEYS.join(", ")}.`,
                        );
                    }
                }
            }

            config[key] = kept;
            continue;
        }

        if (allowed.has(key)) {
            config[key] = source[key];
            continue;
        }

        const reason = REFUSAL_REASONS[key] ?? "sous does not recognise it as a key a recipe may set";

        warnings.push(
            `The recipe ${recipeKey} tried to set '${key}' in a config layer, and sous removed it before merging anything (${layerPath}). That key is not one a recipe may set (${reason}). A recipe's config layer may set only: ${[...allowed].join(", ")}.`,
        );
    }

    return { config, warnings };
}

/** One layer read and filtered. */
export interface RecipeConfigLayer {
    readonly path: string;
    readonly recipeKey: string;
    readonly config: Record<string, unknown>;
}

/** Every config layer of the active recipes held through `subscribes`, by recipe key then path, and warnings. */
export function readRecipeConfigLayers(
    recipes: readonly ActiveRecipeEntity[],
    io: {
        readonly match: (patterns: readonly string[], cwd: string, ignore: readonly string[]) => string[];
        readonly parse: (text: string, fileName: string) => unknown;
        readonly extraKeys?: readonly string[];
    },
): { layers: RecipeConfigLayer[]; warnings: string[] } {
    const layers: RecipeConfigLayer[] = [];
    const warnings: string[] = [];
    const executable: string[] = [];
    const unsupported: string[] = [];

    for (const recipe of [...recipes].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))) {
        if (recipe.kind !== "subscribes") {
            continue;
        }

        const found = new Set<string>();

        for (const content of recipe.manifest.contents ?? []) {
            if (content.kind !== "config") {
                continue;
            }

            for (const file of io.match(content.include, recipe.dir, content.exclude ?? [])) {
                const extension = path.extname(file).toLowerCase();

                if ((RECIPE_LAYER_EXECUTABLE_EXTENSIONS as readonly string[]).includes(extension)) {
                    executable.push(file);
                } else if (!(RECIPE_LAYER_EXTENSIONS as readonly string[]).includes(extension)) {
                    unsupported.push(file);
                } else {
                    found.add(path.normalize(file));
                }
            }
        }

        for (const file of sortKeys(found)) {
            let raw: unknown;

            try {
                raw = io.parse(fs.readFileSync(file, "utf8"), file);
            } catch (error) {
                warnings.push(`The recipe ${recipe.id} contributes a config layer sous could not read, so none of it was merged (${file}): ${messageOf(error)}`);
                continue;
            }

            const filtered = filterRecipeConfigLayer(recipe.id, file, raw, io.extraKeys);

            warnings.push(...filtered.warnings);
            layers.push({ path: file, recipeKey: recipe.id, config: filtered.config });
        }
    }

    if (executable.length > 0) {
        warnings.push(
            `Some subscribed recipes contribute config layers that are program code, and sous refused to load them: ${executable.join(", ")}. Sous must read everything a repository publishes without running any of it; publish the same settings as ${RECIPE_LAYER_EXTENSIONS.join(", ")} instead.`,
        );
    }

    if (unsupported.length > 0) {
        warnings.push(`Some subscribed recipes contribute config layers in a format sous does not read, and they were skipped: ${unsupported.join(", ")}. A recipe's config layer is ${RECIPE_LAYER_EXTENSIONS.join(", ")}.`);
    }

    return { layers, warnings };
}

/** The `recipes.config-layers` contributor. */
export function configLayersContributor(runtime: PartBRuntime): ContributorDefinition {
    return {
        id: CONTRIBUTORS.configLayers,
        after: [CONTRIBUTORS.fetch],
        before: ["@sous-io/plugin-config-files", "config-files.*", "confd/*"],

        contribute(config: ConfigBuilder) {
            const recipes = config.entities("active-recipe");

            if (recipes.length === 0) {
                return;
            }

            const globs = runtime.services.get("host.globs");
            const manifests = runtime.services.get("formats.manifests");
            const extraKeys = config.options<RecipesPluginOptions>()?.configLayers?.allowedKeys ?? [];
            const { layers, warnings } = readRecipeConfigLayers(recipes, {
                match: (patterns, cwd, ignore) => globs.matchSync(patterns, { cwd, ignore, absolute: true }),
                parse: (text, file) => manifests.parseText(text, file),
                extraKeys,
            });

            for (const warning of warnings) {
                config.log("warning", warning);
            }

            for (const layer of layers) {
                for (const [key, value] of Object.entries(layer.config)) {
                    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
                        config.atPath([key]).merge(value);
                    } else {
                        config.atPath([key]).set(value);
                    }
                }
            }
        },
    };
}
