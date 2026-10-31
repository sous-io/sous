import type { IndexFile, Lockfile } from "@sous-io/plugin-formats/types";
import { describe, expect, it } from "vitest";
import { shortRefs } from "../../test/part-a/helpers.js";
import {
    describedLocation,
    describeNamespace,
    describeRecipe,
    findInCatalog,
    latestVersion,
    listNamespaces,
    listRecipes,
    narrowToInstalled,
    type CatalogInputs,
    type CatalogRepo,
} from "./catalog.js";

const hash = "sha256-aa" as const;

function index(name: string, recipes: Record<string, string[]>, namespaces: Record<string, string | undefined>): IndexFile {
    return {
        formatVersion: 1,
        name,
        generatedAt: "2026-01-01T00:00:00Z",
        generator: "0.2.34",
        namespaces: Object.fromEntries(Object.entries(namespaces).map(([key, description]) => [key, description === undefined ? {} : { description }])),
        recipes: Object.fromEntries(
            Object.entries(recipes).map(([key, versions]) => [
                key,
                {
                    path: `recipes/${key}`,
                    description: `About ${key}`,
                    versions: Object.fromEntries(versions.map((version) => [version, { hash, tag: `${key}@${version}`, prerelease: version.includes("-"), dependencies: {} }])),
                },
            ]),
        ),
    };
}

const official: CatalogRepo = {
    name: "sous-recipes",
    url: "https://github.com/sous-io/sous-recipes",
    identity: "github.com/sous-io/sous-recipes",
    index: index("sous-recipes", { "core/sous-skills": ["0.2.34"], "workflow/task-files": ["1.0.0", "1.2.0", "2.0.0-beta.1"] }, { core: "Sous itself", workflow: "Ways of working" }),
};

const acme: CatalogRepo = {
    name: "acme",
    url: "https://github.com/acme/recipes",
    identity: "github.com/acme/recipes",
    index: index("acme", { "workflow/reviews": ["0.1.0"], "tools/task-files": ["3.0.0"] }, { workflow: "Acme's ways", tools: undefined }),
};

const lock: Lockfile = {
    formatVersion: 1,
    repos: { "sous-recipes": { url: official.url!, identity: official.identity! } },
    recipes: { "workflow/task-files": { repo: "sous-recipes", version: "1.0.0", hash, requestedBy: ["project"], kind: "subscribes" } },
};

const inputs: CatalogInputs = { repos: [official, acme], lock, subscriptions: ["workflow/task-files", "core"], linked: { "sous-recipes": "/work/sous-recipes" } };
const refs = shortRefs();
const read = (text: string) => refs.resolver.parse(text).refs;

describe("listings", () => {
    /** Namespaces sort by name, then repository, with how much of each the project subscribes to. */
    it("should list namespaces with coverage", () => {
        expect(listNamespaces(inputs)).toEqual([
            { repo: "sous-recipes", namespace: "core", description: "Sous itself", recipeCount: 1, subscribed: "whole namespace" },
            { repo: "acme", namespace: "tools", recipeCount: 1, subscribed: "none" },
            { repo: "acme", namespace: "workflow", description: "Acme's ways", recipeCount: 1, subscribed: "none" },
            { repo: "sous-recipes", namespace: "workflow", description: "Ways of working", recipeCount: 1, subscribed: "some recipes" },
        ]);
    });

    /** A recipe claims a pin only for the repository the lockfile says it came from; a pinned linked recipe names the checkout. */
    it("should list recipes with latest, pinned and linked", () => {
        const rows = listRecipes(inputs);
        const pinned = rows.find((row) => row.key === "workflow/task-files")!;

        expect(rows.map((row) => `${row.repo}:${row.key}`)).toEqual(["sous-recipes:core/sous-skills", "acme:tools/task-files", "acme:workflow/reviews", "sous-recipes:workflow/task-files"]);
        expect(pinned).toMatchObject({ latest: "1.2.0", pinned: "1.0.0", linkedPath: "/work/sous-recipes", subscribed: true });
        expect(rows.find((row) => row.key === "tools/task-files")).not.toHaveProperty("pinned");
    });

    /** Prereleases count as latest only when nothing else is published. */
    it("should pick the latest version", () => {
        expect(latestVersion({ "1.0.0": {}, "2.0.0-rc.1": { prerelease: true } })).toBe("1.0.0");
        expect(latestVersion({ "2.0.0-rc.1": { prerelease: true } })).toBe("2.0.0-rc.1");
        expect(latestVersion({})).toBeUndefined();
    });

    /** `--installed` keeps only what the lockfile pins, from its own repository. */
    it("should narrow to what is installed", () => {
        const narrowed = narrowToInstalled(inputs);

        expect(listRecipes(narrowed).map((row) => row.key)).toEqual(["workflow/task-files"]);
        expect(listNamespaces(narrowed).map((row) => `${row.repo}:${row.namespace}`)).toEqual(["sous-recipes:workflow"]);
    });
});

