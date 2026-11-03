/**
 * Which files recipes publish: the one place that globs a manifest's `contents` entries.
 */

import fs from "node:fs";
import path from "node:path";
import type { ServiceReader } from "@sous-io/plugin-api";
import type { ContentKind } from "@sous-io/plugin-formats/types";
import type { ActiveRecipeContent, ContentRecipe, RecipeContentFile, RecipesContents } from "../types.js";

/** `recipes.contents`. */
export class RecipeContents implements RecipesContents {
    constructor(private readonly services: Pick<ServiceReader, "get">) {}

    of<R extends ContentRecipe>(recipes: readonly R[], kind: ContentKind): Array<ActiveRecipeContent<R>> {
        const globs = this.services.get("host.globs");
        const found: Array<ActiveRecipeContent<R>> = [];

        for (const recipe of recipes) {
            if (recipe.kind !== "subscribes") {
                continue;
            }

            for (const content of recipe.manifest.contents ?? []) {
                if (content.kind !== kind) {
                    continue;
                }

                const seen = new Set<string>();
                const files: RecipeContentFile[] = [];

                for (const include of content.include) {
                    const staticBase = globs.hasGlob(include) ? globs.staticBase(include) : path.posix.dirname(include);
                    const base = path.join(recipe.dir, staticBase === "/" ? "." : staticBase);
                    const relative = globs.matchSync(include, {
                        cwd: recipe.dir,
                        dot: true,
                        ignore: content.exclude ?? [],
                    });

                    for (const file of globs.sortBytewise(relative)) {
                        const absolute = path.join(recipe.dir, file);

                        if (seen.has(absolute) || !isFile(absolute)) {
                            continue;
                        }

                        seen.add(absolute);
                        files.push({ path: globs.toPosix(file), file: absolute, base });
                    }
                }

                found.push({ recipe, kind, files });
            }
        }

        return found;
    }
}

function isFile(candidate: string): boolean {
    try {
        return fs.statSync(candidate).isFile();
    } catch {
        return false;
    }
}
