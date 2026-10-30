/**
 * The `conf.d` files in a real engine, with the real plugin-config-files: one contributor per file,
 * each after the one before, the first after `sous.config.*`. Ported from the old config kernel's
 * integration test and the conf.d parts of config discovery's spec.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { definePlugin } from "@sous-io/plugin-api";
import { makeEngine, makeProject, type TestProject } from "./helpers.js";

let project: TestProject;

beforeEach(() => {
    project = makeProject();
});

afterEach(() => {
    project.cleanup();
});

async function build(options: Parameters<typeof makeEngine>[1] = {}): Promise<Record<string, any>> {
    const { engine } = makeEngine(project.info(), options);

    return (await engine.buildConfig()).value() as Record<string, any>;
}

describe("conf.d order", () => {
    /** The main config first, then the conf.d files in file order. */
    it("should merge sous.config.* first, then conf.d files in bytewise order", async () => {
        project.write("sous.config.json", JSON.stringify({ _aliases: { order: ["primary"] } }));
        project.write("conf.d/10-a.json", JSON.stringify({ _aliases: { order: ["a"] } }));
        project.write("conf.d/20-b.json", JSON.stringify({ _aliases: { order: ["b"] } }));

        expect((await build())._aliases.order).toEqual(["primary", "a", "b"]);
    });

    /** Bytewise, not numeric: `10-early` sorts before `2-late`. */
    it("should sort conf.d bytewise, so 10- loads before 2-", async () => {
        project.write("sous.config.json", JSON.stringify({ _aliases: { order: ["primary"] } }));
        project.write("conf.d/2-late.json", JSON.stringify({ _aliases: { order: ["two"] } }));
        project.write("conf.d/10-early.json", JSON.stringify({ _aliases: { order: ["ten"] } }));

        expect((await build())._aliases.order).toEqual(["primary", "ten", "two"]);
    });

    /** A later file wins for a scalar. */
    it("should let later files win for scalars", async () => {
        project.write("sous.config.json", JSON.stringify({ name: "first" }));
        project.write("conf.d/50-override.json", JSON.stringify({ name: "second" }));

        expect((await build()).name).toBe("second");
    });

    /** Objects merge key by key across files. */
    it("should deep-merge nested objects across files", async () => {
        project.write("sous.config.json", JSON.stringify({ _vars: { a: "1" } }));
        project.write("conf.d/50-more.json", JSON.stringify({ _vars: { b: "2" } }));

        expect((await build())._vars).toEqual({ a: "1", b: "2" });
    });

    /** Arrays are joined in file order. */
    it("should join arrays across files, in order", async () => {
        project.write("sous.config.json", JSON.stringify({ compilation: { targets: [{ entryPoint: "a.md", outputs: [] }] } }));
        project.write("conf.d/50-second-target.json", JSON.stringify({ compilation: { targets: [{ entryPoint: "b.md", outputs: [] }] } }));

        expect((await build()).compilation.targets.map((t: { entryPoint: string }) => t.entryPoint)).toEqual(["a.md", "b.md"]);
    });

    /** Every format sous reads works in conf.d. */
    it("should read YAML, JSONC and module files in conf.d", async () => {
        project.write("sous.config.json", JSON.stringify({ name: "json-primary" }));
        project.write("conf.d/50-extra.yaml", "name: yaml-layer\n_vars:\n  fromYaml: yes-it-works\n");
        project.write("conf.d/60-c.jsonc", '{ "_vars": { "fromJsonc": "1", }, } // trailing\n');
        project.write("conf.d/70-m.mjs", "export function configure(config) { config.atPath('_vars.fromModule').set('2'); }\n");

        const value = await build();

        expect(value.name).toBe("yaml-layer");
        expect(value._vars).toEqual({ fromYaml: "yes-it-works", fromJsonc: "1", fromModule: "2" });
    });

    /** Files that are not config, and folders, are skipped. */
    it("should ignore nested and non-config files in conf.d", async () => {
        project.write("conf.d/README.md", "# notes");
        project.write("conf.d/nested/10-x.json", JSON.stringify({ name: "nested" }));
        project.write("conf.d/.hidden.json", JSON.stringify({ name: "hidden" }));
        project.write("conf.d/20-real.json", JSON.stringify({ name: "real" }));

        const { engine } = makeEngine(project.info());
        const config = await engine.buildConfig();

        expect(config.get("name")).toBe("real");
        expect(engine.handle.config.services.get("confd.files").list().map((file) => file.name)).toEqual(["20-real.json"]);
    });

    /** A missing conf.d has no files. */
    it("should treat a missing conf.d as no files", async () => {
        project.write("sous.config.json", JSON.stringify({ name: "only" }));

        const { engine } = makeEngine(project.info());
        const config = await engine.buildConfig();

        expect(config.get("name")).toBe("only");
        expect(config.services.get("confd.files").list()).toEqual([]);
        expect(config.services.get("confd.files").directory()).toBe(project.confDir);
    });

    /** Each file is its own contributor, named after it, in file order. */
    it("should add one contributor per file, named after it", async () => {
        project.write("sous.config.json", "{}");
        project.write("conf.d/500-repos.jsonc", "{}");
        project.write("conf.d/610-mac.jsonc", "{}");

        const { engine } = makeEngine(project.info());
        const config = await engine.buildConfig();
        const ids = config.contributions().map((c) => c.contributor);

        expect(ids).toContain("confd/500-repos.jsonc");
        expect(ids.indexOf("config-files.main")).toBeLessThan(ids.indexOf("confd/500-repos.jsonc"));
        expect(ids.indexOf("confd/500-repos.jsonc")).toBeLessThan(ids.indexOf("confd/610-mac.jsonc"));
        expect(config.services.get("confd.files").list()).toEqual([
            { name: "500-repos.jsonc", path: path.join(project.confDir, "500-repos.jsonc"), format: "jsonc", contributor: "confd/500-repos.jsonc", managed: true },
            { name: "610-mac.jsonc", path: path.join(project.confDir, "610-mac.jsonc"), format: "jsonc", contributor: "confd/610-mac.jsonc", managed: false },
        ]);
    });

    /** The layers view names each file's contributor. */
    it("should name the file that set each value", async () => {
        project.write("sous.config.json", JSON.stringify({ name: "a" }));
        project.write("conf.d/50-b.json", JSON.stringify({ name: "b" }));

        const { engine } = makeEngine(project.info());
        const config = await engine.buildConfig();

        expect(config.layers("name").map((layer) => layer.contributor)).toEqual(["config-files.main", "confd/50-b.json"]);
    });
});