describe("details", () => {
    /** A namespace detail lists every recipe in it. */
    it("should describe a namespace", () => {
        const detail = describeNamespace(inputs, { repo: official, namespace: "workflow" });

        expect(detail).toMatchObject({ repo: "sous-recipes", repoUrl: official.url, namespace: "workflow", subscribed: "some recipes" });
        expect(detail.recipes.map((recipe) => recipe.key)).toEqual(["workflow/task-files"]);
    });

    /** A recipe detail describes the pinned version, lists versions newest first, and reads contents from the manifest. */
    it("should describe a recipe", () => {
        const found = { repo: official, key: "workflow/task-files" };

        expect(describedLocation(inputs, found)).toEqual({ key: "workflow/task-files", namespace: "workflow", name: "task-files", repo: "sous-recipes", version: "1.0.0", path: "recipes/workflow/task-files" });

        const detail = describeRecipe(inputs, found, {
            formatVersion: 1,
            namespace: "workflow",
            name: "task-files",
            version: "1.0.0",
            contents: [{ kind: "skills", include: ["skills/**"] }],
            depends: ["tools/helper@^1"],
        });

        expect(detail.describing).toBe("1.0.0");
        expect(detail.versions.map((version) => `${version.version} ${version.status}`)).toEqual(["2.0.0-beta.1 other", "1.2.0 latest", "1.0.0 pinned"]);
        expect(detail.contents).toEqual([{ kind: "skills", include: ["skills/**"], destinations: [] }]);
        expect(detail.dependencies).toEqual([{ key: "tools/helper", declared: "tools/helper@^1", kind: "depends" }]);
        expect(detail.dependenciesRecorded).toBe(true);
        expect(detail.manifestRead).toBe(true);
    });

    /** Without the recipe's files, the detail says the manifest was not read. */
    it("should describe a recipe from its index alone", () => {
        const detail = describeRecipe(inputs, { repo: acme, key: "workflow/reviews" });

        expect(detail).toMatchObject({ describing: "0.1.0", manifestRead: false, contents: [], variables: [] });
    });
});

describe("findInCatalog", () => {
    /** A one-word name finds namespaces in every repository, in search order. */
    it("should find a namespace in every repository", () => {
        const matches = findInCatalog(inputs, read("workflow"), ["namespace"]);

        expect(matches.map((match) => `${match.repo.name}:${match.key}`)).toEqual(["sous-recipes:workflow", "acme:workflow"]);
    });

    /** A bare recipe name finds the recipe under any namespace. */
    it("should find a recipe by its bare name", () => {
        const matches = findInCatalog(inputs, read("task-files"), ["recipe"]);

        expect(matches.map((match) => `${match.repo.name}:${match.key}`)).toEqual(["sous-recipes:workflow/task-files", "acme:tools/task-files"]);
    });

    /** A repository qualifier narrows, a range is kept, and an exact spelling sorts before a folded one. */
    it("should honor qualifiers, ranges and case", () => {
        const [match] = findInCatalog(inputs, read("acme:workflow/reviews@^0.1"), ["recipe"]);

        expect(match?.repo.name).toBe("acme");
        expect(match?.ref).toMatchObject({ kind: "recipe", name: "reviews", range: "^0.1" });
        expect(findInCatalog(inputs, read("Workflow/Task-Files"), ["recipe"])[0]).toMatchObject({ key: "workflow/task-files", exact: false });
    });

    /** A location finds the repository at it, whatever this project calls it. */
    it("should find by repository identity", () => {
        const located = [{ kind: "namespace" as const, name: "tools", repo: { kind: "repo" as const, location: { provider: "github", host: "github.com", repoPath: "acme/recipes", identity: "github.com/acme/recipes", url: acme.url! } } }];

        expect(findInCatalog(inputs, located, ["namespace"]).map((match) => match.repo.name)).toEqual(["acme"]);
    });
});
