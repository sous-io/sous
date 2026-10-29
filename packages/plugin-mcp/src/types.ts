/**
 * The contract of plugin-mcp (S6, "Front ends"; S1, "Front Ends"): the `sous mcp` server, with a
 * tool generated from every intent's input schema, MCP logging (`McpReporter`) and elicitation
 * (`ElicitationPrompter`), so every front end can do what another can (C45). It holds no operation
 * itself; it submits the same intents as the CLI.
 *
 * Other plugins import this file type-only.
 */

import type { IntentRequest } from "@sous-io/plugin-api";

/** One MCP tool made from an intent. */
export interface McpToolDefinition {
    /** The tool name: the intent's `agent.tool`, or its name with dots as underscores. */
    readonly name: string;
    /** The intent it runs. */
    readonly intent: string;
    /** The summary, `usage` and `whenNotToUse`, as one description. */
    readonly description: string;
    /** The input's JSON Schema. */
    readonly inputSchema: Readonly<Record<string, unknown>>;
    /** The result's JSON Schema, when the intent declares one. */
    readonly outputSchema?: Readonly<Record<string, unknown>>;
}

/** Turning intents into tools, and tool calls into intent requests (S6: tools generated from intents). */
export interface McpTools {
    /** Every tool: active intents that are neither internal nor `agent.hidden`, filtered by the `mcp` key. */
    list(): McpToolDefinition[];
    /** The intent request a tool call makes; throws an `InputError` for a call that matches no tool. */
    toRequest(tool: string, args: Readonly<Record<string, unknown>>): IntentRequest;
}

/** The `mcp` config key. */
export interface McpSettings {
    /** Only tools whose names match these globs. Default: all. */
    include?: string[];
    /** Leaves out tools whose names match these globs. Default `[]`. */
    exclude: string[];
}

/** `mcp.serve` (background): serves MCP until the client closes. */
export interface McpServeInput {
    /** Default `stdio`. */
    transport?: "stdio";
}

/** The result of `mcp.serve`, when it stops. */
export interface McpServeResult {
    /** How many tool calls it answered. */
    readonly calls: number;
    readonly failed: number;
    readonly stoppedBy: "closed" | "signal" | "error";
}

/** The payload of `mcp.called`: one tool call answered. */
export interface McpCalledPayload {
    readonly tool: string;
    readonly intent: string;
    readonly ok: boolean;
    readonly durationMs: number;
}

declare module "@sous-io/plugin-api" {
    interface SousServices {
        "mcp.tools": McpTools;
    }

    interface SousIntents {
        "mcp.serve": { input: McpServeInput; result: McpServeResult };
    }

    interface SousEvents {
        "mcp.called": McpCalledPayload;
    }

    interface SousConfig {
        mcp: McpSettings;
    }
}
