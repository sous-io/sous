/**
 * The `config.set` intent, through a real engine: one value written surgically, and the config
 * rebuilt after it.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configFilesPlugin } from "../src/index.js";
import { parseCliValue, resolveSetTarget } from "../src/set.js";
import { makeEngine, makeProject, type TestProject } from "./helpers.js";

let project: TestProject;

beforeEach(() => {
    project = makeProject();
});

afterEach(() => {
    project.cleanup();
});

async function engineFor() {
    const { engine } = makeEngine(project.info(), [configFilesPlugin]);

    await engine.buildConfig();

    return engine;
}

describe("config.set", () => {
    /**
     * Sets one value in sous.config.jsonc, keeping the comments, and rebuilds the config.
     *
     * sous config set compilation.includeSourceComments false
     */
    it("should set one value surgically and rebuild the config", async () => {
        const file = project.write("sous.config.jsonc", '// my config\n{\n    "name": "x", // the name\n    "compilation": {}\n}\n');
        const engine = await engineFor();

        const result = await engine.handle.submit({ intent: "config.set", input: { path: "compilation.includeSourceComments", value: "false" } });

        expect(result).toEqual({ file, path: "compilation.includeSourceComments", previous: undefined, value: false, changed: true, dryRun: false });

        const text = fs.readFileSync(file, "utf8");

        expect(text).toContain("// my config");
        expect(text).toContain("// the name");

        // The engine rebuilds the config before the next chain; build it now to look.
        expect((await engine.buildConfig()).get("compilation.includeSourceComments")).toBe(false);
    });

    /** A quoted key path reaches keys with dots and slashes in them. */
    it("should take a quoted key path and a conf.d file", async () => {
        project.write("sous.config.json", "{}");
        const engine = await engineFor();

        const result = await engine.handle.submit({
            intent: "config.set",
            input: { path: 'subscriptions."workflow/x".enabled', value: "false", file: "610-mac.jsonc" },
        });

        expect(result).toMatchObject({ file: path.join(project.confDir, "610-mac.jsonc"), changed: true });
        expect(JSON.parse(fs.readFileSync(path.join(project.confDir, "610-mac.jsonc"), "utf8"))).toEqual({
            subscriptions: { "workflow/x": { enabled: false } },
        });
    });

    /** --unset removes the key; removing a missing key changes nothing. */
    it("should remove a key with unset", async () => {
        const file = project.write("sous.config.json", '{ "name": "x", "version": 1 }\n');
        const engine = await engineFor();

        expect(await engine.handle.submit({ intent: "config.set", input: { path: "name", unset: true } })).toMatchObject({ previous: "x", value: undefined, changed: true });
        expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ version: 1 });
        expect(await engine.handle.submit({ intent: "config.set", input: { path: "name", unset: true } })).toMatchObject({ changed: false });
    });

    /** A dry run writes nothing. */
    it("should write nothing on a dry run", async () => {
        const file = project.write("sous.config.yaml", "name: x\n");
        const engine = await engineFor();

        const result = await engine.handle.submit({ intent: "config.set", input: { path: "name", value: "y", dryRun: true } });

        expect(result).toMatchObject({ previous: "x", value: "y", changed: true, dryRun: true });
        expect(fs.readFileSync(file, "utf8")).toBe("name: x\n");
    });

    /** A YAML file is edited as YAML. */
    it("should edit a YAML file", async () => {
        const file = project.write("sous.config.yaml", "# top\nname: x\n");
        const engine = await engineFor();

        await engine.handle.submit({ intent: "config.set", input: { path: "name", value: "y" } });

        expect(fs.readFileSync(file, "utf8")).toBe("# top\nname: y\n");
    });

    /** A project with no main config gets sous.config.jsonc. */
    it("should create sous.config.jsonc when there is no main config", async () => {
        const engine = await engineFor();

        const result = await engine.handle.submit({ intent: "config.set", input: { path: "name", value: "new" } });

        expect(result).toMatchObject({ file: path.join(project.sousDir, "sous.config.jsonc"), changed: true });
        expect((await engine.buildConfig()).get("name")).toBe("new");
    });

    /** A JavaScript main config cannot be edited; the error says to pass --file. */
    it("should refuse to edit a JavaScript config", async () => {
        project.write("sous.config.js", "export default {};");
        const engine = await engineFor();

        await expect(engine.handle.submit({ intent: "config.set", input: { path: "name", value: "y" } })).rejects.toMatchObject({
            details: [expect.stringMatching(/--file/)],
        });
    });

    /** A value or --unset is required, and the path must parse. */
    it("should reject a missing value and a bad path", async () => {
        project.write("sous.config.json", "{}");
        const engine = await engineFor();

        await expect(engine.handle.submit({ intent: "config.set", input: { path: "name" } })).rejects.toThrow(/not valid/);
        await expect(engine.handle.submit({ intent: "config.set", input: { path: "a..b", value: "1" } })).rejects.toThrow(/not valid/);
    });

    /** The CLI command is `config set <path> <value>`. */
    it("should declare its CLI command", async () => {
        const engine = await engineFor();
        const definition = engine.handle.intents.get("config.set")!.definition;

        expect(definition.cli).toMatchObject({ command: ["config", "set"], positional: ["path", "value"] });
        expect(definition.changesConfig).toBe(true);
    });
});

describe("parseCliValue() and resolveSetTarget()", () => {
    /** JSON when it is JSON, else text. */
    it("should read a value as JSON when it is valid JSON", () => {
        expect(parseCliValue("false")).toBe(false);
        expect(parseCliValue("12")).toBe(12);
        expect(parseCliValue('{"a": [1]}')).toEqual({ a: [1] });
        expect(parseCliValue("hello")).toBe("hello");
        expect(parseCliValue('"quoted"')).toBe("quoted");
    });

    /** Bare names are conf.d files or main config names; other paths are from the project root. */
    it("should find the file to write", () => {
        const info = project.info();

        expect(resolveSetTarget(info, undefined)).toBe(path.join(project.sousDir, "sous.config.jsonc"));
        expect(resolveSetTarget(info, "610-mac.jsonc")).toBe(path.join(project.confDir, "610-mac.jsonc"));
        expect(resolveSetTarget(info, "sous.config.yaml")).toBe(path.join(project.sousDir, "sous.config.yaml"));
        expect(resolveSetTarget(info, "configs/x.json")).toBe(path.join(project.root, "configs/x.json"));
        expect(resolveSetTarget(info, "/abs/x.json")).toBe("/abs/x.json");
    });
});
