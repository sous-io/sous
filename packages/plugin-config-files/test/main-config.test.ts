/**
 * `config-files.main` in a real engine: `sous.config.*` read in-process, one merge at the root.
 * Ported from the old config kernel's integration test (src/test/integration/config-kernel.test.ts):
 * the same files, loaded without a child process.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { definePlugin } from "@sous-io/plugin-api";
import { configFilesPlugin } from "../src/index.js";
import { makeEngine, makeProject, type TestProject } from "./helpers.js";

let project: TestProject;

beforeEach(() => {
    project = makeProject();
});

afterEach(() => {
    project.cleanup();
});

/** The error a promise rejects with. */
async function rejection(promise: Promise<unknown>): Promise<Error & { details: string[] }> {
    try {
        await promise;
    } catch (error) {
        return error as Error & { details: string[] };
    }

    throw new Error("expected a rejection");
}

/** Builds the config of the test project and returns its values. */
async function build(extra: Parameters<typeof makeEngine>[2] = {}): Promise<Record<string, unknown>> {
    const { engine } = makeEngine(project.info(), [configFilesPlugin], extra);
    const config = await engine.buildConfig();

    return config.value() as Record<string, unknown>;
}

describe("sous.config.* data files", () => {
    /**
     * A JSON main config merges at the root.
     *
     * // .sous/sous.config.json: { "name": "first", "_vars": { "a": "1" } }
     * config.value();   // { name: "first", _vars: { a: "1" }, ... }
     */
    it("should load a JSON main config", async () => {
        project.write("sous.config.json", JSON.stringify({ name: "first", _vars: { a: "1" } }));

        const value = await build();

        expect(value.name).toBe("first");
        expect(value._vars).toEqual({ a: "1" });
    });

    /** A JSONC file may hold comments and trailing commas. */
    it("should load a JSONC main config with comments and trailing commas", async () => {
        project.write("sous.config.jsonc", '// a note\n{\n  "name": "jsonc", /* inline */\n  "_vars": { "a": "1", },\n}\n');

        const value = await build();

        expect(value.name).toBe("jsonc");
        expect(value._vars).toEqual({ a: "1" });
    });

    /** A YAML main config, under either spelling. */
    it("should parse a YAML main config", async () => {
        project.write("sous.config.yml", "name: yaml-main\n_vars:\n  fromYaml: yes-it-works\n");

        const value = await build();

        expect(value.name).toBe("yaml-main");
        expect(value._vars).toEqual({ fromYaml: "yes-it-works" });
    });

    /** A broken file is an error naming it. */
    it("should reject a broken JSON file, naming it", async () => {
        project.write("sous.config.json", "{ this is not: valid json ]");

        await expect(build()).rejects.toThrow(/sous\.config\.json/);
    });

    /** The removed multi-project schema is an error naming the file. */
    it("should reject the removed multi-project schema, naming the file", async () => {
        project.write("sous.config.json", JSON.stringify({ projects: { foo: {} }, defaultProject: "foo" }));

        await expect(build()).rejects.toThrow(/sous\.config\.json uses the removed multi-project schema/);
    });

    /** A file that holds an array is not a config. */
    it("should reject a file that is not an object", async () => {
        project.write("sous.config.json", "[1, 2]");

        await expect(build()).rejects.toThrow(/did not produce a plain object/);
    });

    /** No config file at all: nothing to contribute, and the build still works. */
    it("should contribute nothing when the project has no main config", async () => {
        const value = await build();

        expect(value.name).toBeUndefined();
    });

    /** Outside a project, the contributor does nothing. */
    it("should contribute nothing outside a project", async () => {
        const { engine } = makeEngine(undefined, [configFilesPlugin]);

        await expect(engine.buildConfig()).resolves.toBeDefined();
    });

    /** Two main config files: the first is read, and sous warns (L6: report, never forbid). */
    it("should warn when a .sous directory holds several main config files", async () => {
        project.write("sous.config.json", JSON.stringify({ name: "json" }));
        project.write("sous.config.yaml", "name: yaml\n");

        const { engine, reporter } = makeEngine(project.info(), [configFilesPlugin]);
        const config = await engine.buildConfig();

        expect(config.get("name")).toBe("json");
        expect(reporter.at("warning").join("\n")).toMatch(/2 main config files/);
    });

    /** The config keys this plugin owns are checked: `version` must be 1. */
    it("should check version, name and $schema", async () => {
        project.write("sous.config.json", JSON.stringify({ $schema: "./schema.json", version: 1, name: "ok" }));
        await expect(build()).resolves.toMatchObject({ version: 1, name: "ok" });

        project.write("sous.config.json", JSON.stringify({ version: 2 }));
        const error = await rejection(build());

        expect(error.details.join("\n")).toMatch(/^version:/m);
    });
});

