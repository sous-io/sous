import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitCloneOptions } from "@sous-io/plugin-git/types";
import { fakeGit, hostContext, readWith } from "@sous-io/repository-hosts/testing";
import { createLocalHost } from "./host.js";
import { identityOwnerPath } from "./paths.js";

const host = createLocalHost();
let root: string;

beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "sous-local-host-"));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

/** A git stand-in for a directory that is not a git repository. */
const noGit = () =>
    fakeGit({
        root: async () => undefined,
        revParse: async () => undefined,
        runAnswer: () => ({ exitCode: 128, stderr: "fatal: not a git repository (or any of the parent directories): .git" }),
    });

describe("the local host", () => {
    /**
     * It claims local paths only: a `file://` URL or an absolute path.
     *
     * host.matches("/home/me/recipes"); // -> true; host.matches("https://github.com/o/r"); // -> false
     */
    it("should claim local paths only", () => {
        expect(host.matches("/home/me/recipes")).toBe(true);
        expect(host.matches("file:///home/me/recipes")).toBe(true);
        expect(host.matches("https://github.com/o/r")).toBe(false);
        expect(host.matches("../recipes")).toBe(false);
    });

    /**
     * canonicalize gives the directory (which git is handed) and its file URL.
     *
     * host.canonicalize("file:///home/me/recipes");
     * // -> { host: "localhost", owner: "/home/me", name: "recipes", httpsUrl: "/home/me/recipes", sshUrl: "file:///home/me/recipes" }
     */
    it("should canonicalize a local path into its directory and file URL", () => {
        const directory = path.join(root, "recipes");

        expect(host.canonicalize(pathToFileURL(directory).href)).toEqual({
            host: "localhost",
            // The owner is written with `/` whatever the platform, since it becomes directories.
            owner: identityOwnerPath(root),
            name: "recipes",
            httpsUrl: directory,
            sshUrl: pathToFileURL(directory).href,
        });
        expect(() => host.canonicalize("relative/path")).toThrow("is not a local repository path that sous can read.");
    });

    /**
     * Proposing a change to a directory on disk is just editing it: no submit feature, no CLI.
     *
     * host.features; // -> ["fetch"]
     */
    it("should declare no submit feature and no command line tool", () => {
        expect(host.features).toEqual(["fetch"]);
        expect(host.cli).toBeUndefined();
        expect(host.proposeChange).toBeUndefined();
        expect(host.tokenSources).toBeUndefined();
        expect(host.readLocation({ host: "localhost", segments: ["a", "b"] })).toEqual([]);
    });
});

describe("reading through the local host", () => {
    const request = () => ({ repository: host.canonicalize(root), path: "sous.index.json", ref: "HEAD" });

    /**
     * The working tree's index is read first, so one being written right now is seen.
     *
     * // <repo>/sous.index.json exists -> { ok: true, text, ref: "working tree" }
     */
    it("should read the index from the working tree", async () => {
        await writeFile(path.join(root, "sous.index.json"), "{}");

        expect(host.readStrategies.map((strategy) => strategy.id)).toEqual(["file", "git"]);
        expect(await readWith(host, "file", request(), hostContext())).toEqual({ ok: true, text: "{}", ref: "working tree" });
    });

    /**
     * The committed copy is read with `git show HEAD:sous.index.json`.
     *
     * // git show HEAD:sous.index.json -> "{\"committed\":true}"
     */
    it("should read the committed index through git", async () => {
        const git = fakeGit({ runAnswer: (args) => (args[0] === "show" && args[1] === "HEAD:sous.index.json" ? { stdout: '{"committed":true}' } : { exitCode: 1 }) });

        expect(await readWith(host, "git", request(), hostContext({ services: { "git.runner": git } }))).toEqual({ ok: true, text: '{"committed":true}', ref: "HEAD" });
    });

    /**
     * A directory with no index and no git explains both; a missing directory is named.
     *
     * // file: "the working tree has no sous.index.json"; git: "not a git repository ..."
     */
    it("should explain a directory that publishes no index", async () => {
        const ctx = hostContext({ services: { "git.runner": noGit() } });

        expect(await readWith(host, "file", request(), ctx)).toEqual({ ok: false, reason: "the working tree has no sous.index.json" });
        expect(await readWith(host, "git", request(), ctx)).toEqual({ ok: false, reason: "not a git repository (or any of the parent directories): .git" });
        expect(await readWith(host, "file", { ...request(), ref: "v1" }, ctx)).toEqual({ ok: false, reason: "the working tree is not v1" });

        const gone = { ...request(), repository: host.canonicalize(path.join(root, "gone")) };

        expect(await readWith(host, "file", gone, ctx)).toEqual({ ok: false, reason: `there is no directory at ${path.join(root, "gone")}` });
    });
});

describe("fetchRecipeTree on the local host", () => {
    /**
     * A plain directory has no versions, so its working-tree folder is copied.
     *
     * fetchRecipeTree(repo, "recipes/w/a", "w/a@1.0.0", dest) // dest/SKILL.md copied from the working tree
     */
    it("should copy the recipe folder when there is no git repository", async () => {
        await mkdir(path.join(root, "recipes", "w", "a"), { recursive: true });
        await writeFile(path.join(root, "recipes", "w", "a", "SKILL.md"), "skill");

        const destination = path.join(root, "out", "a");

        await host.fetchRecipeTree(host.canonicalize(root), "recipes/w/a", "w/a@1.0.0", destination, hostContext({ services: { "git.runner": noGit() } }));

        expect(await readFile(path.join(destination, "SKILL.md"), "utf8")).toBe("skill");
    });

    /**
     * A git repository holding the tag is cloned at it, sparse, so the version is the tag's.
     *
     * // git.root and revParse(refs/tags/t) answer -> git.clone(<dir>, ..., { branch: "t", sparsePaths: ["x"] })
     */
    it("should clone a git repository at the tag", async () => {
        const git = fakeGit({
            root: async () => root,
            revParse: async () => "abc123",
            clone: async (_url: string, directory: string, options?: GitCloneOptions) => {
                await mkdir(path.join(directory, "x"), { recursive: true });
                await writeFile(path.join(directory, "x", "f"), String(options?.branch));
            },
        });
        const destination = path.join(root, "out");

        await host.fetchRecipeTree(host.canonicalize(root), "x", "t", destination, hostContext({ services: { "git.runner": git } }));

        expect(await readFile(path.join(destination, "f"), "utf8")).toBe("t");
        expect(git.calls.find((call) => call.method === "clone")?.args[0]).toBe(root);
    });

    /**
     * A recipe folder that is not there is a ConfigError naming it.
     *
     * // -> "The repository at <root> has no folder 'missing'."
     */
    it("should name a recipe folder that is not there", async () => {
        await expect(host.fetchRecipeTree(host.canonicalize(root), "missing", "t", path.join(root, "out"), hostContext({ services: { "git.runner": noGit() } }))).rejects.toThrow(
            `The repository at ${root} has no folder 'missing'.`,
        );
    });
});
