/**
 * The npm plugins a recipe requires, on a real engine: the
 * recipe is put in the store, its manifest's `requires` read, and an unmet requirement refused or
 * installed through `plugins.install` (`--install-plugins`, or a yes at the prompt).
 */

import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { definePlugin, jsonSchema, scriptedPrompter, type Context } from "@sous-io/plugin-api";
import type { PluginsInstallInput } from "@sous-io/plugin-update/types";
import { cleanTemp, fakeHost, fakeUrl, hashOf, indexFile, startEngine, tempDir, writeRecipe, type FakeRepo } from "../part-b/helpers.js";
import { ensureRequiredPlugins, unmetRequirements, type RequirementFlags } from "../../src/part-a/required-plugins.js";
import type { ResolvedRecipe } from "../../src/types.js";

const URL = fakeUrl("acme", "recipes");
const IDENTITY = "fake.test/acme/recipes";

let home: string;
let root: string;
let repo: FakeRepo;
let resolved: ResolvedRecipe;
let installs: PluginsInstallInput[];

beforeEach(() => {
    home = tempDir();
    root = tempDir();
    installs = [];

    const source = writeRecipe(path.join(tempDir(), "alpha"), { namespace: "workflow", name: "alpha", version: "1.0.0", requires: { plugins: { "sous-plugin-extra": "^1.2.0" } } });
    const hash = hashOf(source);

    repo = { url: URL, index: indexFile("acme", { "workflow/alpha": { versions: { "1.0.0": { hash } } } }), trees: { "recipes/workflow/alpha@workflow/alpha@1.0.0": source } };
    resolved = {
        key: "workflow/alpha",
        namespace: "workflow",
        name: "alpha",
        repo: "acme",
        identity: IDENTITY,
        version: "1.0.0",
        hash,
        tag: "workflow/alpha@1.0.0",
        path: "recipes/workflow/alpha",
        kind: "subscribes",
        requestedBy: ["project"],
        ranges: [],
        prerelease: false,
    };
});

afterEach(() => cleanTemp());

/** An engine with a test intent that runs the check, and a stand-in `plugins.install`. */
async function engineWith(extraPlugins: Array<{ name: string; version: string }> = []) {
    const harness = definePlugin({
        name: "test-requirements",
        register(sous) {
            sous.intents.add({
                intent: "test.requirements",
                summary: "Runs the requirement check",
                input: jsonSchema({ type: "object", additionalProperties: true }),
                handle: (input: unknown, ctx: Context) => ensureRequiredPlugins(ctx, [resolved], input as RequirementFlags, "workflow/alpha"),
            } as never);
            sous.intents.add({
                intent: "plugins.install",
                summary: "Stand-in for plugin-update",
                input: jsonSchema({ type: "object", additionalProperties: true }),
                handle: async (input: unknown) => {
                    installs.push(input as PluginsInstallInput);

                    return { manager: "npm", command: { command: "npm", args: ["install"] }, installed: [], declined: false, dryRun: false };
                },
            } as never);
        },
    });
    const extras = extraPlugins.map((plugin) => definePlugin({ name: plugin.name, version: plugin.version, register() {} }));

    return startEngine({
        root,
        home,
        data: () => ({ repos: { acme: { url: URL }, "sous-recipes": { enabled: false } } }),
        hosts: [fakeHost([repo])],
        plugins: [harness, ...extras],
    });
}

describe("ensureRequiredPlugins()", () => {
    it("should refuse a recipe whose required plugin is not installed, naming it and --install-plugins", async () => {
        const { engine } = await engineWith();

        await expect(engine.handle.submit({ intent: "test.requirements" as never, input: {} as never })).rejects.toThrow(
            /'workflow\/alpha' requires the plugin sous-plugin-extra \^1\.2\.0, which is not installed/,
        );
        expect(installs).toEqual([]);
    });

    it("should install the plugin through plugins.install with --install-plugins", async () => {
        const { engine } = await engineWith();
        const result = (await engine.handle.submit({ intent: "test.requirements" as never, input: { installPlugins: true } as never })) as { intent: string };

        expect(installs).toEqual([{ plugins: ["sous-plugin-extra@^1.2.0"], yes: true }]);
        expect(result.intent).toBe("plugins.install");
    });

    it("should offer to install when run interactively", async () => {
        const { engine } = await engineWith();
        const prompter = scriptedPrompter([true]);

        await engine.handle.submit({ intent: "test.requirements" as never, input: {} as never }, { prompter });

        expect(prompter.asked).toEqual(["Install sous-plugin-extra@^1.2.0 now?"]);
        expect(installs).toHaveLength(1);
    });

    it("should do nothing when the plugin is loaded in range", async () => {
        const { engine } = await engineWith([{ name: "sous-plugin-extra", version: "1.4.0" }]);

        expect(await engine.handle.submit({ intent: "test.requirements" as never, input: {} as never })).toBeUndefined();
        expect(installs).toEqual([]);
    });
});

describe("unmetRequirements()", () => {
    it("should report a plugin outside its range with the version loaded", () => {
        expect(unmetRequirements([{ recipe: "a/b", plugins: { x: "^2.0.0" } }], [{ name: "x", version: "1.0.0" }])).toEqual([{ recipe: "a/b", plugin: "x", range: "^2.0.0", installed: "1.0.0" }]);
    });
});
