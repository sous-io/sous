import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ClientCapabilities, LoggingMessageNotification } from "@modelcontextprotocol/sdk/types.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createEngine, type Engine } from "@sous-io/core";
import { BufferedReporter, definePlugin, type PluginDefinition, type ProjectInfo, type Sous } from "@sous-io/plugin-api";
import { createMcpPlugin } from "../src/index.js";
import type { McpServeResult } from "../src/types.js";

/** A running `mcp.serve` with a connected in-memory client. */
export interface Served {
    readonly engine: Engine;
    readonly client: Client;
    /** Engine-level and `mcp.serve` messages (the terminal, in a real run). */
    readonly reporter: BufferedReporter;
    /** Every log message the client received. */
    readonly logs: Array<LoggingMessageNotification["params"]>;
    /** Resolves when the server stops. */
    readonly serving: Promise<McpServeResult>;
    /** Closes the client and waits for the server to stop. */
    close(): Promise<McpServeResult>;
}

/** The project tests serve. */
export const PROJECT: ProjectInfo = {
    root: "/work/project",
    sousDir: "/work/project/.sous",
    configPath: "/work/project/.sous/sous.config.yaml",
    confDir: "/work/project/.sous/conf.d",
};

/** A plugin from a register function. */
export function plugin(name: string, register: (sous: Sous) => void | Promise<void>): PluginDefinition {
    return definePlugin({ name, version: "1.0.0", register });
}

/** Starts an engine with plugin-mcp and the given plugins, serves MCP in memory, and connects a client. */
export async function serve(
    plugins: readonly PluginDefinition[],
    options: { capabilities?: ClientCapabilities; project?: ProjectInfo | null } = {},
): Promise<Served> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const reporter = new BufferedReporter();
    const engine = createEngine({
        builtIns: [createMcpPlugin({ transport: () => serverTransport }), ...plugins],
        reporter,
        app: { name: "sous", version: "1.2.3" },
        ...(options.project === null ? {} : { project: options.project ?? PROJECT }),
    });

    await engine.buildConfig();

    const serving = engine.submit({ intent: "mcp.serve" }, { reporter }) .then((outputs) => outputs.toPlain() as unknown as McpServeResult);
    const client = new Client({ name: "test-client", version: "0.0.1" }, { capabilities: options.capabilities ?? {} });
    const logs: Array<LoggingMessageNotification["params"]> = [];

    client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
        logs.push(notification.params);
    });

    await client.connect(clientTransport);

    return {
        engine,
        client,
        reporter,
        logs,
        serving,
        async close() {
            await client.close();

            return serving;
        },
    };
}

/** The text of a tool result's first content block. */
export function textOf(result: unknown): string {
    const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];

    return content[0]?.text ?? "";
}
