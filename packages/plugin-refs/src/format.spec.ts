import { beforeAll, describe, expect, it } from "vitest";
import { buildRefs, nsRef, recipeRef, type Refs } from "../test/fixtures.js";
import { refIdentity } from "./format.js";
import { locationOf, namesOf, namespaceOf, rangeOf, recipeOf, repoOf, shortKey } from "./parts.js";
import type { SousRef, VariableRef } from "./types.js";

let refs: Refs;

beforeAll(async () => {
    refs = await buildRefs();
});

/** The reading of one kind among every reading of a text. */
function reading(text: string, kind: SousRef["kind"]): SousRef {
    return refs.parser.parse(text).readings.find((ref) => ref.kind === kind)!;
}

const variable: VariableRef = { kind: "variable", name: "apiUrl", recipe: recipeRef("w", "a", "r") };

describe("refs.format key()", () => {
    /**
     * Each kind has one canonical key, without range or query values.
     *
     * key(r:workflow/alpha@^1?x=1) // -> "r:workflow/alpha"
     */
    it("should key each kind canonically", () => {
        expect(refs.format.key(reading("workflow", "namespace"))).toBe("workflow");
        expect(refs.format.key(reading("r:workflow/alpha@^1?x=1", "recipe"))).toBe("r:workflow/alpha");
        expect(refs.format.key(reading("workflow/alpha/_p/x.md", "recipeFile"))).toBe("workflow/alpha/_p/x.md");
        expect(refs.format.key(reading("workflow/alpha.apiUrl", "variable"))).toBe("workflow/alpha.apiUrl");
        expect(refs.format.key(reading("SOUS_X", "envVar"))).toBe("SOUS_X");
        expect(refs.format.key(reading("fixtures", "repo"))).toBe("fixtures");
    });

    /**
     * A repository known only by location is keyed by its identity.
     *
     * key(github://o/r/workflow) // -> "github.com/o/r:workflow"
     */
    it("should key a located repository by identity", () => {
        expect(refs.format.key(reading("github://o/r/workflow", "namespace"))).toBe("github.com/o/r:workflow");
        expect(refs.format.key(reading("https://github.com/o/r/tree/main/x", "repo"))).toBe("github.com/o/r:tree/main/x");
        expect(refs.format.key(reading("git@github.com:o/r.git", "repo"))).toBe("github.com/o/r");
    });

    /**
     * The identity of a key carries its kind; the kind has a label.
     *
     * refIdentity(namespace workflow) // -> "namespace workflow"
     */
    it("should prefix the kind in the identity", () => {
        expect(refIdentity(nsRef("workflow"))).toBe("namespace workflow");
        expect(refs.format.kindLabel(nsRef("workflow"))).toBe("namespace");
        expect(refs.format.kindLabel({ kind: "envVar", name: "X" })).toBe("environment variable");
    });

    /**
     * identity() puts the repository identity in front whenever the ref knows where it lives.
     *
     * identity(mine:w/a at github.com/o/r) // -> "github.com/o/r:w/a"
     */
    it("should key a ref by repository identity when it has one", () => {
        const located = reading("github://o/r/w/a", "recipe");
        const known: SousRef = { ...recipeRef("w", "a"), namespace: { ...nsRef("w"), repo: { kind: "repo", name: "mine", location: locationOf(located)! } } };

        expect(refs.format.identity(known)).toBe("github.com/o/r:w/a");
        expect(refs.format.identity(reading("git@github.com:o/r.git", "repo"))).toBe("github.com/o/r");
        expect(refs.format.identity(recipeRef("w", "a", "mine"))).toBe("mine:w/a");
    });
});

