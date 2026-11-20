import { Table, VariableSet } from "@sous-io/sous-plugin-api";
import { describe, expect, it } from "vitest";
import { configGetOutputs } from "./outputs.js";
import type { ConfigGetResult } from "./types.js";

describe("configGetOutputs()", () => {
    const longName = "recipes/acme/an-unusually-long-namespace-name/with-an-even-longer-recipe-name-inside-it";
    const value = { targets: ["one", "two"], description: "x".repeat(120) };
    const result: ConfigGetResult = {
        path: "demo",
        exists: true,
        value,
        passes: 1,
        layers: [
            {
                contributor: longName,
                plugin: "test",
                patch: { op: "setKey", path: "", key: "demo", value },
                helpers: [],
                applyOrder: 50,
                actualApplyOrder: 50,
                build: "",
            },
        ],
    };

    /**
     * `--layers` shows a layer's name whole, in a column that wraps rather than cuts, and every value
     * as pretty-printed JSON, never cut short.
     *
     * configGetOutputs({ path: "demo", layers: [{ contributor: "<long name>", patch: setKey demo = {...} }], ... });
     * // -> table row { source: "<long name>", change: "{\n  \"targets\": [...],\n  ..." }; result value the same JSON
     */
    it("should show layer names in full and values as pretty-printed JSON", () => {
        const [layers, settled] = configGetOutputs(result);
        const table = layers!.result as Table;
        const source = table.columns.find((column) => column.key === "source");

        expect(source?.overflow).toBe("wrap");
        expect(table.rows[0]).toEqual({ source: longName, change: JSON.stringify(value, null, 2) });
        expect((settled!.result as VariableSet).entries[0]!.value).toBe(JSON.stringify(value, null, 2));
    });
});
