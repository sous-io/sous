import { describe, expect, it } from "vitest";
import { BufferedReporter, TIMING_CATEGORIES } from "@sous-io/plugin-api";
import { createEngine, DEFAULT_BUDGETS } from "../src/index.js";
import { Timer } from "../src/timing/timer.js";
import { contributorsPlugin, keysPlugin, makeEngine, manualClock, plugin } from "./helpers.js";

describe("timing and budgets", () => {
    /**
     * Every core stage and every call into a plugin has a budget: a test fails when a timing category
     * has none (S1, "Timing and Budgets", ruled 2026-10-25; L5).
     */
    it("should have a default budget for every timing category (L5)", () => {
        for (const category of TIMING_CATEGORIES) {
            expect(DEFAULT_BUDGETS[category], category).toBeGreaterThan(0);
        }

        expect(Object.keys(DEFAULT_BUDGETS).sort()).toEqual([...TIMING_CATEGORIES].sort());
    });

    /**
     * A build over budget warns, naming the slowest contributor; the warning goes to the engine's
     * reporter (stderr in the CLI).
     */
    it("should warn when building the config goes over budget, naming the slowest contributor", async () => {
        const clock = manualClock();
        const { engine, reporter } = makeEngine(
            [
                contributorsPlugin("p", [
                    { id: "confd/530-team.js", contribute: () => clock.advance(610) },
                    { id: "fast", contribute: () => clock.advance(1) },
                ]),
            ],
            { now: clock.now },
        );

        await engine.buildConfig();

        expect(reporter.at("warning")).toEqual([
            "building the config took 611ms (budget 200ms).\n  confd/530-team.js took 610ms of that.\n  See every timing with --timings.",
        ]);
        expect(engine.timings.get("contributor:confd/530-team.js")).toMatchObject({ count: 1, totalMs: 610, maxMs: 610, overBudget: 1, budgetMs: 50 });
    });

    /**
     * Budgets change under the budgets config key, by category or by "category:name"; false turns a
     * warning off; the config's budgets apply to its own build (C50).
     */
    it("should take budgets from the config, with false turning a warning off (C50)", async () => {
        const clock = manualClock();
        const { engine, reporter } = makeEngine(
            [
                contributorsPlugin("p", [
                    {
                        id: "budgets",
                        contribute: (config) =>
                            config.atPath("budgets").merge({ contributor: 1000, "config.build": false, "config.stage": false, "config.pass": false, "intent:slow.thing": 5, "service.method:q.svc.work": false }),
                    },
                    { id: "slow", contribute: () => clock.advance(500) },
                ]),
                plugin("q", (sous) => {
                    sous.intents.add({ intent: "slow.thing", handle: () => clock.advance(10) });
                    sous.intents.add({ intent: "fast.thing", handle: () => clock.advance(10) });
                    sous.services.add("q.svc", () => ({ work: () => clock.advance(99_999), other: () => clock.advance(99_999) }));
                }),
            ],
            { now: clock.now },
        );

        const built = await engine.buildConfig();

        expect(reporter.at("warning")).toEqual([]);

        await engine.submit({ intent: "slow.thing" });
        await engine.submit({ intent: "fast.thing" });
        (built.services.get("q.svc") as { work(): void; other(): void }).work();
        (built.services.get("q.svc") as { work(): void; other(): void }).other();

        expect(reporter.at("warning")).toEqual([
            'the intent "slow.thing" took 10ms (budget 5ms).\n  See every timing with --timings.',
            "the service call q.svc.other() took 99999ms (budget 5000ms).\n  See every timing with --timings.",
        ]);
        expect(engine.timings.get("intent:slow.thing")?.budgetMs).toBe(5);
        expect(engine.timings.get("service.method:q.svc.work")?.budgetMs).toBe(false);
    });

    /**
     * Every kind of plugin call is timed: contributors, plugin loads and registers, intents,
     * listeners, chains, stages and passes, validation, service creation (C52).
     */
    it("should time every stage and plugin call (C52)", async () => {
        const { engine } = makeEngine([
            keysPlugin("x"),
            plugin("p", (sous) => {
                sous.config.contribute({ id: "c", contribute: (config) => config.atPath("x").set(1) });
                sous.intents.add({ intent: "p.go", handle: (_input, ctx) => ctx.services.get("p.svc") });
                sous.on("p.go.before", () => {});
                sous.services.add("p.svc", () => 1);
            }),
        ]);

        await engine.buildConfig();
        await engine.submit({ intent: "p.go" });

        const categories = new Set(engine.timings.entries().map((entry) => entry.category));

        for (const category of ["config.build", "config.stage", "config.pass", "config.validate", "contributor", "plugin.register", "intent", "listener", "chain", "service.create"]) {
            expect(categories, category).toContain(category);
        }

        expect(engine.timings.get("listener:p.go.before:p")).toMatchObject({ plugin: "p", count: 1 });
        expect(engine.timings.get("nope")).toBeUndefined();
    });

    /**
     * Timing costs almost nothing when nothing is over budget: 100k timed calls stay within a few
     * microseconds each (G9, L5).
     */
    it("should add near-zero overhead to calls under budget (L5, G9)", () => {
        const timer = new Timer(DEFAULT_BUDGETS, () => {});
        const calls = 100_000;
        let sum = 0;
        const fn = () => (sum += 1);
        const start = performance.now();

        for (let i = 0; i < calls; i++) {
            timer.measure("service.method", "bench.call", "bench", fn);
        }

        const perCallMicros = ((performance.now() - start) * 1000) / calls;

        expect(sum).toBe(calls);
        expect(perCallMicros).toBeLessThan(5);
    });

    /**
     * The timer times async calls and failed calls, and start() measures something that ends later.
     */
    it("should time async, failing and started calls", async () => {
        const clock = manualClock();
        const over: string[] = [];
        const timer = new Timer(DEFAULT_BUDGETS, (entry) => void over.push(entry.key), clock.now);

        await timer.measure("intent", "async", undefined, async () => clock.advance(20_000));
        expect(() =>
            timer.measure("intent", "throws", undefined, () => {
                clock.advance(1);
                throw new Error("x");
            }),
        ).toThrow("x");

        const end = timer.start("chain", "later");

        clock.advance(5);
        expect(end()).toBe(5);
        expect(over).toEqual(["intent:async"]);
        expect(timer.budgetFor("intent", "async")).toBe(10_000);
        expect(timer.entries().map((entry) => entry.key)).toEqual(["intent:async", "intent:throws", "chain:later"]);
    });
});

describe("the engine reporter", () => {
    /**
     * Engine-level messages are kept until a front end sets a reporter, then sent there first.
     */
    it("should keep messages until a reporter is set, then flush them", async () => {
        const engine = createEngine({
            builtIns: [plugin("p", (sous) => sous.reporter.warning("early warning"))],
        });

        await engine.buildConfig();

        const reporter = new BufferedReporter();

        engine.setReporter(reporter);
        engine.reporter.note("later");
        engine.handle.setReporter(reporter);

        expect(reporter.messages).toEqual([
            { level: "warning", message: "early warning" },
            { level: "notice", message: "later" },
        ]);
        expect(engine.handle.reporter).toBe(reporter);
        expect(engine.handle.app).toEqual({ name: "sous", version: "0.0.0" });
    });
});
