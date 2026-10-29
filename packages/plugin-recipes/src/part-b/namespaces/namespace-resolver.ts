/**
 * The resolver the `~` sigil uses (`compiler.namespace-resolver`, declared by plugin-compiler,
 * implemented here): which directory `~namespace/recipe/path` means.
 *
 * Its scoping rule:
 * - a file inside a recipe may address only that recipe and what it declares (`depends` plus
 *   `subscribes`), at their pinned versions; the lockfile's holder lists record which keys each
 *   recipe holds, however its manifest wrote them;
 * - a file of the project's own templates may address every active recipe.
 *
 * Only active recipes are known (S4, 3): a recipe whose subscription is switched off here is not
 * addressable, and the error says so.
 */

import path from "node:path";
import type { DroppedRecipe, NamespaceRequest, NamespaceResolution, NamespaceResolver, RecipeRoot } from "@sous-io/plugin-compiler/types";
import type { RecipeFileRef, RefResolution, SousRef } from "@sous-io/plugin-refs/types";
import type { ActiveRecipeEntity } from "../../types.js";
import { sortKeys } from "../support.js";

/** How a name as written matches a known one: in exactly its case, only ignoring case, or not at all. */
export type NameMatch = "exact" | "folded" | undefined;

/** What the resolver is built from. */
export interface NamespaceResolverOptions {
    /** The active recipes. */
    readonly recipes: readonly ActiveRecipeEntity[];
    /** Parses an include reference into its readings, refusing what an include may not hold. */
    readonly parse: (reference: string) => Pick<RefResolution, "refs" | "dropped">;
    /** Whether a name matches a written name or glob. */
    readonly isMatch: (name: string, pattern: string, options: { nocase: boolean }) => boolean;
    /** Why a project template's recipe is not active, when that can be known. */
    readonly explainMissing?: (recipe: string) => DroppedRecipe | undefined;
}

/** `compiler.namespace-resolver`. */
export class ActiveNamespaceResolver implements NamespaceResolver {
    private readonly dirs = new Map<string, string>();
    private readonly repos = new Map<string, string>();
    private readonly dependencies = new Map<string, string[]>();

    constructor(private readonly options: NamespaceResolverOptions) {
        for (const recipe of options.recipes) {
            this.dirs.set(recipe.id, path.resolve(recipe.dir));
            this.repos.set(recipe.id, recipe.repo);

            for (const holder of recipe.requestedBy) {
                const held = this.dependencies.get(holder) ?? [];

                held.push(recipe.id);
                this.dependencies.set(holder, held);
            }
        }
    }

    /** The recipe whose directory holds a file, the deepest first, or `null` for a project file. */
    includingRecipe(fromFile: string): string | null {
        const target = path.resolve(fromFile);
        let best: string | null = null;
        let bestLength = -1;

        for (const [key, dir] of this.dirs) {
            if ((target === dir || target.startsWith(dir + path.sep)) && dir.length > bestLength) {
                best = key;
                bestLength = dir.length;
            }
        }

        return best;
    }

    resolve(request: NamespaceRequest): NamespaceResolution {
        const { reference, fromFile } = request;
        let parsed: Pick<RefResolution, "refs" | "dropped">;

        try {
            parsed = this.options.parse(reference);
        } catch (error) {
            return { kind: "invalid", reference, message: error instanceof Error ? error.message : String(error) };
        }

        const kept = parsed.refs.filter((ref): ref is RecipeFileRef => ref.kind === "recipeFile");

        if (kept.length === 0) {
            return this.refused(reference, parsed);
        }

        // Of a `?name=value` that could also be part of a glob, the reading that read it as values comes first.
        const written = kept.find((ref) => ref.vars !== undefined) ?? kept[0];
        const namespace = written.recipe.namespace?.name ?? "";
        const wanted = `${namespace}/${written.recipe.name}`;
        const matched = this.match(written);

        if (matched.length === 0) {
            if (written.glob === true) {
                return { kind: "candidates", candidates: [], glob: true };
            }

            if (!this.knowsNamespace(namespace)) {
                return { kind: "unknown-namespace", namespace, recipe: wanted, known: this.namespaces(), ...this.droppedFor(wanted, fromFile) };
            }

            return { kind: "unknown-recipe", recipe: wanted, known: this.recipesInNamespace(namespace), ...this.droppedFor(wanted, fromFile) };
        }

        const including = this.includingRecipe(fromFile);
        const declared = including === null ? undefined : [including, ...(this.dependencies.get(including) ?? [])];
        const candidates: string[] = [];
        const roots: RecipeRoot[] = [];

        for (const key of matched) {
            const dir = this.dirs.get(key) as string;

            if (declared !== undefined && !declared.some((entry) => entry === key || entry === key.slice(0, key.indexOf("/")))) {
                if (written.glob === true) {
                    continue;
                }

                return { kind: "not-a-dependency", recipe: key, includingRecipe: including };
            }

            if (written.glob === true) {
                if (climbs(written.path)) {
                    return { kind: "escapes-recipe", recipe: key, reference };
                }

                candidates.push(`${escapeGlob(dir)}/${written.path}`);
                roots.push({ recipe: key, dir });
                continue;
            }

            const resolved = path.resolve(dir, written.path);
            const relative = path.relative(dir, resolved);

            if (resolved !== dir && (relative === "" || relative.startsWith("..") || path.isAbsolute(relative))) {
                return { kind: "escapes-recipe", recipe: key, reference };
            }

            candidates.push(resolved);
            roots.push({ recipe: key, dir });
        }

        return written.glob === true ? { kind: "candidates", candidates, glob: true, roots } : { kind: "candidates", candidates, roots };
    }

