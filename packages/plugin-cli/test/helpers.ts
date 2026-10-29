import { PassThrough } from "node:stream";
import { createEngine } from "@sous-io/core";
import type { PluginDefinition } from "@sous-io/plugin-api";
import type { CliIo } from "../src/io.js";
import { createCliPlugin } from "../src/plugin.js";

/** A fake terminal: what the CLI wrote, and the exit code it set. */
export interface FakeIo extends CliIo {
    readonly out: string[];
    readonly err: string[];
    exitCode: number | undefined;
    stdout: CliIo["stdout"] & { isTTY?: boolean };
}

/** Streams that record what the CLI writes. `tty` makes them look like a terminal. */
export function fakeIo(options: { tty?: boolean; input?: string } = {}): FakeIo {
    const out: string[] = [];
    const err: string[] = [];
    const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };

    stdin.isTTY = options.tty ?? false;

    if (options.input !== undefined) {
        stdin.end(options.input);
    }

    const io: FakeIo = {
        out,
        err,
        exitCode: undefined,
        stdout: { write: (text: string) => out.push(text), isTTY: options.tty ?? false },
        stderr: { write: (text: string) => err.push(text), isTTY: false },
        stdin,
        setExitCode(code) {
            io.exitCode = code;
        },
    };

    return io;
}

/** Runs one command line through a real engine with plugin-cli and the given plugins. */
export async function runCli(
    plugins: readonly PluginDefinition[],
    argv: readonly string[],
    options: { env?: Record<string, string>; io?: FakeIo } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number | undefined; io: FakeIo }> {
    const io = options.io ?? fakeIo();
    const engine = createEngine({
        builtIns: [createCliPlugin({ io: () => io }), ...plugins],
        env: options.env ?? {},
        app: { name: "sous", version: "9.8.7" },
    });

    try {
        await engine.buildConfig();
    } catch (error) {
        io.err.push(`BUILD FAILED: ${(error as Error).message}\n${((error as { details?: string[] }).details ?? []).join("\n")}`);

        return { stdout: io.out.join(""), stderr: io.err.join(""), exitCode: -1, io };
    }

    await engine.frontEnd("cli").start(argv);
    await engine.whenBackgroundIntentsReturn();

    return { stdout: io.out.join(""), stderr: io.err.join(""), exitCode: io.exitCode, io };
}