describe("sous.config.* module files", () => {
    /** `export const config` is data, merged at the root. */
    it("should load a module that exports only a config object", async () => {
        project.write("sous.config.mjs", `export const config = { name: "from-config-export", _vars: { x: "1" } };\n`);

        const value = await build();

        expect(value.name).toBe("from-config-export");
        expect(value._vars).toEqual({ x: "1" });
    });

    /** A default export that is an object is data too. */
    it("should accept a default-export object", async () => {
        project.write("sous.config.js", `export default { name: "default-object", _vars: { a: "1" } };\n`);

        expect((await build()).name).toBe("default-object");
    });

    /**
     * `configure(config)` is given the builder, like any contributor (S2).
     *
     * export function configure(config) { config.atPath("_aliases.extra").append("x"); }
     */
    it("should give configure() the builder", async () => {
        project.write(
            "sous.config.mjs",
            `export function configure(config) {
    config.atPath("name").set("from-builder");
    config.atPath("_aliases.list").append("x");
    config.atPath("_aliases.list").append("y");
}
`,
        );

        const value = await build();

        expect(value.name).toBe("from-builder");
        expect(value._aliases).toEqual({ list: ["x", "y"] });
    });

    /** A TypeScript config file is imported in-process. */
    it("should import a TypeScript config file", async () => {
        project.write("sous.config.ts", `const name: string = "typed";\nexport const config = { name };\n`);

        expect((await build()).name).toBe("typed");
    });

    /** The old style still works: configure(cfg) changing a plain config object in place. */
    it("should run a configure() that mutates the config by reference", async () => {
        project.write(
            "sous.config.mjs",
            `export const config = { name: "seed" };
export function configure(cfg) { cfg._vars = { mutated: "yes", sawName: cfg.name }; }
`,
        );

        const value = await build();

        expect(value._vars).toEqual({ mutated: "yes", sawName: "seed" });
    });

    /** Data merges before the function runs, so the function can read it. */
    it("should merge the config object before running configure() when a file exports both", async () => {
        project.write(
            "sous.config.mjs",
            `export const config = { _vars: { seed: "objval" } };
export function configure(cfg) { cfg._vars.readBack = cfg._vars.seed + "-seen"; }
`,
        );

        expect((await build())._vars).toEqual({ seed: "objval", readBack: "objval-seen" });
    });

    /** A default-export function is configure(). */
    it("should accept a default-export function as configure()", async () => {
        project.write("sous.config.mjs", `export default (cfg) => { cfg.name = "via-default-fn"; };\n`);

        expect((await build()).name).toBe("via-default-fn");
    });

    /** An async configure() is awaited. */
    it("should await an async configure()", async () => {
        project.write(
            "sous.config.mjs",
            `export async function configure(cfg) {
  const v = await Promise.resolve("async-value");
  cfg._vars = { asyncField: v };
}
`,
        );

        expect((await build())._vars).toEqual({ asyncField: "async-value" });
    });

    /** An object returned from configure() is merged. */
    it("should merge a value returned from configure()", async () => {
        project.write("sous.config.mjs", `export function configure() { return { _vars: { returned: "merged-after" } }; }\n`);

        expect((await build())._vars).toEqual({ returned: "merged-after" });
    });

    /** Mutating and returning the config for chaining never doubles an array. */
    it("should not duplicate arrays when configure() mutates and returns the config", async () => {
        project.write(
            "sous.config.mjs",
            `export function configure(cfg) {
  cfg.compilation = { targets: [{ entryPoint: "a.md", outputs: [] }, { entryPoint: "b.md", outputs: [] }] };
  return cfg;
}
`,
        );

        const value = (await build()) as { compilation: { targets: Array<{ entryPoint: string }> } };

        expect(value.compilation.targets.map((t) => t.entryPoint)).toEqual(["a.md", "b.md"]);
    });

    /** The same when it returns the old builder's `config`. */
    it("should not duplicate arrays when configure() returns builder.config", async () => {
        project.write(
            "sous.config.mjs",
            `export function configure(cfg, builder) {
  cfg._aliases = { order: ["x", "y"] };
  return builder.config;
}
`,
        );

        expect((await build())._aliases).toEqual({ order: ["x", "y"] });
    });

    /** The old builder's merge(). */
    it("should support builder.merge()", async () => {
        project.write("sous.config.mjs", `export function configure(cfg, builder) { builder.merge({ _vars: { extra: "via-merge" } }); }\n`);

        expect((await build())._vars).toEqual({ extra: "via-merge" });
    });

    /** The old builder's env(), reading the engine's environment (never process.env). */
    it("should support builder.env() with a fallback", async () => {
        project.write(
            "sous.config.mjs",
            `export function configure(cfg, builder) {
  cfg._vars = {
    present: builder.env("SOUS_KERNEL_TEST_VAR", "fallback"),
    missing: builder.env("SOUS_KERNEL_DEFINITELY_UNSET", "fallback-used"),
  };
}
`,
        );

        const value = await build({ env: { SOUS_KERNEL_TEST_VAR: "from-env" } });

        expect(value._vars).toEqual({ present: "from-env", missing: "fallback-used" });
    });

    /** The old builder's loadConfig(), relative and with `${sousDir}`. */
    it("should support builder.loadConfig() with a relative path and a ${sousDir} path", async () => {
        project.write("extra/rel.json", JSON.stringify({ _vars: { fromRelative: "yes" } }));
        project.write("extra/abs.json", JSON.stringify({ _vars: { fromAutoVar: "yes" } }));
        project.write(
            "sous.config.mjs",
            `export async function configure(cfg, builder) {
  await builder.loadConfig("./extra/rel.json");
  await builder.loadConfig("\${sousDir}/extra/abs.json");
}
`,
        );

        expect((await build())._vars).toEqual({ fromRelative: "yes", fromAutoVar: "yes" });
    });

    /** The old builder's loadConfigs(), in bytewise order. */
    it("should support builder.loadConfigs() globbing in bytewise order", async () => {
        project.write("parts/20-b.json", JSON.stringify({ _aliases: { order: ["b"] } }));
        project.write("parts/10-a.json", JSON.stringify({ _aliases: { order: ["a"] } }));
        project.write(
            "sous.config.mjs",
            `export async function configure(cfg, builder) {
  cfg._aliases = { order: ["primary"] };
  await builder.loadConfigs("\${sousDir}/parts/*.json");
}
`,
        );

        expect((await build())._aliases).toEqual({ order: ["primary", "a", "b"] });
    });

    /** An unknown `${var}` in a builder path names the variables that can be used. */
    it("should reject an unknown ${var} in a builder path, listing the allowed ones", async () => {
        project.write("sous.config.mjs", `export async function configure(cfg, builder) { await builder.loadConfig("\${bogusVar}/nope.json"); }\n`);

        const error = await rejection(build());

        expect(error.message).toMatch(/bogusVar/);
        expect(error.details.join("\n")).toMatch(/sousConfDir/);
    });

    /** A configure() that throws is one error, naming the file. */
    it("should report a configure() throw once, naming the file", async () => {
        project.write("sous.config.js", `export function configure() { throw new Error("boom in configure"); }\n`);

        await expect(build()).rejects.toThrow(/sous\.config\.js.*boom in configure/);
    });

    /** A module exporting nothing useful is an error. */
    it("should reject a module that exports neither data nor a function", async () => {
        project.write("sous.config.mjs", `export const unrelated = 1;\n`);

        await expect(build()).rejects.toThrow(/exports neither config data nor a configure function/);
    });

    /** Values pass through a JSON round-trip: functions and undefined are dropped. */
    it("should drop functions and undefined values from a module (plain JSON)", async () => {
        project.write(
            "sous.config.mjs",
            `export const config = { name: "plain", fn: () => 1, _vars: { gone: undefined, kept: "yes" } };\n`,
        );

        const value = await build();

        expect(value.fn).toBeUndefined();
        expect(value._vars).toEqual({ kept: "yes" });
    });
});

