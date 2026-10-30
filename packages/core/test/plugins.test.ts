import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { definePlugin, PluginError } from "@sous-io/plugin-api";
import { contributorsPlugin, keysPlugin, makeEngine, plugin } from "./helpers.js";

/** A plugin module's source: it sets `loaded.<name>` to true, so tests see it ran. */
function pluginSource(name: string, extra = ""): string {
    return `export default {
    name: ${JSON.stringify(name)},
    version: "1.2.3",
    register(sous) {
        sous.config.contribute({ id: ${JSON.stringify(`${name}/contrib`)}, contribute: (config) => config.atPath(["loaded", ${JSON.stringify(name)}]).set(true) });
        ${extra}
    },
};
`;
}

let dir: string;

beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "sous-core-plugins-"));
    writeFileSync(path.join(dir, "relative.mjs"), pluginSource("relative-plugin"));
    writeFileSync(path.join(dir, "absolute.mjs"), pluginSource("absolute-plugin"));
    writeFileSync(path.join(dir, "url.mjs"), pluginSource("url-plugin"));
    writeFileSync(path.join(dir, "named.mjs"), `export const plugin = ${pluginSource("named-export").replace("export default ", "").replace(/;\n$/, "")};\n`);
    writeFileSync(path.join(dir, "broken.mjs"), "throw new Error('cannot start');\n");
    writeFileSync(path.join(dir, "not-a-plugin.mjs"), "export default { hello: 1 };\n");
    writeFileSync(path.join(dir, "located.mjs"), pluginSource("located-plugin"));

    const cjs = path.join(dir, "node_modules", "sous-plugin-cjsable");

    mkdirSync(cjs, { recursive: true });
    writeFileSync(path.join(cjs, "package.json"), JSON.stringify({ name: "sous-plugin-cjsable", type: "module", main: "index.js" }));
    writeFileSync(path.join(cjs, "index.js"), pluginSource("sous-plugin-cjsable"));

    const esm = path.join(dir, "node_modules", "@acme", "sous-plugin-esm");

    mkdirSync(path.join(esm, "dist"), { recursive: true });
    writeFileSync(
        path.join(esm, "package.json"),
        JSON.stringify({ name: "@acme/sous-plugin-esm", type: "module", exports: { ".": { import: "./dist/index.js" } } }),
    );
    writeFileSync(path.join(esm, "dist", "index.js"), pluginSource("@acme/sous-plugin-esm"));
});

afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

/** A built-in that lists plugins in plugins.load. */
function lister(...specifiers: string[]) {
    return contributorsPlugin("lister", [
        {
            id: "lister",
            contribute: (config) => {
                for (const specifier of specifiers) {
                    config.atPath("plugins.load").append(specifier);
                }
            },
        },
    ]);
}

