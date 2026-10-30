import { describe, expect, it } from "vitest";
import { type BuiltConfig, ConfigError, jsonSchema, SousError } from "@sous-io/plugin-api";
import { keysPlugin, makeEngine, plugin } from "./helpers.js";

/** A plugin whose `value` key comes from a variable the test changes between builds. */
function sourcePlugin(source: { value: string }) {
    return plugin("source", (sous) => {
        sous.entities.add("config-key", { id: "value", schema: jsonSchema({}) });
        sous.config.contribute({ id: "source", contribute: (config) => config.atPath("value").set(source.value) });
    });
}

describe("ctx.refreshConfig()", () => {
    /**
     * A series chain rebuilds the config mid-chain: later ctx.run calls, ctx.config and the
     * config-lifetime services see the new one; the config it started with is left as it was.
     */
    it("should rebuild the config for the rest of a series chain", async () => {
        const source = { value: "old" };
        let made = 0;
        const { engine } = makeEngine([
            sourcePlugin(source),
            plugin("p", (sous) => {
                sous.services.add("p.reader", (config) => ({ value: config.get("value"), number: ++made }));
                sous.intents.add({
                    intent: "p.read",
                    handle: (_input, ctx) => ({ config: ctx.config.get("value"), service: ctx.services.get("p.reader" as never) as { value: unknown } }),
                });
                sous.intents.add({
                    intent: "p.change",
                    changesConfig: true,
                    async handle(_input, ctx) {
                        const before = await ctx.run("p.read" as never);

                        source.value = "new";

                        const refreshed = await ctx.refreshConfig();
                        const after = await ctx.run("p.read" as never);

                        return { before, after, refreshed: refreshed.get("value"), ctxConfig: ctx.config.get("value") };
                    },
                });
            }),
        ]);

        const first = await engine.buildConfig();
        const result = (await engine.submit({ intent: "p.change" })) as Record<string, { config: unknown; service: { value: unknown } } | unknown>;

        expect(result).toEqual({
            before: { config: "old", service: { value: "old", number: 1 } },
            after: { config: "new", service: { value: "new", number: 2 } },
            refreshed: "new",
            ctxConfig: "new",
        });
        expect(first.get("value")).toBe("old");
        expect(engine.config.get("value")).toBe("new");
    });

    /** A refresh resets the chain's "changed the config" mark, so no second rebuild follows it. */
    it("should not rebuild again after the chain when nothing changed since the refresh", async () => {
        let builds = 0;
        const { engine } = makeEngine([
            keysPlugin(),
            plugin("p", (sous) => {
                sous.config.contribute({ id: "count", contribute: () => void (builds += 1) });
                sous.intents.add({ intent: "p.change", changesConfig: true, handle: async (_input, ctx) => void (await ctx.refreshConfig()) });
                sous.intents.add({ intent: "p.noop", handle: () => "ok" });
            }),
        ]);

        await engine.buildConfig();
        await engine.submit({ intent: "p.change" });
        await engine.submit({ intent: "p.noop" });

        expect(builds).toBe(2);
    });

    /** Only a series chain may refresh: a parallel chain gets a SousError. */
    it("should refuse a refresh in a parallel chain", async () => {
        const { engine } = makeEngine([
            plugin("p", (sous) => {
                sous.intents.add({ intent: "p.parallel", parallel: true, handle: (_input, ctx) => ctx.refreshConfig() });
            }),
        ]);

        await engine.buildConfig();

        await expect(engine.submit({ intent: "p.parallel" })).rejects.toThrow(/parallel chain/);
    });

    /** A config.built listener cannot refresh: it is part of a build already. */
    it("should refuse a refresh from a config.built listener's chain", async () => {
        const { engine } = makeEngine([
            plugin("p", (sous) => {
                sous.intents.add({ intent: "p.refresh", handle: (_input, ctx) => ctx.refreshConfig() });
                sous.on("config.built", (_event, ctx) => ctx.run("p.refresh" as never));
            }),
        ]);

        await expect(engine.buildConfig()).rejects.toThrow(SousError);
    });
});

