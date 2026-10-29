import { describe, expect, it } from "vitest";
import { ConfigError, ConflictError, jsonSchema, NotFoundError, SousError } from "@sous-io/plugin-api";
import { contributorsPlugin, keysPlugin, makeEngine, plugin } from "./helpers.js";

describe("services", () => {
    /**
     * Three lifetimes: a singleton is shared by every build, a config service is made once per build,
     * a factory service on every get; each is made on first use (C29).
     */
    it("should honour the three lifetimes and create on first use (C29)", async () => {
        const made = { singleton: 0, config: 0, factory: 0 };
        const { engine } = makeEngine([
            plugin("p", (sous) => {
                sous.services.add("git.runner", () => ({ n: ++made.singleton }), { lifetime: "singleton" });
                sous.services.add("variables.resolver", () => ({ n: ++made.config }), { lifetime: "config" });
                sous.services.add("liquid.engine", () => ({ n: ++made.factory }), { lifetime: "factory" });
                sous.services.add("p.default", () => ({ n: 1 }));
            }),
        ]);
        const first = await engine.buildConfig();

        expect(made).toEqual({ singleton: 0, config: 0, factory: 0 });
        expect(first.services.get("git.runner")).toEqual({ n: 1 });
        expect(first.services.get("variables.resolver")).toEqual({ n: 1 });
        expect(first.services.get("variables.resolver")).toEqual({ n: 1 });
        expect(first.services.get("liquid.engine")).toEqual({ n: 1 });
        expect(first.services.get("liquid.engine")).toEqual({ n: 2 });

        const second = await engine.buildConfig();

        expect(second.services.get("git.runner")).toEqual({ n: 1 });
        expect(second.services.get("variables.resolver")).toEqual({ n: 2 });
        expect(first.services.get("variables.resolver")).toEqual({ n: 1 });
        expect(second.services.has("p.default")).toBe(true);
        expect(() => second.services.get("nope")).toThrow(NotFoundError);
    });

    /**
     * Wrappers stack in plugin order (C30); a replacement is used instead of the original (C31).
     */
    it("should stack wrappers in plugin order and use a replacement (C30, C31)", async () => {
        const { engine } = makeEngine([
            plugin("plugin-git", (sous) => sous.services.add("git.runner", () => ({ name: () => "git" }), { lifetime: "singleton" })),
            plugin("logger", (sous) => sous.services.wrap("git.runner", (inner) => ({ name: () => `log(${(inner as { name(): string }).name()})` }))),
            plugin("tracer", (sous) => sous.services.wrap("git.runner", (inner) => ({ name: () => `trace(${(inner as { name(): string }).name()})` }))),
            plugin("fast", (sous) => sous.services.replace("git.runner", () => ({ name: () => "fast-git" }), { lifetime: "singleton" })),
        ]);

        const built = await engine.buildConfig();

        expect((built.services.get("git.runner") as { name(): string }).name()).toBe("trace(log(fast-git))");
    });

    /**
     * Two plugins replacing one service stop the build with an error naming both; services.replace
     * picks one, and sous warns on every build that the other may not work (C49).
     */
    it("should refuse two replacements unless services.replace picks one (C49)", async () => {
        const original = plugin("plugin-git", (sous) => sous.services.add("git.runner", () => "git"));
        const fast = plugin("sous-plugin-fast-git", (sous) => sous.services.replace("git.runner", () => "fast"));
        const lfs = plugin("sous-plugin-git-lfs", (sous) => sous.services.replace("git.runner", () => "lfs"));
        const error = (await makeEngine([original, fast, lfs]).engine.buildConfig().catch((e) => e)) as ConflictError;

        expect(error).toBeInstanceOf(ConflictError);
        expect(error.message).toBe('Two plugins replace "git.runner": sous-plugin-fast-git and sous-plugin-git-lfs.');
        expect(error.details).toEqual(['Choose one in the config:  services.replace."git.runner": "sous-plugin-fast-git"']);

        const pick = contributorsPlugin("user", [
            { id: "pick", contribute: (config) => config.atPath(["services", "replace", "git.runner"]).set("sous-plugin-fast-git") },
        ]);
        const { engine, reporter } = makeEngine([original, fast, lfs, pick]);
        const built = await engine.buildConfig();

        await engine.buildConfig();

        expect(built.services.get("git.runner")).toBe("fast");
        expect(reporter.at("warning")).toEqual([
            'services.replace picks sous-plugin-fast-git for "git.runner". sous-plugin-git-lfs\'s replacement is ignored, and the plugin may not work as expected.',
            'services.replace picks sous-plugin-fast-git for "git.runner". sous-plugin-git-lfs\'s replacement is ignored, and the plugin may not work as expected.',
        ]);

        const twoAdds = makeEngine([
            plugin("a", (sous) => sous.services.add("x.svc", () => "a")),
            plugin("b", (sous) => sous.services.add("x.svc", () => "b")),
        ]);

        await expect(twoAdds.engine.buildConfig()).rejects.toThrow('Two plugins add "x.svc": a and b.');
    });

    /**
     * A contributor may use singleton services while the config is built, but not config or factory
     * ones; a register() may get a singleton before the first build.
     */
    it("should allow only singleton services while the config is built", async () => {
        const seen: unknown[] = [];
        const { engine } = makeEngine([
            keysPlugin("x"),
            plugin("p", (sous) => {
                sous.services.add("p.single", () => "single", { lifetime: "singleton" });
                sous.services.add("p.config", () => "config", { lifetime: "config" });
                sous.services.add("p.factory", () => "factory", { lifetime: "factory" });
                seen.push(sous.services.get("p.single"), sous.services.has("p.config"));
                sous.config.contribute({
                    id: "c",
                    contribute: (config) => {
                        config.atPath("x").set(sous.services.get("p.single") as string);

                        for (const name of ["p.config", "p.factory"]) {
                            try {
                                sous.services.get(name);
                            } catch (error) {
                                seen.push((error as SousError).message);
                            }
                        }
                    },
                });
            }),
        ]);

        const built = await engine.buildConfig();

        expect(built.get("x")).toBe("single");
        expect(seen).toEqual([
            "single",
            true,
            'The service "p.config" lives per config build (config), so it cannot be used while the config is being built.',
            'The service "p.factory" lives per config build (factory), so it cannot be used while the config is being built.',
        ]);
    });

    /**
     * A service that needs itself to be made is an error showing the cycle; factories get the config
     * and a context with other services.
     */
    it("should detect a cycle of services and pass factories their context", async () => {
        const { engine } = makeEngine([
            keysPlugin("name"),
            plugin("p", (sous) => {
                sous.config.contribute({ id: "n", contribute: (config) => config.atPath("name").set("demo") });
                sous.services.add("p.a", (_config, ctx) => ctx.services.get("p.b"));
                sous.services.add("p.b", (_config, ctx) => ctx.services.get("p.a"));
                sous.services.add("p.uses", (config, ctx) => `${String(config.get("name"))} by ${ctx.plugin}`);
            }),
        ]);

        const built = await engine.buildConfig();

        expect(() => built.services.get("p.a")).toThrow('The service "p.a" needs itself to be made (a cycle of services).');
        expect(built.services.get("p.uses")).toBe("demo by p");
    });

    /**
     * Method calls on a service are timed through a proxy that keeps `this` and #private fields
     * working; function services are timed too (L5).
     */
    it("should time service methods without breaking private fields (L5)", async () => {
        class Counter {
            #count = 0;

            increment(): number {
                this.#count += 1;

                return this.#count;
            }

            async later(): Promise<number> {
                return this.#count;
            }
        }
        const { engine } = makeEngine([
            plugin("p", (sous) => {
                sous.services.add("p.counter", () => new Counter(), { lifetime: "singleton" });
                sous.services.add("p.fn", () => (x: number) => x * 2);
                sous.services.add("p.value", () => 42);
            }),
        ]);

        const built = await engine.buildConfig();
        const counter = built.services.get("p.counter") as Counter;

        expect(counter.increment()).toBe(1);
        expect(counter.increment()).toBe(2);
        expect(await counter.later()).toBe(2);
        expect(counter.increment).toBe(counter.increment);
        expect(counter instanceof Counter).toBe(true);
        expect((built.services.get("p.fn") as (x: number) => number)(4)).toBe(8);
        expect(built.services.get("p.value")).toBe(42);
        expect(engine.timings.get("service.method:p.counter.increment")).toMatchObject({ count: 2, plugin: "p" });
        expect(engine.timings.get("service.method:p.fn")).toMatchObject({ count: 1 });
    });

    /**
     * A service without a factory function is refused.
     */
    it("should refuse a service without a factory", async () => {
        await expect(makeEngine([plugin("p", (sous) => sous.services.add("p.x", 3 as never))]).engine.buildConfig()).rejects.toThrow(
            'p added the service "p.x" without a factory function.',
        );
    });
});