describe("loading plugins by specifier", () => {
    /**
     * The plugins to load are the plugins.load config key; a specifier may be a relative path (from
     * the project), an absolute path, a file: URL, or a package name in node_modules, CommonJS-
     * resolvable or ES-module-only (S1, "Loading"; C47).
     */
    it("should load paths, file URLs and packages listed in plugins.load", async () => {
        const { engine } = makeEngine(
            [
                keysPlugin("loaded"),
                lister(
                    "./relative.mjs",
                    path.join(dir, "absolute.mjs"),
                    pathToFileURL(path.join(dir, "url.mjs")).href,
                    "./named.mjs",
                    "sous-plugin-cjsable",
                    "@acme/sous-plugin-esm",
                ),
            ],
            { cwd: dir },
        );

        const built = await engine.buildConfig();

        expect(built.get("loaded")).toEqual({
            "relative-plugin": true,
            "absolute-plugin": true,
            "url-plugin": true,
            "named-export": true,
            "sous-plugin-cjsable": true,
            "@acme/sous-plugin-esm": true,
        });
        expect(engine.pluginInfo().find((info) => info.name === "url-plugin")).toMatchObject({
            active: true,
            builtIn: false,
            loadedBy: "plugins.load",
            version: "1.2.3",
        });
    });

    /**
     * plugin-locator entities are asked first, in plugin order: one may answer with a path, a URL or a
     * definition, or pass with undefined.
     */
    it("should ask plugin-locator entities first (path, URL, definition, undefined)", async () => {
        const fromLocator = definePlugin({
            name: "defined-by-locator",
            register: (sous) => sous.config.contribute({ id: "d", contribute: (config) => config.atPath("loaded.def").set(true) }),
        });
        const locators = plugin("plugin-recipes", (sous) => {
            sous.entities.add("plugin-locator", { id: "pass", locate: () => undefined });
            sous.entities.add("plugin-locator", {
                id: "recipes",
                locate: async (specifier) =>
                    specifier === "recipe:path"
                        ? path.join(dir, "located.mjs")
                        : specifier === "recipe:url"
                          ? pathToFileURL(path.join(dir, "url.mjs"))
                          : specifier === "recipe:def"
                            ? fromLocator
                            : undefined,
            });
        });
        const { engine } = makeEngine([keysPlugin("loaded"), locators, lister("recipe:path", "recipe:url", "recipe:def")], { cwd: dir });

        const built = await engine.buildConfig();

        expect(built.get("loaded")).toEqual({ "located-plugin": true, "url-plugin": true, def: true });
    });

    /**
     * A specifier nothing can find is an error after the config settles, naming it; a module that
     * fails to import, or exports no plugin, is an error naming it.
     */
    it("should fail with a PluginError for missing, broken and non-plugin modules", async () => {
        await expect(makeEngine([lister("sous-plugin-nowhere")], { cwd: dir }).engine.buildConfig()).rejects.toThrow(
            'Could not find the plugin "sous-plugin-nowhere" listed in plugins.load.',
        );
        await expect(makeEngine([lister("./missing.mjs", "./also-missing.mjs")], { cwd: dir }).engine.buildConfig()).rejects.toThrow(
            'Could not find the plugins "./missing.mjs", "./also-missing.mjs"',
        );
        await expect(makeEngine([lister("./broken.mjs")], { cwd: dir }).engine.buildConfig()).rejects.toThrow(
            'The plugin "./broken.mjs" could not be loaded: cannot start',
        );
        await expect(makeEngine([lister("./not-a-plugin.mjs")], { cwd: dir }).engine.buildConfig()).rejects.toThrow(
            '"./not-a-plugin.mjs" does not export a sous plugin.',
        );
        await expect(
            makeEngine([lister("bare-thing")], {
                cwd: dir,
                importModule: () => Promise.reject(new Error("exploded")),
            }).engine.buildConfig(),
        ).rejects.toBeInstanceOf(PluginError);
    });

    /**
     * A bare specifier not under the project falls back to an import from sous's own install.
     */
    it("should fall back to importing a bare specifier from sous's own install", async () => {
        const fallback = contributorsPlugin("fallback-plugin", [{ id: "f", contribute: (config) => config.atPath("loaded.fallback").set(true) }]);
        const { engine } = makeEngine([keysPlugin("loaded"), lister("sous-plugin-bundled")], {
            cwd: dir,
            importModule: async (url) => {
                if (url === "sous-plugin-bundled") {
                    return { default: fallback };
                }

                return import(url);
            },
        });

        expect((await engine.buildConfig()).get("loaded.fallback")).toBe(true);
    });
});

