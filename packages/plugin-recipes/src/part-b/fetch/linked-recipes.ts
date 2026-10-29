/**
 * The recipes a linked checkout publishes, by key: its repository manifest lists their folders,
 * and each folder's own manifest names the recipe. A folder with no readable manifest is skipped,
 * since a working copy is edited by hand and may be mid-change.
 */

import path from "node:path";
import type { FormatsManifests, RecipeManifest } from "@sous-io/plugin-formats/types";

/** One recipe in a checkout. */
export interface LinkedRecipe {
    readonly dir: string;
    readonly manifest: RecipeManifest;
}

/** Every recipe a checkout publishes, by `namespace/recipe`. */
export async function mapLinkedRecipes(checkout: string, manifests: FormatsManifests): Promise<Map<string, LinkedRecipe>> {
    const found = new Map<string, LinkedRecipe>();
    let repo;

    try {
        repo = await manifests.readRepo(checkout);
    } catch {
        return found;
    }

    for (const relative of repo?.manifest.recipes ?? []) {
        const dir = path.join(checkout, relative);

        try {
            const recipe = await manifests.readRecipe(dir);

            if (recipe !== undefined) {
                found.set(`${recipe.manifest.namespace}/${recipe.manifest.name}`, { dir, manifest: recipe.manifest });
            }
        } catch {
            // Mid-change; skipped.
        }
    }

    return found;
}
