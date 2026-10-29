import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandHomePath, localRepoPath, looksLikeLocalPath, resolveRepoArgument } from "./paths.js";

let cwd: string;
const home = "/home/me";

beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "sous-local-paths-"));
});

afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
});

describe("localRepoPath()", () => {
    /**
     * Both the file URL and the bare absolute path name the same directory.
     *
     * localRepoPath("file:///home/me/recipes"); // -> "/home/me/recipes"
     */
    it("should accept both the file URL and the bare absolute path", () => {
        expect(localRepoPath("file:///home/me/recipes")).toBe("/home/me/recipes");
        expect(localRepoPath(" /home/me/recipes ")).toBe("/home/me/recipes");
    });

    /**
     * A hosted URL and a relative path are not local repository paths.
     *
     * localRepoPath("../recipes"); // -> undefined
     */
    it("should reject a hosted URL and a relative path", () => {
        expect(localRepoPath("https://github.com/o/r")).toBeUndefined();
        expect(localRepoPath("../recipes")).toBeUndefined();
        expect(localRepoPath("")).toBeUndefined();
    });
});

describe("expandHomePath()", () => {
    /**
     * expandHomePath("~/recipes", "/home/me"); // -> "/home/me/recipes"
     */
    it("should expand ~ and ~/ only", () => {
        expect(expandHomePath("~", home)).toBe(home);
        expect(expandHomePath("~/recipes", home)).toBe("/home/me/recipes");
        expect(expandHomePath("~other/x", home)).toBe("~other/x");
    });
});

describe("looksLikeLocalPath()", () => {
    /**
     * Relative, home and absolute paths count outright.
     *
     * looksLikeLocalPath("../my-recipes", where); // -> true
     */
    it("should recognize relative, home and absolute paths", () => {
        const where = { cwd, home };

        for (const value of ["../x", "./x", ".", "..", "~/x", "/abs", "file:///abs", "C:\\recipes"]) {
            expect(looksLikeLocalPath(value, where)).toBe(true);
        }
    });

    /**
     * A hosted URL, in any spelling, is not a path.
     *
     * looksLikeLocalPath("git@github.com:o/r.git", where); // -> false
     */
    it("should not claim a hosted URL", () => {
        for (const value of ["https://github.com/o/r", "git@github.com:o/r.git", "ssh://git@github.com/o/r", ""]) {
            expect(looksLikeLocalPath(value, { cwd, home })).toBe(false);
        }
    });

    /**
     * A bare segment is a path only when that directory is there.
     *
     * looksLikeLocalPath("my-recipes", where); // -> true only when <cwd>/my-recipes exists
     */
    it("should claim a bare segment only when the directory exists", async () => {
        expect(looksLikeLocalPath("my-recipes", { cwd, home })).toBe(false);

        await mkdir(path.join(cwd, "my-recipes"));

        expect(looksLikeLocalPath("my-recipes", { cwd, home })).toBe(true);
    });
});

describe("resolveRepoArgument()", () => {
    /**
     * A relative path is resolved against the working directory; a home path expanded; a URL left alone.
     *
     * resolveRepoArgument("../my-recipes", { cwd: "/home/me/work", home }); // -> "/home/me/my-recipes"
     */
    it("should resolve a path and leave a URL alone", () => {
        expect(resolveRepoArgument("../my-recipes", { cwd: "/home/me/work", home })).toBe("/home/me/my-recipes");
        expect(resolveRepoArgument("~/r", { cwd, home })).toBe("/home/me/r");
        expect(resolveRepoArgument("file:///abs/r", { cwd, home })).toBe("/abs/r");
        expect(resolveRepoArgument(" https://github.com/o/r ", { cwd, home })).toBe("https://github.com/o/r");
    });
});
