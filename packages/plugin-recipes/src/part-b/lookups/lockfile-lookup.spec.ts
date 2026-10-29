import { hostGlobs } from "@sous-io/plugin-host";
import type { Lockfile } from "@sous-io/plugin-formats/types";
import type { ServiceContext } from "@sous-io/plugin-api";
import type { SousRef } from "@sous-io/plugin-refs/types";
import { describe, expect, it } from "vitest";
import { LOCKFILE_LOOKUP_ID, lockfileLookup, matchPinned } from "./lockfile-lookup.js";

const HASH = "sha256-0" as const;
const LOCK: Lockfile = {
    formatVersion: 1,
    repos: { acme: { url: "https://fake.test/acme/recipes" }, other: { url: "https://fake.test/other/recipes" } },
    recipes: {
        "workflow/task-files": { repo: "acme", version: "1.0.0", hash: HASH, requestedBy: ["project"], kind: "subscribes" },
        "workflow/github-projects": { repo: "acme", version: "1.0.0", hash: HASH, requestedBy: ["project"], kind: "subscribes" },
        "tools/linting": { repo: "other", version: "2.0.0", hash: HASH, requestedBy: ["project"], kind: "subscribes" },
    },
};
const isMatch = (known: string, written: string, nocase: boolean): boolean => hostGlobs.isMatch(known, written, { nocase });
const recipeRef = (namespace: string, name: string, repo?: string): Extract<SousRef, { kind: "recipe" }> => ({
    kind: "recipe",
    name,
    namespace: { kind: "namespace", name: namespace, ...(repo === undefined ? {} : { repo: { kind: "repo", name: repo } }) },
});

describe("matchPinned()", () => {
    it("should find a pinned recipe file, with its repository and the written path", () => {
        const matches = matchPinned({ kind: "recipeFile", path: "a.md", recipe: recipeRef("workflow", "task-files") }, LOCK, isMatch);

        expect(matches).toEqual([
            {
                ref: { kind: "recipeFile", path: "a.md", recipe: { kind: "recipe", name: "task-files", namespace: { kind: "namespace", name: "workflow", repo: { kind: "repo", name: "acme" } } } },
                exactSpelling: true,
            },
        ]);
    });

    it("should match a glob across recipes, in key order", () => {
        const matches = matchPinned({ kind: "recipeFile", path: "*.md", glob: true, recipe: recipeRef("workflow", "*") }, LOCK, isMatch);

        expect(matches.map((match) => (match.ref.kind === "recipeFile" ? match.ref.recipe.name : ""))).toEqual(["github-projects", "task-files"]);
        expect(matches[0].ref).toHaveProperty("glob", true);
    });

    it("should answer a recipe ref keeping its range, and a namespace ref once per namespace", () => {
        expect(matchPinned({ ...recipeRef("tools", "linting"), range: "^2" }, LOCK, isMatch)[0].ref).toMatchObject({ kind: "recipe", name: "linting", range: "^2" });
        expect(matchPinned({ kind: "namespace", name: "workflow" }, LOCK, isMatch)).toEqual([
            { ref: { kind: "namespace", name: "workflow", repo: { kind: "repo", name: "acme" } }, exactSpelling: true },
        ]);
    });

    it("should honour a repository qualifier", () => {
        expect(matchPinned(recipeRef("tools", "linting", "acme"), LOCK, isMatch)).toEqual([]);
        expect(matchPinned(recipeRef("tools", "linting", "other"), LOCK, isMatch)).toHaveLength(1);
    });

    it("should mark a match found only ignoring case as not exactly spelled", () => {
        expect(matchPinned(recipeRef("Tools", "Linting"), LOCK, isMatch)[0].exactSpelling).toBe(false);
    });

    it("should answer nothing for other kinds, and for a recipe ref with no namespace", () => {
        expect(matchPinned({ kind: "envVar", name: "X" }, LOCK, isMatch)).toEqual([]);
        expect(matchPinned({ kind: "recipe", name: "linting" }, LOCK, isMatch)).toEqual([]);
    });
});

describe("lockfileLookup()", () => {
    const ctx = (services: Record<string, unknown>, project = true): ServiceContext =>
        ({
            project: project ? { root: "/p", sousDir: "/p/.sous", configPath: undefined, confDir: "/p/.sous/conf.d" } : undefined,
            services: { get: (name: string) => services[name], has: (name: string) => name in services },
        }) as unknown as ServiceContext;

    it("should be opt-in, tagged lockfile and installed", () => {
        expect(lockfileLookup()).toMatchObject({ id: LOCKFILE_LOOKUP_ID, optIn: true, tags: ["lockfile", "installed"], kinds: ["namespace", "recipe", "recipeFile"] });
    });

    it("should read the lockfile through recipes.lock", async () => {
        const services = { "recipes.lock": { read: () => LOCK }, "host.globs": hostGlobs };

        expect(await lockfileLookup().find(recipeRef("tools", "linting"), ctx(services))).toHaveLength(1);
    });

    it("should answer nothing outside a project or without recipes.lock", () => {
        expect(lockfileLookup().findSync?.(recipeRef("tools", "linting"), ctx({}, true))).toEqual([]);
        expect(lockfileLookup().findSync?.(recipeRef("tools", "linting"), ctx({ "recipes.lock": { read: () => LOCK } }, false))).toEqual([]);
    });
});
