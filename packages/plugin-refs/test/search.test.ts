/**
 * What a word on the command line means, decided for every command by refs.resolver and the
 * `ref-lookup` entities: each level of qualification, the kinds a command accepts, the listing
 * order, the exact-then-ignoring-case rule, and locations. Ported from today's ref-search spec; the
 * variable and environment-variable cases move with their lookups to plugin-recipe-answers.
 */

import { nonInteractivePrompter } from "@sous-io/plugin-api";
import { describe, expect, it } from "vitest";
import type { RefKind } from "../src/types.js";
import { catalogLookup, catalogRepo, type CatalogRepo } from "./catalog-lookup.js";
import { buildRefs, lookupsPlugin, type Refs } from "./fixtures.js";

/** The services of a build whose only lookup is a catalog of these repositories. */
async function over(repos: CatalogRepo[]): Promise<Refs> {
    return buildRefs({ plugins: [lookupsPlugin(catalogLookup(repos))] });
}

/** What a command does: resolves a word against what exists and accepts some kinds. */
async function search(refs: Refs, input: string, kinds?: readonly RefKind[]): Promise<string[]> {
    const { refs: found } = await refs.resolver.resolve({ input, refusedIsEmpty: true, ...(kinds ? { kinds } : {}) });

    return found.map((ref) => `${ref.kind}:${refs.format.spelling(ref)}`);
}