describe("the user's file lands on top (C70, C74)", () => {
    /**
     * A plugin sets a key; the user's file sets it too; the user's value wins, with no special
     * operation (S2's worked example).
     */
    it("should let sous.config.* win over a plugin's value", async () => {
        project.write("sous.config.json", JSON.stringify({ compilation: { includeSourceComments: false } }));

        const acme = definePlugin({
            name: "sous-plugin-acme-standards",
            register(sous) {
                sous.config.contribute({
                    id: "zz-acme",
                    contribute(config) {
                        config.atPath("compilation.includeSourceComments").setValue(true);
                    },
                });
            },
        });

        const value = (await build({ extra: [acme] })) as { compilation: Record<string, unknown> };

        expect(value.compilation.includeSourceComments).toBe(false);
    });

    /** Where the user's file is silent, the plugin's value stands. */
    it("should keep a plugin's value when the file does not set it", async () => {
        project.write("sous.config.json", JSON.stringify({ name: "x" }));

        const acme = definePlugin({
            name: "sous-plugin-acme-standards",
            register(sous) {
                sous.config.contribute({ id: "acme", contribute: (config) => config.atPath("compilation.includeSourceComments").setValue(true) });
            },
        });

        const value = (await build({ extra: [acme] })) as { compilation: Record<string, unknown> };

        expect(value.compilation.includeSourceComments).toBe(true);
    });

    /** The file's expressions are evaluated through the expression evaluator before merging (S2, S5). */
    it("should evaluate config expressions before merging", async () => {
        project.write(
            "sous.config.json",
            JSON.stringify({ _vars: { machineRole: "laptop" }, name: { $if: { expr: "machineRole == 'laptop'", then: "on-laptop", else: "elsewhere" } } }),
        );

        expect((await build()).name).toBe("on-laptop");
    });

    /** The layers view names the file's contributor as the author of each value (G4). */
    it("should record the contributor as the author of each value", async () => {
        project.write("sous.config.json", JSON.stringify({ name: "x" }));

        const { engine } = makeEngine(project.info(), [configFilesPlugin]);
        const config = await engine.buildConfig();

        expect(config.layers("name").map((layer) => layer.contributor)).toEqual(["config-files.main"]);
    });
});

