import { describe, expect, it } from "vitest";
import {
    ConflictError,
    InputError,
    jsonSchema,
    LoopError,
    NotFoundError,
    scriptedPrompter,
    SousError,
    BufferedReporter,
    IntentOutputs,
} from "@sous-io/plugin-api";
import { contributorsPlugin, keysPlugin, makeEngine, plugin } from "./helpers.js";

function gate(): { promise: Promise<void>; open: () => void } {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => (open = resolve));

    return { promise, open };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("the chain scheduler", () => {
    /**
     * Chains run in series by default; parallel chains run together; a waiting series chain blocks
     * new starts, so a parallel chain submitted after it queues behind it.
     */
    it("should queue a parallel chain behind a waiting series chain", async () => {
        const log: string[] = [];
        const gates = { get: gate(), build: gate(), catalog: gate() };
        const { engine } = makeEngine([
            plugin("p", (sous) => {
                for (const [name, parallel] of [["config.get", true], ["build", false], ["catalog", true]] as const) {
                    sous.intents.add({
                        intent: name,
                        parallel,
                        handle: async () => {
                            log.push(`${name} start`);
                            await gates[name === "config.get" ? "get" : name].promise;
                            log.push(`${name} end`);

                            return IntentOutputs.of({ name });
                        },
                    });
                }
            }),
        ]);

        await engine.buildConfig();

        const get = engine.submit({ intent: "config.get" });
        const build = engine.submit({ intent: "build" });
        const catalog = engine.submit({ intent: "catalog" });

        await tick();
        expect(log).toEqual(["config.get start"]);

        gates.get.open();
        await tick();
        expect(log).toEqual(["config.get start", "config.get end", "build start"]);

        gates.build.open();
        gates.catalog.open();
        expect((await Promise.all([get, build, catalog])).map((outputs) => outputs.toPlain())).toEqual([{ name: "config.get" }, { name: "build" }, { name: "catalog" }]);
        expect(log.slice(3)).toEqual(["build end", "catalog start", "catalog end"]);
    });

    /**
     * Two parallel chains run together; two series chains one after the other.
     */
    it("should run parallel chains together and series chains one at a time", async () => {
        let running = 0;
        let most = 0;
        const { engine } = makeEngine([
            plugin("p", (sous) => {
                sous.intents.add({
                    intent: "p.work",
                    handle: async () => {
                        running += 1;
                        most = Math.max(most, running);
                        await tick();
                        running -= 1;

                        return IntentOutputs.of({});
                    },
                });
            }),
        ]);

        await engine.buildConfig();
        await Promise.all([engine.submit({ intent: "p.work" }, { parallel: true }), engine.submit({ intent: "p.work" }, { parallel: true })]);
        expect(most).toBe(2);

        most = 0;
        await Promise.all([engine.submit({ intent: "p.work" }), engine.submit({ intent: "p.work" })]);
        expect(most).toBe(1);
    });

    /**
     * After a series chain that changed the config, the config is rebuilt before the next chain
     * starts; a running chain keeps the config and services it started with.
     */
    it("should rebuild after a chain that changed the config, keeping running chains on theirs", async () => {
        let value = 1;
        const seen: unknown[] = [];
        const { engine } = makeEngine([
            keysPlugin("value"),
            plugin("p", (sous) => {
                sous.config.contribute({ id: "v", contribute: (config) => config.atPath("value").set(value) });
                sous.services.add("p.snapshot", (config) => ({ value: config.get("value") }), { lifetime: "config" });
                sous.intents.add({
                    intent: "p.write",
                    changesConfig: true,
                    handle: () => {
                        value = 2;

                        return IntentOutputs.of({});
                    },
                });
                sous.intents.add({
                    intent: "p.mark",
                    handle: (_input, ctx) => {
                        value = 3;
                        ctx.configChanged();

                        return IntentOutputs.of({});
                    },
                });
                sous.intents.add({
                    intent: "p.read",
                    handle: async (_input, ctx) => {
                        const before = ctx.config.get("value");

                        await tick();

                        return IntentOutputs.of({ seen: [before, ctx.config.get("value"), (ctx.services.get("p.snapshot") as { value: number }).value] });
                    },
                });
            }),
        ]);

        await engine.buildConfig();

        const reading = engine.submit({ intent: "p.read" }, { parallel: true });

        await tick();
        await engine.submit({ intent: "p.write" });
        seen.push((await reading).toPlain().seen, (await engine.submit({ intent: "p.read" })).toPlain().seen);
        await engine.submit({ intent: "p.mark" });
        seen.push((await engine.submit({ intent: "p.read" })).toPlain().seen);

        expect(seen).toEqual([
            [1, 1, 1],
            [2, 2, 2],
            [3, 3, 3],
        ]);
    });

    /**
     * When the rebuild before a chain fails, that chain fails with the error; the next one tries again.
     */
    it("should fail the waiting chain when the rebuild fails", async () => {
        let broken = false;
        const { engine } = makeEngine([
            plugin("p", (sous) => {
                sous.config.contribute({
                    id: "fragile",
                    contribute: () => {
                        if (broken) {
                            throw new Error("broken");
                        }
                    },
                });
                sous.intents.add({ intent: "p.break", changesConfig: true, handle: () => ((broken = true), IntentOutputs.of({})) });
                sous.intents.add({ intent: "p.ok", handle: () => IntentOutputs.of({ value: "ok" }) });
            }),
        ]);

        await engine.buildConfig();
        await engine.submit({ intent: "p.break" });
        await expect(engine.submit({ intent: "p.ok" })).rejects.toThrow('The contributor "fragile" (p) failed: broken');

        broken = false;
        expect((await engine.submit({ intent: "p.ok" })).toPlain()).toEqual({ value: "ok" });
    });

    /**
     * A background intent runs outside the scheduler: it never blocks a chain, reads the latest
     * config, submits chains with ctx.run, and whenBackgroundIntentsReturn waits for it.
     */
    it("should run background intents outside the scheduler", async () => {
        const stop = gate();
        const log: unknown[] = [];
        let value = "first";
        const { engine } = makeEngine([
            keysPlugin("value"),
            plugin("p", (sous) => {
                sous.config.contribute({ id: "v", contribute: (config) => config.atPath("value").set(value) });
                sous.services.add("p.clock", () => ({ now: () => 42 }), { lifetime: "singleton" });
                sous.intents.add({
                    intent: "p.serve",
                    background: true,
                    handle: async (_input, ctx) => {
                        log.push(`chain:${String(ctx.chain)}`);
                        log.push((await ctx.run("p.change", {})).toPlain().value);
                        await stop.promise;
                        log.push(ctx.config.get("value"), (ctx.services.get("p.clock") as { now(): number }).now());

                        return IntentOutputs.of({});
                    },
                });
                sous.intents.add({ intent: "p.change", changesConfig: true, handle: () => ((value = "second"), IntentOutputs.of({ value: "changed" })) });
                sous.intents.add({ intent: "p.quick", handle: () => IntentOutputs.of({ value: "quick" }) });
            }),
        ]);

        await engine.buildConfig();

        const serving = engine.submit({ intent: "p.serve" });

        expect((await engine.submit({ intent: "p.quick" })).toPlain()).toEqual({ value: "quick" });

        let returned = false;
        const waiting = engine.whenBackgroundIntentsReturn().then(() => (returned = true));

        await tick();
        expect(returned).toBe(false);
        // The rebuild after p.change happens before the next chain starts.
        await engine.submit({ intent: "p.quick" });
        stop.open();
        await waiting;
        await serving;
        expect(log).toEqual(["chain:undefined", "changed", "second", 42]);
    });

    /**
     * ctx.run inside a chain runs at once as part of the chain, never queued, so it never deadlocks;
     * results flow back, and intents can run in parallel inside a chain.
     */
    it("should run nested intents at once inside the chain", async () => {
        const { engine } = makeEngine([
            plugin("p", (sous) => {
                sous.intents.add({
                    intent: "subscription.add",
                    input: jsonSchema<{ ref: string }>({ type: "object", required: ["ref"], properties: { ref: { type: "string" } } }),
                    handle: async (input, ctx) => {
                        const recipe = (await ctx.run("ref.resolve", { ref: (input as { ref: string }).ref })).toPlain() as { key: string };
                        const both = (await Promise.all([ctx.run("p.slow", { n: 1 }), ctx.run("p.slow", { n: 2 })])).map((outputs) => outputs.toPlain().n);

                        return IntentOutputs.of({ subscribed: recipe.key, both, chain: ctx.chain?.intent });
                    },
                });
                sous.intents.add({ intent: "ref.resolve", internal: true, handle: (input) => IntentOutputs.of({ key: `${(input as { ref: string }).ref}@1.0.0` }) });
                sous.intents.add({ intent: "p.slow", handle: async (input) => (await tick(), IntentOutputs.of({ n: (input as { n: number }).n })) });
            }),
        ]);

        await engine.buildConfig();

        expect((await engine.submit({ intent: "subscription.add", input: { ref: "workflow/x" } })).toPlain()).toEqual({
            subscribed: "workflow/x@1.0.0",
            both: [1, 2],
            chain: "subscription.add",
        });
        expect(engine.handle.intents.get("ref.resolve")?.definition.internal).toBe(true);
    });

    /**
     * ctx.run nested past limits.runDepth, or the same intent re-entered with the same input past
     * limits.sameIntentDepth, is a LoopError showing the path.
     */
    it("should stop deep and self-recursive ctx.run calls with the path", async () => {
        const { engine } = makeEngine([
            plugin("p", (sous) => {
                sous.intents.add({ intent: "p.deeper", handle: (input, ctx) => ctx.run("p.deeper", { n: (input as { n: number }).n + 1 }) });
                sous.intents.add({ intent: "p.same", handle: (_input, ctx) => ctx.run("p.same", { x: 1 }) });
            }),
        ]);

        await engine.buildConfig();

        const deep = (await engine.submit({ intent: "p.deeper", input: { n: 0 } }).catch((error) => error)) as LoopError;

        expect(deep).toBeInstanceOf(LoopError);
        expect(deep.limit).toBe("runDepth");
        expect(deep.message).toBe("Intents are nested 33 deep, past the limit of 32.");

        const same = (await engine.submit({ intent: "p.same", input: { x: 1 } }).catch((error) => error)) as LoopError;

        expect(same.limit).toBe("sameIntentDepth");
        expect(same.message).toBe('"p.same" called itself with the same input, 3 deep (the limit is 2).');
        expect(same.details[0]).toBe('intent "p.same" ({"x":1}) → intent "p.same" ({"x":1}) → intent "p.same" ({"x":1})');

        const limited = makeEngine([
            plugin("p", (sous) => {
                sous.config.contribute({ id: "l", contribute: (config) => config.atPath("limits.runDepth").set(3) });
                sous.intents.add({ intent: "p.deeper", handle: (input, ctx) => ctx.run("p.deeper", { n: (input as { n: number }).n + 1 }) });
            }),
        ]);

        await limited.engine.buildConfig();
        await expect(limited.engine.submit({ intent: "p.deeper", input: { n: 0 } })).rejects.toThrow("Intents are nested 4 deep, past the limit of 3.");
    });

    /**
     * Each chain's ctx.reporter and ctx.prompter are the ones its front end handed over, and
     * globals reach ctx.globals.
     */
    it("should give each chain its front end's reporter, prompter and globals", async () => {
        const reporter = new BufferedReporter();
        const prompter = scriptedPrompter(["yes please"]);
        const { engine } = makeEngine([
            plugin("p", (sous) => {
                sous.intents.add({
                    intent: "p.ask",
                    handle: async (_input, ctx) => {
                        ctx.reporter.notice("asking");

                        return IntentOutputs.of({ answers: [await ctx.prompter.askValue({ message: "Name?", answeredBy: "--name" }), ctx.globals.debug, ctx.plugin, ctx.project, ctx.env.X] });
                    },
                });
            }),
        ], { env: { X: "1" } });

        await engine.buildConfig();

        expect((await engine.submit({ intent: "p.ask" }, { reporter, prompter, globals: { debug: true } })).toPlain()).toEqual({ answers: ["yes please", true, "p", undefined, "1"] });
        expect(reporter.at("notice")).toEqual(["asking"]);
        await expect(engine.submit({ intent: "p.ask" })).rejects.toThrow('sous needed to ask "Name?" but cannot ask questions in this run. Pass --name');
    });
});

