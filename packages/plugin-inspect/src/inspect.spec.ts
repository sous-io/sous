import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEngine } from "@sous-io/core";
import { definePlugin, jsonSchema, type PluginDefinition, type ProjectInfo } from "@sous-io/plugin-api";
import { hostPlugin } from "@sous-io/plugin-host";
import { variablesPlugin } from "@sous-io/plugin-variables";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import inspectPlugin from "./index.js";
import { HIDDEN, redactText } from "./redact.js";

const demo = definePlugin({
    name: "demo",
    version: "1.0.0",
    description: "A plugin that sets some config.",
    dependsOn: {},
    register(sous) {
        sous.entities.add("config-key", {
            id: "demo",
            schema: jsonSchema({ type: "object", properties: { count: { type: "integer" } } }),
        });
        sous.config.contribute({
            id: "demo/main",
            contribute(config) {
                config.atPath("demo").merge({ count: 2, apiToken: "s3cr3t", list: [1, 2] });
            },
        });
    },
});

/**
 * Stands in for plugin-confd and plugin-config-files: lists the `conf.d` files of the project in
 * name order, and reads a file's text.
 */
const confdStandIn = definePlugin({
    name: "confd-stand-in",
    version: "1.0.0",
    register(sous) {
        sous.services.add(
            "config-files.loader",
            () =>
                ({
                    findPatches: () => [],
                    load: async (file: string) => ({ kind: "data", path: file, format: "jsonc", data: {}, text: readFileSync(file, "utf8") }),
                }) as never,
            { lifetime: "singleton" },
        );
        sous.services.add(
            "confd.files",
            (_config, ctx) =>
                ({
                    directory: () => ctx.project?.confDir,
                    list: () =>
                        ctx.project === undefined
                            ? []
                            : readdirSync(ctx.project.confDir)
                                  .sort()
                                  .map((name) => ({
                                      name,
                                      path: path.join(ctx.project!.confDir, name),
                                      format: "jsonc",
                                      contributor: `confd/${name}`,
                                      managed: false,
                                  })),
                }) as never,
            { lifetime: "singleton" },
        );
    },
});

/** A project with no files: the config intents need one (they fail outside a project). */
const EMPTY_PROJECT: ProjectInfo = { root: "/no-files", sousDir: "/no-files/.sous", configPath: undefined, confDir: "/no-files/.sous/conf.d" };

async function run(intent: string, input: Record<string, unknown> = {}, project: ProjectInfo = EMPTY_PROJECT, extra: PluginDefinition[] = []) {
    const engine = createEngine({ builtIns: [inspectPlugin, demo, ...extra], env: {}, project });

    await engine.buildConfig();

    return engine.handle.submit({ intent, input } as never) as Promise<any>;
}

describe("config.show", () => {
    /** The evaluated config prints with secrets hidden (G4). */
    it("should show the config and hide secrets", async () => {
        const result = await run("config.show");

        expect(result.config.demo.count).toBe(2);
        expect(result.config.demo.apiToken).toBe(HIDDEN);
        expect(result.passes).toBeGreaterThan(0);
        expect(result.layers).toBeUndefined();
    });

    /** --layers lists each contributor's primitive patches, in order, with secrets hidden. */
    it("should list layers", async () => {
        const result = await run("config.show", { layers: true });
        const demoLayers = result.layers.filter((l: any) => l.contributor === "demo/main");

        expect(demoLayers.length).toBeGreaterThan(0);
        expect(JSON.stringify(demoLayers)).not.toContain("s3cr3t");
    });

    /** --raw reads the main file and conf.d in name order. */
    it("should read config files as written", async () => {
        const root = mkdtempSync(path.join(tmpdir(), "inspect-"));
        const sousDir = path.join(root, ".sous");
        const confDir = path.join(sousDir, "conf.d");

        mkdirSync(confDir, { recursive: true });
        writeFileSync(path.join(sousDir, "sous.config.jsonc"), '{ "name": "x", "password": "hunter2" }\n');
        writeFileSync(path.join(confDir, "620-b.jsonc"), "{}\n");
        writeFileSync(path.join(confDir, "510-a.jsonc"), "{}\n");

        const result = await run("config.show", { raw: true }, {
            root,
            sousDir,
            configPath: path.join(sousDir, "sous.config.jsonc"),
            confDir,
        }, [confdStandIn]);

        expect(result.raw.map((f: any) => f.contributor)).toEqual(["config-files.main", "confd/510-a.jsonc", "confd/620-b.jsonc"]);
        expect(result.raw[0].text).not.toContain("hunter2");
    });
});

describe("config.get", () => {
    /** A path gives its value; a missing path says so. */
    it("should get a value and report a missing one", async () => {
        const found = await run("config.get", { path: "demo.list[1]" });
        const missing = await run("config.get", { path: "demo.nope" });

        expect(found).toMatchObject({ exists: true, value: 2 });
        expect(missing.exists).toBe(false);
        expect(missing.value).toBeUndefined();
    });

    /** A secret's value is hidden, alone or inside an object. */
    it("should hide secrets", async () => {
        expect((await run("config.get", { path: "demo.apiToken" })).value).toBe(HIDDEN);
        expect((await run("config.get", { path: "demo" })).value.apiToken).toBe(HIDDEN);
    });

    /** --layers lists the changes that touched the path. */
    it("should list the layers of a path", async () => {
        const result = await run("config.get", { path: "demo.count", layers: true });

        expect(result.layers.some((l: any) => l.contributor === "demo/main")).toBe(true);
    });

    /** Each change that sets the value says what it was and became; one that changes nothing is left out. */
    it("should say what each change did to the value", async () => {
        const override = definePlugin({
            name: "override",
            version: "1.0.0",
            dependsOn: {},
            register(sous) {
                sous.config.contribute({ id: "override/same", after: ["demo/main"], contribute: (config) => void config.atPath("demo").merge({ count: 2 }) });
                sous.config.contribute({ id: "override/new", after: ["override/same"], contribute: (config) => void config.atPath("demo").merge({ count: 3 }) });
            },
        });
        const result = await run("config.get", { path: "demo.count", layers: true }, undefined, [override]);

        expect(result.layers.map((l: any) => [l.contributor, l.change])).toEqual([
            ["demo/main", { to: 2 }],
            ["override/new", { from: 2, to: 3 }],
        ]);
    });
});