describe("patch files beside sous.config.* (C77)", () => {
    /** `sous.config.patch.json` with `$patches` applies after the main file. */
    it("should apply sous.config.patch.json after sous.config.*", async () => {
        project.write("sous.config.json", JSON.stringify({ name: "main", tools: { codex: {}, claude: {} } }));
        project.write(
            "sous.config.patch.json",
            JSON.stringify({
                $patches: [
                    { op: "setKey", path: "", key: "name", value: "patched" },
                    { op: "deleteKey", path: "tools", key: "codex" },
                ],
            }),
        );

        const value = await build();

        expect(value.name).toBe("patched");
        expect(value.tools).toEqual({ claude: {} });
    });

    /** A `.patch.jsonl` file holds one patch per line. */
    it("should apply sous.config.patch.jsonl, one patch per line", async () => {
        project.write("sous.config.json", JSON.stringify({ _vars: {} }));
        project.write(
            "sous.config.patch.jsonl",
            ['{"op": "setKey", "path": "_vars", "key": "machineRole", "value": "laptop"}', '{"op": "setKey", "path": "_vars", "key": "other", "value": "x"}', ""].join("\n"),
        );

        expect((await build())._vars).toEqual({ machineRole: "laptop", other: "x" });
    });

    /** A patch file keeps landing on top when a plugin changes the key it sets. */
    it("should keep a patch file's value on top of a plugin's", async () => {
        project.write("sous.config.patch.json", JSON.stringify({ op: "setKey", path: "", key: "name", value: "patched" }));

        const late = definePlugin({
            name: "late-plugin",
            register(sous) {
                sous.config.contribute({ id: "zzz-late", contribute: (config) => config.atPath("name").set("plugin") });
            },
        });

        expect((await build({ extra: [late] })).name).toBe("patched");
    });
});