    /** The known namespaces, sorted. */
    namespaces(): string[] {
        return sortKeys(new Set([...this.dirs.keys()].map((key) => key.slice(0, key.indexOf("/")))));
    }

    /** The active recipes a written namespace matches: exact spellings, else case-folded ones. */
    recipesInNamespace(written: string): string[] {
        const hits = [...this.dirs.keys()].map((key) => ({ key, match: this.matchName(written, key.slice(0, key.indexOf("/"))) })).filter((hit) => hit.match !== undefined);
        const exact = hits.filter((hit) => hit.match === "exact");

        return sortKeys((exact.length > 0 ? exact : hits).map((hit) => hit.key));
    }

    /** Whether a written namespace matches an active one in some spelling. */
    knowsNamespace(written: string): boolean {
        return [...this.dirs.keys()].some((key) => this.matchName(written, key.slice(0, key.indexOf("/"))) !== undefined);
    }

    /** The active recipe keys a reading names: exact spellings when any, else case-folded ones. */
    private match(ref: RecipeFileRef): string[] {
        const namespace = ref.recipe.namespace?.name;

        if (namespace === undefined) {
            return [];
        }

        const repo = ref.recipe.namespace?.repo?.name ?? ref.recipe.repo?.name;
        const hits: Array<{ key: string; match: NameMatch }> = [];

        for (const key of this.dirs.keys()) {
            const slash = key.indexOf("/");
            let match = combine(this.matchName(namespace, key.slice(0, slash)), this.matchName(ref.recipe.name, key.slice(slash + 1)));

            if (repo !== undefined) {
                const known = this.repos.get(key);

                match = combine(match, known === undefined ? undefined : this.matchName(repo, known));
            }

            if (match !== undefined) {
                hits.push({ key, match });
            }
        }

        const exact = hits.filter((hit) => hit.match === "exact");

        return sortKeys((exact.length > 0 ? exact : hits).map((hit) => hit.key));
    }

    private matchName(written: string, known: string): NameMatch {
        if (this.options.isMatch(known, written, { nocase: false })) {
            return "exact";
        }

        return this.options.isMatch(known, written, { nocase: true }) ? "folded" : undefined;
    }

    /** The answer for a reference every reading of which was refused. */
    private refused(reference: string, parsed: Pick<RefResolution, "dropped">): NamespaceResolution {
        for (const entry of parsed.dropped) {
            const ref = entry.ref as SousRef;

            if (ref.kind === "recipeFile" && ref.path.split("/").some((part) => part === "." || part === "..")) {
                return { kind: "escapes-recipe", recipe: `${ref.recipe.namespace?.name ?? ""}/${ref.recipe.name}`, reference };
            }
        }

        const reasons = parsed.dropped.map((entry) => (entry.instead === undefined ? entry.reason : `${entry.reason} Write ${entry.instead}.`));

        return { kind: "invalid", reference, message: reasons.length > 0 ? [...new Set(reasons)].join("\n") : `'~${reference}' does not name a file inside a recipe.` };
    }

    private droppedFor(recipe: string, fromFile: string): { dropped?: DroppedRecipe } {
        if (this.options.explainMissing === undefined || this.includingRecipe(fromFile) !== null) {
            return {};
        }

        const dropped = this.options.explainMissing(recipe);

        return dropped === undefined ? {} : { dropped };
    }
}

/** The weaker of two matches. */
function combine(left: NameMatch, right: NameMatch): NameMatch {
    if (left === undefined || right === undefined) {
        return undefined;
    }

    return left === "exact" && right === "exact" ? "exact" : "folded";
}

/** Whether a glob path, any brace alternative included, holds a `.` or `..` segment. */
function climbs(pattern: string): boolean {
    return pattern.split(/[/{},]/).some((part) => part === "." || part === "..");
}

/** A directory escaped for use in front of a glob. */
function escapeGlob(dir: string): string {
    return dir.replace(/[*?[\]{}()!+@\\]/g, (char) => `\\${char}`);
}