describe("a word on the command line, against repositories", () => {
    /**
     * A bare word naming a namespace resolves to it, qualified with the repository publishing it.
     *
     * search("workflow", ["namespace"]) // -> ["namespace:fixtures:workflow"]
     */
    it("should find a namespace by its bare name", async () => {
        const refs = await over([catalogRepo("fixtures", ["workflow/task-files"])]);

        expect(await search(refs, "workflow", ["namespace"])).toEqual(["namespace:fixtures:workflow"]);
        expect(await search(refs, "fixtures:workflow", ["namespace"])).toEqual(["namespace:fixtures:workflow"]);
    });

    /**
     * A repository is named by its short name, and carries where it lives.
     *
     * search("fixtures", ["repo"]) // -> the repository, with its location
     */
    it("should find a repository by its short name", async () => {
        const probe = await buildRefs();
        const location = probe.locations.fromUrl("https://github.com/o/fixtures.git")!;
        const refs = await over([{ ...catalogRepo("fixtures", ["workflow/task-files"]), location }]);
        const { refs: found } = await refs.resolver.resolve({ input: "fixtures", kinds: ["repo"] });

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ kind: "repo", name: "fixtures" });
        expect(refs.format.describe(found[0]!)).toContain("at https://github.com/o/fixtures.git");
    });

    /**
     * A recipe is found by every level of qualification.
     *
     * search("workflow/task-files", ["recipe"]) // -> ["recipe:fixtures:workflow/task-files"]
     */
    it("should find a recipe at every level of qualification", async () => {
        const refs = await over([catalogRepo("fixtures", ["workflow/task-files"])]);

        for (const written of ["task-files", "workflow/task-files", "fixtures:task-files", "fixtures:workflow/task-files"]) {
            expect(await search(refs, written, ["recipe"]), written).toEqual(["recipe:fixtures:workflow/task-files"]);
        }
    });

    /**
     * A word can be a namespace in one repository and a recipe in another; both come back, the
     * namespace first.
     *
     * search("task-files", ["namespace", "recipe"]) // -> ["fixtures:task-files", "extras:workflow/task-files"]
     */
    it("should return both meanings when a word is a namespace and a recipe name", async () => {
        const refs = await over([catalogRepo("fixtures", ["task-files/daily"]), catalogRepo("extras", ["workflow/task-files"])]);

        expect(await search(refs, "task-files", ["namespace", "recipe"])).toEqual(["namespace:fixtures:task-files", "recipe:extras:workflow/task-files"]);
    });

    /**
     * The listing order is the contract, because it is what --accept-first picks from: repository
     * order, then namespace, then recipe name, a whole namespace ahead of the recipes.
     *
     * search("shared", ["namespace", "recipe"]) // -> ["sous-recipes:shared", "sous-recipes:core/shared", ...]
     */
    it("should order matches by repository, then namespace, then recipe name", async () => {
        const refs = await over([
            catalogRepo("sous-recipes", ["core/shared"], ["shared"]),
            catalogRepo("beta", ["mid/shared"]),
            catalogRepo("alpha", ["zeta/shared", "alpha-ns/shared"]),
        ]);

        expect(await search(refs, "shared", ["namespace", "recipe"])).toEqual([
            "namespace:sous-recipes:shared",
            "recipe:sous-recipes:core/shared",
            "recipe:beta:mid/shared",
            "recipe:alpha:alpha-ns/shared",
            "recipe:alpha:zeta/shared",
        ]);
    });

    /**
     * A more qualified spelling outranks a less qualified one, whatever each names.
     *
     * search("fixtures:shared") // -> the namespace 'shared' before the recipe 'shared'
     */
    it("should list a more qualified match before a less qualified one", async () => {
        const refs = await over([catalogRepo("fixtures", ["core/shared"], ["shared"])]);

        expect(await search(refs, "fixtures:shared", ["repo", "namespace", "recipe"])).toEqual(["namespace:fixtures:shared", "recipe:fixtures:core/shared"]);
    });

    /**
     * The exact spelling is tried first, and case is ignored when nothing matches exactly.
     *
     * search("WORKFLOW", ["namespace"]) // -> [fixtures:workflow]
     */
    it("should fall back to ignoring case when nothing matches exactly", async () => {
        const refs = await over([catalogRepo("fixtures", ["workflow/task-files"])]);

        expect(await search(refs, "WORKFLOW", ["namespace"])).toEqual(["namespace:fixtures:workflow"]);
        expect(await search(refs, "Workflow/Task-Files", ["recipe"])).toEqual(["recipe:fixtures:workflow/task-files"]);
        expect(await search(refs, "Fixtures:Task-Files", ["recipe"])).toEqual(["recipe:fixtures:workflow/task-files"]);
    });

    /**
     * An exact match wins outright; a name matching several ignoring case returns them all.
     *
     * search("workflow") // -> the exact namespace;  search("WORKFLOW") // -> both
     */
    it("should prefer an exact match, and return every case-insensitive one otherwise", async () => {
        const refs = await over([catalogRepo("fixtures", ["workflow/task-files", "Workflow/other"])]);

        expect(await search(refs, "workflow", ["namespace"])).toEqual(["namespace:fixtures:workflow"]);
        expect(await search(refs, "WORKFLOW", ["namespace"])).toEqual(["namespace:fixtures:Workflow", "namespace:fixtures:workflow"]);
    });

    /**
     * The exact pass is decided among the kinds a command accepts.
     *
     * search("Fixtures", ["namespace"]) // -> the namespace "fixtures", though a repository is called "Fixtures"
     */
    it("should decide exact before ignoring case among the accepted kinds only", async () => {
        const refs = await over([catalogRepo("Fixtures", ["workflow/a"]), catalogRepo("other", ["fixtures/b"])]);

        expect(await search(refs, "Fixtures", ["namespace"])).toEqual(["namespace:other:fixtures"]);
        expect(await search(refs, "Fixtures", ["repo", "namespace"])).toEqual(["repo:Fixtures"]);
    });

    /**
     * What nothing publishes finds nothing, and so does a word the place refuses when the caller
     * says a refusal names nothing.
     *
     * search("nothing-like-this") // -> []
     */
    it("should find nothing for what is not published, empty or malformed", async () => {
        const refs = await over([catalogRepo("fixtures", ["workflow/task-files"])]);

        expect(await search(refs, "nothing-like-this")).toEqual([]);
        expect(await search(refs, "   ")).toEqual([]);
        expect(await search(refs, "a/b/c")).toEqual([]);
        expect(await search(refs, "*")).toEqual([]);
        await expect(refs.resolver.resolve({ input: "a/b/c" })).rejects.toThrow(/at most two path segments/);
    });
});

