import { describe, expect, it } from "vitest";
import { CancelledError, IntentOutputs, jsonSchema, SousError } from "@sous-io/plugin-api";
import { keysPlugin, makeEngine, plugin } from "./helpers.js";

function readerPlugin() {
    return plugin("p", (sous) => {
        sous.config.contribute({
            id: "base",
            contribute(config) {
                config.atPath("x").set(1);
            },
        });
        sous.intents.add({
            intent: "read",
            readOnly: true,
            handle: async (_input, ctx) => IntentOutputs.of({ x: ctx.config.get("x"), nested: (await ctx.run("read.nested" as never, {} as never)).toPlain() }),
        });
        sous.intents.add({ intent: "read.nested", internal: true, readOnly: true, handle: (_input, ctx) => IntentOutputs.of({ x: ctx.config.get("x") }) });
        sous.intents.add({ intent: "write", handle: () => IntentOutputs.of({}) });
        sous.intents.add({
            intent: "maybe",
            input: jsonSchema<{ dryRun?: boolean }>({ type: "object", properties: { dryRun: { type: "boolean" } } }),
            readOnly: (input) => input.dryRun === true,
            handle: () => IntentOutputs.of({ ran: true }),
        });
        sous.intents.add({ intent: "bg", background: true, handle: () => IntentOutputs.of({}) });
    });
}

describe("chains on a what-if config", () => {
    /**
     * A chain given a what-if config sees it in ctx.config and in nested ctx.run calls; the
     * current config is unchanged.
     */
    it("should run the chain, nested calls included, against the what-if config", async () => {
        const { engine } = makeEngine([keysPlugin("x"), readerPlugin()]);

        await engine.buildConfig();

        const whatIf = await engine.buildConfig({ extraContributors: [{ id: "try", contribute: (config) => config.atPath("x").set(2) }] });
        const result = (await engine.submit({ intent: "read" }, { config: whatIf })).toPlain();
        const current = (await engine.submit({ intent: "read" })).toPlain();

        expect(result).toEqual({ x: 2, nested: { x: 2 } });
        expect(current).toEqual({ x: 1, nested: { x: 1 } });
    });

    /**
     * intents not declared read-only (for their input), background intents and configs that are not what-if ones are refused.
     */
    it("should refuse writes, background intents and real configs", async () => {
        const { engine } = makeEngine([keysPlugin("x"), readerPlugin()]);
        const real = await engine.buildConfig();
        const whatIf = await engine.buildConfig({ extraContributors: [{ id: "try", contribute: (config) => config.atPath("x").set(2) }] });

        await expect(engine.submit({ intent: "write" }, { config: whatIf })).rejects.toThrow(/not declared read-only/);
        await expect(engine.submit({ intent: "maybe", input: {} }, { config: whatIf })).rejects.toThrow(/not declared read-only/);
        expect((await engine.submit({ intent: "maybe", input: { dryRun: true } }, { config: whatIf })).toPlain()).toEqual({ ran: true });
        await expect(engine.submit({ intent: "bg" }, { config: whatIf })).rejects.toThrow(/background intent/);
        await expect(engine.submit({ intent: "read" }, { config: real })).rejects.toBeInstanceOf(SousError);
    });
});

describe("cancelling a chain", () => {
    /**
     * ctx.signal is the front end's signal; an aborted one stops the next intent from starting.
     */
    it("should give ctx.signal and refuse to start an intent once it aborts", async () => {
        const controller = new AbortController();
        const seen: boolean[] = [];
        const { engine } = makeEngine([
            plugin("p", (sous) => {
                sous.intents.add({
                    intent: "outer",
                    handle: async (_input, ctx) => {
                        seen.push(ctx.signal === controller.signal);
                        controller.abort();

                        return ctx.run("inner" as never, {} as never);
                    },
                });
                sous.intents.add({ intent: "inner", internal: true, handle: () => IntentOutputs.of({}) });
            }),
        ]);

        await engine.buildConfig();

        await expect(engine.submit({ intent: "outer" }, { signal: controller.signal })).rejects.toBeInstanceOf(CancelledError);
        expect(seen).toEqual([true]);
    });
});