describe("config.validate", () => {
    /** A `${name}` defined nowhere is reported, naming it, as a build would refuse it. */
    it("should report a variable defined nowhere", async () => {
        const vars = definePlugin({
            name: "vars",
            version: "1.0.0",
            dependsOn: { "@sous-io/plugin-host": "*" },
            register(sous) {
                // Stands in for plugin-host's identity of the installed sous, which the auto-variables read.
                const identity = { name: "@sous-io/sous", version: "1.0.0", root: "/opt/sous", realRoot: "/opt/sous", bin: undefined };

                sous.services.replace("host.package", () => ({ identity: () => identity }) as never, { lifetime: "singleton" });
                sous.config.contribute({ id: "vars/main", contribute: (config) => void config.atPath("_vars").merge({ thing: "${bogus}" }) });
            },
        });
        const result = await run("config.validate", {}, undefined, [hostPlugin, variablesPlugin, vars]);

        expect(result.ok).toBe(false);
        expect(result.issues.join("\n")).toMatch(/bogus/);
    });

    /** A good config gives what was checked, for the summary. */
    it("should summarize a good config", async () => {
        const result = await run("config.validate");

        expect(result.summary).toEqual({ configFile: undefined, layers: 0, targets: 0, tools: [] });
    });

    /** A value that breaks its key's schema is reported with who set it. */
    it("should report issues and name the contributor", async () => {
        const bad = definePlugin({
            name: "bad",
            version: "1.0.0",
            description: "Sets a bad value.",
            dependsOn: {},
            register(sous) {
                sous.config.contribute({
                    id: "bad/main",
                    after: ["demo"],
                    contribute(config) {
                        config.atPath("demo").merge({ count: "many" });
                    },
                });
            },
        });
        const good = await run("config.validate");

        expect(good).toMatchObject({ ok: true, issues: [] });

        const engine = createEngine({ builtIns: [inspectPlugin, demo, bad], env: {}, project: EMPTY_PROJECT });

        try {
            await engine.buildConfig();
        } catch {
            return; // The engine itself already refuses a config that fails its schemas.
        }

        const result = await engine.handle.submit({ intent: "config.validate" } as never) as any;

        expect(result.ok).toBe(false);
        expect(result.issues[0]).toContain("bad/main");
    });
});

describe("plugins.show", () => {
    /** Every plugin shows what it registered; a name narrows it; an unknown name is an error. */
    it("should list plugins and filter by name", async () => {
        const all = await run("plugins.show");
        const one = await run("plugins.show", { name: "demo" });

        expect(all.map((p: any) => p.name)).toEqual(expect.arrayContaining(["demo", "@sous-io/plugin-inspect"]));
        expect(one).toHaveLength(1);
        expect(one[0].registrations).toContainEqual({ kind: "entity", name: "config-key: demo" });
        await expect(run("plugins.show", { name: "nope" })).rejects.toThrow(/No plugin named/);
    });
});

describe("timings.show", () => {
    /** Timings come slowest first and can be narrowed by category. */
    it("should list and filter timings", async () => {
        const all = await run("timings.show");
        const contributors = await run("timings.show", { category: "contributor" });
        const over = await run("timings.show", { overBudget: true });

        expect(all.length).toBeGreaterThan(0);
        expect(contributors.every((e: any) => e.category === "contributor")).toBe(true);
        expect(over.every((e: any) => e.overBudget > 0)).toBe(true);
        expect(all[0].totalMs).toBeGreaterThanOrEqual(all[all.length - 1].totalMs);
    });
});

describe("redactText()", () => {
    /** Values after secret keys are hidden; others stay. */
    it("should hide secret values line by line", () => {
        const out = redactText('{\n  "name": "x",\n  "apiKey": "abc",\n}');

        expect(out).toContain('"name": "x"');
        expect(out).toContain(`"apiKey": "${HIDDEN}",`);
        expect(out).not.toContain("abc");
    });
});

describe("the secret policy", () => {
    /**
     * With plugin-variables loaded, a value in a known token format is hidden under any name, and
     * a plain value under a secret-sounding name (a flag) is not.
     */
    it("should use variables.secrets when it is loaded", async () => {
        const token = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
        const tokens = definePlugin({
            name: "tokens",
            version: "1.0.0",
            register(sous) {
                sous.config.contribute({
                    id: "tokens/main",
                    contribute(config) {
                        config.atPath("demo").merge({ note: token, tokenCount: 3, apiToken: "s3cr3t", useToken: "true" });
                    },
                });
            },
        });
        const result = await run("config.show", {}, undefined, [hostPlugin, variablesPlugin, tokens]);

        expect(result.config.demo.note).toBe(HIDDEN);
        expect(result.config.demo.apiToken).toBe(HIDDEN);
        expect(result.config.demo.tokenCount).toBe(3);
        expect(result.config.demo.useToken).toBe("true");
    });
});