describe("ctx.cwd", () => {
    /** Handlers, listeners and the intents they run see the front end's directory; services the engine's. */
    it("should give handlers the front end's directory and services the engine's", async () => {
        const seen: Record<string, string> = {};
        const { engine } = makeEngine(
            [
                plugin("p", (sous) => {
                    sous.services.add("p.where", (_config, ctx) => ctx.cwd);
                    sous.intents.add({ intent: "p.inner", handle: (_input, ctx) => void (seen.inner = ctx.cwd) });
                    sous.intents.add({
                        intent: "p.outer",
                        async handle(_input, ctx) {
                            seen.outer = ctx.cwd;
                            seen.service = ctx.services.get("p.where" as never);
                            await ctx.run("p.inner" as never);
                        },
                    });
                    sous.on("p.outer.before", (_event, ctx) => void (seen.listener = ctx.cwd));
                }),
            ],
            { cwd: "/engine" },
        );

        await engine.buildConfig();
        await engine.submit({ intent: "p.outer" }, { cwd: "/front-end" });

        expect(seen).toEqual({ listener: "/front-end", outer: "/front-end", inner: "/front-end", service: "/engine" });

        await engine.submit({ intent: "p.inner" });
        expect(seen.inner).toBe("/engine");
    });
});

describe("intents that tolerate config errors", () => {
    function brokenEngine() {
        const state = { broken: true };
        const { engine, reporter } = makeEngine([
            keysPlugin("value"),
            plugin("p", (sous) => {
                sous.config.contribute({ id: "a-value", contribute: (config) => config.atPath("value").set("partial") });
                sous.config.contribute({
                    id: "b-broken",
                    contribute() {
                        if (state.broken) {
                            throw new ConfigError("The file is broken.");
                        }
                    },
                });
                sous.intents.add({
                    intent: "p.update",
                    toleratesConfigErrors: true,
                    changesConfig: true,
                    handle: (_input, ctx) => {
                        state.broken = false;

                        return ctx.config.get("value") ?? "none";
                    },
                });
                sous.intents.add({ intent: "p.build", handle: () => "built" });
                sous.intents.add({ intent: "p.touch", changesConfig: true, handle: () => "touched" });
            }),
        ]);

        return { engine, reporter, state };
    }

    /**
     * When the build fails, a tolerant intent still runs, with the partial config and the error as
     * a warning; other intents fail with the build's error; a later good build clears it.
     */
    it("should run a tolerant intent with the partial config when the build fails", async () => {
        const { engine, reporter } = brokenEngine();

        await expect(engine.buildConfig()).rejects.toThrow("The file is broken.");
        expect(engine.configError).toBeInstanceOf(ConfigError);
        expect(engine.handle.configError).toBe(engine.configError);

        await expect(engine.submit({ intent: "p.build" })).rejects.toThrow("The file is broken.");
        await expect(engine.submit({ intent: "p.update" })).resolves.toBe("partial");
        expect(reporter.at("warning").join("\n")).toContain("The config could not be built, so p.update runs with what was built before the error: The file is broken.");

        // p.update changed the config, so it is rebuilt, now without the error.
        await expect(engine.submit({ intent: "p.build" })).resolves.toBe("built");
        expect(engine.configError).toBeUndefined();
    });

    /** A rebuild between chains that fails lets a waiting tolerant chain run anyway. */
    it("should run a tolerant chain when the rebuild before it fails", async () => {
        const { engine, state } = brokenEngine();

        state.broken = false;
        await engine.buildConfig();
        state.broken = true;
        await engine.submit({ intent: "p.touch" }); // the config must be rebuilt, which now fails

        await expect(engine.submit({ intent: "p.update" })).resolves.toBe("partial");
        await expect(engine.submit({ intent: "p.build" })).resolves.toBe("built");
    });
});

describe("plugin info and names", () => {
    /** PluginInfo carries each plugin's options from the current config (plugins show). */
    it("should give each plugin's options", async () => {
        const { engine } = makeEngine([
            plugin("p", (sous) => {
                sous.config.contribute({ id: "options", contribute: (config) => config.atPath(["plugins", "options", "p"]).set({ colour: "blue" }) });
            }),
        ]);

        await engine.buildConfig();

        expect(engine.pluginInfo().find((info) => info.name === "p")?.options).toEqual({ colour: "blue" });
    });

    /** A service another plugin declares implementable is not warned about. */
    it("should not warn about a name the owning plugin declares implementable", async () => {
        const compiler = plugin("@sous-io/plugin-compiler", (sous) => sous.services.add("compiler.state", () => ({})), {
            implementable: ["compiler.namespace-resolver"],
        });
        const recipes = plugin("@sous-io/plugin-recipes", (sous) => sous.services.add("compiler.namespace-resolver", () => ({})));
        const { engine, reporter } = makeEngine([compiler, recipes]);
        const built: BuiltConfig = await engine.buildConfig();

        expect(built.buildNumber).toBe(1);
        expect(reporter.at("warning")).toEqual([]);
    });
});