describe("plugin lifecycle", () => {
    /**
     * A plugin removed from the list in a later stage stays in memory, but its patches are dropped;
     * listed again in a later build, it is active again without registering twice (S2, "Plugins load
     * inside the loop").
     */
    it("should drop a removed plugin's patches and re-activate it without registering again", async () => {
        let registered = 0;
        const removable = definePlugin({
            name: "removable",
            register(sous) {
                registered += 1;
                sous.config.contribute({ id: "removable", contribute: (config) => config.atPath("loaded.removable").set(true) });
            },
        });
        let remove = true;
        const { engine } = makeEngine(
            [
                keysPlugin("loaded"),
                lister("removable-spec"),
                contributorsPlugin("remover", [
                    {
                        id: "remover",
                        stage: 1,
                        contribute: (config) => {
                            if (remove) {
                                config.atPath("plugins.load").removeWhere((item) => item === "removable-spec");
                            }
                        },
                    },
                ]),
            ],
            { cwd: dir, importModule: async () => ({ default: removable }) },
        );

        const first = await engine.buildConfig();

        expect(first.get("loaded")).toBeUndefined();
        expect(engine.pluginInfo().find((info) => info.name === "removable")?.active).toBe(false);

        remove = false;

        const second = await engine.buildConfig();

        expect(second.get("loaded")).toEqual({ removable: true });
        expect(registered).toBe(1);
    });

    /**
     * plugins.disabled keeps a plugin from loading, built-ins included, by name or by specifier (C47).
     */
    it("should never load a disabled plugin, built-ins included (C47)", async () => {
        const builtIn = contributorsPlugin("sous-plugin-old-thing", [{ id: "old", contribute: (config) => config.atPath("loaded.old").set(true) }]);
        const { engine } = makeEngine(
            [
                keysPlugin("loaded"),
                builtIn,
                lister("./relative.mjs"),
                contributorsPlugin("disabler", [
                    {
                        id: "disabler",
                        contribute: (config) => config.atPath("plugins.disabled").set(["sous-plugin-old-thing", "./relative.mjs"]),
                    },
                ]),
            ],
            { cwd: dir },
        );

        const built = await engine.buildConfig();

        expect(built.get("loaded")).toBeUndefined();
        expect(engine.pluginInfo().map((info) => info.name)).not.toContain("relative-plugin");
    });

    /**
     * A plugin may bring in other plugins as its own dependencies (sous.plugins.add); they are active
     * while it is, users can disable them by name, and the ledger records who loaded them (C5).
     */
    it("should load a plugin's own dependencies with sous.plugins.add (C5)", async () => {
        const child = contributorsPlugin("sous-plugin-mcp-extras", [{ id: "extras", contribute: (config) => config.atPath("loaded.extras").set(true) }]);
        const parent = plugin("plugin-claude-code", async (sous) => {
            await sous.plugins.add(child);
            await sous.plugins.add(child);
        });

        const { engine } = makeEngine([keysPlugin("loaded"), parent]);
        const built = await engine.buildConfig();

        expect(built.get("loaded.extras")).toBe(true);
        expect(engine.pluginInfo().find((info) => info.name === "sous-plugin-mcp-extras")).toMatchObject({
            loadedBy: "plugin-claude-code",
            builtIn: true,
        });

        const disabled = makeEngine([
            keysPlugin("loaded"),
            parent,
            contributorsPlugin("d", [{ id: "d", contribute: (config) => config.atPath("plugins.disabled").append("sous-plugin-mcp-extras") }]),
        ]);

        expect((await disabled.engine.buildConfig()).get("loaded")).toBeUndefined();
    });

    /**
     * dependsOn: sous stops before any intent runs when a needed plugin is missing, outside its range,
     * or has no version; "*" accepts any (C38).
     */
    it("should check dependsOn ranges at the end of the build (C38)", async () => {
        const skills = definePlugin({ name: "@sous-io/plugin-skills", version: "1.4.0", register() {} });
        const unversioned = definePlugin({ name: "unversioned", register() {} });
        const needs = (range: Record<string, string>) => definePlugin({ name: "sous-plugin-diagrams", dependsOn: range, register() {} });

        await expect(makeEngine([skills, needs({ "@sous-io/plugin-skills": "^1.0.0" })]).engine.buildConfig()).resolves.toBeDefined();
        await expect(makeEngine([unversioned, needs({ unversioned: "*" })]).engine.buildConfig()).resolves.toBeDefined();
        await expect(makeEngine([needs({ "@sous-io/plugin-skills": "^1.0.0" })]).engine.buildConfig()).rejects.toThrow(
            "sous-plugin-diagrams needs @sous-io/plugin-skills ^1.0.0, which is not loaded.",
        );
        await expect(makeEngine([skills, needs({ "@sous-io/plugin-skills": "^2.0.0" })]).engine.buildConfig()).rejects.toThrow(
            "sous-plugin-diagrams needs @sous-io/plugin-skills ^2.0.0, but @sous-io/plugin-skills 1.4.0 is loaded.",
        );
        await expect(makeEngine([unversioned, needs({ unversioned: "^1.0.0" })]).engine.buildConfig()).rejects.toThrow(
            "declares no version",
        );

        const both = await makeEngine([needs({ a: "1", b: "2" })]).engine.buildConfig().catch((error: PluginError) => error);

        expect(both).toBeInstanceOf(PluginError);
        expect((both as PluginError).details).toEqual([
            "sous-plugin-diagrams needs a 1, which is not loaded.",
            "sous-plugin-diagrams needs b 2, which is not loaded.",
        ]);
    });

    /**
     * A register() that throws is a PluginError naming the plugin; a definition without a name or
     * register is refused.
     */
    it("should report a failing or malformed plugin", async () => {
        await expect(
            makeEngine([
                plugin("sous-plugin-crash", () => {
                    throw new Error("nope");
                }),
            ]).engine.buildConfig(),
        ).rejects.toThrow("The plugin sous-plugin-crash failed to register: nope");
        await expect(makeEngine([{ name: "x" } as never]).engine.buildConfig()).rejects.toThrow(
            "A built-in plugin is not a sous plugin",
        );
    });

    /**
     * Two modules with one plugin name: the first is used, and sous warns once.
     */
    it("should warn when two modules share a plugin name", async () => {
        const one = definePlugin({ name: "twin", register() {} });
        const two = definePlugin({ name: "twin", register() {} });
        const { engine, reporter } = makeEngine([one, two]);

        await engine.buildConfig();

        expect(reporter.at("warning")).toContain("Two modules are named twin; the one loaded first is used.");
    });

    /**
     * A name starting with another plugin's prefix is allowed; sous warns once, naming both (S1,
     * "Names"; C35).
     */
    it("should warn once when a plugin registers under another plugin's prefix (C35)", async () => {
        const compiler = plugin("@sous-io/plugin-compiler", (sous) => {
            sous.services.add("compiler.state", () => ({}));
        });
        const extender = plugin("sous-plugin-diagrams", (sous) => {
            sous.services.add("compiler.diagram-renderer", () => ({}));
            sous.intents.add({ intent: "diagrams.render", handle: () => 0 });
            sous.intents.add({ intent: "build", handle: () => 0 });
        });
        const { engine, reporter } = makeEngine([compiler, extender]);

        await engine.buildConfig();
        await engine.buildConfig();

        expect(reporter.at("warning")).toEqual([
            'sous-plugin-diagrams registers the service "compiler.diagram-renderer", which starts with @sous-io/plugin-compiler\'s prefix "compiler".',
        ]);
    });

    /**
     * Every registration is recorded with its plugin, for plugins show (S1, "Visibility").
     */
    it("should record every registration in the ledger", async () => {
        const { engine } = makeEngine([
            plugin("p", (sous) => {
                sous.config.contribute({ id: "c", contribute() {} });
                sous.intents.add({ intent: "p.go", handle: () => 1 });
                sous.intents.wrap("p.go", (next) => next);
                sous.services.add("p.svc", () => 1, { lifetime: "singleton" });
                sous.services.replace("p.other", () => 2);
                sous.services.wrap("p.svc", (inner) => inner);
                sous.entities.define("thing", { "~standard": { version: 1, vendor: "t", validate: (value) => ({ value }) } });
                sous.entities.add("thing", { id: "one" });
                sous.on("p.go.before", () => {});
                sous.once("p.go.after", () => {});
                sous.frontEnds.add({ id: "web", start() {} });
            }),
        ]);

        await engine.buildConfig();

        expect(engine.pluginInfo()[0]!.registrations).toEqual([
            { kind: "contributor", name: "c" },
            { kind: "intent", name: "p.go" },
            { kind: "intent wrapper", name: "p.go" },
            { kind: "service", name: "p.svc" },
            { kind: "service replacement", name: "p.other" },
            { kind: "service wrapper", name: "p.svc" },
            { kind: "entity kind", name: "thing" },
            { kind: "entity", name: "thing: one" },
            { kind: "listener", name: "p.go.before" },
            { kind: "listener", name: "p.go.after" },
            { kind: "front end", name: "web" },
        ]);
    });

    /**
     * A plugin loaded partway through takes its sorted place among the contributors, not the end of
     * the list, and its patch applies in that place, so b-z-writer, declared after it,
     * stays on top without re-running.
     */
    it("should sort a newly loaded plugin's contributors into place", async () => {
        const order: string[] = [];
        const late = contributorsPlugin("late", [{ id: "b-late", contribute: (config) => void (order.push("b-late"), config.atPath("x").set(0)) }]);
        const { engine } = makeEngine(
            [
                keysPlugin("x"),
                contributorsPlugin("early", [
                    {
                        id: "a-loader",
                        contribute: (config) => {
                            order.push("a-loader");
                            config.atPath("plugins.load").append("late-spec");
                        },
                    },
                    {
                        id: "c-reader",
                        contribute: (config) => {
                            order.push("c-reader");
                            config.atPath("x").get();
                        },
                    },
                    { id: "b-z-writer", after: ["b-late"], contribute: (config) => void (order.push("b-z-writer"), config.atPath("x").set(1)) },
                ]),
            ],
            { cwd: dir, importModule: async () => ({ default: late }) },
        );

        const built = await engine.buildConfig();

        expect(order).toEqual(["a-loader", "b-z-writer", "c-reader", "b-late"]);
        expect(built.get("x")).toBe(1);
    });
});
