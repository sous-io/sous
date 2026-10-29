/**
 * A test-only namespace resolver over a fixed map of recipes to directories (S6, "Misfiled
 * Modules": today's `StaticNamespaceResolver` goes to the test helpers). It reads a reference as
 * `namespace/recipe/path` by its first two segments, with globs in any of them, and keeps today's
 * scoping rule: a recipe's own file may reach only itself and what it declares; a project file
 * reaches every recipe.
 */

import path from "node:path";
import { braceExpand, minimatch } from "minimatch";
import type { NamespaceRequest, NamespaceResolution, NamespaceResolver, RecipeRoot } from "../src/types.js";

/** What the resolver knows. */
export interface StaticNamespaceResolverOptions {
    /** `namespace/recipe` to its directory. */
    recipes: Record<string, string>;
    /** `namespace/recipe` to the keys it declares (a recipe key or a bare namespace). */
    dependencies?: Record<string, string[]>;
    /** What the project's own templates may reach; default every recipe. */
    projectScope?: string[];
}

const hasGlob = (text: string) => /[*?{[]/.test(text);

/** Escapes glob characters in a directory, so it can lead a pattern. */
function escapeGlob(dir: string): string {
    return dir.replace(/[*?{}[\]()!]/g, "\\$&");
}

export class StaticNamespaceResolver implements NamespaceResolver {
    private readonly recipes: Record<string, string>;
    private readonly dependencies: Record<string, string[]>;
    private readonly projectScope: string[] | undefined;

    constructor(options: StaticNamespaceResolverOptions) {
        this.recipes = Object.fromEntries(Object.entries(options.recipes).map(([key, dir]) => [key, path.resolve(dir)]));
        this.dependencies = options.dependencies ?? {};
        this.projectScope = options.projectScope;
    }

    includingRecipe(fromFile: string): string | null {
        const target = path.resolve(fromFile);
        let best: string | null = null;
        let bestLength = -1;

        for (const [key, dir] of Object.entries(this.recipes)) {
            if ((target === dir || target.startsWith(dir + path.sep)) && dir.length > bestLength) {
                best = key;
                bestLength = dir.length;
            }
        }

        return best;
    }

    resolve(request: NamespaceRequest): NamespaceResolution {
        const reference = request.reference.replace(/\?[^?\s]*=\S*$/, "");
        const [namespace, recipe, ...rest] = reference.split("/");
        const inner = rest.join("/");

        if (!namespace || !recipe || inner === "") {
            return { kind: "invalid", reference: request.reference, message: "A recipe reference names a namespace, a recipe and a file inside it." };
        }

        if (inner.startsWith("/") || inner.split("/").some((part) => part === "." || part === "..")) {
            return { kind: "escapes-recipe", recipe: `${namespace}/${recipe}`, reference: request.reference };
        }

        const glob = hasGlob(reference);
        const keys = Object.keys(this.recipes).filter((key) => minimatch(key, `${namespace}/${recipe}`));
        const wanted = `${namespace}/${recipe}`;

        if (keys.length === 0) {
            if (glob) {
                return { kind: "candidates", candidates: [], glob: true };
            }

            const namespaces = [...new Set(Object.keys(this.recipes).map((key) => key.split("/")[0]!))].sort();

            if (!namespaces.includes(namespace)) {
                return { kind: "unknown-namespace", namespace, recipe: wanted, known: namespaces };
            }

            return { kind: "unknown-recipe", recipe: wanted, known: Object.keys(this.recipes).filter((key) => key.startsWith(`${namespace}/`)) };
        }

        const including = this.includingRecipe(request.fromFile);
        const declared = including ? [including, ...(this.dependencies[including] ?? [])] : this.projectScope;
        const candidates: string[] = [];
        const roots: RecipeRoot[] = [];

        for (const key of keys) {
            const dir = this.recipes[key]!;

            if (declared !== undefined && !declared.some((entry) => entry === key || entry === key.split("/")[0])) {
                if (glob) {
                    continue;
                }

                return { kind: "not-a-dependency", recipe: key, includingRecipe: including };
            }

            if (glob) {
                if (braceExpand(inner).some((alternative) => alternative.split("/").some((part) => part === "." || part === ".."))) {
                    return { kind: "escapes-recipe", recipe: key, reference: request.reference };
                }

                candidates.push(`${escapeGlob(dir)}/${inner}`);
            } else {
                candidates.push(path.resolve(dir, inner));
            }

            roots.push({ recipe: key, dir });
        }

        return glob ? { kind: "candidates", candidates, glob: true, roots } : { kind: "candidates", candidates, roots };
    }
}
