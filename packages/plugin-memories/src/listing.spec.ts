import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTmpDir, recipe as makeRecipe, standInGlobs, write, type RecipeFixture } from "../test/stand-ins.js";
import { dependencyOrder, selectMemories, viewPath } from "./listing.js";

let tmp: { path: string; cleanup(): void };

const recipe = (key: string, options?: RecipeFixture) => makeRecipe(tmp.path, key, options);
const select = (recipes: ReturnType<typeof recipe>[], settings = {}, onWarning?: (m: string) => void) =>
    selectMemories({ recipes, settings, globs: standInGlobs, ...(onWarning ? { onWarning } : {}) });

beforeEach(() => {
    tmp = makeTmpDir();
});

afterEach(() => {
    tmp.cleanup();
});

describe("dependencyOrder()", () => {
    /**
     * A recipe comes after every recipe it depends on, whatever the keys say; unrelated recipes go by key.
     *
     * zeta is held by alpha (alpha depends on zeta): zeta, alpha, then beta
     */
    it("should put a recipe after the recipes it depends on and break ties by key", () => {
        const alpha = recipe("a/alpha");
        const beta = recipe("b/beta");
        const zeta = recipe("z/zeta", { requestedBy: ["a/alpha"] });

        expect(dependencyOrder([alpha, beta, zeta], standInGlobs.compareBytewise)).toEqual(["b/beta", "z/zeta", "a/alpha"]);
    });

    /**
     * A cycle leaves its members in key order at the end.
     *
     * a/x requested by b/y, b/y requested by a/x, c/z free -> c/z, a/x, b/y
     */
    it("should put the members of a cycle last, in key order", () => {
        const x = recipe("a/x", { requestedBy: ["b/y"] });
        const y = recipe("b/y", { requestedBy: ["a/x"] });
        const z = recipe("c/z");

        expect(dependencyOrder([x, y, z], standInGlobs.compareBytewise)).toEqual(["c/z", "a/x", "b/y"]);
    });
});

describe("selectMemories()", () => {
    /**
     * Each memory is named by its path relative to the static base of the include pattern, in bytewise
     * order within a recipe; the view lists it under namespace/recipe.
     *
     * include "memories/**\/*.md" with memories/b.md and memories/sub/a.md
     * // -> "c/one/b.md", "c/one/sub/a.md"
     */
    it("should name memories relative to the include pattern's base", () => {
        const one = recipe("c/one", { files: ["memories/sub/a.md", "memories/b.md", "other/x.md"], include: ["memories/**/*.md"] });
        const { selected } = select([one]);

        expect(selected.map(viewPath)).toEqual(["c/one/b.md", "c/one/sub/a.md"]);
        expect(selected[0]).toEqual({
            recipe: "c/one",
            repository: "fixtures",
            name: "b.md",
            path: path.join(one.dir, "memories", "b.md"),
        });
    });

    /**
     * A content block's exclude patterns leave files out, and a file two patterns match is listed once.
     *
     * include ["memories/*.md", "memories/a.md"], exclude ["memories/skip.md"] -> a.md, b.md
     */
    it("should honour a content block's exclude and list each file once", () => {
        const one = recipe("c/one", {
            files: ["memories/a.md", "memories/b.md", "memories/skip.md"],
            include: ["memories/*.md", "memories/a.md"],
            exclude: ["memories/skip.md"],
        });

        expect(select([one]).selected.map((memory) => memory.name)).toEqual(["a.md", "b.md"]);
    });

    /**
     * A recipe held only through depends is a library and lists nothing.
     *
     * kind "depends" -> []
     */
    it("should list nothing for a recipe held only through depends", () => {
        const library = recipe("c/lib", { kind: "depends", requestedBy: ["c/one"] });

        expect(select([library]).selected).toEqual([]);
    });

    /**
     * Recipes are in dependency order.
     *
     * a/app depends on z/base -> z/base's memory first
     */
    it("should list a dependency's memories before its dependent's", () => {
        const app = recipe("a/app");
        const base = recipe("z/base", { requestedBy: ["a/app"] });

        expect(select([app, base]).selected.map((memory) => memory.recipe)).toEqual(["z/base", "a/app"]);
    });

    /**
     * `first` moves matching recipes to the front, keeping the same relative order among them and the rest.
     *
     * first ["z/*"] with a/one, b/two, z/last -> z/last, a/one, b/two
     */
    it("should move recipes matching first to the front", () => {
        const recipes = [recipe("a/one"), recipe("b/two"), recipe("z/last")];

        expect(select(recipes, { first: ["z/*"] }).selected.map((memory) => memory.recipe)).toEqual(["z/last", "a/one", "b/two"]);
    });

    /**
     * `exclude` drops matching recipes, including by a /regular expression/, and says which entry did it.
     *
     * exclude ["a/*", "/^b\//"] with a/one, b/two, z/last -> z/last; a/one by [0], b/two by [1]
     */
    it("should drop recipes matching exclude and name the entry", () => {
        const recipes = [recipe("a/one"), recipe("b/two"), recipe("z/last")];
        const result = select(recipes, { exclude: ["a/*", "/^b\\//"] });

        expect(result.selected.map((memory) => memory.recipe)).toEqual(["z/last"]);
        expect(result.excluded.map(({ memory, by }) => [memory.recipe, by])).toEqual([
            ["a/one", "recipes.memories.exclude[0]"],
            ["b/two", "recipes.memories.exclude[1]"],
        ]);
    });

    /**
     * No active recipes, no memories.
     *
     * selectMemories({ recipes: [] }) // -> { selected: [], excluded: [] }
     */
    it("should list nothing when no recipe is active", () => {
        expect(select([])).toEqual({ selected: [], excluded: [] });
    });

    /**
     * A memory whose real path is outside its recipe's directory is skipped with one warning naming
     * it; ordinary memories stay.
     *
     * memories/leak links to a folder outside the recipe -> only memories/m.md is listed
     */
    it("should skip a memory that is a link leading out of its recipe, with a warning", () => {
        const one = recipe("c/one", { include: ["memories/**/*.md"] });

        write(tmp.path, "outside/secret.md", "secret");
        // A junction on Windows, where a file symlink needs elevated rights; the type is ignored elsewhere.
        fs.symlinkSync(path.join(tmp.path, "outside"), path.join(one.dir, "memories", "leak"), "junction");

        const warnings: string[] = [];
        const { selected } = select([one], {}, (message) => warnings.push(message));

        expect(selected.map(viewPath)).toEqual(["c/one/m.md"]);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain(path.join("leak", "secret.md"));
    });
});