/** A project at `root`, as the CLI's project discovery would find it. */
function projectAt(root: string) {
    return { root, sousDir: `${root}/.sous`, configPath: `${root}/.sous/sous.config.js`, confDir: `${root}/.sous/conf.d` };
}

describe("intents that require a project", () => {
    const needsProject = plugin("p", (sous) => {
        sous.intents.add({ intent: "p.build", requiresProject: true, handle: () => "built" });
        sous.intents.add({ intent: "p.anywhere", handle: () => "ran" });
    });

    /**
     * Run outside a project, an intent with `requiresProject` fails with the old CLI's message
     * before its handler runs; one without it runs.
     *
     * engine.submit({ intent: "p.build" })   // no project -> ConfigError "No sous config found."
     */
    it("should fail outside a project with 'No sous config found.'", async () => {
        const { engine } = makeEngine([needsProject], { cwd: "/nowhere/here" });

        await engine.buildConfig();

        const failure = engine.submit({ intent: "p.build" });

        await expect(failure).rejects.toBeInstanceOf(ConfigError);
        await expect(failure).rejects.toThrow("No sous config found.");
        await expect(failure).rejects.toMatchObject({ details: expect.arrayContaining(["    /nowhere/here/.sous/", "  1. Set the project up: run 'sous init' in its root directory, or"]) });
        await expect(engine.submit({ intent: "p.anywhere" })).resolves.toBe("ran");
    });

    /** Inside a project, it runs as usual. */
    it("should run inside a project", async () => {
        const { engine } = makeEngine([needsProject], { project: projectAt("/work/app") });

        await engine.buildConfig();

        await expect(engine.submit({ intent: "p.build" })).resolves.toBe("built");
    });
});

describe("ctx.refreshConfig({ locateProjectFrom })", () => {
    /**
     * After an intent sets a project up, a refresh that locates it from that directory makes the
     * engine serve it: `engine.project`, `ctx.project` and intents that require a project.
     *
     * await ctx.refreshConfig({ locateProjectFrom: "/work/new" });   // the engine now serves /work/new
     */
    it("should take the project found there, using the locateProject option", async () => {
        const asked: string[] = [];
        const { engine } = makeEngine(
            [
                plugin("p", (sous) => {
                    sous.intents.add({ intent: "p.needs", requiresProject: true, handle: (_input, ctx) => ctx.project?.root });
                    sous.intents.add({
                        intent: "p.init",
                        async handle(_input, ctx) {
                            const before = ctx.project?.root;

                            await ctx.refreshConfig({ locateProjectFrom: "/work/new" });

                            return { before, after: ctx.project?.root, needs: await ctx.run("p.needs" as never) };
                        },
                    });
                }),
            ],
            {
                locateProject: (directory) => {
                    asked.push(directory);

                    return directory === "/work/new" ? projectAt("/work/new") : undefined;
                },
            },
        );

        await engine.buildConfig();

        await expect(engine.submit({ intent: "p.init" })).resolves.toEqual({ before: undefined, after: "/work/new", needs: "/work/new" });
        expect(asked).toEqual(["/work/new"]);
        expect(engine.project?.root).toBe("/work/new");
    });

    /** Where nothing is found, the engine keeps the project it had. */
    it("should keep the current project when none is found there", async () => {
        const { engine } = makeEngine(
            [
                plugin("p", (sous) => {
                    sous.intents.add({
                        intent: "p.init",
                        async handle(_input, ctx) {
                            await ctx.refreshConfig({ locateProjectFrom: "/empty" });

                            return ctx.project?.root;
                        },
                    });
                }),
            ],
            { project: projectAt("/work/app"), locateProject: () => undefined },
        );

        await engine.buildConfig();

        await expect(engine.submit({ intent: "p.init" })).resolves.toBe("/work/app");
    });
});

describe("config.built listeners", () => {
    /** An error a config.built listener throws fails the build; it is not swallowed. */
    it("should fail the build when a config.built listener throws", async () => {
        const { engine } = makeEngine([
            plugin("p", (sous) => {
                sous.on("config.built", () => {
                    throw new SousError("The listener failed.");
                });
            }),
        ]);

        await expect(engine.buildConfig()).rejects.toThrow("The listener failed.");
    });
});
