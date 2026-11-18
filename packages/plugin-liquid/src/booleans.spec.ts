/**
 * gh-161 (ADR 0038): a boolean variable answered `false` reaches Liquid as the text `"false"`,
 * which Liquid treats as true. An engine told which names are booleans sees `"true"` and
 * `"false"` as `true` and `false`, in templates and in evaluated expressions.
 */

import { describe, expect, it } from "vitest";
import type { EntityReader, ServiceReader } from "@sous-io/plugin-api";
import { createLiquidEngines, liquidValues } from "./engine.js";

const noEntities = { get: () => undefined, list: () => [], has: () => false, describe: () => [], kinds: () => [] } as unknown as EntityReader;

/** Services where `variables.booleans` declares the given names. */
function services(names: string[]): ServiceReader {
    return {
        has: (name: string) => name === "variables.booleans",
        get: () => ({ declared: () => new Set(names) }),
    } as unknown as ServiceReader;
}

function engine(names: string[]) {
    return createLiquidEngines({ project: undefined, env: {}, services: services(names), entities: noEntities }).create();
}

describe("boolean variables in Liquid", () => {
    /**
     * {% if jiraEnabled %}TRUE{% else %}FALSE{% endif %} with jiraEnabled: "false" -> FALSE
     */
    it("should take the false branch of {% if %} for a boolean answered false", async () => {
        const template = "{% if jiraEnabled %}TRUE{% else %}FALSE{% endif %}";

        expect(await engine(["jiraEnabled"]).parseAndRender(template, { jiraEnabled: "false" })).toBe("FALSE");
        expect(await engine(["jiraEnabled"]).parseAndRender(template, { jiraEnabled: "true" })).toBe("TRUE");
        expect(engine(["jiraEnabled"]).parseAndRenderSync(template, { jiraEnabled: "false" })).toBe("FALSE");
    });

    /** The workaround recipes use today still works for true: `x == true or x == "true"`. */
    it("should keep the old workaround working", async () => {
        const template = '{% if x == true or x == "true" %}TRUE{% else %}FALSE{% endif %}';

        expect(await engine(["x"]).parseAndRender(template, { x: "true" })).toBe("TRUE");
        expect(await engine(["x"]).parseAndRender(template, { x: "false" })).toBe("FALSE");
    });

    /** A name nobody declared a boolean keeps Liquid's own rule: the text "false" is true. */
    it("should leave other names alone", async () => {
        expect(await engine([]).parseAndRender("{% if x %}TRUE{% endif %}", { x: "false" })).toBe("TRUE");
        expect(engine(["flag"]).evalValueSync("flag", { flag: "false" })).toBe(false);
    });

    /** liquidValues converts only "true" and "false", and only declared names. */
    it("should convert only declared names holding true or false", () => {
        expect(liquidValues({ a: "false", b: "false", c: "maybe" }, new Set(["a", "c"]))).toEqual({ a: false, b: "false", c: "maybe" });
    });
});
