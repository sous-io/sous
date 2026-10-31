/**
 * The lockfile as a `ref-lookup` entity: which pinned recipes a namespace, recipe or recipe-file
 * reading names. Asked when a caller selects it by id or by the `lockfile` or `installed` tag.
 */

import type { ServiceContext } from "@sous-io/plugin-api";
import type { Lockfile } from "@sous-io/plugin-formats/types";
import type { RefLookupEntity, RefMatch, SousRef } from "@sous-io/plugin-refs/types";
import { sortKeys, splitStoredKey } from "../support.js";

/** The lookup's id. */
export const LOCKFILE_LOOKUP_ID = "recipes.lockfile";

/** Whether a known name matches a written one, exactly or ignoring case. */
type Matcher = (known: string, written: string, nocase: boolean) => boolean;

/** Every pinned recipe a candidate names. */
export function matchPinned(candidate: SousRef, lockfile: Lockfile, isMatch: Matcher): RefMatch[] {
    const entries = sortKeys(Object.keys(lockfile.recipes)).map((key) => ({ key, ...splitStoredKey(key), repo: lockfile.recipes[key].repo }));
    const name = (written: string, known: string): "exact" | "folded" | undefined => (isMatch(known, written, false) ? "exact" : isMatch(known, written, true) ? "folded" : undefined);
    const both = (...matches: Array<"exact" | "folded" | undefined>): "exact" | "folded" | undefined =>
        matches.includes(undefined) ? undefined : matches.every((match) => match === "exact") ? "exact" : "folded";
    const found: RefMatch[] = [];

    if (candidate.kind === "namespace") {
        const seen = new Set<string>();

        for (const entry of entries) {
            const match = both(name(candidate.name, entry.namespace), candidate.repo?.name === undefined ? "exact" : name(candidate.repo.name, entry.repo));

            if (match !== undefined && !seen.has(entry.namespace)) {
                seen.add(entry.namespace);
                found.push({ ref: { kind: "namespace", name: entry.namespace, repo: { kind: "repo", name: entry.repo } }, exactSpelling: match === "exact" });
            }
        }

        return found;
    }

    const recipe = candidate.kind === "recipe" ? candidate : candidate.kind === "recipeFile" ? candidate.recipe : undefined;

    if (recipe?.namespace === undefined) {
        return found;
    }

    const repo = recipe.namespace.repo?.name ?? recipe.repo?.name;

    for (const entry of entries) {
        const match = both(name(recipe.namespace.name, entry.namespace), name(recipe.name, entry.name), repo === undefined ? "exact" : name(repo, entry.repo));

        if (match === undefined) {
            continue;
        }

        const known = {
            kind: "recipe" as const,
            name: entry.name,
            namespace: { kind: "namespace" as const, name: entry.namespace, repo: { kind: "repo" as const, name: entry.repo } },
            ...(recipe.range === undefined ? {} : { range: recipe.range }),
        };
        const ref: SousRef =
            candidate.kind === "recipeFile"
                ? { kind: "recipeFile", path: candidate.path, recipe: known, ...(candidate.glob ? { glob: true as const } : {}), ...(candidate.vars ? { vars: candidate.vars } : {}) }
                : known;

        found.push({ ref, exactSpelling: match === "exact" });
    }

    return found;
}

/** The `ref-lookup` entity over the project's lockfile. */
export function lockfileLookup(): RefLookupEntity {
    const findSync = (candidate: SousRef, ctx: ServiceContext): RefMatch[] => {
        if (ctx.project === undefined || !ctx.services.has("recipes.lock")) {
            return [];
        }

        const globs = ctx.services.get("host.globs");

        return matchPinned(candidate, ctx.services.get("recipes.lock").read(), (known, written, nocase) => globs.isMatch(known, written, { nocase }));
    };

    return {
        id: LOCKFILE_LOOKUP_ID,
        description: "the recipes this project's lockfile pins",
        kinds: ["namespace", "recipe", "recipeFile"],
        tags: ["lockfile", "installed"],
        optIn: true,
        find: async (candidate, ctx) => findSync(candidate, ctx),
        findSync,
    };
}
