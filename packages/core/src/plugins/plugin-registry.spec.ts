import { describe, expect, it } from "vitest";
import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import { definitionFromModule, PluginRegistry } from "./plugin-registry.js";

const hooks = (definitions: Record<string, PluginDefinition>, registered: string[] = []) => ({
    resolve: async (specifier: string) => definitions[specifier]!,
    register: async (record: { name: string }) => void registered.push(record.name),
});

describe("PluginRegistry", () => {
    /**
     * A plugin loads and registers once, by definition or by specifier; asking again for its name or
     * specifier returns the loaded one, and two loads of one specifier at once share one import.
     */
    it("should load each plugin once, by definition or specifier", async () => {
        const registry = new PluginRegistry();
        const registered: string[] = [];
        const diagrams = definePlugin({ name: "sous-plugin-diagrams", version: "1.0.0", register() {} });
        const options = { builtIn: false, loadedBy: undefined };
        const [first, second] = await Promise.all([
            registry.load("./diagrams.mjs", options, hooks({ "./diagrams.mjs": diagrams }, registered)),
            registry.load("./diagrams.mjs", options, hooks({ "./diagrams.mjs": diagrams }, registered)),
        ]);

        expect(first).toBe(second);
        expect(await registry.load("sous-plugin-diagrams", options, hooks({}, registered))).toBe(first);
        expect(await registry.load(diagrams, options, hooks({}, registered))).toBe(first);
        expect(registered).toEqual(["sous-plugin-diagrams"]);
        expect(registry.bySpecifier("./diagrams.mjs")).toBe(first);
        expect(registry.bySpecifier("./other.mjs")).toBeUndefined();
        expect(registry.index("sous-plugin-diagrams")).toBe(0);
        expect(registry.index("@sous-io/core")).toBe(-1);
        expect(registry.index("unknown")).toBe(Number.MAX_SAFE_INTEGER);
    });

    /**
     * A second module with a name already loaded is ignored, with a warning naming where it came from;
     * its specifier then points at the loaded plugin.
     */
    it("should warn about a second module with a loaded name", async () => {
        const registry = new PluginRegistry();
        const one = definePlugin({ name: "twin", register() {} });
        const two = definePlugin({ name: "twin", register() {} });
        const options = { builtIn: false, loadedBy: undefined };

        await registry.load(one, options, hooks({}));
        await registry.load("./two.mjs", options, hooks({ "./two.mjs": two }));

        expect(registry.takeDuplicateWarnings()).toEqual(['Two modules are named twin (from "./two.mjs"); the one loaded first is used.']);
        expect(registry.takeDuplicateWarnings()).toEqual([]);
        expect(registry.bySpecifier("./two.mjs")?.definition).toBe(one);
        await expect(registry.load("./bad.mjs", options, hooks({ "./bad.mjs": { name: 3 } as never }))).rejects.toThrow(
            '"./bad.mjs" is not a sous plugin: it needs a name and a register function.',
        );
    });
});

describe("definitionFromModule()", () => {
    /**
     * A module's plugin is its default export, its `plugin` export, or the module itself.
     */
    it("should find the plugin in a module", () => {
        const definition = definePlugin({ name: "p", register() {} });

        expect(definitionFromModule({ default: definition }, "x")).toBe(definition);
        expect(definitionFromModule({ plugin: definition }, "x")).toBe(definition);
        expect(definitionFromModule(definition, "x")).toBe(definition);
        expect(() => definitionFromModule(null, "x")).toThrow('"x" does not export a sous plugin.');
    });
});