describe("entities", () => {
    /**
     * A kind is defined with a schema; every entry is checked when added; a wrong entry is a
     * ConfigError naming the plugin (C32). Defining a kind twice names both plugins.
     */
    it("should check entries against their kind's schema (C32)", async () => {
        const harness = jsonSchema({ type: "object", required: ["id"], properties: { id: { type: "string" }, command: { type: "string", default: "claude" } } });
        const ok = makeEngine([
            plugin("plugin-harnesses", (sous) => sous.entities.define("harness", harness)),
            plugin("plugin-claude-code", (sous) => sous.entities.add("harness", { id: "claude" })),
        ]);
        const built = await ok.engine.buildConfig();

        expect(built.entities.get("harness", "claude")).toEqual({ id: "claude", command: "claude" });
        expect(built.entities.has("harness", "claude")).toBe(true);
        expect(built.entities.kinds()).toContain("harness");

        await expect(
            makeEngine([
                plugin("plugin-harnesses", (sous) => sous.entities.define("harness", harness)),
                plugin("bad", (sous) => sous.entities.add("harness", { id: "x", command: 3 } as never)),
            ]).engine.buildConfig(),
        ).rejects.toThrow('bad added a "harness" entity "x" that does not match its schema.');
        await expect(makeEngine([plugin("bad", (sous) => sous.entities.add("harness", { name: "x" } as never))]).engine.buildConfig()).rejects.toThrow(
            'bad added a "harness" entity without a string id.',
        );
        await expect(
            makeEngine([
                plugin("a", (sous) => sous.entities.define("harness", harness)),
                plugin("b", (sous) => sous.entities.define("harness", harness)),
            ]).engine.buildConfig(),
        ).rejects.toThrow('Two plugins define the entity kind "harness": a and b.');
    });

    /**
     * An entity added before its kind is defined is checked once the build ends; an entity of a kind
     * nobody defines is warned about.
     */
    it("should check early entities at the end and warn about undefined kinds", async () => {
        const schema = jsonSchema({ type: "object", properties: { id: { type: "string" }, size: { type: "number", default: 1 } } });
        const { engine, reporter } = makeEngine([
            plugin("early", (sous) => {
                sous.entities.add("widget", { id: "w" });
                sous.entities.add("gadget", { id: "g" });
            }),
            plugin("definer", (sous) => sous.entities.define("widget", schema)),
        ]);

        const built = await engine.buildConfig();

        expect(built.entities.get("widget", "w")).toEqual({ id: "w", size: 1 });
        expect(reporter.at("warning")).toContain('early added a "gadget" entity, but no plugin defines that kind.');

        const failing = makeEngine([
            plugin("early", (sous) => sous.entities.add("widget", { id: "w", size: "big" } as never)),
            plugin("definer", (sous) => sous.entities.define("widget", schema)),
        ]);

        await expect(failing.engine.buildConfig()).rejects.toBeInstanceOf(ConfigError);
    });

    /**
     * Two entries with one id: the later wins.
     */
    it("should let a later entry with the same id win", async () => {
        const { engine } = makeEngine([
            plugin("a", (sous) => sous.entities.add("pointer-file", { id: "CLAUDE.md", from: "a" } as never)),
            plugin("b", (sous) => sous.entities.add("pointer-file", { id: "CLAUDE.md", from: "b" } as never)),
        ]);

        const built = await engine.buildConfig();

        expect(built.entities.list("pointer-file")).toEqual([{ id: "CLAUDE.md", from: "b" }]);
    });

    /**
     * Anything about an entity that depends on the config is a method, called after the build with a
     * ctx holding the config; entity methods are timed (C34, L5).
     */
    it("should let entity methods read the built config through ctx (C34)", async () => {
        const { engine } = makeEngine([
            keysPlugin("tools"),
            plugin("plugin-claude-code", (sous) => {
                sous.config.contribute({ id: "t", contribute: (config) => config.atPath("tools.claude.command").set("claude-beta") });
                sous.entities.add("harness", {
                    id: "claude",
                    launch: (args: string[], ctx: { config: { get(p: string): unknown } }) => [ctx.config.get("tools.claude.command"), ...args],
                    Ctor: class {},
                } as never);
            }),
            plugin("plugin-harnesses", (sous) =>
                sous.intents.add({
                    intent: "launch",
                    handle: (_input, ctx) => (ctx.entities.get("harness", "claude") as unknown as { launch(a: string[], c: unknown): unknown }).launch(["--x"], ctx),
                }),
            ),
        ]);

        await engine.buildConfig();

        expect(await engine.submit({ intent: "launch" })).toEqual(["claude-beta", "--x"]);
        expect(engine.timings.get("entity.method:harness:claude.launch")).toMatchObject({ count: 1, plugin: "plugin-claude-code" });
    });

    /**
     * sous.entities reads the latest built config's entities outside building, with no warning.
     */
    it("should read entities directly after the build", async () => {
        let read: (() => unknown) | undefined;
        const { engine, reporter } = makeEngine([
            plugin("p", (sous) => {
                sous.entities.add("thing", { id: "one" });
                read = () => [sous.entities.list("thing"), sous.entities.get("thing", "one"), sous.entities.has("thing", "two"), sous.entities.describe("thing"), sous.entities.kinds()];
            }),
        ]);

        await engine.buildConfig();

        expect(read!()).toEqual([[{ id: "one" }], { id: "one" }, false, [{ kind: "thing", id: "one", entry: { id: "one" }, plugin: "p" }], ["config-key", "plugin-locator"]]);
        expect(reporter.at("warning").filter((m) => m.includes("directly"))).toEqual([]);
    });
});
