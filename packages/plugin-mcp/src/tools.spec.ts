import { type IntentInfo, InputError, jsonSchema } from "@sous-io/plugin-api";
import { describe, expect, it } from "vitest";
import { buildTools, createMcpTools, matchesGlob, toolDescription, toolInputSchema, toolName, toolOutputSchema } from "./tools.js";

function info(definition: IntentInfo["definition"], plugin = "p"): IntentInfo {
    return { definition, plugin };
}

describe("toolName", () => {
    it("uses agent.tool, or the intent name with dots as underscores", () => {
        expect(toolName({ intent: "namespace.list" })).toBe("namespace_list");
        expect(toolName({ intent: "version", agent: { tool: "sous_version" } })).toBe("sous_version");
    });
});

describe("toolDescription", () => {
    it("joins the summary, usage and when not to use it", () => {
        expect(toolDescription({ intent: "a.b", summary: "Does a", agent: { usage: "Use it.", whenNotToUse: "Not for b." } })).toBe(
            "Does a\n\nUse it.\n\nWhen not to use it: Not for b.",
        );
    });

    it("falls back to the description, then to the intent name", () => {
        expect(toolDescription({ intent: "a.b", description: "More about a" })).toBe("More about a");
        expect(toolDescription({ intent: "a.b" })).toBe('Runs the sous intent "a.b".');
    });
});

describe("toolInputSchema and toolOutputSchema", () => {
    it("gives an object schema for every intent", () => {
        expect(toolInputSchema({ intent: "a" })).toEqual({ type: "object", properties: {} });
        expect(toolInputSchema({ intent: "a", input: jsonSchema({ properties: { x: { type: "string" } } }) })).toEqual({
            type: "object",
            properties: { x: { type: "string" } },
        });
    });

    it("keeps only object output schemas, which MCP allows", () => {
        expect(toolOutputSchema({ intent: "a", output: jsonSchema({ type: "string" }) })).toBeUndefined();
        expect(toolOutputSchema({ intent: "a", output: jsonSchema({ type: "object" }) })).toEqual({ type: "object" });
    });
});

describe("matchesGlob", () => {
    it("matches * and ? and nothing else specially", () => {
        expect(matchesGlob("recipe_search", "recipe_*")).toBe(true);
        expect(matchesGlob("recipe_search", "recipe_searc?")).toBe(true);
        expect(matchesGlob("recipe_search", "recipe")).toBe(false);
        expect(matchesGlob("a.b", "a.b")).toBe(true);
        expect(matchesGlob("axb", "a.b")).toBe(false);
    });
});

describe("buildTools", () => {
    const intents = [
        info({ intent: "a.one" }),
        info({ intent: "a.two", internal: true }),
        info({ intent: "a.three", agent: { hidden: true } }),
        info({ intent: "a.four", background: true }),
        info({ intent: "b.one" }),
    ];

    it("leaves out internal, hidden and background intents", () => {
        expect(buildTools(intents).tools.map((tool) => tool.name)).toEqual(["a_one", "b_one"]);
    });

    it("filters by include and exclude", () => {
        expect(buildTools(intents, { include: ["a_*"] }).tools.map((tool) => tool.name)).toEqual(["a_one"]);
        expect(buildTools(intents, { exclude: ["a_*"] }).tools.map((tool) => tool.name)).toEqual(["b_one"]);
    });

    it("warns when two intents claim one tool name", () => {
        const set = buildTools([info({ intent: "x.y" }, "first"), info({ intent: "z", agent: { tool: "x_y" } }, "second")]);

        expect(set.tools.map((tool) => tool.intent)).toEqual(["x.y"]);
        expect(set.warnings).toHaveLength(1);
        expect(set.warnings[0]).toContain('"x.y" (first) and "z" (second)');
    });
});

describe("createMcpTools", () => {
    it("turns a tool call into an intent request", () => {
        const tools = createMcpTools(buildTools([info({ intent: "a.one" })]));

        expect(tools.toRequest("a_one", { x: 1 })).toEqual({ intent: "a.one", input: { x: 1 } });
        expect(() => tools.toRequest("nope", {})).toThrow(InputError);
    });
});
