import path from "node:path";
import { hostGlobs } from "@sous-io/plugin-host";
import type { RefsResolver } from "@sous-io/plugin-refs/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanTemp, startEngine, tempDir } from "../../../test/part-b/helpers.js";
import type { ActiveRecipeEntity } from "../../types.js";
import { ActiveNamespaceResolver } from "./namespace-resolver.js";

// Absolute on every platform (`D:\store` on Windows), as a real store root is.
const STORE = path.resolve("/store");
const PROJECT_FILE = path.resolve("/project/prompts/AGENTS.md");

let refs: RefsResolver;

beforeAll(async () => {
    const { engine } = await startEngine({ root: tempDir(), home: tempDir(), data: () => ({ repos: { "sous-recipes": { enabled: false } } }) });

    refs = engine.config.services.get("refs.resolver");
});

afterAll(() => cleanTemp());

/** An active recipe in the fake store. */
function recipe(id: string, requestedBy: string[] = ["project"], repo = "acme", dir = path.join(STORE, id)): ActiveRecipeEntity {
    const [namespace, name] = id.split("/");

    return { id, namespace, name, repo, identity: `fake.test/${repo}`, version: "1.0.0", hash: "sha256-0", kind: "subscribes", requestedBy, dir, source: "store", manifest: { formatVersion: 1, namespace, name, version: "1.0.0", contents: [] } };
}

/** The default set: two workflow recipes, one held by the other, and a tools recipe. */
function makeResolver(recipes: ActiveRecipeEntity[] = defaults(), explain?: ConstructorParameters<typeof ActiveNamespaceResolver>[0]["explainMissing"]): ActiveNamespaceResolver {
    return new ActiveNamespaceResolver({
        recipes,
        parse: (reference) => refs.resolveSync({ input: reference, from: "include", kinds: ["recipeFile"], lookups: false, refusedIsEmpty: true }),
        isMatch: (name, pattern, options) => hostGlobs.isMatch(name, pattern, { nocase: options.nocase, dot: true }),
        ...(explain === undefined ? {} : { explainMissing: explain }),
    });
}

function defaults(): ActiveRecipeEntity[] {
    return [recipe("workflow/task-files"), recipe("workflow/github-projects", ["project", "workflow/task-files"]), recipe("tools/linting")];
}

