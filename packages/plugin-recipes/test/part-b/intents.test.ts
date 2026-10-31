/**
 * Part B's intents on a real engine: `lock.rebuild`, `lock.show`, `repo.gc`, `repo.link` and
 * `repo.unlink`, ported from the old `sous lock` and `sous repo link/unlink/gc` commands.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonObject } from "@sous-io/plugin-api";
import { cleanTemp, fakeHost, fakeUrl, hashOf, indexFile, startEngine, tempDir, writeLockfile, writeRecipe, type FakeHostCalls, type FakeRepo } from "./helpers.js";

const URL = fakeUrl("acme", "recipes");
const IDENTITY = "fake.test/acme/recipes";

let home: string;
let root: string;
let repo: FakeRepo;
let calls: FakeHostCalls;
let hashes: Record<string, string>;

/** Publishes a recipe version in the fake repository. */
function publish(key: string, version: string): void {
    const [namespace, name] = key.split("/");
    const dir = writeRecipe(path.join(tempDir(), name), { namespace, name, version }, { [`skills/${name}.md`]: `# ${name} ${version}\n` });
    const recipes = repo.index?.recipes ?? {};
    const hash = hashOf(dir);

    hashes[`${key}@${version}`] = hash;
    recipes[key] ??= { path: `recipes/${key}`, versions: {} };
    recipes[key].versions[version] = { hash, tag: `${key}@${version}`, prerelease: false };
    repo.index = { ...indexFile("acme", {}, [...new Set([...Object.keys(recipes).map((entry) => entry.split("/")[0])])]), recipes };
    repo.trees[`recipes/${key}@${key}@${version}`] = dir;
}

/** The user's config. */
function config(subscriptions: JsonObject): () => JsonObject {
    return () => ({ repos: { acme: { url: URL }, "sous-recipes": { enabled: false } }, subscriptions });
}

/** The lockfile on disk. */
function lockfile(): { recipes: Record<string, { version: string; requestedBy: string[] }>; repos: Record<string, { identity?: string }> } {
    return JSON.parse(fs.readFileSync(path.join(root, ".sous", "sous.lock.json"), "utf8"));
}

beforeEach(() => {
    home = tempDir();
    root = tempDir();
    repo = { url: URL, index: indexFile("acme", {}), trees: {} };
    calls = { reads: [], fetches: [] };
    hashes = {};
    publish("workflow/alpha", "1.0.0");
    publish("workflow/alpha", "1.2.0");
    publish("workflow/beta", "2.0.0");
});

afterEach(() => cleanTemp());

describe("lock.rebuild", () => {
    it("should resolve every subscription to the newest version in range, write the lockfile and download what is missing", async () => {
        const { engine } = await startEngine({ root, home, data: config({ "workflow/alpha": { range: "^1" } }), hosts: [fakeHost([repo], calls)] });
        const result = (await engine.handle.submit({ intent: "lock.rebuild", input: {} })).toPlain();

        expect(result.diff.added).toEqual([{ key: "workflow/alpha", to: "1.2.0" }]);
        expect(result.restored.restored).toEqual(["workflow/alpha"]);
        expect(lockfile().recipes["workflow/alpha"]).toMatchObject({ version: "1.2.0", requestedBy: ["project"] });
        expect(lockfile().repos.acme.identity).toBe(IDENTITY);
    });

    it("should write nothing on a dry run", async () => {
        const { engine } = await startEngine({ root, home, data: config({ "workflow/alpha": {} }), hosts: [fakeHost([repo], calls)] });
        const result = (await engine.handle.submit({ intent: "lock.rebuild", input: { dryRun: true } })).toPlain();

        expect(result.dryRun).toBe(true);
        expect(result.lockfile.recipes["workflow/alpha"].version).toBe("1.2.0");
        expect(fs.existsSync(path.join(root, ".sous", "sous.lock.json"))).toBe(false);
    });

    it("should keep the pin of a subscription switched off on this machine", async () => {
        writeLockfile(
            { root, sousDir: path.join(root, ".sous"), configPath: undefined, confDir: "" },
            {
                formatVersion: 1,
                repos: { acme: { url: URL, identity: IDENTITY } },
                recipes: { "workflow/beta": { repo: "acme", version: "2.0.0", hash: hashes["workflow/beta@2.0.0"], requestedBy: ["project"], kind: "subscribes" } },
            },
        );

        const { engine } = await startEngine({ root, home, data: config({ "workflow/alpha": {}, "workflow/beta": { enabled: false } }), hosts: [fakeHost([repo], calls)] });

        await engine.handle.submit({ intent: "lock.rebuild", input: {} });

        expect(Object.keys(lockfile().recipes).sort()).toEqual(["workflow/alpha", "workflow/beta"]);
        expect(calls.fetches.map((fetch) => fetch.tag)).toEqual(["workflow/alpha@1.2.0"]);
    });

    it("should refuse when a subscription needs a repository the project does not trust", async () => {
        publish("workflow/gamma", "1.0.0");
        repo.index!.recipes["workflow/gamma"].versions["1.0.0"].depends = ["https://fake.test/other/lib/tools/helper"];

        const { engine } = await startEngine({ root, home, data: config({ "workflow/gamma": {} }), hosts: [fakeHost([repo], calls)] });

        await expect(engine.handle.submit({ intent: "lock.rebuild", input: {} })).rejects.toThrow(/does not trust/);
    });
});

