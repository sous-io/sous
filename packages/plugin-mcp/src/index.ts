/**
 * plugin-mcp: The sous mcp front end: tools generated from intents, MCP logging and elicitation.
 *
 * S6, "Front ends: plugin-cli, plugin-mcp". The contract other plugins code against is `./types.ts`.
 * The MCP SDK loads only when `sous mcp` runs, so other commands never pay for it (G9).
 */

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { definePlugin, jsonSchema, type PluginDefinition } from "@sous-io/plugin-api";
import { buildTools, createMcpTools } from "./tools.js";
import type { McpServeInput, McpSettings } from "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-mcp";

/** Options for {@link createMcpPlugin}. */
export interface McpPluginOptions {
    /** The transport `mcp.serve` uses. Default: standard input and output, stopping on SIGINT and SIGTERM. */
    transport?: () => Transport | Promise<Transport>;
}

/** The schema of the `mcp` config key. */
const settingsSchema = jsonSchema<McpSettings>({
    type: "object",
    properties: {
        include: { type: "array", items: { type: "string" }, description: "Only tools whose names match these globs." },
        exclude: { type: "array", items: { type: "string" }, default: [], description: "Leaves out tools whose names match these globs." },
    },
    additionalProperties: false,
});

/** The schema of `mcp.serve`'s input. */
const serveInputSchema = jsonSchema<McpServeInput>({
    type: "object",
    properties: {
        transport: { type: "string", enum: ["stdio"], default: "stdio", description: "How the client talks to the server." },
    },
    additionalProperties: false,
});

/**
 * The MCP front end (S6, `plugin-mcp`): `sous mcp` serves the project it started in, with a tool for
 * every intent agents may see.
 */
export function createMcpPlugin(options: McpPluginOptions = {}): PluginDefinition {
    return definePlugin({
        name: PLUGIN_NAME,
        version: "0.2.34",
        description: "The sous mcp front end: tools generated from intents, MCP logging and elicitation.",
        dependsOn: {},

        register(sous) {
            sous.entities.add("config-key", {
                id: "mcp",
                description: "MCP server settings: mcp.include and mcp.exclude pick tools by name, with globs.",
                schema: settingsSchema,
            });

            sous.services.add(
                "mcp.tools",
                (config) =>
                    createMcpTools(
                        buildTools(sous.engine.intents.list(), {
                            ...(config.get<string[]>("mcp.include") === undefined ? {} : { include: config.get<string[]>("mcp.include")! }),
                            exclude: config.get<string[]>("mcp.exclude") ?? [],
                        }),
                    ),
                { lifetime: "config" },
            );

            sous.intents.add({
                intent: "mcp.serve",
                summary: "Serve this project to agents over MCP",
                description:
                    "Starts an MCP server on standard input and output. Every command is a tool, and each tool call " +
                    "runs as its own chain, with its messages sent as MCP log messages and its questions as MCP elicitation.",
                input: serveInputSchema,
                background: true,
                cli: { command: ["mcp"], aliases: [["mcp", "serve"]], examples: ["sous mcp"] },
                agent: { hidden: true },

                async load() {
                    const { serveMcp } = await import("./server.js");

                    return async (_input, ctx) => {
                        if (options.transport) {
                            return serveMcp(ctx, { transport: await options.transport() });
                        }

                        const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");

                        const transport = new StdioServerTransport();

                        // The SDK's stdio transport does not notice the client closing standard input;
                        // without this, the server would wait forever (and Node exits with code 13).
                        process.stdin.once("end", () => void transport.close());

                        return serveMcp(ctx, { transport, handleSignals: true });
                    };
                },
            });
        },
    });
}

/** The plugin, serving over standard input and output. */
export const mcpPlugin: PluginDefinition = createMcpPlugin();

export default mcpPlugin;

export { buildTools, createMcpTools, isAgentVisible, matchesGlob, toolDescription, toolName } from "./tools.js";
export type { ToolSet } from "./tools.js";
export { McpReporter } from "./reporter.js";
export type { McpReporterOptions } from "./reporter.js";
export { ElicitationPrompter, argumentFor } from "./prompter.js";
export type { ElicitationPrompterOptions } from "./prompter.js";

export type * from "./types.js";