describe("conf.d problems", () => {
    /** A broken file is an error naming it. */
    it("should reject a broken file, naming it", async () => {
        project.write("sous.config.json", JSON.stringify({ name: "ok" }));
        project.write("conf.d/50-broken.json", "{ this is not: valid json ]");

        await expect(build()).rejects.toThrow(/conf\.d\/50-broken\.json/);
    });

    /** The removed multi-project schema is an error naming the file. */
    it("should reject the removed multi-project schema, naming the file", async () => {
        project.write("sous.config.json", JSON.stringify({ name: "ok" }));
        project.write("conf.d/50-legacy.json", JSON.stringify({ projects: { foo: {} }, defaultProject: "foo" }));

        await expect(build()).rejects.toThrow(/50-legacy\.json/);
    });

    /**
     * Validation checks the merged result, not each fragment: a fragment that is incomplete on its
     * own is fine, and an unknown key added by a fragment fails, naming the file that set it.
     */
    it("should validate the merged result, not individual fragments", async () => {
        project.write("sous.config.json", JSON.stringify({ name: "ok", compilation: { targets: [{ entryPoint: "a.md", outputs: [] }] } }));
        project.write("conf.d/10-frag.json", JSON.stringify({ compilation: { includeSourceComments: true } }));

        const value = await build();

        expect(value.compilation.includeSourceComments).toBe(true);
        expect(value.compilation.targets).toHaveLength(1);

        project.write("conf.d/20-typo.json", JSON.stringify({ compilaton: {} }));

        const error = (await build().catch((caught: unknown) => caught)) as { details: string[] };

        expect(error.details.join("\n")).toMatch(/compilaton: Not a known config key.*20-typo/);
    });

    /**
     * Two files that differ only in their extension would merge in an order that depends on it,
     * so the build stops and names both, as the old loader did.
     */
    it("should refuse files that differ only in their extension, naming both", async () => {
        project.write("conf.d/500-repos.json", JSON.stringify({ _vars: { a: "json" } }));
        project.write("conf.d/500-repos.jsonc", JSON.stringify({ _vars: { b: "jsonc" } }));

        const { engine } = makeEngine(project.info());
        const error = (await engine.buildConfig().catch((caught: unknown) => caught)) as { message: string; details: string[] };

        expect(error.message).toMatch(/Duplicate config layer baseName '500-repos'/);
        expect(error.details.join("\n")).toMatch(/500-repos\.json[\s\S]*500-repos\.jsonc/);
    });
});

