import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activeRecipe, definition, definitionParser, pinnedRecipe, readJson } from "../test/stand-ins.js";
import { definitionsFromRecipes, loadDefinitionsFile, namesVariable, placeIssue, pseudoRecipeName, qualifiedKey, recipeKey } from "./definitions.js";

describe("definitionsFromRecipes()", () => {
    /** It should return no variables when no recipe is active. */
    it("should return nothing for no active recipes", () => {
        expect(definitionsFromRecipes([])).toEqual([]);
    });

    /**
     * It should read every variable of every active recipe, in recipe order, with the recipe that
     * defines it, its ref and its key.
     */
    it("should read the variables of every active recipe", () => {
        const defined = definitionsFromRecipes(
            [
                activeRecipe("misc/stuff", [definition(), definition({ name: "apiToken", secret: true, scope: "local" })]),
                activeRecipe("workflow/task-files", [definition({ name: "taskRoot" })], { requestedBy: ["misc/stuff"], kind: "depends" }),
            ],
            { "sous-recipes": { url: "https://github.com/sous-io/sous-recipes" } },
        );

        expect(defined.map((entry) => entry.key)).toEqual(["misc/stuff.apiUrl", "misc/stuff.apiToken", "workflow/task-files.taskRoot"]);
        expect(defined[0]!.recipe).toMatchObject({ repo: "sous-recipes", url: "https://github.com/sous-io/sous-recipes", direct: true, dir: "/store/misc/stuff" });
        expect(defined[2]!.recipe.direct).toBe(false);
        expect(defined[0]!.ref).toEqual({
            kind: "variable",
            name: "apiUrl",
            description: "Which API?",
            recipe: { kind: "recipe", name: "stuff", namespace: { kind: "namespace", name: "misc", repo: { kind: "repo", name: "sous-recipes" } } },
        });
        expect(qualifiedKey(defined[0]!)).toBe("sous-recipes:misc/stuff.apiUrl");
    });

    /** It should name, for each variable, the other recipes defining the same name. */
    it("should link recipes that share a name", () => {
        const defined = definitionsFromRecipes([activeRecipe("misc/stuff", [definition()]), activeRecipe("misc/other", [definition()])]);

        expect(defined[0]!.requiredBy?.map(recipeKey)).toEqual(["misc/other"]);
        expect(defined[1]!.requiredBy?.map(recipeKey)).toEqual(["misc/stuff"]);
    });

    /**
     * Two recipes defining one name should both carry the strictest combination, each keeping its
     * own definition as `published`.
     *
     * misc/stuff: apiToken (shared), misc/other: apiToken (secret, local)
     * // -> both: { secret: true, scope: "local" }
     */
    it("should give every definition of a shared name the combination", () => {
        const plain = definition({ name: "apiToken" });
        const secret = definition({ name: "apiToken", secret: true, scope: "local" });
        const defined = definitionsFromRecipes([activeRecipe("misc/stuff", [plain]), activeRecipe("misc/other", [secret])]);

        expect(defined.map((entry) => [entry.definition.secret, entry.definition.scope])).toEqual([
            [true, "local"],
            [true, "local"],
        ]);
        expect(defined[0]!.published).toBe(plain);
        expect(defined[0]!.separate).toBeUndefined();
    });

    /**
     * Definitions that cannot be combined should each keep their own, with the reason.
     *
     * misc/stuff: port (number), misc/other: port (string)
     * // -> separate: "misc/stuff defines port as a number, and misc/other defines it as a string, ..."
     */
    it("should mark definitions that cannot be combined as separate", () => {
        const defined = definitionsFromRecipes([
            activeRecipe("misc/stuff", [definition({ name: "port", type: "number" })]),
            activeRecipe("misc/other", [definition({ name: "port", type: "string" })]),
        ]);

        expect(defined.map((entry) => entry.definition.type)).toEqual(["number", "string"]);
        expect(defined[1]!.separate).toBe("misc/stuff defines port as a number, and misc/other defines it as a string, so no answer fits both.");
        expect(defined[1]!.requiredBy?.map(recipeKey)).toEqual(["misc/stuff"]);
    });

    /**
     * Two versions of one recipe whose definitions cannot be combined would store their answers
     * under the same recipe-scoped name, so only the shared version is asked; the pinned one gets
     * a warning naming both versions, their holders and why.
     *
     * support/base 1.0.0 (lib/one): tone (string), support/base 2.0.0 (lib/two): tone (number)
     * // -> 2.0.0: unanswerable "The variable tone of support/base 2.0.0 cannot be answered alongside support/base 1.0.0, ..."
     */
    it("should not ask a version whose definition cannot be combined with the shared version", () => {
        const defined = definitionsFromRecipes([
            pinnedRecipe([definition({ name: "tone" })], [{ holder: "lib/two", version: "2.0.0", variables: [definition({ name: "tone", type: "number" })] }]),
        ]);

        expect(defined.map((entry) => entry.recipe.version)).toEqual(["1.0.0", "2.0.0"]);
        expect(defined[0]!).not.toHaveProperty("unanswerable");
        expect(defined[0]!).not.toHaveProperty("separate");
        expect(defined[0]!).not.toHaveProperty("requiredBy");
        expect(defined[1]!.unanswerable).toBe(
            "The variable tone of support/base 2.0.0 cannot be answered alongside support/base 1.0.0, so it is not asked and gets no answer: " +
                "where support/base 2.0.0 is used, tone renders empty. support/base 2.0.0 is used by lib/two, and support/base 1.0.0 by lib/one. " +
                "support/base 1.0.0 defines tone as a string, and support/base 2.0.0 defines it as a number, so no answer fits both.",
        );
    });

    /**
     * When the shared version does not define the name, the first pinned version (in lockfile
     * order) is the one asked.
     *
     * support/base 1.0.0: nothing, 2.0.0 (lib/two): tone (string), 3.0.0 (lib/three): tone (number)
     * // -> 3.0.0 is not asked
     */
    it("should ask the first pinned version when the shared version does not define the name", () => {
        const defined = definitionsFromRecipes([
            pinnedRecipe(
                [],
                [
                    { holder: "lib/two", version: "2.0.0", variables: [definition({ name: "tone" })] },
                    { holder: "lib/three", version: "3.0.0", variables: [definition({ name: "tone", type: "number" })] },
                ],
            ),
        ]);

        expect(defined.map((entry) => [entry.recipe.version, entry.unanswerable === undefined])).toEqual([
            ["2.0.0", true],
            ["3.0.0", false],
        ]);
        expect(defined[1]!.unanswerable).toContain("support/base 3.0.0 is used by lib/three, and support/base 2.0.0 by lib/two.");
    });

    /**
     * Two versions that combine with each other share one question, even when another recipe's
     * definition of the name keeps them apart from it: each recipe is asked separately, and both
     * versions carry their own combination.
     *
     * misc/other: tone (string); support/base 1.0.0: tone (number, min 1), 2.0.0: tone (number, max 9)
     * // -> misc/other separate; both versions separate with { min: 1, max: 9 }
     */
    it("should combine the versions of one recipe that is asked separately from another", () => {
        const defined = definitionsFromRecipes([
            activeRecipe("misc/other", [definition({ name: "tone" })]),
            pinnedRecipe(
                [definition({ name: "tone", type: "number", validate: { min: 1 } })],
                [{ holder: "lib/two", version: "2.0.0", variables: [definition({ name: "tone", type: "number", validate: { max: 9 } })] }],
            ),
        ]);

        expect(defined.map((entry) => entry.unanswerable)).toEqual([undefined, undefined, undefined]);
        expect(defined.every((entry) => entry.separate !== undefined)).toBe(true);
        expect(defined[0]!.definition.type).toBe("string");
        expect(defined[1]!.definition.validate).toEqual({ min: 1, max: 9 });
        expect(defined[2]!.definition.validate).toEqual({ min: 1, max: 9 });
    });
});

