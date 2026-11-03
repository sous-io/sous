import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { globSync } from "glob";
import { afterEach, describe, expect, it } from "vitest";
import type { ActiveRecipeEntity } from "../types.js";
import { RecipeContents } from "./contents.js";

const dirs: string[] = [];

afterEach(() => {
    while (dirs.length > 0) {
        fs.rmSync(dirs.pop()!, { recursive: true, force: true });
    }
});

const globs = {
    matchSync: (pattern: string, options: { cwd: string; dot?: boolean; ignore?: readonly string[] }) =>
        globSync(pattern, { cwd: options.cwd, dot: options.dot ?? false, nodir: true, ignore: [...(options.ignore ?? [])] }),
    sortBytewise: (items: Iterable<string>) => [...items].sort(),
    toPosix: (file: string) => file.split(path.sep).join("/"),
    hasGlob: (text: string) => /[*?{[]/.test(text),
    staticBase: (pattern: string) => {
        const parts = pattern.split("/");
        const stop = parts.findIndex((part) => /[*?{[]/.test(part));

        return parts.slice(0, stop).join("/") || "/";
    },
};

function recipe(dir: string, kind: "subscribes" | "depends", include: string[], exclude?: string[]): ActiveRecipeEntity {
    return {
        id: "a/b",
        namespace: "a",
        name: "b",
        repo: "r",
        identity: "x/r",
        version: "1.0.0",
        hash: "sha256-aa",
        kind,
        requestedBy: ["project"],
        dir,
        source: "store",
        manifest: { formatVersion: 1, namespace: "a", name: "b", version: "1.0.0", contents: [{ kind: "memories", include, ...(exclude ? { exclude } : {}) }] },
    } as ActiveRecipeEntity;
}

function tree(files: string[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sous-contents-"));

    dirs.push(dir);

    for (const file of files) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), "x");
    }

    return dir;
}

const contents = new RecipeContents({ get: () => globs } as never);

describe("recipes.contents", () => {
    /**
     * Each file carries the base of the include pattern that matched it, and a file two patterns
     * match is listed once, under the first.
     *
     * of([r], "memories") with include ["m/**", "m/x/*.md"]
     * // -> m/x/1.md has base <dir>/m
     */
    it("should give each file the base of its pattern, once", () => {
        const dir = tree(["m/x/1.md", "other/2.md", "lone.md"]);
        const [block] = contents.of([recipe(dir, "subscribes", ["m/**", "m/x/*.md", "other/*.md", "lone.md"])], "memories");

        expect(block?.files.map((file) => [file.path, path.relative(dir, file.base) || "."])).toEqual([
            ["m/x/1.md", "m"],
            ["other/2.md", "other"],
            ["lone.md", "."],
        ]);
    });

    /**
     * Dot files and excludes: dot files are listed, excluded ones are not.
     *
     * include ["m/**"], exclude ["m/skip.md"] -> m/.hidden.md, m/keep.md
     */
    it("should list dot files and leave out excluded ones", () => {
        const dir = tree(["m/.hidden.md", "m/keep.md", "m/skip.md"]);
        const [block] = contents.of([recipe(dir, "subscribes", ["m/**"], ["m/skip.md"])], "memories");

        expect(block?.files.map((file) => file.path)).toEqual(["m/.hidden.md", "m/keep.md"]);
    });

    /** A recipe held only through `depends` publishes nothing. */
    it("should skip recipes that are not subscribed", () => {
        const dir = tree(["m/a.md"]);

        expect(contents.of([recipe(dir, "depends", ["m/**"])], "memories")).toEqual([]);
    });
});