describe("conf.d files changing between builds", () => {
    /** A file added after the plugin loaded joins the next build. */
    it("should pick up conf.d files added after the first build", async () => {
        project.write("sous.config.json", JSON.stringify({ name: "main" }));

        const { engine } = makeEngine(project.info());

        expect((await engine.buildConfig()).get("name")).toBe("main");

        project.write("conf.d/50-new.json", JSON.stringify({ name: "added" }));

        expect((await engine.buildConfig()).get("name")).toBe("added");
    });

    /** A file removed contributes nothing on the next build. */
    it("should drop conf.d files removed after the first build", async () => {
        project.write("sous.config.json", JSON.stringify({ name: "main" }));
        const file = project.write("conf.d/50-gone.json", JSON.stringify({ name: "gone" }));

        const { engine } = makeEngine(project.info());

        expect((await engine.buildConfig()).get("name")).toBe("gone");

        fs.rmSync(file);

        expect((await engine.buildConfig()).get("name")).toBe("main");
    });

    /** A file changed on disk is read again on the next build (each file is read once per build). */
    it("should read a changed file again on the next build", async () => {
        const file = project.write("conf.d/50-x.json", JSON.stringify({ name: "one" }));

        const { engine } = makeEngine(project.info());

        expect((await engine.buildConfig()).get("name")).toBe("one");

        fs.writeFileSync(file, JSON.stringify({ name: "two" }));

        expect((await engine.buildConfig()).get("name")).toBe("two");
    });
});

describe("the user's files land on top", () => {
    /** A plugin's value gives way to a conf.d file, even when the plugin sorts after it. */
    it("should let a conf.d file win over a plugin's value", async () => {
        project.write("conf.d/610-mine.json", JSON.stringify({ compilation: { includeSourceComments: false } }));

        const acme = definePlugin({
            name: "sous-plugin-acme",
            register(sous) {
                sous.config.contribute({ id: "zzz-acme", contribute: (config) => config.atPath("compilation.includeSourceComments").setValue(true) });
            },
        });

        expect((await build({ extra: [acme] })).compilation.includeSourceComments).toBe(false);
    });

    /**
     * A subscription switched off on one machine. The managed file keeps every field; the
     * user's file only adds `enabled: false`, and only where its condition holds.
     */
    it("should switch a subscription off on one machine, keeping its fields", async () => {
        project.write(
            "conf.d/510-subscriptions.jsonc",
            JSON.stringify({ subscriptions: { "tool-usage/browser": { range: "^2.1.0", alwaysPull: true } } }),
        );
        project.write(
            "conf.d/610-mac.jsonc",
            JSON.stringify({
                subscriptions: { "tool-usage/browser": { enabled: { $if: { expr: "platform == 'darwin'", then: false } } } },
            }),
        );

        project.write("sous.config.json", JSON.stringify({ _vars: { platform: "darwin" } }));
        expect((await build()).subscriptions).toEqual({ "tool-usage/browser": { range: "^2.1.0", alwaysPull: true, enabled: false } });

        project.write("sous.config.json", JSON.stringify({ _vars: { platform: "linux" } }));
        expect((await build()).subscriptions).toEqual({ "tool-usage/browser": { range: "^2.1.0", alwaysPull: true } });
    });

    /**
     * The config-building spec's example: a variable set in a later file. 610 reads machineRole
     * as "laptop" in pass 1; 700 then sets "ci"; 610 re-runs and sees "ci". Patches apply in the
     * sorted order and a re-run never moves one, so sous.config.* stays under 700 and the build
     * settles.
     */
    it("should re-run a file when a variable it read changes in a later file", async () => {
        project.write("sous.config.json", JSON.stringify({ _vars: { machineRole: "laptop" } }));
        project.write("conf.d/610-browser.json", JSON.stringify({ name: { $if: { expr: "machineRole == 'laptop'", then: "browser-on", else: "browser-off" } } }));
        project.write("conf.d/700-ci.json", JSON.stringify({ _vars: { machineRole: "ci" } }));

        const { engine } = makeEngine(project.info());
        const config = await engine.buildConfig();

        expect(config.get("name")).toBe("browser-off");
        expect(config.passes).toBeGreaterThan(1);
    });
});

