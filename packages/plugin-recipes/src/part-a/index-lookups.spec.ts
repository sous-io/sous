import { describe, expect, it } from "vitest";
import { hostGlobs } from "@sous-io/plugin-host";
import type { IndexFile } from "@sous-io/plugin-formats/types";
import type { RefLocation, SousRef } from "@sous-io/plugin-refs/types";
import { catalogRepoOfIndex, globNameMatcher, matchIndexes, type IndexCatalogRepo } from "./index-lookups.js";

/** An index publishing `namespace/name` keys, each at `recipes/<key>` unless a path is given. */
function indexOf(keys: string[], paths: Record<string, string> = {}): IndexFile {
    return {
        formatVersion: 1,
        name: "test",
        generatedAt: "2026-10-01T00:00:00.000Z",
        generator: "0.2.34",
        namespaces: Object.fromEntries([...new Set(keys.map((key) => key.split("/")[0]!))].map((namespace) => [namespace, {}])),
        recipes: Object.fromEntries(keys.map((key) => [key, { path: paths[key] ?? `recipes/${key}`, versions: {} }])),
    } as IndexFile;
}

const location = (repoPath: string): RefLocation => ({ provider: "github", host: "github.com", repoPath, identity: `github.com/${repoPath}`, url: `https://github.com/${repoPath}` });

const REPOS: IndexCatalogRepo[] = [
    catalogRepoOfIndex(indexOf(["workflow/task-files", "workflow/alpha", "tooling/lint"]), { name: "fixtures", location: location("o/fixtures") }),
    catalogRepoOfIndex(indexOf(["workflow/task-files"]), { name: "other", location: location("o/other") }),
];

const tools = { matchName: globNameMatcher(hostGlobs), key: (ref: SousRef) => JSON.stringify(ref) };

const recipe = (name: string, namespace?: string, repo?: string): SousRef =>
    ({ kind: "recipe", name, ...(namespace === undefined ? {} : { namespace: { kind: "namespace", name: namespace, ...(repo === undefined ? {} : { repo: { kind: "repo", name: repo } }) } }) }) as SousRef;

const names = (matches: ReturnType<typeof matchIndexes>): string[] =>
    matches.map(({ ref }) => (ref.kind === "recipe" ? `${ref.namespace?.repo?.name}:${ref.namespace?.name}/${ref.name}` : ref.kind === "namespace" ? `${ref.repo?.name}:${ref.name}` : ref.kind));

describe("matchIndexes()", () => {
    it("should list matches in repository order", () => {
        expect(names(matchIndexes(REPOS, recipe("task-files", "workflow"), tools))).toEqual(["fixtures:workflow/task-files", "other:workflow/task-files"]);
    });

    it("should flag whether the spelling matched exactly", () => {
        const [match] = matchIndexes(REPOS, recipe("Alpha", "workflow"), tools);

        expect(match).toMatchObject({ exactSpelling: false, ref: { name: "alpha" } });
    });

    it("should match glob patterns", () => {
        expect(names(matchIndexes(REPOS, recipe("*", "workflow", "fixtures"), tools)).sort()).toEqual(["fixtures:workflow/alpha", "fixtures:workflow/task-files"]);
    });

    it("should return nothing for what is not published", () => {
        expect(matchIndexes(REPOS, recipe("nope", "workflow"), tools)).toEqual([]);
    });

    it("should find a repository by its name and by its location", () => {
        expect(names(matchIndexes(REPOS, { kind: "repo", name: "other" } as SousRef, tools))).toEqual(["repo"]);
        expect(matchIndexes(REPOS, { kind: "repo", location: location("o/fixtures") } as SousRef, tools)[0]?.ref).toMatchObject({ kind: "repo", name: "fixtures" });
    });

    it("should settle a browser path behind any branch through the recipe folders", () => {
        const browsed = { kind: "repo", location: location("o/fixtures"), browsed: "feature/x/recipes/workflow/alpha/SKILL.md" } as SousRef;
        const [match] = matchIndexes(REPOS, browsed, tools);

        expect(match?.ref).toMatchObject({ kind: "recipe", name: "alpha", namespace: { name: "workflow", repo: { revision: "feature/x" } } });
    });

    it("should settle a folder holding one namespace's recipes as that namespace", () => {
        const browsed = { kind: "repo", location: location("o/fixtures"), browsed: "main/recipes/tooling" } as SousRef;

        expect(matchIndexes(REPOS, browsed, tools)[0]?.ref).toMatchObject({ kind: "namespace", name: "tooling" });
    });

    it("should match a recipe file through its recipe, keeping its path", () => {
        const file = { kind: "recipeFile", path: "skills/a.md", recipe: recipe("lint", "tooling") } as SousRef;

        expect(matchIndexes(REPOS, file, tools)[0]?.ref).toMatchObject({ kind: "recipeFile", path: "skills/a.md", recipe: { name: "lint", namespace: { repo: { name: "fixtures" } } } });
    });
});