describe("ActiveNamespaceResolver", () => {
    it("should map a namespace reference to a path inside the recipe directory", () => {
        expect(makeResolver().resolve({ reference: "workflow/task-files/_partials/resume.md", fromFile: PROJECT_FILE })).toEqual({
            kind: "candidates",
            candidates: [path.join(STORE, "workflow/task-files/_partials/resume.md")],
            roots: [{ recipe: "workflow/task-files", dir: path.join(STORE, "workflow/task-files") }],
        });
    });

    it("should report an unknown namespace and list the known ones", () => {
        expect(makeResolver().resolve({ reference: "nope/x/a.md", fromFile: PROJECT_FILE })).toEqual({ kind: "unknown-namespace", namespace: "nope", recipe: "nope/x", known: ["tools", "workflow"] });
    });

    it("should report an unknown recipe inside a known namespace, listing what it holds", () => {
        expect(makeResolver().resolve({ reference: "workflow/nope/a.md", fromFile: PROJECT_FILE })).toEqual({
            kind: "unknown-recipe",
            recipe: "workflow/nope",
            known: ["workflow/github-projects", "workflow/task-files"],
        });
    });

    it("should let a project template address every active recipe", () => {
        expect(makeResolver().resolve({ reference: "tools/linting/a.md", fromFile: PROJECT_FILE }).kind).toBe("candidates");
    });

    it("should let a recipe address a recipe it holds", () => {
        const fromFile = path.join(STORE, "workflow/task-files/skills/SKILL.md");

        expect(makeResolver().resolve({ reference: "workflow/github-projects/board.md", fromFile }).kind).toBe("candidates");
    });

    it("should refuse a recipe the including recipe does not declare", () => {
        const fromFile = path.join(STORE, "workflow/task-files/skills/SKILL.md");

        expect(makeResolver().resolve({ reference: "tools/linting/a.md", fromFile })).toEqual({ kind: "not-a-dependency", recipe: "tools/linting", includingRecipe: "workflow/task-files" });
    });

    it("should let a recipe address itself without declaring a dependency", () => {
        const fromFile = path.join(STORE, "tools/linting/a.md");

        expect(makeResolver().resolve({ reference: "tools/linting/b.md", fromFile }).kind).toBe("candidates");
    });

    it("should give the deepest recipe holding a file as the including recipe", () => {
        const outer = recipe("outer/one", ["project"], "acme", path.join(STORE, "outer"));
        const inner = recipe("inner/two", ["project"], "acme", path.join(STORE, "outer", "nested"));
        const resolver = makeResolver([outer, inner]);

        expect(resolver.includingRecipe(path.join(STORE, "outer", "nested", "x.md"))).toBe("inner/two");
        expect(resolver.includingRecipe(path.join(STORE, "outer", "x.md"))).toBe("outer/one");
        expect(resolver.includingRecipe(path.resolve("/project/x.md"))).toBeNull();
    });

    it("should refuse references containing '.' or '..' segments", () => {
        for (const reference of ["workflow/task-files/../x.md", "workflow/task-files/./partial.md", "workflow/task-files/sub/../../github-projects/partial.md"]) {
            expect(makeResolver().resolve({ reference, fromFile: PROJECT_FILE }).kind).toBe("escapes-recipe");
        }
    });

    it("should refuse a glob whose brace alternative climbs out of the recipe", () => {
        expect(makeResolver().resolve({ reference: "workflow/task-files/{a,..}/x.md", fromFile: PROJECT_FILE }).kind).toBe("escapes-recipe");
    });

    it("should refuse the recipe root with the ref service's sentence, and still resolve nested paths", () => {
        const root = makeResolver().resolve({ reference: "workflow/task-files", fromFile: PROJECT_FILE });

        expect(root.kind).toBe("invalid");
        expect(root.kind === "invalid" && root.message).toContain("names a file inside a recipe");
        expect(makeResolver().resolve({ reference: "workflow/task-files/a/b/c.md", fromFile: PROJECT_FILE })).toMatchObject({
            candidates: [path.join(STORE, "workflow/task-files/a/b/c.md")],
        });
    });

    it("should call a reference that is no ref at all invalid", () => {
        expect(makeResolver().resolve({ reference: "/abs/x.md", fromFile: PROJECT_FILE }).kind).toBe("invalid");
    });

    it("should give every matching recipe of a glob, its directory escaped, with roots", () => {
        const odd = recipe("workflow/odd", ["project"], "acme", "/store/[odd]");
        const result = makeResolver([...defaults(), odd]).resolve({ reference: "workflow/*/memories/*.md", fromFile: PROJECT_FILE });

        expect(result).toEqual({
            kind: "candidates",
            glob: true,
            candidates: [`${path.join(STORE, "workflow/github-projects")}/memories/*.md`, "/store/\\[odd\\]/memories/*.md", `${path.join(STORE, "workflow/task-files")}/memories/*.md`],
            roots: [
                { recipe: "workflow/github-projects", dir: path.join(STORE, "workflow/github-projects") },
                { recipe: "workflow/odd", dir: "/store/[odd]" },
                { recipe: "workflow/task-files", dir: path.join(STORE, "workflow/task-files") },
            ],
        });
    });

    it("should give an empty glob nothing, and leave out recipes a recipe may not address", () => {
        expect(makeResolver().resolve({ reference: "nope/*/a.md", fromFile: PROJECT_FILE })).toEqual({ kind: "candidates", candidates: [], glob: true });

        const fromFile = path.join(STORE, "tools/linting/a.md");
        const result = makeResolver().resolve({ reference: "*/*/a.md", fromFile });

        expect(result.kind === "candidates" && result.roots?.map((root) => root.recipe)).toEqual(["tools/linting"]);
    });

    it("should match a repository qualifier against the recipe's repository", () => {
        const resolver = makeResolver([recipe("workflow/task-files", ["project"], "acme"), recipe("tools/linting", ["project"], "other")]);

        expect(resolver.resolve({ reference: "acme:workflow/task-files/a.md", fromFile: PROJECT_FILE }).kind).toBe("candidates");
        expect(resolver.resolve({ reference: "other:workflow/task-files/a.md", fromFile: PROJECT_FILE }).kind).toBe("unknown-recipe");
    });

    it("should take a name written in another case when no exact spelling matches", () => {
        expect(makeResolver().resolve({ reference: "Workflow/Task-Files/a.md", fromFile: PROJECT_FILE })).toMatchObject({
            kind: "candidates",
            candidates: [path.join(STORE, "workflow/task-files/a.md")],
        });
    });

    it("should read a '?name=value' as values, keeping the path without it", () => {
        expect(makeResolver().resolve({ reference: "workflow/task-files/a.md?x=1", fromFile: PROJECT_FILE })).toMatchObject({
            candidates: [path.join(STORE, "workflow/task-files/a.md")],
        });
    });

    it("should hold no recipes with no active recipes", () => {
        expect(makeResolver([]).resolve({ reference: "workflow/x/a.md", fromFile: PROJECT_FILE })).toEqual({ kind: "unknown-namespace", namespace: "workflow", recipe: "workflow/x", known: [] });
    });
});

describe("ActiveNamespaceResolver explainMissing", () => {
    it("should attach the explanation for a project template", () => {
        const resolver = makeResolver(defaults(), (key) => (key === "tools/gone" ? { by: "disabled-subscription", subscription: "tools/gone" } : undefined));

        expect(resolver.resolve({ reference: "tools/gone/a.md", fromFile: PROJECT_FILE })).toEqual({
            kind: "unknown-recipe",
            recipe: "tools/gone",
            known: ["tools/linting"],
            dropped: { by: "disabled-subscription", subscription: "tools/gone" },
        });
    });

    it("should not consult the explanation for a file inside a recipe", () => {
        let asked = false;
        const resolver = makeResolver(defaults(), () => {
            asked = true;

            return { by: "disabled-subscription", subscription: "x" };
        });

        const result = resolver.resolve({ reference: "tools/gone/a.md", fromFile: path.join(STORE, "tools/linting/a.md") });

        expect(result).not.toHaveProperty("dropped");
        expect(asked).toBe(false);
    });
});
