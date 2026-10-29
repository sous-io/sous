import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createEngine } from "@sous-io/core";
import { createCliPlugin } from "@sous-io/plugin-cli";
import { describe, expect, it } from "vitest";
import { createMcpPlugin } from "../src/index.js";

/** Runs a command line through plugin-cli, with plugin-mcp serving in memory. */
async function runSous(argv: string[], onServing?: (client: Client) => Promise<void>) {
    const out: string[] = [];
    const err: string[] = [];
    const stdin = new PassThrough();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const io = {
        stdout: { write: (text: string) => out.push(text), isTTY: false },
        stderr: { write: (text: string) => err.push(text), isTTY: false },
        stdin,
        exitCode: undefined as number | undefined,
        setExitCode(code: number) {
            io.exitCode = code;
        },
    };
    const engine = createEngine({
        builtIns: [createCliPlugin({ io: () => io }), createMcpPlugin({ transport: () => serverTransport })],
        app: { name: "sous", version: "1.2.3" },
    });

    await engine.buildConfig();

    const running = engine.frontEnd("cli").start(argv);

    if (onServing) {
        const client = new Client({ name: "cli-test", version: "0" });

        await client.connect(clientTransport);
        await onServing(client);
        await client.close();
    }

    await running;
    await engine.whenBackgroundIntentsReturn();

    return { stdout: out.join(""), stderr: err.join(""), exitCode: io.exitCode };
}

describe("sous mcp", () => {
    it("starts the MCP server, serving the CLI's own intents as tools", async () => {
        let names: string[] = [];
        const result = await runSous(["mcp"], async (client) => {
            names = (await client.listTools()).tools.map((tool) => tool.name);
            expect(client.getServerVersion()?.version).toBe("1.2.3");
        });

        expect(names).toContain("sous_version");
        expect(result.exitCode).toBeUndefined();
        expect(JSON.parse(result.stdout)).toEqual({ calls: 0, failed: 0, stoppedBy: "closed" });
    });

    it("also answers to sous mcp serve", async () => {
        const result = await runSous(["mcp", "serve"], async () => {});

        expect(result.exitCode).toBeUndefined();
    });

    it("has help", async () => {
        const result = await runSous(["mcp", "--help"]);

        expect(result.stdout).toContain("Starts an MCP server on standard input and output.");
        expect(result.stdout).toContain("--transport");
    });
});
