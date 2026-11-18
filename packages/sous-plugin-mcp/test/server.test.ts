import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { DataValue, IntentOutputs, jsonSchema, type PluginDefinition } from "@sous-io/plugin-api";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { McpCalledPayload } from "../src/types.js";
import { plugin, serve, type Served, textOf } from "./helpers.js";

/** Intents of every shape MCP has to handle. */
const fixtures: PluginDefinition = plugin("test-intents", (sous) => {
    sous.intents.add({
        intent: "namespace.list",
        summary: "List the namespaces in your subscribed repositories",
        input: z.object({
            repository: z.string().optional().describe("Only this repository"),
            json: z.boolean().default(false).describe("Print JSON"),
        }),
        output: z.object({ namespaces: z.array(z.string()), chain: z.boolean() }),
        cli: { aliases: [["ns", "list"], ["list", "namespaces"]], positional: ["repository"] },
        agent: {
            usage: "Call this before subscribing, to find which namespaces exist.",
            whenNotToUse: "Not for finding a recipe by name; use recipe_search for that.",
        },
        handle: (input, ctx) => {
            ctx.reporter.debug("Reading the catalog.");
            ctx.reporter.info("Read 2 namespaces.");
            ctx.reporter.warning("One repository is offline.", { repository: "example" });

            const data = { namespaces: input.repository ? [input.repository] : ["a", "b"], chain: ctx.chain !== undefined };

            return IntentOutputs.of(data, { result: new DataValue(data) });
        },
    });

    sous.intents.add({
        intent: "recipe.search",
        summary: "Find recipes by name",
        agent: { tool: "recipe_search" },
        input: jsonSchema<{ query: string }>({ type: "object", properties: { query: { type: "string" } }, required: ["query"] }),
        handle: (input) => IntentOutputs.of({ found: 0 }, { summary: `Found 0 recipes for ${input.query}.` }),
    });

    sous.intents.add({ intent: "secret.reset", summary: "Hidden from agents", agent: { hidden: true }, handle: () => IntentOutputs.of({}) });
    sous.intents.add({ intent: "inner.step", internal: true, handle: () => IntentOutputs.of({}) });
    sous.intents.add({ intent: "watch.run", background: true, handle: () => IntentOutputs.of({}) });

    sous.intents.add({
        intent: "vars.ask",
        summary: "Ask for the recipe's variables",
        handle: async (_input, ctx) => {
            const name = await ctx.prompter.askValue({
                message: "Project name?",
                answeredBy: "--name <name>",
                validate: (answer) => (answer.length < 3 ? "Use three letters or more." : undefined),
            });
            const harness = await ctx.prompter.askChoice({
                message: "Which harness?",
                answeredBy: "--harness <id>",
                choices: [
                    { label: "Claude Code", value: "claude" },
                    { label: "Codex", value: "codex" },
                ],
            });
            const sure = await ctx.prompter.confirm({ message: "Write the answers?", answeredBy: "--yes" });

            return IntentOutputs.of({ name, harness, sure });
        },
    });

    sous.intents.add({
        intent: "slow.job",
        summary: "Reports progress",
        handle: (_input, ctx) => {
            ctx.reporter.progress({ label: "Downloading recipes", done: 1, total: 2 });
            ctx.reporter.progress({ label: "Downloading recipes", done: 2, total: 2, finished: true });

            return IntentOutputs.of({ steps: 2 });
        },
    });

    sous.intents.add({
        intent: "always.fails",
        summary: "Fails",
        handle: () => {
            throw new Error("Nothing works.");
        },
    });
});

let served: Served | undefined;

afterEach(async () => {
    await served?.client.close();
    served = undefined;
});

describe("mcp.serve: connecting", () => {
    it("reports sous's name and version, and the project it serves, when a client connects", async () => {
        served = await serve([fixtures]);

        expect(served.client.getServerVersion()).toEqual({ name: "sous", version: "1.2.3" });
        expect(served.client.getInstructions()).toContain("sous 1.2.3, serving the project at /work/project");
        expect(served.client.getServerCapabilities()).toMatchObject({ tools: { listChanged: true }, logging: {} });
    });

    it("says when it serves no project", async () => {
        served = await serve([fixtures], { project: null });

        expect(served.client.getInstructions()).toContain("no project");
    });

    it("stops when the client closes, with how many calls it answered", async () => {
        served = await serve([fixtures]);
        await served.client.callTool({ name: "recipe_search", arguments: { query: "x" } });
        await served.client.callTool({ name: "always_fails", arguments: {} });

        await expect(served.close()).resolves.toEqual({ calls: 2, failed: 1, stoppedBy: "closed" });
        await served.engine.whenBackgroundIntentsReturn();
    });
});