describe("a location on the command line", () => {
    /** A trusted repository at github.com/owner/recipes, called "mine" in this project. */
    async function trusted(): Promise<Refs> {
        const probe = await buildRefs();
        const repo: CatalogRepo = {
            name: "mine",
            location: probe.locations.fromUrl("https://github.com/owner/recipes")!,
            namespaces: [{ name: "workflow" }],
            recipes: [
                { namespace: "workflow", name: "alpha", path: "recipes/workflow/alpha" },
                { namespace: "workflow", name: "beta", path: "recipes/workflow/beta" },
            ],
        };

        return over([repo]);
    }

    /**
     * A location matches the trusted repository at it, whatever this project calls it, in every form.
     *
     * search("https://github.com/owner/recipes/workflow/alpha") // -> [mine:workflow/alpha]
     */
    it("should find a recipe named by any location form", async () => {
        const refs = await trusted();

        for (const written of [
            "github://owner/recipes/workflow/alpha",
            "https://github.com/owner/recipes/workflow/alpha",
            "github.com/owner/recipes.git/workflow/alpha",
            "git@github.com:owner/recipes.git/workflow/alpha",
            "https://github.com/Owner/Recipes/Workflow/Alpha",
        ]) {
            expect(await search(refs, written, ["recipe"]), written).toEqual(["recipe:mine:workflow/alpha"]);
        }
    });

    /**
     * A browser URL is settled through the folder each recipe lives in.
     *
     * search("https://github.com/owner/recipes/tree/main/recipes/workflow/beta") // -> [mine:workflow/beta]
     */
    it("should find a recipe named by a browser URL", async () => {
        const refs = await trusted();

        expect(await search(refs, "https://github.com/owner/recipes/tree/main/recipes/workflow/beta", ["recipe"])).toEqual(["recipe:mine:workflow/beta"]);
    });

    /**
     * A namespace and a whole repository are found the same way.
     *
     * search("git@github.com:owner/recipes.git", ["repo"]) // -> [mine]
     */
    it("should find a namespace and a repository named by location", async () => {
        const refs = await trusted();

        expect(await search(refs, "github://owner/recipes/workflow/*", ["namespace"])).toEqual(["namespace:mine:workflow"]);
        expect(await search(refs, "git@github.com:owner/recipes.git", ["repo"])).toEqual(["repo:mine"]);
    });

    /**
     * A location this project does not trust, or that does not parse, names nothing.
     *
     * search("https://github.com/someone/else/workflow/alpha") // -> []
     */
    it("should find nothing at an untrusted or malformed location", async () => {
        const refs = await trusted();

        expect(await search(refs, "https://github.com/someone/else/workflow/alpha")).toEqual([]);
        expect(await search(refs, "https://github.com/owner/recipes/a/b/c", ["recipe"])).toEqual([]);
        expect(await search(refs, "https://github.com/owner/recipes/workflow/gamma")).toEqual([]);
    });
});

describe("resolving and picking together", () => {
    /**
     * An ambiguous word resolves to several matches, and --accept-first takes the first listed.
     *
     * resolve("formatter") then pick({ acceptFirst: true }) // -> fixtures:workflow/formatter
     */
    it("should settle an ambiguous word with --accept-first", async () => {
        const refs = await over([catalogRepo("fixtures", ["workflow/formatter"]), catalogRepo("extras", ["tooling/formatter"])]);
        const { refs: found } = await refs.resolver.resolve({ input: "formatter", kinds: ["recipe"] });
        const picked = await refs.picker.pick(found, { search: "formatter", acceptFirst: true }, { prompter: nonInteractivePrompter, reporter: refs.reporter });

        expect(refs.format.identity(picked)).toBe("fixtures:workflow/formatter");
    });
});
