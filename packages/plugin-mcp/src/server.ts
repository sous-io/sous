import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
    CallToolRequestSchema,
    type CallToolResult,
    ErrorCode,
    ListToolsRequestSchema,
    McpError,
    SetLevelRequestSchema,
    type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { type Context, isSousError, type LogLevel } from "@sous-io/plugin-api";
import { ElicitationPrompter } from "./prompter.js";
import { McpReporter } from "./reporter.js";
import type { McpServeResult, McpToolDefinition, McpTools } from "./types.js";

/** What {@link serveMcp} serves over. */
export interface ServeOptions {
    /** The transport to the client. */
    readonly transport: Transport;
    /** Stops on SIGINT and SIGTERM. Default false; the stdio server turns it on. */
    readonly handleSignals?: boolean;
}

/** The level log messages start at, until the client asks for another. */
const DEFAULT_LEVEL: LogLevel = "info";

/**
 * Serves MCP until the client closes. Each tool call is
 * submitted as a new chain with an {@link McpReporter} and an {@link ElicitationPrompter}, so its
 * output and questions go back to the client that called it. The server reports sous's name and
 * version when a client connects, so the Claude Code plugin can check the oldest sous it supports.
 */
export async function serveMcp(ctx: Context, options: ServeOptions): Promise<McpServeResult> {
    const engine = ctx.engine;
    const server = new Server(
        { name: engine.app.name, version: engine.app.version },
        { capabilities: { tools: { listChanged: true }, logging: {} }, instructions: instructionsFor(ctx) },
    );
    let threshold: LogLevel = DEFAULT_LEVEL;
    let calls = 0;
    let failed = 0;
    let transportFailed = false;
    let signalled = false;
    let warnedFor: string | undefined;

    /** The tools of the latest config; warnings are reported once per config. */
    const currentTools = (): McpTools => {
        const service = engine.config.services.get("mcp.tools") as McpTools & { warnings?: readonly string[] };

        if (warnedFor !== engine.config.hash) {
            warnedFor = engine.config.hash;

            for (const warning of service.warnings ?? []) {
                ctx.reporter.warning(warning);
            }
        }

        return service;
    };

    server.setRequestHandler(SetLevelRequestSchema, (request) => {
        threshold = request.params.level;

        return {};
    });

    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: currentTools().list().map(toMcpTool) }));

    server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
        const service = currentTools();
        const name = request.params.name;
        const tool = service.list().find((candidate) => candidate.name === name);

        if (!tool) {
            throw new McpError(ErrorCode.InvalidParams, `No sous tool is named "${name}".`);
        }

        const progressToken = extra._meta?.progressToken;
        const reporter = new McpReporter({
            send: (notification) => extra.sendNotification(notification),
            threshold: () => threshold,
            ...(progressToken === undefined ? {} : { progressToken }),
        });
        const prompter = new ElicitationPrompter({
            canElicit: server.getClientCapabilities()?.elicitation !== undefined,
            elicit: (params) => server.elicitInput(params, { relatedRequestId: extra.requestId }),
        });
        const hashBefore = engine.config.hash;
        const started = performance.now();
        let result: CallToolResult;

        try {
            const value = await engine.submit(service.toRequest(name, request.params.arguments ?? {}), {
                reporter,
                prompter,
                // An agent's relative paths mean the project, not wherever the server was started.
                cwd: ctx.project?.root ?? ctx.cwd,
            });

            result = successResult(value, tool);
        } catch (error) {
            failed++;
            result = errorResult(error);
        }

        calls++;

        try {
            await ctx.emit("mcp.called", {
                tool: name,
                intent: tool.intent,
                ok: result.isError !== true,
                durationMs: performance.now() - started,
            });
        } catch (error) {
            ctx.reporter.warning(`A listener of mcp.called failed: ${(error as Error).message}`);
        }

        if (engine.config.hash !== hashBefore) {
            server.sendToolListChanged().catch(() => {});
        }

        return result;
    });

    server.oninitialized = () => {
        const client = server.getClientVersion();
        const who = client ? `${client.name} ${client.version}` : "an MCP client";

        ctx.reporter.info(`MCP: ${who} connected to ${engine.app.name} ${engine.app.version}.`);
    };

    server.onerror = (error) => {
        transportFailed = true;
        ctx.reporter.warning(`MCP: ${error.message}`);
    };

    const closed = new Promise<void>((resolve) => {
        server.onclose = () => resolve();
    });
    const stop = (): void => {
        signalled = true;
        void server.close();
    };

    if (options.handleSignals) {
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
    }

    try {
        await server.connect(options.transport);
        await closed;
    } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
    }

    return { calls, failed, stoppedBy: signalled ? "signal" : transportFailed ? "error" : "closed" };
}

/** A tool as MCP lists it. */
function toMcpTool(tool: McpToolDefinition): Tool {
    return {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Tool["inputSchema"],
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema as NonNullable<Tool["outputSchema"]> } : {}),
    };
}

/** An intent's result as a tool result: text for every client, and the object itself when it is one. */
function successResult(value: unknown, tool: McpToolDefinition): CallToolResult {
    const structured = isPlainObject(value) ? value : undefined;

    return {
        content: [{ type: "text", text: resultText(value) }],
        ...(structured ? { structuredContent: structured } : tool.outputSchema ? { structuredContent: { result: value } } : {}),
    };
}

/** An error as a tool result, so the agent reads what went wrong and how to fix it. */
function errorResult(error: unknown): CallToolResult {
    const message = error instanceof Error ? error.message : String(error);
    const details = isSousError(error) ? error.details : [];
    const text = [message, ...details.map((detail) => `  ${detail}`)].join("\n");

    return { isError: true, content: [{ type: "text", text }] };
}

/** The text of a result, written the way the CLI prints it. */
export function resultText(value: unknown): string {
    if (value === undefined || value === null) {
        return "Done.";
    }

    if (typeof value === "string") {
        return value;
    }

    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
        return String(value);
    }

    return JSON.stringify(value, null, 2);
}

/** What the server tells the client about itself. */
function instructionsFor(ctx: Context): string {
    const { name, version } = ctx.engine.app;
    const where = ctx.project
        ? `the project at ${ctx.project.root}`
        : "no project (none was found where the server started; tools that need one will fail)";

    return `${name} ${version}, serving ${where}. Every tool runs a ${name} intent, as the matching ${name} command does.`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