describe("patch files in conf.d", () => {
    /** One patch, several under `$patches`, and one per line. */
    it("should apply .patch.json and .patch.jsonl files in file order", async () => {
        project.write("sous.config.json", JSON.stringify({ compilation: { overwriteUntracked: true, targets: [{ id: "second" }] }, tools: { codex: {}, claude: {} } }));
        project.write(
            "conf.d/720-my-special-thing.patch.json",
            JSON.stringify({
                $patches: [
                    { op: "setKey", path: "compilation", key: "overwriteUntracked", value: false },
                    { op: "deleteKey", path: "tools", key: "codex" },
                ],
            }),
        );
        project.write(
            "conf.d/721-my-list-of-things.patch.jsonl",
            '{"op": "insertAt", "path": "compilation.targets", "index": 0, "value": {"id": "first"}}\n{"op": "setKey", "path": "_vars", "key": "machineRole", "value": "laptop"}\n',
        );
        project.write("conf.d/722-one-thing.patch.json", JSON.stringify({ op: "setKey", path: "", key: "name", value: "patched" }));

        const value = await build();

        expect(value.compilation).toEqual({ overwriteUntracked: false, targets: [{ id: "first" }, { id: "second" }] });
        expect(value.tools).toEqual({ claude: {} });
        expect(value._vars).toEqual({ machineRole: "laptop" });
        expect(value.name).toBe("patched");
    });

    /** A patch file's value stays on top when a plugin changes the key later. */
    it("should keep a patch file on top of a plugin that sorts after it", async () => {
        project.write("conf.d/722-one-thing.patch.json", JSON.stringify({ op: "setKey", path: "", key: "name", value: "patched" }));

        const late = definePlugin({
            name: "late",
            register(sous) {
                sous.config.contribute({ id: "zzz", contribute: (config) => config.atPath("name").set("plugin") });
            },
        });

        expect((await build({ extra: [late] })).name).toBe("patched");
    });

    /** A broken patch file is an error naming it. */
    it("should name a broken patch file", async () => {
        project.write("conf.d/723-bad.patch.jsonl", '{"op": "setKey", "path": "", "key": "a", "value": 1}\nnot json\n');

        await expect(build()).rejects.toThrow(/Line 2 of conf\.d\/723-bad\.patch\.jsonl/);
    });
});

describe("confd.managed through the engine", () => {
    /** An intent edits a managed file; the next build reads it like any conf.d file. */
    it("should edit a managed file that the next build reads", async () => {
        project.write("sous.config.json", JSON.stringify({ name: "main" }));

        const { engine } = makeEngine(project.info());
        const first = await engine.buildConfig();
        const result = await first.services.get("confd.managed").set("510-subscriptions.jsonc", 'subscriptions."workflow/x".enabled', false);

        expect(result).toMatchObject({ created: true, changed: true, file: path.join(project.confDir, "510-subscriptions.jsonc") });
        expect((await engine.buildConfig()).get("subscriptions")).toEqual({ "workflow/x": { enabled: false } });
    });
});
