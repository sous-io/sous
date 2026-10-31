import path from "node:path";
import { parseManifestText } from "@sous-io/plugin-formats";
import { hostGlobs } from "@sous-io/plugin-host";
import { afterEach, describe, expect, it } from "vitest";
import { cleanTemp, tempDir, writeRecipe } from "../../../test/part-b/helpers.js";
import type { ActiveRecipeEntity } from "../../types.js";
import { filterRecipeConfigLayer, readRecipeConfigLayers, RECIPE_CONFIG_ALLOWED_KEYS } from "./config-layers.js";

afterEach(() => cleanTemp());

describe("filterRecipeConfigLayer()", () => {
    it("should keep the keys a recipe may set and drop the others with a reason", () => {
        const { config, warnings } = filterRecipeConfigLayer("acme/one", "/r/layer.yaml", {
            _vars: { a: 1 },
            compilation: { targets: [] },
            repos: { evil: { url: "x" } },
            subscriptions: { x: {} },
            tools: {},
            whatever: true,
        });

        expect(config).toEqual({ _vars: { a: 1 }, compilation: { targets: [] } });
        expect(warnings).toHaveLength(4);
        expect(warnings[0]).toContain("only you decide which repositories this project trusts");
        expect(warnings[1]).toContain("subscribe on your behalf");
        expect(warnings[2]).toContain("names a program sous launches");
        expect(warnings[3]).toContain("does not recognise it");
        expect(warnings[0]).toContain("acme/one");
        expect(warnings[0]).toContain("/r/layer.yaml");
    });

    it("should keep only recipes.skills under recipes", () => {
        const { config, warnings } = filterRecipeConfigLayer("acme/one", "/r/l.yaml", { recipes: { skills: { outputs: ["x"] }, memories: ["y"] } });

        expect(config).toEqual({ recipes: { skills: { outputs: ["x"] } } });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("'recipes.memories'");
    });

    it("should allow the keys the plugin option adds", () => {
        const { config, warnings } = filterRecipeConfigLayer("acme/one", "/r/l.yaml", { skills: { a: 1 }, recipes: { memories: [] } }, ["skills", "recipes"]);

        expect(config).toEqual({ skills: { a: 1 }, recipes: { memories: [] } });
        expect(warnings).toEqual([]);
    });

    it("should merge nothing from a layer that is not an object", () => {
        for (const raw of [null, [], "text", 3]) {
            const result = filterRecipeConfigLayer("acme/one", "/r/l.yaml", raw);

            expect(result.config).toEqual({});
            expect(result.warnings[0]).toContain("not a set of configuration keys");
        }
    });

    it("should list exactly the documented allowed keys", () => {
        expect([...RECIPE_CONFIG_ALLOWED_KEYS]).toEqual(["_aliases", "_vars", "compilation", "recipes", "runtimeContext", "store", "varMappings"]);
    });
});

/** An active recipe at a directory. */
function active(dir: string, id: string, contents: ActiveRecipeEntity["manifest"]["contents"], kind: "subscribes" | "depends" = "subscribes"): ActiveRecipeEntity {
    const [namespace, name] = id.split("/");

    return { id, namespace, name, repo: "acme", identity: "fake.test/acme", version: "1.0.0", hash: "sha256-0", kind, requestedBy: ["project"], dir, source: "store", manifest: { formatVersion: 1, namespace, name, version: "1.0.0", contents } };
}

const io = {
    match: (patterns: readonly string[], cwd: string, ignore: readonly string[]) => hostGlobs.matchSync(patterns, { cwd, ignore, absolute: true }),
    parse: (text: string, file: string) => parseManifestText(text, file),
};

describe("readRecipeConfigLayers()", () => {
    it("should read a subscribed recipe's layers in recipe-key then path order, filtered", () => {
        const base = tempDir();
        const b = writeRecipe(path.join(base, "b"), { namespace: "acme", name: "b", version: "1.0.0" }, { "config/b.yaml": "_vars:\n  from: b\n" });
        const a = writeRecipe(path.join(base, "a"), { namespace: "acme", name: "a", version: "1.0.0" }, { "config/2.json": '{"_vars": {"two": 2}}', "config/1.jsonc": '// c\n{"_vars": {"one": 1}, "repos": {}}' });
        const { layers, warnings } = readRecipeConfigLayers([active(b, "acme/b", [{ kind: "config", include: ["config/*"] }]), active(a, "acme/a", [{ kind: "config", include: ["config/*"] }])], io);

        expect(layers.map((layer) => [layer.recipeKey, path.basename(layer.path)])).toEqual([
            ["acme/a", "1.jsonc"],
            ["acme/a", "2.json"],
            ["acme/b", "b.yaml"],
        ]);
        expect(layers[0].config).toEqual({ _vars: { one: 1 } });
        expect(warnings).toHaveLength(1);
    });

    it("should skip recipes held only as build dependencies, and other content kinds", () => {
        const dir = writeRecipe(path.join(tempDir(), "a"), { namespace: "acme", name: "a", version: "1.0.0" }, { "config/a.yaml": "_vars: {}\n" });

        expect(readRecipeConfigLayers([active(dir, "acme/a", [{ kind: "config", include: ["config/*"] }], "depends")], io).layers).toEqual([]);
        expect(readRecipeConfigLayers([active(dir, "acme/a", [{ kind: "skills", include: ["config/*"] }])], io).layers).toEqual([]);
    });

    it("should honour excludes", () => {
        const dir = writeRecipe(path.join(tempDir(), "a"), { namespace: "acme", name: "a", version: "1.0.0" }, { "config/a.yaml": "_vars: {}\n", "config/b.yaml": "_vars: {}\n" });
        const { layers } = readRecipeConfigLayers([active(dir, "acme/a", [{ kind: "config", include: ["config/*"], exclude: ["config/b.yaml"] }])], io);

        expect(layers.map((layer) => path.basename(layer.path))).toEqual(["a.yaml"]);
    });

    it("should refuse program code and skip formats it does not read, with one warning each", () => {
        const dir = writeRecipe(path.join(tempDir(), "a"), { namespace: "acme", name: "a", version: "1.0.0" }, { "config/run.js": "export default {}", "config/run.ts": "", "config/notes.toml": "" });
        const { layers, warnings } = readRecipeConfigLayers([active(dir, "acme/a", [{ kind: "config", include: ["config/*"] }])], io);

        expect(layers).toEqual([]);
        expect(warnings).toHaveLength(2);
        expect(warnings[0]).toContain("program code");
        expect(warnings[0]).toContain("run.js");
        expect(warnings[1]).toContain("notes.toml");
    });

    it("should warn about a layer it cannot parse and merge nothing from it", () => {
        const dir = writeRecipe(path.join(tempDir(), "a"), { namespace: "acme", name: "a", version: "1.0.0" }, { "config/bad.json": "{ nope" });
        const { layers, warnings } = readRecipeConfigLayers([active(dir, "acme/a", [{ kind: "config", include: ["config/*"] }])], io);

        expect(layers).toEqual([]);
        expect(warnings[0]).toContain("could not read");
    });
});
