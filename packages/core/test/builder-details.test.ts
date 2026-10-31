import { describe, expect, it } from "vitest";
import { ConfigError, jsonSchema } from "@sous-io/plugin-api";
import { contributorsPlugin, keysPlugin, makeEngine, plugin } from "./helpers.js";

const anything = { "~standard": { version: 1 as const, vendor: "t", validate: (value: unknown) => ({ value }) } };

describe("the builder, in detail", () => {
    /**
     * A contributor sees the entities it added itself in this run, over the view's, without that
     * being recorded as a read.
     */
    it("should show a contributor its own entities in the same run", async () => {
        const seen: unknown[] = [];
        const { engine } = makeEngine([
            plugin("p", (sous) => {
                sous.entities.define("thing", anything);
                sous.entities.add("thing", { id: "one", from: "register" } as never);
                sous.config.contribute({
                    id: "c",
                    contribute: (config) => {
                        config.addEntity("thing", { id: "one", from: "contributor" } as never);
                        config.addEntity("thing", { id: "two" });
                        seen.push(config.entities("thing"), config.entity("thing", "one"), config.entity("thing", "one"), config.entity("thing", "none"));
                    },
                });
            }),
        ]);

        await engine.buildConfig();

        expect(seen).toEqual([[{ id: "one", from: "contributor" }, { id: "two" }], { id: "one", from: "contributor" }, { id: "one", from: "contributor" }, undefined]);
    });

    /**
     * A narrow entity read re-runs its reader when that entity appears, or when another plugin's entry
     * replaces it.
     */
    it("should re-run a narrow reader when its own entity appears", async () => {
        let runs = 0;
        const { engine } = makeEngine([
            keysPlugin("found"),
            plugin("p", (sous) => {
                sous.entities.define("thing", anything);
                sous.config.contribute({
                    id: "1-reader",
                    contribute: (config) => {
                        runs += 1;
                        config.atPath("found").set(config.entity("thing", "late") !== undefined);
                    },
                });
                sous.config.contribute({ id: "2-adder", contribute: (config) => config.addEntity("thing", { id: "late" }) });
            }),
        ]);

        const built = await engine.buildConfig();

        expect(built.get("found")).toBe(true);
        expect(runs).toBe(2);
    });

    /**
     * A ConfigError a contributor throws on purpose passes through unchanged.
     */
    it("should pass a contributor's own ConfigError through", async () => {
        const { engine } = makeEngine([
            contributorsPlugin("p", [
                {
                    id: "c",
                    contribute() {
                        throw new ConfigError("Could not download workflow/x.");
                    },
                },
            ]),
        ]);

        await expect(engine.buildConfig()).rejects.toThrow(/^Could not download workflow\/x\.$/);
    });

    /**
     * A nested config key is restored even when its parent's own schema leaves nothing, or the parent
     * held a scalar.
     */
    it("should restore nested config keys under a missing or scalar parent value", async () => {
        const { engine } = makeEngine([
            plugin("p", (sous) => {
                sous.entities.add("config-key", { id: "tools", schema: jsonSchema({ anyOf: [{ type: "object" }, { type: "null" }] }) });
                sous.entities.add("config-key", { id: "tools.claude.settings", schema: jsonSchema({ type: "object" }) });
                sous.entities.add("config-key", { id: "outer", schema: jsonSchema({}) });
                sous.entities.add("config-key", { id: "outer.inner", schema: jsonSchema({ type: "number" }) });
                sous.config.contribute({
                    id: "c",
                    contribute: (config) => {
                        config.atPath("tools.claude.settings").set({ model: "opus" });
                        config.atPath("outer.inner").set(1);
                    },
                });
            }),
        ]);

        const built = await engine.buildConfig();

        expect(built.get("tools")).toEqual({ claude: { settings: { model: "opus" } } });
        expect(built.get("outer")).toEqual({ inner: 1 });
    });

    /**
     * A finished-stage contributor that read an entity list says so in its debug message; when no
     * contributor of the running stage wrote a key it read, the message says something changed.
     */
    it("should describe finished-stage entity reads and unknown writers", async () => {
        const { engine, reporter } = makeEngine(
            [
                keysPlugin("loaded"),
                plugin("p", (sous) => {
                    sous.entities.define("thing", anything);
                    sous.config.contribute({ id: "early-list", contribute: (config) => void config.entities("thing") });
                    sous.config.contribute({ id: "early-key", contribute: (config) => void config.atPath("plugins.load").get() });
                    sous.config.contribute({
                        id: "late",
                        stage: 2,
                        contribute: (config) => {
                            config.addEntity("thing", { id: "t" });
                            config.atPath("plugins.load").append("./plugin.mjs");
                        },
                    });
                }),
            ],
            { cwd: "/nonexistent", importModule: async () => ({ default: { name: "loaded-late", register() {} } }) },
        );

        await engine.buildConfig();

        expect(reporter.at("debug")).toEqual([
            "late, running in config stage 2, changed plugins.load, which would have made early-key re-run, but early-key is in stage 0, so it didn't.",
            "In config stage 2, something changed the thing list, which would have made early-list re-run, but early-list is in stage 0, so it didn't.",
        ]);
    });

    /**
     * A build where new plugins keep appearing never settles; the error says so.
     */
    it("should report plugins that keep appearing", async () => {
        let n = 0;
        const { engine } = makeEngine(
            [
                keysPlugin("latest"),
                contributorsPlugin("p", [
                    { id: "loader", contribute: (config) => config.atPath("plugins.load").append(`./p${String(config.atPath("latest").valueOr(0))}.mjs`) },
                ]),
            ],
            {
                cwd: "/nonexistent",
                importModule: async () => {
                    n += 1;

                    const k = n;

                    return {
                        default: {
                            name: `plugin-${k}`,
                            register: (sous: import("@sous-io/plugin-api").Sous) =>
                                sous.config.contribute({ id: `c${k}`, contribute: (config) => config.atPath("latest").set(k) }),
                        },
                    };
                },
            },
        );

        const error = (await engine.buildConfig().catch((caught: unknown) => caught)) as ConfigError;

        expect(error.message).toBe("The config did not settle in 10 passes of config stage 0.");
    });
});
