import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activeRecipe, definition, definitionParser, readJson } from "../test/stand-ins.js";
import { definitionsFromRecipes, loadDefinitionsFile, namesVariable, pseudoRecipeName, qualifiedKey, recipeKey } from "./definitions.js";

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
        await expect(loadDefinitionsFile(bad, { readFile: readJson, definition: definitionParser })).rejects.toMatchObject({ details: expect.arrayContaining(["type: is required"]) });
    });
});
