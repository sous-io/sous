import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitCloneOptions } from "@sous-io/plugin-git/types";
import { copyRecipeTree, fetchRecipeTree } from "./recipe-tree.js";
import { fakeGit, hostContext } from "./testing.js";

let root: string;

beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "sous-recipe-tree-"));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

/** A clone that writes the sparse path, as git would. */
function cloningGit(failFor: string[] = [], withFolder = true) {
    return fakeGit({
        clone: async (url: string, directory: string, options?: GitCloneOptions) => {
            if (failFor.includes(url)) {
                throw new Error(`fatal: could not read from ${url}`);
            }

            const folder = path.join(directory, options?.sparsePaths?.[0] ?? "");

            await mkdir(withFolder ? folder : directory, { recursive: true });

            if (withFolder) {
                await writeFile(path.join(folder, "SKILL.md"), `from ${url} at ${options?.branch}`);
            }
        },
    });
}

describe("fetchRecipeTree()", () => {
    /**
     * Only the recipe folder is fetched: a shallow, sparse clone at the tag, moved into place, the
     * work directory removed.
     *
     * fetchRecipeTree({ urls: [https, ssh], tag: "w/a@1.0.0", recipePath: "recipes/w/a", destination }, ctx);
     * // destination/SKILL.md exists; git.clone got { branch: tag, depth: 1, sparsePaths: ["recipes/w/a"] }
     */
    it("should clone shallow and sparse at the tag and move the folder into place", async () => {
        const git = cloningGit();
        const destination = path.join(root, "store", "alpha");

        await fetchRecipeTree({ urls: ["https://h/o/r.git"], tag: "w/a@1.0.0", recipePath: "recipes/w/a", destination }, hostContext({ services: { "git.runner": git } }));

        expect(await readFile(path.join(destination, "SKILL.md"), "utf8")).toBe("from https://h/o/r.git at w/a@1.0.0");
        expect(git.calls[0]?.args[2]).toEqual({ branch: "w/a@1.0.0", depth: 1, sparsePaths: ["recipes/w/a"] });
        expect(await readdir(path.join(root, "store"))).toEqual(["alpha"]);
    });

    /**
     * When the first URL cannot be cloned, the next is tried.
     *
     * // HTTPS fails, SSH works -> files from the SSH URL
     */
    it("should try the next URL when one fails", async () => {
        const destination = path.join(root, "alpha");

        await fetchRecipeTree(
            { urls: ["https://h/o/r.git", "git@h:o/r.git"], tag: "t", recipePath: "x", destination },
            hostContext({ services: { "git.runner": cloningGit(["https://h/o/r.git"]) } }),
        );

        expect(await readFile(path.join(destination, "SKILL.md"), "utf8")).toBe("from git@h:o/r.git at t");
    });

    /**
     * A tag without the folder, or no URL that clones, is a ConfigError.
     *
     * // -> "The repository https://h/o/r.git has no folder 'x' at the tag 't'."
     */
    it("should explain a missing folder and a failed clone", async () => {
        const destination = path.join(root, "alpha");

        await expect(
            fetchRecipeTree({ urls: ["https://h/o/r.git"], tag: "t", recipePath: "x", destination }, hostContext({ services: { "git.runner": cloningGit([], false) } })),
        ).rejects.toThrow("The repository https://h/o/r.git has no folder 'x' at the tag 't'.");
        await expect(
            fetchRecipeTree({ urls: ["https://h/o/r.git"], tag: "t", recipePath: "x", destination }, hostContext({ services: { "git.runner": cloningGit(["https://h/o/r.git"]) } })),
        ).rejects.toThrow("Could not fetch 'x' at the tag 't'.");
        expect(existsSync(destination)).toBe(false);
    });
});

describe("copyRecipeTree()", () => {
    /**
     * copyRecipeTree replaces the destination with a copy of the source.
     *
     * copyRecipeTree("/repo/recipes/a", "/store/a"); // /store/a/SKILL.md
     */
    it("should replace the destination with a copy", async () => {
        const source = path.join(root, "src");
        const destination = path.join(root, "deep", "dest");

        await mkdir(source);
        await writeFile(path.join(source, "SKILL.md"), "hi");
        await mkdir(destination, { recursive: true });
        await writeFile(path.join(destination, "old.md"), "old");
        await copyRecipeTree(source, destination);

        expect(await readdir(destination)).toEqual(["SKILL.md"]);
    });
});
