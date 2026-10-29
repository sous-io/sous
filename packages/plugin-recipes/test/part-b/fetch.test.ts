/**
 * The `recipes.fetch`, `recipes.config-layers` and `recipes.plugins` contributors, end to end on a
 * real engine: downloading during config building (S2, "Downloads"), switched-off subscriptions
 * (S4, 3; C59), recipe config layers, recipe plugins loaded from one bundle (C39, C48), and their
 * `.d.ts` copied to `.sous/types/` (C40).
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { definePlugin, type JsonObject } from "@sous-io/plugin-api";
import { cleanTemp, fakeHost, fakeUrl, hashOf, indexFile, startEngine, tempDir, writeLockfile, writeRecipe, type FakeHostCalls, type FakeRepo } from "./helpers.js";

const URL = fakeUrl("acme", "recipes");
const IDENTITY = "fake.test/acme/recipes";

const PLUGIN_SOURCE = `export default {
    name: "sous-plugin-alpha",
    register(sous) {
        sous.config.contribute({ id: "alpha.flag", contribute(config) { config.atPath("alphaLoaded").set(true); } });
    },
};
`;

let home: string;
let root: string;
let source: string;
let repo: FakeRepo;
let calls: FakeHostCalls;

/** The config the user's files would give. */
function userConfig(extra: JsonObject = {}): () => JsonObject {
    return () => ({
        repos: { acme: { url: URL }, "sous-recipes": { enabled: false } },
        subscriptions: { "workflow/alpha": {} },
        ...extra,
    });
}

/** A lockfile pinning workflow/alpha@1.0.0. */
function pin(hash: string): void {
    writeLockfile(
        { root, sousDir: path.join(root, ".sous"), configPath: undefined, confDir: "" },
        {
            formatVersion: 1,
            repos: { acme: { url: URL, identity: IDENTITY } },
            recipes: { "workflow/alpha": { repo: "acme", version: "1.0.0", hash, requestedBy: ["project"], kind: "subscribes" } },
        },
    );
}

beforeEach(() => {
    home = tempDir();
    root = tempDir();
    source = writeRecipe(
        path.join(tempDir(), "alpha"),
        {
            namespace: "workflow",
            name: "alpha",
            version: "1.0.0",
            contents: [{ kind: "config", include: ["config/*"] }],
            plugin: { bundle: "plugin/index.js", types: "plugin/index.d.ts" },
        },
        {
            "config/defaults.yaml": "_vars:\n  alphaColour: blue\nrepos:\n  evil:\n    url: https://fake.test/evil/repo\n",
            "config/run.js": "export default {}",
            "plugin/index.js": PLUGIN_SOURCE,
            "plugin/index.d.ts": "export interface Alpha { ok: true }\n",
        },
    );
    repo = { url: URL, index: indexFile("acme", { "workflow/alpha": { versions: { "1.0.0": { hash: hashOf(source) } } } }), trees: { "recipes/workflow/alpha@workflow/alpha@1.0.0": source } };
    calls = { reads: [], fetches: [] };
    fs.mkdirSync(path.join(root, ".sous"), { recursive: true });
    pin(hashOf(source));
});

afterEach(() => cleanTemp());

describe("recipes.fetch", () => {
    it("should download a pinned recipe the store lacks while the config is built, and add it as an active recipe", async () => {
        const { engine } = await startEngine({ root, home, data: userConfig(), hosts: [fakeHost([repo], calls)] });
        const active = engine.config.entities.list("active-recipe");

        expect(active.map((recipe) => recipe.id)).toEqual(["workflow/alpha"]);
        expect(active[0]).toMatchObject({ repo: "acme", identity: IDENTITY, version: "1.0.0", source: "store", kind: "subscribes" });
        expect(fs.existsSync(path.join(active[0].dir, "sous.recipe.yaml"))).toBe(true);
        expect(calls.fetches).toHaveLength(1);
        // The store root was made self-describing while the config was built.
        expect(fs.existsSync(path.join(home, "cache", "README.md"))).toBe(true);
    });

    it("should find a download already in the store on the next run, fetching nothing", async () => {
        await startEngine({ root, home, data: userConfig(), hosts: [fakeHost([repo], calls)] });
        calls.fetches.length = 0;

        const { engine } = await startEngine({ root, home, data: userConfig(), hosts: [fakeHost([repo], calls)] });

        expect(engine.config.entities.list("active-recipe")).toHaveLength(1);
        expect(calls.fetches).toHaveLength(0);
    });

    it("should fail to build the config, saying what it could not download, when nothing is downloaded and the network is down", async () => {
        repo.offline = "network unreachable";

        await expect(startEngine({ root, home, data: userConfig(), hosts: [fakeHost([repo], calls)] })).rejects.toThrow(/could not download a recipe/);
    });

    it("should skip what it cannot download when the plugin option fetch.missing is skip", async () => {
        repo.offline = "network unreachable";

        const { engine, reporter } = await startEngine({
            root,
            home,
            data: userConfig({ plugins: { options: { "@sous-io/plugin-recipes": { fetch: { missing: "skip" } } } } }),
            hosts: [fakeHost([repo], calls)],
        });

        expect(engine.config.entities.list("active-recipe")).toEqual([]);
        expect(reporter.at("warning").join("\n")).toMatch(/Skipped workflow\/alpha/);
    });

    it("should leave a recipe whose subscription is switched off on this machine inactive, keeping its pin (C59)", async () => {
        const { engine } = await startEngine({
            root,
            home,
            data: () => ({ repos: { acme: { url: URL }, "sous-recipes": { enabled: false } }, subscriptions: { "workflow/alpha": { enabled: false } } }),
            hosts: [fakeHost([repo], calls)],
        });

        expect(engine.config.entities.list("active-recipe")).toEqual([]);
        expect(calls.fetches).toHaveLength(0);
        expect(engine.config.services.get("recipes.lock").get("workflow/alpha")?.version).toBe("1.0.0");
    });

    it("should leave recipes of a repository that is switched off inactive", async () => {
        const { engine } = await startEngine({
            root,
            home,
            data: () => ({ repos: { acme: { url: URL, enabled: false }, "sous-recipes": { enabled: false } }, subscriptions: { "workflow/alpha": {} } }),
            hosts: [fakeHost([repo], calls)],
        });

        expect(engine.config.entities.list("active-recipe")).toEqual([]);
    });

    it("should read a linked repository's recipe from its checkout, downloading nothing", async () => {
        const checkout = tempDir();

        fs.writeFileSync(path.join(checkout, "sous.repo.yaml"), "formatVersion: 1\nname: acme\nnamespaces:\n  workflow: {}\nrecipes:\n  - recipes/workflow/alpha\n", "utf8");
        fs.cpSync(source, path.join(checkout, "recipes/workflow/alpha"), { recursive: true });
        fs.writeFileSync(
            path.join(root, ".sous", "sous.links.json"),
            JSON.stringify({ formatVersion: 1, links: { acme: { path: checkout, linkedAt: "2026-10-01T00:00:00.000Z", origin: "path" } } }),
            "utf8",
        );

        const { engine } = await startEngine({ root, home, data: userConfig(), hosts: [fakeHost([repo], calls)] });
        const [recipe] = engine.config.entities.list("active-recipe");

        expect(recipe).toMatchObject({ source: "link", dir: path.join(checkout, "recipes/workflow/alpha") });
        expect(calls.fetches).toHaveLength(0);
    });
});

