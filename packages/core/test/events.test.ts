import { describe, expect, it } from "vitest";
import { CancelledError, type CustomEvent, IntentOutputs, LoopError } from "@sous-io/plugin-api";
import { contributorsPlugin, keysPlugin, makeEngine, nothing, plugin, valued } from "./helpers.js";

describe("events", () => {
    /**
     * Listeners subscribe by exact name, wildcard or regular expression; once removes itself after one
     * run, and off removes a listener.
     */
    it("should match exact, wildcard and regex listeners, with once and off", async () => {
        const heard: string[] = [];
        const removed = () => void heard.push("removed");
        const { engine } = makeEngine([
            plugin("p", (sous) => {
                sous.intents.add({ intent: "build", handle: () => valued(1) });
                sous.intents.add({ intent: "subscription.add", handle: () => valued(2) });
                sous.on("build.before", (event) => void heard.push(`exact ${event.name}`));
                sous.on("build.*", (event) => void heard.push(`wild ${event.name}`));
                sous.on("*.before", (event) => void heard.push(`any-before ${event.name}`));
                sous.on(/^subscription\.(add|remove)\.after$/, (event) => void heard.push(`regex ${event.name}`));
                sous.once("build.after", () => void heard.push("once"));
                sous.on("build.after", removed);
                sous.off("build.after", removed);
                sous.off(/never/, removed);
            }),
        ]);

        await engine.buildConfig();
        await engine.submit({ intent: "build" });
        await engine.submit({ intent: "build" });
        await engine.submit({ intent: "subscription.add" });

        expect(heard).toEqual([
            "exact build.before",
            "wild build.before",
            "any-before build.before",
            "wild build.after",
            "once",
            "exact build.before",
            "wild build.before",
            "any-before build.before",
            "wild build.after",
            "any-before subscription.add.before",
            "regex subscription.add.after",
        ]);
    });

    /**
     * Listener order: priority (higher first), then plugin order, then the order they were added.
     */
    it("should order listeners by priority, plugin order, then registration", async () => {
        const order: string[] = [];
        const { engine } = makeEngine([
            plugin("first", (sous) => {
                sous.intents.add({ intent: "build", handle: () => valued(1) });
                sous.on("build.before", () => void order.push("first-a"));
                sous.on("build.before", () => void order.push("first-b"));
            }),
            plugin("second", (sous) => {
                sous.on("build.before", () => void order.push("second-high"), { priority: 100 });
                sous.on("build.before", () => void order.push("second-low"), { priority: -1 });
                sous.on("build.before", () => void order.push("second-default"));
            }),
        ]);

        await engine.buildConfig();
        await engine.submit({ intent: "build" });

        expect(order).toEqual(["second-high", "first-a", "first-b", "second-default", "second-low"]);
    });

    /**
     * A before listener changes the input; an after listener replaces the result; data is
     * shared from before to after.
     */
    it("should let listeners change input and result and share data", async () => {
        const { engine } = makeEngine([
            plugin("p", (sous) => {
                sous.intents.add({ intent: "build", handle: (input) => IntentOutputs.of({ pruned: (input as { prune: boolean }).prune }) });
                sous.on("build.before", (event) => {
                    (event.input as { prune: boolean }).prune = false;
                    event.data.set("startedAt", 7);
                });
                sous.on("build.after", (event) => {
                    event.result = IntentOutputs.of({ ...(event.result as IntentOutputs).toPlain(), note: "pruned 3 files", startedAt: event.data.get("startedAt") });
                });
            }),
        ]);

        await engine.buildConfig();

        expect((await engine.submit({ intent: "build", input: { prune: true } })).toPlain()).toEqual({ pruned: false, note: "pruned 3 files", startedAt: 7 });
    });

    /**
     * Cancelling stops the intent and reports the reason and the plugin; stopPropagation hides
     * the event from later listeners while the intent still runs.
     */
    it("should cancel intents with a reason, and stop propagation", async () => {
        let ran = 0;
        const later: string[] = [];
        const { engine } = makeEngine([
            plugin("owner", (sous) => {
                sous.intents.add({ intent: "build", handle: () => ((ran += 1), nothing()) });
                sous.intents.add({ intent: "quiet", handle: () => ((ran += 10), nothing()) });
            }),
            plugin("sous-plugin-guard", (sous) => {
                sous.on("build.before", (event) => event.cancel("Recipe X needs sous-plugin-diagrams"));
                sous.on("build.before", (event) => event.cancel("second reason is ignored"));
                sous.on("quiet.before", (event) => event.stopPropagation(), { priority: 5 });
                sous.on("quiet.before", () => void later.push("should not run"));
            }),
        ]);

        await engine.buildConfig();

        const error = (await engine.submit({ intent: "build" }).catch((e) => e)) as CancelledError;

        expect(error).toBeInstanceOf(CancelledError);
        expect(error.message).toBe('"build" was cancelled: Recipe X needs sous-plugin-diagrams (cancelled by sous-plugin-guard)');
        expect(error.cancelledBy).toBe("sous-plugin-guard");
        await engine.submit({ intent: "quiet" });
        expect(ran).toBe(10);
        expect(later).toEqual([]);
    });

    /**
     * An error listener can turn the failure into a result, and then after fires; without a
     * recovery the error propagates. A listener that throws fails the intent.
     */
    it("should recover from errors and fail on throwing listeners", async () => {
        const afters: unknown[] = [];
        const { engine } = makeEngine([
            plugin("p", (sous) => {
                sous.intents.add({
                    intent: "build",
                    handle: (input) => {
                        throw new Error(`failed ${(input as { n: number }).n}`);
                    },
                });
                sous.intents.add({ intent: "p.ok", handle: () => valued("ok") });
                sous.on("build.error", (event) => {
                    if ((event.input as { n: number }).n === 1) {
                        event.recover(IntentOutputs.of({ built: 0, because: (event.error as Error).message }));
                    }
                });
                sous.on("build.after", (event) => void afters.push((event.result as IntentOutputs).toPlain()));
                sous.on("p.ok.before", () => {
                    throw new Error("listener broke");
                });
            }),
        ]);

        await engine.buildConfig();

        expect((await engine.submit({ intent: "build", input: { n: 1 } })).toPlain()).toEqual({ built: 0, because: "failed 1" });
        await expect(engine.submit({ intent: "build", input: { n: 2 } })).rejects.toThrow("failed 2");
        await expect(engine.submit({ intent: "p.ok" })).rejects.toThrow("listener broke");
        expect(afters).toEqual([{ built: 0, because: "failed 1" }]);
    });

    /**
     * Any plugin fires any event and emit waits for every listener; a listener can cancel a custom
     * event, which the emitter sees. A listener's ctx can run intents, read the config and
     * report. Intent events fire whoever started the intent: a front end, ctx.run, or a listener.
     */
    it("should fire custom events and give listeners a full ctx", async () => {
        const befores: string[] = [];
        const { engine, reporter } = makeEngine([
            keysPlugin("diagrams"),
            plugin("sous-plugin-diagrams", (sous) => {
                sous.config.contribute({ id: "d", contribute: (config) => config.atPath("diagrams.count").set(3) });
                sous.intents.add({
                    intent: "diagrams.render",
                    handle: async (_input, ctx) => {
                        const event = (await ctx.emit("diagrams.rendered", { files: ["a.svg"] })) as CustomEvent<unknown>;

                        return IntentOutputs.of({ cancelled: event.cancelled, reason: event.cancelReason });
                    },
                });
                sous.intents.add({ intent: "diagrams.count", handle: (_input, ctx) => valued(ctx.config.get("diagrams.count")) });
            }),
            plugin("sous-plugin-docs-site", (sous) => {
                sous.on("*.before", (event) => void befores.push(event.name));
                sous.on("diagrams.rendered", async (event, ctx) => {
                    const count = (await ctx.run("diagrams.count", {})).toPlain().value;

                    ctx.reporter.notice(`rendered ${JSON.stringify((event as CustomEvent<{ files: string[] }>).payload.files)} of ${String(count)}`);
                    event.cancel("docs site says no");
                });
            }),
        ]);

        await engine.buildConfig();

        expect((await engine.submit({ intent: "diagrams.render" })).toPlain()).toEqual({ cancelled: true, reason: "docs site says no" });
        expect(reporter.at("notice")).toEqual(['rendered ["a.svg"] of 3']);
        expect(befores).toEqual(["diagrams.render.before", "diagrams.count.before"]);

        const direct = await engine.handle.config.services.has("nothing");

        expect(direct).toBe(false);
    });

    /**
     * An event emitted outside any chain (sous.emit from plugin code) reaches listeners, whose
     * ctx.run submits a new chain.
     */
    it("should deliver events emitted outside a chain, with ctx.run submitting a chain", async () => {
        let emit!: (name: string, payload: unknown) => Promise<unknown>;
        const { engine } = makeEngine([
            plugin("p", (sous) => {
                emit = (name, payload) => sous.emit(name, payload as never);
                sous.intents.add({ intent: "p.go", handle: (input) => IntentOutputs.of(input as Record<string, unknown>) });
                sous.on("p.poked", async (event, ctx) => {
                    (event as CustomEvent<{ got?: unknown }>).payload.got = (await ctx.run("p.go", { x: 1 })).toPlain();
                    ctx.configChanged();
                });
            }),
        ]);

        await engine.buildConfig();

        const event = (await emit("p.poked", {})) as CustomEvent<{ got: unknown }>;

        expect(event.payload.got).toEqual({ x: 1 });
    });

    /**
     * No events fire while the config is built: an emit from register() or a contributor warns and
     * reaches nobody. config.built fires once per real build, never for what-if builds.
     */
    it("should fire no events while building, and config.built once per build", async () => {
        const heard: string[] = [];
        const { engine, reporter } = makeEngine([
            plugin("p", async (sous) => {
                sous.on("*", (event) => void heard.push(event.name));
                await sous.emit("p.registered", {});
                sous.config.contribute({ id: "c", contribute: async () => void (await sous.emit("p.contributed", {})) });
            }),
        ]);

        await engine.buildConfig();
        await engine.buildConfig({ extraContributors: [{ id: "x", contribute() {} }] });
        await engine.buildConfig();

        expect(heard).toEqual(["config.built", "config.built"]);
        expect(reporter.at("warning").filter((m) => m.includes("was emitted while the config was being built"))).toHaveLength(2);
    });

    /**
     * A config.built listener may run an intent that changes the config; the engine rebuilds.
     */
    it("should rebuild when a config.built listener changes the config", async () => {
        let enabled = false;
        let builds = 0;
        const { engine } = makeEngine([
            keysPlugin("enabled"),
            plugin("p", (sous) => {
                sous.config.contribute({ id: "e", contribute: (config) => config.atPath("enabled").set(enabled) });
                sous.intents.add({ intent: "subscription.enable", changesConfig: true, handle: () => ((enabled = true), nothing()) });
                sous.on("config.built", async (event, ctx) => {
                    builds += 1;

                    if (!(event as CustomEvent<{ config: { get(p: string): unknown } }>).payload.config.get("enabled")) {
                        await ctx.run("subscription.enable", {});
                    }
                });
            }),
        ]);

        const built = await engine.buildConfig();

        expect(built.get("enabled")).toBe(true);
        expect(builds).toBe(2);
    });

    /**
     * Rebuilds in a row that produce a config already seen stop after 5 (going in circles); rebuilds
     * that keep producing a new config stop after 10; both name the path.
     */
    it("should stop rebuild loops: repeating after 5, changing after 10", async () => {
        let flag = false;
        const circles = makeEngine([
            keysPlugin("enabled"),
            plugin("sous-plugin-foo", (sous) => {
                sous.config.contribute({ id: "e", contribute: (config) => config.atPath("enabled").set(flag) });
                sous.intents.add({ intent: "subscription.toggle", changesConfig: true, handle: () => ((flag = !flag), nothing()) });
                sous.on("config.built", (_event, ctx) => ctx.run("subscription.toggle", { enabled: !flag }).then(() => {}));
            }),
        ]);
        const circling = (await circles.engine.buildConfig().catch((e) => e)) as LoopError;

        expect(circling).toBeInstanceOf(LoopError);
        expect(circling.limit).toBe("rebuildsRepeating");
        expect(circling.message).toBe("The config is going in circles (it was the same as 2 rebuilds ago, 6 times).");
        expect(circling.details).toContain('config.built → sous-plugin-foo listener → intent "subscription.toggle" ({"enabled":true})');

        let counter = 0;
        const growing = makeEngine([
            keysPlugin("counter"),
            plugin("sous-plugin-bar", (sous) => {
                sous.config.contribute({ id: "c", contribute: (config) => config.atPath("counter").set(counter) });
                sous.intents.add({ intent: "p.bump", changesConfig: true, handle: () => ((counter += 1), nothing()) });
                sous.on("config.built", (_event, ctx) => ctx.run("p.bump", {}).then(() => {}));
            }),
        ]);
        const changing = (await growing.engine.buildConfig().catch((e) => e)) as LoopError;

        expect(changing.limit).toBe("rebuildsChanging");
        expect(changing.message).toBe("The config kept changing: it was rebuilt 11 times in a row, and was different each time.");
        expect(changing.details).toEqual(['config.built → sous-plugin-bar listener → intent "p.bump"']);
    });

    /**
     * An event emitted again while its own listeners run, past limits.eventDepth, is a LoopError.
     */
    it("should stop an event that keeps emitting itself (eventDepth)", async () => {
        const { engine } = makeEngine([
            plugin("p", (sous) => {
                sous.intents.add({ intent: "p.go", handle: async (_input, ctx) => (await ctx.emit("p.echoed", {}), nothing()) });
                sous.on("p.echoed", async (_event, ctx) => void (await ctx.emit("p.echoed", {})));
            }),
        ]);

        await engine.buildConfig();

        const error = (await engine.submit({ intent: "p.go" }).catch((e) => e)) as LoopError;

        expect(error.limit).toBe("eventDepth");
        expect(error.message).toBe('"p.echoed" was emitted 6 deep while its own listeners were running (the limit is 5).');
    });

    /**
     * Listeners of a plugin that is not active are skipped.
     */
    it("should skip listeners of inactive plugins", async () => {
        const heard: string[] = [];
        const { engine } = makeEngine([
            plugin("owner", (sous) => sous.intents.add({ intent: "build", handle: () => valued(1) })),
            plugin("sous-plugin-off", (sous) => sous.on("build.before", () => void heard.push("off"))),
            contributorsPlugin("disabler", [{ id: "d", contribute: (config) => config.atPath("plugins.disabled").set(["sous-plugin-off"]) }]),
        ]);

        await engine.buildConfig();
        await engine.submit({ intent: "build" });

        expect(heard).toEqual([]);
    });

    /**
     * A listener that is not a function is refused at registration.
     */
    it("should refuse a listener that is not a function", async () => {
        await expect(makeEngine([plugin("p", (sous) => sous.on("x", 3 as never))]).engine.buildConfig()).rejects.toThrow(
            'p added a listener for "x" that is not a function.',
        );
    });
});
