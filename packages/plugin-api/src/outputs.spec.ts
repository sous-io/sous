import { describe, expect, it } from "vitest";
import { DataValue, IntentOutput, IntentOutputs, ItemList, Payload, Table, TextBlock, VariableSet } from "./outputs.js";
import { BufferedReporter, errorChain, messageText } from "./reporter.js";

describe("payloads", () => {
    /**
     * Each payload converts to plain values: toPlain() is always a plain object, and each type has
     * its own conversion.
     *
     * new VariableSet({ A: 1 }).toObject() → { A: 1 }; new Table(cols, rows).toRows() → rows
     */
    it("should convert to plain values", () => {
        const set = new VariableSet({ Repository: "/work/recipes", Recipes: 3 });
        const table = new Table([{ key: "name", header: "Name" }], [{ name: "a" }, { name: "b" }]);
        const list = new ItemList(["one", "two"]);

        expect(set.toObject()).toEqual({ Repository: "/work/recipes", Recipes: 3 });
        expect(set.toPlain()).toEqual(set.toObject());
        expect(table.toRows()).toEqual([{ name: "a" }, { name: "b" }]);
        expect(table.toPlain()).toEqual({ rows: [{ name: "a" }, { name: "b" }] });
        expect(list.toArray()).toEqual(["one", "two"]);
        expect(new TextBlock("hi").toString()).toBe("hi");
        expect(new DataValue([1, 2]).toPlain()).toEqual({ value: [1, 2] });
        expect(new DataValue({ a: 1 }).toPlain()).toEqual({ a: 1 });
    });

    /** A payload is recognized by its marker, not only by instanceof. */
    it("should be recognized by Payload.is", () => {
        expect(Payload.is(new ItemList([]))).toBe(true);
        expect(Payload.is({ kind: "item-list" })).toBe(false);
        expect(Payload.is("text")).toBe(false);
    });
});

describe("IntentOutputs", () => {
    const first = new IntentOutput({ title: "Command Variables", result: new VariableSet({ Project: "app" }) });
    const last = new IntentOutput({ summary: "Downloaded.", result: new VariableSet({ Size: 10 }), data: { size: 10 } });

    /**
     * toPlain() is the last output's plain object (its data when given), never an array; first(),
     * last() and toArray() give the outputs.
     */
    it("should give the last output's plain object, and the outputs themselves", () => {
        const outputs = new IntentOutputs([first, last]);

        expect(outputs.toPlain()).toEqual({ size: 10 });
        expect(outputs.first()).toBe(first);
        expect(outputs.last()).toBe(last);
        expect(outputs.toArray()).toEqual([first, last]);
        expect(outputs.length).toBe(2);
        expect(new IntentOutputs().toPlain()).toEqual({});
        expect(new IntentOutputs(first).toPlain()).toEqual({ Project: "app" });
    });

    /** with() appends outputs and keeps the exit code; of() wraps one plain value. */
    it("should append with with(), keeping the exit code, and wrap a value with of()", () => {
        const outputs = new IntentOutputs(first, { exitCode: 1 }).with(last);

        expect(outputs.length).toBe(2);
        expect(outputs.exitCode).toBe(1);
        expect(IntentOutputs.of({ built: 3 }).toPlain()).toEqual({ built: 3 });
        expect(IntentOutputs.is(outputs)).toBe(true);
        expect(IntentOutputs.is({ toPlain: () => ({}) })).toBe(false);
    });
});

describe("messages", () => {
    /**
     * An error's text is its whole cause chain, one cause per line.
     *
     * Error("Could not download", { cause: Error("DNS failed") }) → "Could not download\nCaused by: DNS failed"
     */
    it("should give an error's cause chain as text", () => {
        const error = new Error("Could not download", { cause: new Error("DNS failed") });

        expect(errorChain(error).map((entry) => entry.message)).toEqual(["Could not download", "DNS failed"]);
        expect(messageText(error)).toBe("Could not download\nCaused by: DNS failed");
    });

    /** The level methods accept an Error, and result() reports outputs with the Result style. */
    it("should report errors and results", () => {
        const reporter = new BufferedReporter();
        const outputs = IntentOutputs.of({ ok: true }, { summary: "Done." });

        reporter.critical(new Error("Build failed"));
        reporter.result(outputs);
        reporter.variables({ Mode: "dry run" }, "Release");

        expect(reporter.at("critical")).toEqual(["Build failed"]);
        expect(reporter.messages[1]).toEqual({ level: "notice", message: outputs, style: "result" });
        expect(reporter.messages[2]!.message).toBeInstanceOf(VariableSet);
        expect(reporter.at("info")).toEqual(["Release\nMode: dry run"]);
    });
});