describe("intents", () => {
    /**
     * Input is checked against the intent's schema, with defaults filled in; a wrong input is an
     * InputError listing each problem.
     */
    it("should check input against the schema (InputError)", async () => {
        const { engine } = makeEngine([
            plugin("p", (sous) => {
                sous.intents.add({
                    intent: "namespace.list",
                    input: jsonSchema({ type: "object", properties: { json: { type: "boolean", default: false }, repository: { type: "string" } } }),
                    handle: (input) => IntentOutputs.of(input as Record<string, unknown>),
                });
                sous.intents.add({ intent: "p.raw", handle: (input) => IntentOutputs.of(input as Record<string, unknown>) });
            }),
        ]);

        await engine.buildConfig();

        expect((await engine.submit({ intent: "namespace.list" })).toPlain()).toEqual({ json: false });
        expect((await engine.submit({ intent: "p.raw" })).toPlain()).toEqual({});

        const error = (await engine.submit({ intent: "namespace.list", input: { repository: 3 } }).catch((e) => e)) as InputError;

        expect(error).toBeInstanceOf(InputError);
        expect(error.issues).toEqual([{ path: "repository", message: "Expected string, got number 3." }]);
        expect(error.exitCode).toBe(2);
    });

    /**
     * A handler given as `load` is imported when the intent first runs: a function, a default export
     * or a `handle` export; a module with none is an error.
     */
    it("should load lazy handlers on first run", async () => {
        let loads = 0;
        const { engine } = makeEngine([
            plugin("p", (sous) => {
                sous.intents.add({ intent: "p.fn", load: async () => ((loads += 1), () => IntentOutputs.of({ value: "fn" })) });
                sous.intents.add({ intent: "p.default", load: async () => ({ default: () => IntentOutputs.of({ value: "default" }) }) });
                sous.intents.add({ intent: "p.handle", load: async () => ({ handle: () => IntentOutputs.of({ value: "handle" }) }) });
                sous.intents.add({ intent: "p.bad", load: async () => ({ nothing: true }) as never });
            }),
        ]);

        await engine.buildConfig();

        expect(loads).toBe(0);
        expect((await engine.submit({ intent: "p.fn" })).toPlain()).toEqual({ value: "fn" });
        expect((await engine.submit({ intent: "p.fn" })).toPlain()).toEqual({ value: "fn" });
        expect(loads).toBe(1);
        expect((await engine.submit({ intent: "p.default" })).toPlain()).toEqual({ value: "default" });
        expect((await engine.submit({ intent: "p.handle" })).toPlain()).toEqual({ value: "handle" });
        await expect(engine.submit({ intent: "p.bad" })).rejects.toThrow('The handler module of "p.bad" exports no handler');
    });

    /**
     * A handler must return IntentOutputs; anything else is an error naming the intent, not
     * wrapped silently. A wrapper that returns something else is the same error.
     */
    it("should refuse a handler or wrapper that returns something other than IntentOutputs", async () => {
        const { engine } = makeEngine([
            plugin("p", (sous) => {
                sous.intents.add({ intent: "p.bare", handle: (() => "bare") as never });
                sous.intents.add({ intent: "p.wrapped", handle: () => IntentOutputs.of({}) });
                sous.intents.wrap("p.wrapped", () => (() => ({ not: "outputs" })) as never);
            }),
        ]);

        await engine.buildConfig();

        await expect(engine.submit({ intent: "p.bare" })).rejects.toThrow('The intent "p.bare" returned something that is not IntentOutputs. A handler must return IntentOutputs');
        await expect(engine.submit({ intent: "p.wrapped" })).rejects.toThrow('The intent "p.wrapped" returned something that is not IntentOutputs.');
    });

    /**
     * An intent needs a name and exactly one of handle and load.
     */
    it("should refuse malformed intents", async () => {
        await expect(makeEngine([plugin("p", (sous) => sous.intents.add({ intent: "" } as never))]).engine.buildConfig()).rejects.toThrow(
            "p added an intent without a name.",
        );
        await expect(makeEngine([plugin("p", (sous) => sous.intents.add({ intent: "p.x" }))]).engine.buildConfig()).rejects.toThrow(
            'needs exactly one of handle and load',
        );
    });

    /**
     * Wrappers stack in plugin order: the plugin loaded last wraps outermost.
     */
    it("should stack intent wrappers in plugin order", async () => {
        const { engine } = makeEngine([
            plugin("build-owner", (sous) => sous.intents.add({ intent: "build", handle: () => IntentOutputs.of({ steps: ["built"] }) })),
            plugin("first", (sous) => sous.intents.wrap("build", (next) => async (input, ctx) => IntentOutputs.of({ steps: [...((await next(input, ctx)).toPlain().steps as string[]), "first"] }))),
            plugin("second", (sous) => sous.intents.wrap("build", (next) => async (input, ctx) => IntentOutputs.of({ steps: [...((await next(input, ctx)).toPlain().steps as string[]), "second"] }))),
        ]);

        await engine.buildConfig();

        expect((await engine.submit({ intent: "build" })).toPlain()).toEqual({ steps: ["built", "first", "second"] });
    });

    /**
     * Two plugins adding one intent is an error naming both, unless intents.replace picks one; the pick
     * is warned about on every build.
     */
    it("should report a duplicate intent and honour intents.replace", async () => {
        const a = plugin("plugin-a", (sous) => sous.intents.add({ intent: "x.go", handle: () => IntentOutputs.of({ value: "a" }) }));
        const b = plugin("plugin-b", (sous) => sous.intents.add({ intent: "x.go", handle: () => IntentOutputs.of({ value: "b" }) }));
        const error = (await makeEngine([a, b]).engine.buildConfig().catch((e) => e)) as ConflictError;

        expect(error).toBeInstanceOf(ConflictError);
        expect(error.message).toBe('Two plugins add the intent "x.go": plugin-a and plugin-b.');
        expect(error.plugins).toEqual(["plugin-a", "plugin-b"]);

        const picker = contributorsPlugin("picker", [{ id: "pick", contribute: (config) => config.atPath(["intents", "replace", "x.go"]).set("plugin-a") }]);
        const { engine, reporter } = makeEngine([a, b, picker]);

        await engine.buildConfig();
        await engine.buildConfig();

        expect((await engine.submit({ intent: "x.go" })).toPlain()).toEqual({ value: "a" });
        expect(reporter.at("warning")).toEqual([
            'intents.replace picks plugin-a for "x.go". plugin-b\'s intent is ignored, and may not work as expected.',
            'intents.replace picks plugin-a for "x.go". plugin-b\'s intent is ignored, and may not work as expected.',
        ]);
        expect(engine.handle.intents.list().map((info) => info.plugin)).toEqual(["plugin-a"]);
    });

    /**
     * Asking for an intent no active plugin adds is a NotFoundError; a front end likewise.
     */
    it("should report unknown intents and front ends", async () => {
        const { engine } = makeEngine([plugin("p", (sous) => sous.frontEnds.add({ id: "cli", start: () => {} }))]);

        await engine.buildConfig();

        expect(() => engine.submit({ intent: "nope" })).toThrow(NotFoundError);
        expect(() => engine.frontEnd("mcp")).toThrow('No plugin provides the front end "mcp".');
        await expect(engine.frontEnd("cli").start([])).resolves.toBeUndefined();
        expect(engine.handle.intents.get("nope")).toBeUndefined();
    });

    /**
     * Two plugins adding one front end id is an error.
     */
    it("should refuse two front ends with one id", async () => {
        const a = plugin("a", (sous) => sous.frontEnds.add({ id: "cli", start() {} }));
        const b = plugin("b", (sous) => sous.frontEnds.add({ id: "cli", start() {} }));

        await expect(makeEngine([a, b]).engine.buildConfig()).rejects.toThrow(SousError);
    });
});