describe("lock.show", () => {
    it("should list every pin, saying which are active here and why the others are skipped", async () => {
        writeLockfile(
            { root, sousDir: path.join(root, ".sous"), configPath: undefined, confDir: "" },
            {
                formatVersion: 1,
                repos: { acme: { url: URL, identity: IDENTITY } },
                recipes: {
                    "workflow/alpha": { repo: "acme", version: "1.0.0", hash: hashes["workflow/alpha@1.0.0"], requestedBy: ["project"], kind: "subscribes" },
                    "workflow/beta": { repo: "acme", version: "2.0.0", hash: hashes["workflow/beta@2.0.0"], requestedBy: ["project"], kind: "subscribes" },
                },
            },
        );

        const { engine } = await startEngine({ root, home, data: config({ "workflow/alpha": {}, "workflow/beta": { enabled: false } }), hosts: [fakeHost([repo], calls)] });
        const result = (await engine.handle.submit({ intent: "lock.show", input: {} })).toPlain();

        expect(result.path).toBe(path.join(root, ".sous", "sous.lock.json"));
        expect(result.recipes.map((recipe) => [recipe.key, recipe.active, recipe.skipped?.reason])).toEqual([
            ["workflow/alpha", true, undefined],
            ["workflow/beta", false, "subscription-disabled"],
        ]);
    });
});

describe("repo.gc", () => {
    it("should keep what this project pins and report what it would evict", async () => {
        const { engine } = await startEngine({ root, home, data: config({ "workflow/alpha": {} }), hosts: [fakeHost([repo], calls)] });

        await engine.handle.submit({ intent: "lock.rebuild", input: {} });

        const report = (await engine.handle.submit({ intent: "repo.gc", input: { maxBytes: 0, dryRun: true } })).toPlain();

        expect(report.dryRun).toBe(true);
        expect(report.kept.map((entry) => `${entry.namespace}/${entry.name}`)).toContain("workflow/alpha");
        expect(report.evicted.map((entry) => `${entry.namespace}/${entry.name}`)).not.toContain("workflow/alpha");
    });
});