describe("namesVariable()", () => {
    /** A variable is named by its name, its key, or its key with the repository. */
    it("should match the name, the key and the qualified key", () => {
        const [defined] = definitionsFromRecipes([activeRecipe("misc/stuff", [definition()])]);

        expect(["apiUrl", "misc/stuff.apiUrl", "sous-recipes:misc/stuff.apiUrl"].map((name) => namesVariable(defined!, name))).toEqual([true, true, true]);
        expect(namesVariable(defined!, "apiurl")).toBe(false);
    });
});

describe("pseudoRecipeName()", () => {
    /** It should turn a file name into a kebab-case recipe name. */
    it("should turn a file name into a kebab-case recipe name", () => {
        expect(pseudoRecipeName("/somewhere/Team Questions.yaml")).toBe("team-questions");
        expect(pseudoRecipeName("/x/team_vars.json")).toBe("team-vars");
    });

    /** It should prefix a name that does not start with a letter. */
    it("should prefix a name that does not start with a letter", () => {
        expect(pseudoRecipeName("/x/2024.yaml")).toBe("file-2024");
    });
});

describe("loadDefinitionsFile()", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(path.join(tmpdir(), "sous-definitions-"));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    /** It should read a definitions file and give its variables to a recipe named after the file. */
    it("should read a definitions file and attribute it to the file", async () => {
        const file = path.join(dir, "team-vars.json");

        writeFileSync(
            file,
            JSON.stringify({
                variables: [
                    { name: "apiUrl", type: "url", prompt: "Which API?", description: "The service.", example: "https://api.example.com" },
                    { name: "apiToken", type: "string", prompt: "Token?", description: "The token.", example: "tok_0", secret: true, scope: "local" },
                ],
            }),
        );

        const defined = await loadDefinitionsFile(file, { readFile: readJson, definition: definitionParser });

        expect(defined).toHaveLength(2);
        expect(recipeKey(defined[0]!.recipe)).toBe("local/team-vars");
        expect(defined[1]!.key).toBe("local/team-vars.apiToken");
        expect(defined[0]!.definition.required).toBe(true);
    });

    /** It should report a file with no variables, and a definition that does not fit. */
    it("should report an invalid file with the file and the field", async () => {
        const empty = path.join(dir, "empty.json");
        const bad = path.join(dir, "bad.json");

        writeFileSync(empty, JSON.stringify({ variables: [] }));
        writeFileSync(bad, JSON.stringify({ variables: [{ name: "apiUrl" }] }));

        await expect(loadDefinitionsFile(empty, { readFile: readJson, definition: definitionParser })).rejects.toThrow(/empty\.json is not valid/);
        await expect(loadDefinitionsFile(bad, { readFile: readJson, definition: definitionParser })).rejects.toThrow(/Invalid variable definitions file at .*bad\.json/);
        await expect(loadDefinitionsFile(bad, { readFile: readJson, definition: definitionParser })).rejects.toMatchObject({ details: expect.arrayContaining(["- variables[0].type: is required"]) });
    });
});

describe("placeIssue()", () => {
    /** A parser's problem line should be named by the definition's place in the file. */
    it("should name the field under its place in the list", () => {
        expect(placeIssue("  - type: Invalid option", 0)).toBe("- variables[0].type: Invalid option");
        expect(placeIssue("  - unknown key 'x' at the top level.", 2)).toBe("- variables[2]: unknown key 'x' at the top level.");
    });
});