describe("mcp.serve: tools generated from intents", () => {
    it("turns every intent agents may see into a tool, leaving out hidden, internal and background ones", async () => {
        served = await serve([fixtures]);
        const { tools } = await served.client.listTools();
        const names = tools.map((tool) => tool.name);

        expect(names).toEqual(expect.arrayContaining(["namespace_list", "recipe_search", "vars_ask", "slow_job", "always_fails"]));
        expect(names).not.toContain("secret_reset");
        expect(names).not.toContain("inner_step");
        expect(names).not.toContain("watch_run");
        expect(names).not.toContain("mcp_serve");
    });

    it("ignores CLI aliases", async () => {
        served = await serve([fixtures]);
        const { tools } = await served.client.listTools();

        expect(tools.filter((tool) => tool.name.includes("ns") || tool.name.startsWith("list"))).toEqual([]);
    });

    it("describes a tool by its summary, usage and when not to use it, with the input's JSON Schema", async () => {
        served = await serve([fixtures]);
        const { tools } = await served.client.listTools();
        const tool = tools.find((candidate) => candidate.name === "namespace_list")!;

        expect(tool.description).toBe(
            "List the namespaces in your subscribed repositories\n\n" +
                "Call this before subscribing, to find which namespaces exist.\n\n" +
                "When not to use it: Not for finding a recipe by name; use recipe_search for that.",
        );
        expect(tool.inputSchema).toMatchObject({
            type: "object",
            properties: { repository: { type: "string", description: "Only this repository" }, json: { type: "boolean", default: false } },
        });
        expect(tool.outputSchema).toMatchObject({ type: "object", properties: { namespaces: { type: "array" } } });
    });

    it("gives an intent without input an empty object schema", async () => {
        served = await serve([fixtures]);
        const { tools } = await served.client.listTools();

        expect(tools.find((tool) => tool.name === "vars_ask")!.inputSchema).toEqual({ type: "object", properties: {} });
    });

    it("picks tools with mcp.include and mcp.exclude", async () => {
        const settings = plugin("test-settings", (sous) => {
            sous.config.contribute({
                id: "mcp-settings",
                contribute: (config) => {
                    config.atPath("mcp").set({ include: ["*_list", "recipe_*", "vars_*"], exclude: ["vars_*"] });
                },
            });
        });

        served = await serve([fixtures, settings]);
        const { tools } = await served.client.listTools();

        expect(tools.map((tool) => tool.name).sort()).toEqual(["namespace_list", "recipe_search"]);
    });

    it("keeps the first of two intents claiming one tool name, and warns naming both", async () => {
        const rival = plugin("rival", (sous) => {
            sous.intents.add({ intent: "rival.search", agent: { tool: "recipe_search" }, handle: () => IntentOutputs.of({}) });
        });

        served = await serve([fixtures, rival]);
        const { tools } = await served.client.listTools();

        expect(tools.filter((tool) => tool.name === "recipe_search")).toHaveLength(1);
        expect(textOf(await served.client.callTool({ name: "recipe_search", arguments: { query: "q" } }))).toBe("Found 0 recipes for q.");
        expect(served.reporter.at("warning").join("\n")).toMatch(/"recipe\.search" \(test-intents\) and "rival\.search" \(rival\)/);
    });
});

