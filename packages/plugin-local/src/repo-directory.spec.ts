import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createManifests } from "@sous-io/plugin-formats";
import { createLocalHost } from "./host.js";
import { assertLocalRepoDirectory } from "./repo-directory.js";

let dir: string;
let repoDir: string;
const manifests = createManifests();

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-repo-"));
    repoDir = path.join(dir, "recipes");
    fs.mkdirSync(repoDir);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("assertLocalRepoDirectory()", () => {
    /**
     * A path that is not there is reported as a path: what was typed, the absolute path sous tried,
     * and what it expected there. Which host reads it is not the reader's problem.
     *
     * assertLocalRepoDirectory("../nope", "/tmp/nope", manifests); // throws
     */
    it("should name the typed path and the resolved path when nothing is there", () => {
        const resolved = path.join(dir, "nope");
        const run = () => assertLocalRepoDirectory("../nope", resolved, manifests);

        expect(run).toThrow(/There is no directory at '\.\.\/nope'/);
        expect(run).toThrow(expect.objectContaining({ details: expect.arrayContaining([expect.stringContaining(resolved)]) }));
        expect(run).not.toThrow(/--provider/);
    });

    it("should say when the path is a file", () => {
        const file = path.join(dir, "file.txt");

        fs.writeFileSync(file, "x");

        expect(() => assertLocalRepoDirectory("./file.txt", file, manifests)).toThrow(/is a file, not a directory/);
    });

    /** A directory publishing no repo manifest is not a repository, and the message says exactly that. */
    it("should say when a directory holds no repository manifest, naming every spelling", () => {
        const run = () => assertLocalRepoDirectory("./recipes", repoDir, manifests);

        expect(run).toThrow(/is not a sous repository/);
        expect(run).toThrow(expect.objectContaining({ details: expect.arrayContaining([expect.stringContaining("sous.repo.yaml")]) }));
    });

    /** A directory holding a manifest passes: only a real repository gets through. */
    it("should accept a directory holding a repo manifest", () => {
        fs.writeFileSync(path.join(repoDir, "sous.repo.yaml"), "name: recipes\n");

        expect(() => assertLocalRepoDirectory("./recipes", repoDir, manifests)).not.toThrow();
    });
});

describe("the local host's checkTypedPath", () => {
    it("should check the path through formats.manifests", async () => {
        const ctx = { services: { get: () => manifests, has: () => true } } as never;

        await expect(Promise.resolve().then(() => createLocalHost().checkTypedPath?.("./recipes", repoDir, ctx))).rejects.toThrow(/is not a sous repository/);
    });
});
