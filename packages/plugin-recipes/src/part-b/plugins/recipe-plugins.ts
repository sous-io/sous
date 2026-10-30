/**
 * Recipe plugins.
 *
 * A recipe ships a plugin as one bundled file (`plugin.bundle` in its manifest), never something
 * needing `npm install`. The `recipes.plugins` contributor adds each active recipe's bundle to
 * `plugins.load` as a `file:` URL, so the loop loads it; only recipes from repositories the
 * project trusts and has switched on are active, so nothing inside an untrusted repository runs.
 *
 * Every recipe plugin's `.d.ts`, from the locked version loaded, is copied into `.sous/types/`
 * with an `index.d.ts` referencing them all, rewritten on every build.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ContributorDefinition } from "@sous-io/plugin-api";
import type { ActiveRecipeEntity, RepoEntry } from "../../types.js";
import { CONTRIBUTORS, TYPES_DIRNAME } from "../constants.js";

/** The bundle of a recipe's plugin, when it ships one that stays inside the recipe. */
export function pluginBundleOf(recipe: ActiveRecipeEntity): { file: string; types?: string } | { problem: string } | undefined {
    const entry = recipe.manifest.plugin;

    if (entry === undefined) {
        return undefined;
    }

    const file = insideRecipe(recipe.dir, entry.bundle);

    if (file === undefined) {
        return { problem: `The recipe ${recipe.id} names a plugin bundle outside its own files (${entry.bundle}), so it was not loaded.` };
    }

    if (!fs.existsSync(file)) {
        return { problem: `The recipe ${recipe.id} names a plugin bundle that is not there (${entry.bundle}), so it was not loaded.` };
    }

    const types = entry.types === undefined ? undefined : insideRecipe(recipe.dir, entry.types);

    return { file, ...(types !== undefined && fs.existsSync(types) ? { types } : {}) };
}

/** A path inside a recipe, after links are followed, or `undefined` when it leaves the recipe. */
function insideRecipe(dir: string, relative: string): string | undefined {
    if (path.isAbsolute(relative)) {
        return undefined;
    }

    const file = path.resolve(dir, relative);
    let real: string;
    let root: string;

    try {
        root = fs.realpathSync(dir);
        real = fs.existsSync(file) ? fs.realpathSync(file) : file;
    } catch {
        return undefined;
    }

    const from = path.relative(root, real);

    return from === "" || from.startsWith("..") || path.isAbsolute(from) ? undefined : file;
}

/** The `recipes.plugins` contributor. */
export function pluginsContributor(): ContributorDefinition {
    return {
        id: CONTRIBUTORS.plugins,
        after: [CONTRIBUTORS.fetch],

        contribute(config) {
            const repos = config.atPath("repos").get<Record<string, RepoEntry>>() ?? {};

            for (const recipe of config.entities("active-recipe")) {
                const repo = repos[recipe.repo];

                // Never run anything inside a repository the project does not trust.
                if (repo === undefined || repo.enabled === false) {
                    continue;
                }

                const bundle = pluginBundleOf(recipe);

                if (bundle === undefined) {
                    continue;
                }

                if ("problem" in bundle) {
                    config.log("warning", bundle.problem);
                    continue;
                }

                config.atPath(["plugins", "load"]).append(pathToFileURL(bundle.file).href);
            }
        },
    };
}

/** What writing `.sous/types/` did. */
export interface TypesReport {
    readonly directory: string;
    readonly written: string[];
    readonly removed: string[];
}

/**
 * Copies every active recipe plugin's `.d.ts` into `<sousDir>/types/<namespace>/<recipe>.d.ts`
 * and writes `index.d.ts` referencing them all. Files no recipe ships any more are removed. A
 * project with no recipe plugin types gets no directory.
 */
export function writeRecipeTypes(sousDir: string, recipes: readonly ActiveRecipeEntity[]): TypesReport {
    const directory = path.join(sousDir, TYPES_DIRNAME);
    const wanted = new Map<string, string>();

    for (const recipe of recipes) {
        const bundle = pluginBundleOf(recipe);

        if (bundle !== undefined && !("problem" in bundle) && bundle.types !== undefined) {
            wanted.set(path.join(recipe.namespace, `${recipe.name}.d.ts`), bundle.types);
        }
    }

    const written: string[] = [];
    const removed: string[] = [];

    if (wanted.size === 0 && !fs.existsSync(directory)) {
        return { directory, written, removed };
    }

    for (const existing of listDeclarations(directory)) {
        if (existing !== "index.d.ts" && !wanted.has(existing)) {
            fs.rmSync(path.join(directory, existing), { force: true });
            removed.push(existing);
        }
    }

    const references: string[] = [];

    for (const relative of [...wanted.keys()].sort()) {
        const target = path.join(directory, relative);
        const text = fs.readFileSync(wanted.get(relative) as string, "utf8");

        if (writeIfChanged(target, text)) {
            written.push(relative);
        }

        references.push(`/// <reference path="./${relative.split(path.sep).join("/")}" />`);
    }

    const index = ["// Written by sous on every build: the types of the plugins the active recipes ship.", ...references, ""].join("\n");

    if (writeIfChanged(path.join(directory, "index.d.ts"), index)) {
        written.push("index.d.ts");
    }

    return { directory, written, removed };
}

/** Every `.d.ts` under a directory, relative to it. */
function listDeclarations(directory: string): string[] {
    try {
        return (fs.readdirSync(directory, { recursive: true }) as string[]).filter((entry) => entry.endsWith(".d.ts"));
    } catch {
        return [];
    }
}

/** Writes a file only when its text changes. True when written. */
function writeIfChanged(file: string, text: string): boolean {
    try {
        if (fs.readFileSync(file, "utf8") === text) {
            return false;
        }
    } catch {
        // Not there yet.
    }

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, "utf8");

    return true;
}