describe("mcp.serve: tool calls", () => {
    it("submits each call as a new chain and returns its result as text and structured content", async () => {
        served = await serve([fixtures]);
        const result = await served.client.callTool({ name: "namespace_list", arguments: { repository: "github.com/x/y" } });

        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toEqual({ namespaces: ["github.com/x/y"], chain: true });
        expect(JSON.parse(textOf(result))).toEqual({ namespaces: ["github.com/x/y"], chain: true });
    });

    it("returns the outputs' text, and their plain object as structured content", async () => {
        served = await serve([fixtures]);

        const result = await served.client.callTool({ name: "recipe_search", arguments: { query: "skills" } });

        expect(textOf(result)).toBe("Found 0 recipes for skills.");
        expect(result.structuredContent).toEqual({ found: 0 });
    });

    it("reports bad input as a tool error naming the field", async () => {
        served = await serve([fixtures]);
        const result = await served.client.callTool({ name: "recipe_search", arguments: {} });

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain('The input to "recipe.search" is not valid.');
        expect(textOf(result)).toContain("query");
    });

    it("reports a failing intent as a tool error", async () => {
        served = await serve([fixtures]);
        const result = await served.client.callTool({ name: "always_fails", arguments: {} });

        expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: "Nothing works." }] });
    });

    it("rejects a call to a tool that does not exist", async () => {
        served = await serve([fixtures]);

        await expect(served.client.callTool({ name: "secret_reset", arguments: {} })).rejects.toThrow(/No sous tool is named "secret_reset"/);
    });

    it("fires mcp.called after every call", async () => {
        const seen: McpCalledPayload[] = [];
        const listener = plugin("listener", (sous) => {
            sous.on("mcp.called", (event) => {
                seen.push(event.payload as McpCalledPayload);
            });
        });

        served = await serve([fixtures, listener]);
        await served.client.callTool({ name: "recipe_search", arguments: { query: "x" } });
        await served.client.callTool({ name: "always_fails", arguments: {} });

        expect(seen.map(({ tool, intent, ok }) => ({ tool, intent, ok }))).toEqual([
            { tool: "recipe_search", intent: "recipe.search", ok: true },
            { tool: "always_fails", intent: "always.fails", ok: false },
        ]);
        expect(seen[0]!.durationMs).toBeGreaterThanOrEqual(0);
    });
});

describe("mcp.serve: the MCP reporter (logging, levels)", () => {
    it("sends a chain's messages as MCP log messages at their levels, info and above by default", async () => {
        served = await serve([fixtures]);
        await served.client.callTool({ name: "namespace_list", arguments: {} });

        expect(served.logs).toEqual([
            { level: "info", logger: "sous", data: "Read 2 namespaces." },
            { level: "warning", logger: "sous", data: { message: "One repository is offline.", style: "plain", repository: "example" } },
        ]);
    });

    it("follows the level the client sets", async () => {
        served = await serve([fixtures]);
        await served.client.setLoggingLevel("debug");
        await served.client.callTool({ name: "namespace_list", arguments: {} });
        expect(served.logs.map((log) => log.level)).toEqual(["debug", "info", "warning"]);

        served.logs.length = 0;
        await served.client.setLoggingLevel("warning");
        await served.client.callTool({ name: "namespace_list", arguments: {} });
        expect(served.logs.map((log) => log.level)).toEqual(["warning"]);
    });

    it("sends progress as progress notifications when the client asks for them", async () => {
        served = await serve([fixtures]);
        const progress: Array<{ progress: number; total?: number; message?: string }> = [];

        await served.client.callTool({ name: "slow_job", arguments: {} }, undefined, { onprogress: (event) => progress.push(event) });

        expect(progress).toEqual([
            { progress: 1, total: 2, message: "Downloading recipes" },
            { progress: 2, total: 2, message: "Downloading recipes" },
        ]);
    });
});

describe("mcp.serve: the elicitation prompter", () => {
    it("asks a chain's questions through MCP elicitation", async () => {
        served = await serve([fixtures], { capabilities: { elicitation: { form: {} } } });
        const asked: string[] = [];
        const answers = [{ answer: "ab" }, { answer: "abc" }, { answer: "1" }, { answer: true }];

        served.client.setRequestHandler(ElicitRequestSchema, (request) => {
            asked.push(request.params.message);

            return { action: "accept", content: answers.shift()! };
        });

        const result = await served.client.callTool({ name: "vars_ask", arguments: {} });

        expect(result.structuredContent).toEqual({ name: "abc", harness: "codex", sure: true });
        expect(asked).toEqual(["Project name?", "Project name?\n\nUse three letters or more.", "Which harness?", "Write the answers?"]);
    });

    it("cancels the chain when the person declines", async () => {
        served = await serve([fixtures], { capabilities: { elicitation: { form: {} } } });
        served.client.setRequestHandler(ElicitRequestSchema, () => ({ action: "decline" }));

        const result = await served.client.callTool({ name: "vars_ask", arguments: {} });

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("declined");
    });

    it("names the argument that answers a question when the client cannot elicit", async () => {
        served = await serve([fixtures]);
        const result = await served.client.callTool({ name: "vars_ask", arguments: {} });

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain('Pass the "name" argument to answer it ahead of time.');
    });
});