describe("refs.format format()", () => {
    /**
     * The canonical form prints the qualifier, the range and the query.
     *
     * format(r:workflow/alpha@^1?x=a%20b) // -> the same text
     */
    it("should print the qualifier, range and query", () => {
        expect(refs.format.format(reading("r:workflow/alpha@^1?x=a%20b", "recipe"))).toBe("r:workflow/alpha@^1?x=a%20b");
        expect(refs.format.format(reading("workflow/alpha.apiUrl", "variable"))).toBe("workflow/alpha.apiUrl");
        expect(refs.format.format(reading("workflow/alpha@^1", "recipe"))).toBe("workflow/alpha@^1");
    });

    /**
     * A location prints as its host's locator; a local one as its URL.
     *
     * format(https://github.com/o/r/w/a@^1) // -> "github://o/r/w/a@^1"
     */
    it("should print a location as its host's locator", () => {
        expect(refs.format.format(reading("https://github.com/o/r/w/a@^1", "recipe"))).toBe("github://o/r/w/a@^1");
        expect(refs.format.format(reading("https://github.com/o/r/tree/main/x@^1", "repo"))).toBe("github://o/r/tree/main/x@^1");
        expect(refs.format.format(reading("file:///x/y", "repo"))).toBe("file:///x/y");
    });

    /**
     * A location whose host is no longer loaded prints as its URL.
     *
     * format(a ref at a host with no entity) // -> "https://github.com/o/r/w"
     */
    it("should fall back to the URL when no host reads the location", async () => {
        const located = reading("github://o/r/w", "namespace");
        const bare = await buildRefs({ hosts: [] });

        expect(bare.format.format(located)).toBe("https://github.com/o/r/w");
    });
});

describe("a known repository with both a short name and a location", () => {
    /**
     * The short name is printed first, and the locator when there is none.
     *
     * spelling(mine:w/a) // -> "mine:w/a";  spelling(github://o/r/w/a) // -> the locator
     */
    it("should print the short name first, and the locator when there is none", () => {
        const located = reading("github://o/r/w/a", "recipe");
        const known: SousRef = { ...recipeRef("w", "a", "mine"), namespace: { ...nsRef("w", "mine"), repo: { kind: "repo", name: "mine", location: locationOf(located)! } } };

        expect(refs.format.format(known)).toBe("mine:w/a");
        expect(refs.format.spelling(known)).toBe("mine:w/a");
        expect(refs.format.spelling(located)).toBe("github://o/r/w/a");
        expect(refs.format.describe(located)).toBe("github://o/r/w/a  (the recipe 'a' in the namespace 'w' of the repository 'https://github.com/o/r')");
        expect(refs.format.describe(reading("github://o/r/w", "namespace"))).toBe("github://o/r/w  (the whole namespace 'w' in the repository 'https://github.com/o/r')");
    });
});

describe("refs.format describe()", () => {
    /**
     * Each kind is described in the words a person choosing between matches needs.
     *
     * describe(r:workflow/alpha with a description) // -> "r:workflow/alpha  (the recipe 'alpha' ... : Alpha)"
     */
    it("should describe each kind", () => {
        expect(refs.format.describe({ ...recipeRef("workflow", "alpha", "r"), description: "Alpha" })).toBe(
            "r:workflow/alpha  (the recipe 'alpha' in the namespace 'workflow' of the repository 'r': Alpha)",
        );
        expect(refs.format.describe(nsRef("workflow", "r"))).toContain("the whole namespace 'workflow'");
        expect(refs.format.describe({ kind: "repo", name: "r" })).toBe("r  (the repository 'r')");
        expect(refs.format.describe(reading("workflow/alpha/x.md", "recipeFile"))).toContain("the file 'x.md'");
        expect(refs.format.describe(variable)).toContain("the variable 'apiUrl' of the recipe 'w/a'");
        expect(refs.format.describe({ kind: "envVar", name: "X", variables: [variable] })).toContain("answering 'apiUrl' of the recipe 'w/a'");
        expect(refs.format.describe({ kind: "envVar", name: "X" })).toBe("X  (the environment variable)");
        expect(refs.format.describe(reading("apiUrl", "variable"))).toContain("of the recipe 'unknown'");
    });
});