describe("recipes.config-layers", () => {
    it("should merge an active recipe's config layer, dropping the keys a recipe may not set and refusing code", async () => {
        const { engine, reporter } = await startEngine({ root, home, data: userConfig(), hosts: [fakeHost([repo], calls)] });
        const warnings = reporter.at("warning").join("\n");

        expect(engine.config.get("_vars.alphaColour")).toBe("blue");
        expect(engine.config.get("repos.evil")).toBeUndefined();
        expect(warnings).toMatch(/tried to set 'repos'/);
        expect(warnings).toMatch(/program code/);
    });

    it("should let the project's own files win over a recipe's layer", async () => {
        const { engine } = await startEngine({ root, home, data: userConfig({ _vars: { alphaColour: "red" } }), hosts: [fakeHost([repo], calls)] });

        expect(engine.config.get("_vars.alphaColour")).toBe("red");
    });
});

describe("recipes.plugins", () => {
    it("should load the plugin an active recipe ships as one bundle (C39, C48)", async () => {
        const { engine } = await startEngine({ root, home, data: userConfig(), hosts: [fakeHost([repo], calls)] });

        expect(engine.config.get("alphaLoaded")).toBe(true);
        expect(engine.handle.plugins().map((plugin) => plugin.name)).toContain("sous-plugin-alpha");
    });

    it("should copy the recipe plugin's .d.ts into .sous/types with an index referencing it (C40)", async () => {
        await startEngine({ root, home, data: userConfig(), hosts: [fakeHost([repo], calls)] });

        const types = path.join(root, ".sous", "types");

        expect(fs.readFileSync(path.join(types, "workflow", "alpha.d.ts"), "utf8")).toContain("interface Alpha");
        expect(fs.readFileSync(path.join(types, "index.d.ts"), "utf8")).toContain('/// <reference path="./workflow/alpha.d.ts" />');
    });

    it("should load nothing from a recipe whose subscription is switched off", async () => {
        const { engine } = await startEngine({
            root,
            home,
            data: () => ({ repos: { acme: { url: URL }, "sous-recipes": { enabled: false } }, subscriptions: { "workflow/alpha": { enabled: false } } }),
            hosts: [fakeHost([repo], calls)],
        });

        expect(engine.config.get("alphaLoaded")).toBeUndefined();
    });
});

describe("recipes.core", () => {
    it("should seed the packaged core recipe into the store while the config is built", async () => {
        const packageRoot = tempDir();

        writeRecipe(path.join(packageRoot, "recipes", "core", "sous-skills"), { namespace: "core", name: "sous-skills", version: "9.9.9" }, { "skills/core.md": "# core\n" });

        const packaged = definePlugin({
            name: "test-package",
            register(sous) {
                sous.services.replace(
                    "host.package",
                    () => ({ identity: () => ({ name: "@sous-io/sous", version: "9.9.9", root: packageRoot, realRoot: packageRoot, bin: undefined }) }),
                    { lifetime: "singleton" },
                );
            },
        });

        const { reporter } = await startEngine({ root, home, data: () => ({ repos: { acme: { url: URL } } }), hosts: [fakeHost([repo], calls)], plugins: [packaged] });

        expect(reporter.at("warning").join("\n")).not.toMatch(/core recipe was not seeded|host\.directories/);
        expect(fs.existsSync(path.join(home, "cache", "github.com", "sous-io", "sous-recipes", "core", "sous-skills", "9.9.9", ".sous.entry.json"))).toBe(true);
        expect(fs.existsSync(path.join(home, "cache", "README.md"))).toBe(true);
    });
});