describe("repo.link and repo.unlink", () => {
    /** A checkout of the acme repository on disk. */
    function checkout(): string {
        const dir = tempDir();

        fs.writeFileSync(path.join(dir, "sous.repo.yaml"), "formatVersion: 1\nname: acme\nnamespaces:\n  workflow: {}\nrecipes:\n  - recipes/workflow/alpha\n", "utf8");
        writeRecipe(path.join(dir, "recipes/workflow/alpha"), { namespace: "workflow", name: "alpha", version: "9.9.9" }, { "skills/local.md": "# local\n" });

        return dir;
    }

    it("should link a trusted repository to an existing checkout, record it in the project's links map and keep it out of git", async () => {
        const dir = checkout();
        const { engine } = await startEngine({ root, home, data: config({ "workflow/alpha": {} }), hosts: [fakeHost([repo], calls)] });
        const result = (await engine.handle.submit({ intent: "repo.link", input: { repo: "acme", path: dir } })).toPlain();

        expect(result).toMatchObject({ repo: "acme", path: dir, origin: "path", scope: "project", cloned: false, trusted: [], dryRun: false });
        expect(JSON.parse(fs.readFileSync(path.join(root, ".sous", "sous.links.json"), "utf8")).links.acme.path).toBe(dir);
        expect(fs.readFileSync(path.join(root, ".sous", ".gitignore"), "utf8")).toContain("sous.links.json");
        expect(fs.readFileSync(path.join(root, ".sous", "repos", ".gitignore"), "utf8")).toBe("*\n");
    });

    it("should write nothing on a dry run", async () => {
        const dir = checkout();
        const { engine } = await startEngine({ root, home, data: config({ "workflow/alpha": {} }), hosts: [fakeHost([repo], calls)] });
        const result = (await engine.handle.submit({ intent: "repo.link", input: { repo: "acme", path: dir, dryRun: true } })).toPlain();

        expect(result.dryRun).toBe(true);
        expect(fs.existsSync(path.join(root, ".sous", "sous.links.json"))).toBe(false);
    });

    it("should refuse a path that is not a sous repository", async () => {
        const { engine } = await startEngine({ root, home, data: config({}), hosts: [fakeHost([repo], calls)] });

        await expect(engine.handle.submit({ intent: "repo.link", input: { repo: "acme", path: tempDir() } })).rejects.toThrow(/is not a sous repository/);
    });

    it("should refuse a name the project does not know that is neither a URL nor a path", async () => {
        const { engine } = await startEngine({ root, home, data: config({}), hosts: [fakeHost([repo], calls)] });

        await expect(engine.handle.submit({ intent: "repo.link", input: { repo: "nowhere" } })).rejects.toThrow(/not a repository this project knows about/);
    });

    it("should unlink a linked repository without building, leaving a checkout it did not clone alone", async () => {
        const dir = checkout();
        const { engine } = await startEngine({ root, home, data: config({ "workflow/alpha": {} }), hosts: [fakeHost([repo], calls)] });

        await engine.handle.submit({ intent: "repo.link", input: { repo: "acme", path: dir } });

        const result = (await engine.handle.submit({ intent: "repo.unlink", input: { repo: "acme", noBuild: true } })).toPlain();

        expect(result).toMatchObject({ repo: "acme", path: dir, scope: "project", removedCheckout: false, dryRun: false });
        expect(result.followUps).toEqual([{ intent: "build", skipped: "--no-build" }]);
        expect(JSON.parse(fs.readFileSync(path.join(root, ".sous", "sous.links.json"), "utf8")).links).toEqual({});
        expect(fs.existsSync(dir)).toBe(true);
    });

    it("should refuse --remove for a checkout sous did not clone", async () => {
        const dir = checkout();
        const { engine } = await startEngine({ root, home, data: config({ "workflow/alpha": {} }), hosts: [fakeHost([repo], calls)] });

        await engine.handle.submit({ intent: "repo.link", input: { repo: "acme", path: dir } });

        await expect(engine.handle.submit({ intent: "repo.unlink", input: { repo: "acme", remove: true, noBuild: true } })).rejects.toThrow(/did not create the checkout/);
    });

    it("should say where a repository is linked when it is not linked in the scope asked about", async () => {
        const dir = checkout();
        const { engine } = await startEngine({ root, home, data: config({ "workflow/alpha": {} }), hosts: [fakeHost([repo], calls)] });

        await engine.handle.submit({ intent: "repo.link", input: { repo: "acme", path: dir } });

        await expect(engine.handle.submit({ intent: "repo.unlink", input: { repo: "acme", global: true, noBuild: true } })).rejects.toThrow(/It is linked in the project map/);
    });
});