describe("parts", () => {
    /**
     * Parents are found at every depth, and partsOf gathers them.
     *
     * namesOf(r:w/a/x.md) // -> ["r", "w", "a", "x.md"]
     */
    it("should find parents at every depth", () => {
        const file = reading("r:w/a/x.md", "recipeFile");

        expect(repoOf(file)?.name).toBe("r");
        expect(namespaceOf(file)?.name).toBe("w");
        expect(recipeOf(file)?.name).toBe("a");
        expect(namesOf(file)).toEqual(["r", "w", "a", "x.md"]);
        expect(namesOf(reading("r:a.v", "variable"))).toEqual(["r", "a", "v"]);
        expect(repoOf(reading("r:a.v", "variable"))?.name).toBe("r");
        expect(repoOf(reading("r:apiUrl", "variable"))?.name).toBe("r");
        expect(repoOf(reading("r:a", "recipe"))?.name).toBe("r");
        expect(repoOf(reading("SOUS_X", "envVar"))).toBeUndefined();
        expect(namespaceOf(reading("SOUS_X", "envVar"))).toBeUndefined();
        expect(recipeOf(reading("w", "namespace"))).toBeUndefined();
        expect(locationOf(reading("github://o/r/w", "namespace"))?.identity).toBe("github.com/o/r");
        expect(namesOf(reading("https://github.com/o/r", "repo"))).toEqual([]);
        expect(refs.format.partsOf(file)).toEqual({ repo: { kind: "repo", name: "r" }, namespace: file.kind === "recipeFile" ? file.recipe.namespace : undefined, recipe: recipeOf(file) });
    });

    /**
     * The range is returned where a kind carries one.
     *
     * rangeOf(w/a@^1) // -> "^1"
     */
    it("should return the range where a kind carries one", () => {
        expect(rangeOf(reading("w/a@^1", "recipe"))).toBe("^1");
        expect(rangeOf(reading("w/a/x.md@^2", "recipeFile"))).toBe("^2");
        expect(rangeOf(reading("w", "namespace"))).toBeUndefined();
        expect(refs.format.partsOf(reading("w/a@^1", "recipe")).range).toBe("^1");
    });
});

describe("refs.format parseNamedRef()", () => {
    /**
     * The one short reading comes back, among the other kinds a word could be; a location is refused.
     *
     * parseNamedRef("workflow/alpha", "config") // -> the recipe
     */
    it("should return the short reading and refuse a location", () => {
        const recipe = refs.format.parseNamedRef("workflow/alpha", "config");

        expect(recipe).toMatchObject({ kind: "recipe", name: "alpha" });
        expect(shortKey(recipe)).toBe("workflow/alpha");
        expect(refs.format.parseNamedRef("workflow")).toMatchObject({ kind: "namespace", name: "workflow" });
        expect(() => refs.format.parseNamedRef("github://o/r/workflow")).toThrow(/names a location/);
    });

    /**
     * The qualifier and the range are kept.
     *
     * parseNamedRef("repo:workflow/alpha@^1") // -> printed back the same
     */
    it("should keep the qualifier and the range", () => {
        const ref = refs.format.parseNamedRef("repo:workflow/alpha@^1");

        expect(repoOf(ref)?.name).toBe("repo");
        expect(refs.format.format(ref)).toBe("repo:workflow/alpha@^1");
    });
});

describe("refs.format splitRecipeKey() and namespaceOfKey()", () => {
    /**
     * A stored key splits into its namespace and name.
     *
     * splitRecipeKey("workflow/alpha") // -> { namespace: "workflow", name: "alpha" }
     */
    it("should split a stored key", () => {
        expect(refs.format.splitRecipeKey("workflow/alpha")).toEqual({ namespace: "workflow", name: "alpha" });
        expect(refs.format.namespaceOfKey("workflow/alpha")).toBe("workflow");
        expect(refs.format.namespaceOfKey("workflow")).toBe("workflow");
    });

    /**
     * A namespace is not a recipe key, and a key not in the stored form is refused.
     *
     * splitRecipeKey("workflow") // throws "names a namespace and a recipe"
     */
    it("should refuse a namespace as a recipe key, and a key not in the stored form", () => {
        expect(() => refs.format.splitRecipeKey("workflow")).toThrow(/names a namespace and a recipe/);
        expect(() => refs.format.namespaceOfKey("Workflow")).toThrow(/lowercase/);
        expect(() => refs.format.splitRecipeKey("github://o/r/workflow/alpha")).toThrow(/stored key/);
    });
});

describe("refs.format builders", () => {
    /**
     * namespaceRef and recipeRef build refs with their parents.
     *
     * recipeRef("workflow", "alpha", { repo: "r", range: "^1" }) // -> "r:workflow/alpha@^1"
     */
    it("should build a namespace and a recipe with their parents", () => {
        expect(refs.format.format(refs.format.namespaceRef("workflow"))).toBe("workflow");
        expect(refs.format.format(refs.format.namespaceRef("workflow", "r"))).toBe("r:workflow");
        expect(refs.format.format(refs.format.recipeRef("workflow", "alpha"))).toBe("workflow/alpha");
        expect(refs.format.format(refs.format.recipeRef("workflow", "alpha", { repo: "r", range: "^1" }))).toBe("r:workflow/alpha@^1");
    });
});
