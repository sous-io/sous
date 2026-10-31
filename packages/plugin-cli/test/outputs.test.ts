import { commandVariables, definePlugin, IntentOutput, IntentOutputs, ReportEntryStyle, SousError, Table, TextBlock, VariableSet } from "@sous-io/plugin-api";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fakeIo, runCli } from "./helpers.js";
import { data, text } from "./outputs.js";

/** An intent returning outputs: a heading, a table, and a note, with machine data for `--json`. */
const reportPlugin = definePlugin({
    name: "sous-plugin-report",

    register(sous) {
        sous.intents.add({
            intent: "report.make",
            summary: "Make a report",
            input: z.object({ fail: z.boolean().default(false) }),
            handle: (input) => {
                const files = ["a.md", "b.md"];
                const outputs = new IntentOutputs([
                    new IntentOutput({ title: "Wrote", summary: "Two files.", result: new Table([{ key: "file", header: "File" }], files.map((file) => ({ file }))) }),
                    new IntentOutput({ result: new TextBlock("Check them."), style: ReportEntryStyle.Note, data: { files, ok: !input.fail } }),
                ]);

                return input.fail ? outputs.withExitCode(1) : outputs;
            },
        });
    },
});

/** `clear`, with the confirmation flag spelled `--force` and `--yes`, as plugin-build declares it. */
const clearPlugin = definePlugin({
    name: "sous-plugin-clear",

    register(sous) {
        sous.intents.add({
            intent: "clear",
            summary: "Delete every file sous wrote",
            input: z.object({ force: z.boolean().default(false), dryRun: z.boolean().default(false) }),
            cli: { flags: { force: { short: "f", aliases: ["yes"] } } },
            handle: (input) => text(input.force ? "forced" : "asked"),
        });
    },
});

/** `build --watch`: starts a background intent that runs until it is interrupted. */
function watchPlugin(state: { builds: Array<Record<string, unknown>>; stop?: () => void }) {
    return definePlugin({
        name: "sous-plugin-watch",

        register(sous) {
            sous.intents.add({
                intent: "build",
                summary: "Build",
                input: z.object({ watch: z.boolean().default(false) }),
                handle: (input, ctx) => {
                    state.builds.push(input);

                    if (input.watch) {
                        void ctx.engine.submit({ intent: "watcher" });
                    }

                    return IntentOutputs.of({ ok: true, watching: input.watch }, { result: new TextBlock("built", { verbatim: true }) });
                },
            });
            sous.intents.add({
                intent: "watcher",
                summary: "Watch",
                background: true,
                internal: true,
                handle: () =>
                    new Promise<IntentOutputs>((resolve) => {
                        state.stop = () => resolve(new IntentOutputs());
                    }),
            });
        },
    });
}

describe("showing the outputs an intent returns", () => {
    /** Each output is drawn in order on standard output: heading, summary, payload, note. */
    it("should draw the outputs on standard output", async () => {
        const run = await runCli([reportPlugin], ["report", "make"]);

        expect(run.stdout).toBe("▶ Wrote:\n \n  Two files.\n  File\n  ----\n  a.md\n  b.md\n  Check them.\n \n \n");
        expect(run.stderr).toBe("");
        expect(run.exitCode).toBeUndefined();
    });

    /** The exit code the outputs carry becomes the command's exit code. */
    it("should set the exit code the outputs carry", async () => {
        const run = await runCli([reportPlugin], ["report", "make", "--fail"]);

        expect(run.exitCode).toBe(1);
        expect(run.stdout).toContain("Wrote");
    });

    /** `--json` prints the last output's plain object (its `data`) and nothing else on standard output. */
    it("should print the last output's data with --json", async () => {
        const run = await runCli([reportPlugin], ["report", "make", "--json"]);

        expect(JSON.parse(run.stdout)).toEqual({ files: ["a.md", "b.md"], ok: true });
    });

    /** With no `data`, the plain object is the payload's own: `{ rows }` for a table. */
    it("should fall back to the payload's plain object", async () => {
        const plugin = definePlugin({
            name: "sous-plugin-table",
            register(sous) {
                sous.intents.add({
                    intent: "table.show",
                    handle: () => new IntentOutputs(new IntentOutput({ result: new Table([{ key: "n", header: "N" }], [{ n: 1 }]) })),
                });
            },
        });

        expect(JSON.parse((await runCli([plugin], ["table", "show", "--json"])).stdout)).toEqual({ rows: [{ n: 1 }] });
    });

    /** The "Command Variables" output of `commandVariables` opens a result with its own look. */
    it("should draw command variables first", async () => {
        const plugin = definePlugin({
            name: "sous-plugin-vars",
            register(sous) {
                sous.intents.add({
                    intent: "vars.demo",
                    handle: (_input, ctx) =>
                        new IntentOutputs([commandVariables(ctx, { Reading: "the cache" }), new IntentOutput({ result: new VariableSet({ Count: 2 }) })]),
                });
            },
        });
        const run = await runCli([plugin], ["vars", "demo"]);

        expect(run.stdout).toContain("$ Command Variables:\n    Reading: the cache\n");
        expect(run.stdout).toContain("Count: 2");
    });

    /** A failure the intent throws is reported with its causes on standard error, and sets the exit code. */
    it("should report a thrown error and its cause on standard error", async () => {
        const plugin = definePlugin({
            name: "sous-plugin-throws",
            register(sous) {
                sous.intents.add({
                    intent: "lookup",
                    handle: () => {
                        throw new SousError("No value at config path 'x'.", { cause: new Error("The file is empty.") });
                    },
                });
            },
        });
        const run = await runCli([plugin], ["lookup"]);

        expect(run.stdout).toBe("");
        expect(run.stderr).toBe("Error: No value at config path 'x'.\n  Caused by: The file is empty.\n");
        expect(run.exitCode).toBe(1);
    });

    /** The banner opens a command on a terminal, on standard error. */
    it("should draw the banner on a terminal only", async () => {
        const io = fakeIo();
        (io.stderr as { isTTY?: boolean }).isTTY = true;

        const run = await runCli([reportPlugin], ["report", "make"], { io });

        expect(run.stderr).toContain("Agent Configuration Manager");
        expect((await runCli([reportPlugin], ["report", "make"])).stderr).not.toContain("Agent Configuration Manager");
    });

    /** Data-only outputs show as JSON when they carry a `DataValue` result. */
    it("should show a data value as JSON", async () => {
        const plugin = definePlugin({ name: "sous-plugin-data", register: (sous) => sous.intents.add({ intent: "data.show", handle: () => data({ a: 1 }) }) });

        expect((await runCli([plugin], ["data", "show"])).stdout).toBe('{\n  "a": 1\n}\n');
    });
});

describe("several short forms per flag", () => {
    /** `sous clear -y`, `-f`, `--yes` and `--force` all answer the confirmation, as before. */
    it("should accept -y, -f, --yes and --force for clear", async () => {
        for (const flag of ["-y", "-f", "--yes", "--force"]) {
            expect((await runCli([clearPlugin], ["clear", flag])).stdout).toBe("forced\n");
        }

        expect((await runCli([clearPlugin], ["clear"])).stdout).toBe("asked\n");
    });

    /** Help names every other spelling. */
    it("should list the other spellings in help", async () => {
        const run = await runCli([clearPlugin], ["clear", "--help"]);

        expect(run.stdout).toMatch(/-f, --force\s+\(also -y, --yes\)/);
    });
});

describe("watch mode keys", () => {
    /**
     * In a terminal, any key rebuilds (the command again, without `--watch`) and Q stops watch
     * mode, as before the refactor.
     */
    it("should rebuild on any key and stop on Q", async () => {
        const state: { builds: Array<Record<string, unknown>>; stop?: () => void } = { builds: [] };
        const io = fakeIo({ tty: true });
        let interrupted = 0;

        io.interrupt = () => {
            interrupted++;
            state.stop?.();
        };

        const done = runCli([watchPlugin(state)], ["build", "--watch"], { io });

        await waitFor(() => io.err.join("").includes("Press Q to quit"));
        (io.stdin as unknown as NodeJS.WritableStream).write("r");
        await waitFor(() => state.builds.length === 2);
        (io.stdin as unknown as NodeJS.WritableStream).write("q");

        const run = await done;

        expect(state.builds).toEqual([{ watch: true }, { watch: false }]);
        expect(interrupted).toBe(1);
        expect(run.stdout.match(/^built$/gm)).toHaveLength(2);
        expect(run.stderr).toContain("Manual rebuild triggered.");
    });

    /** Without a terminal there are no keys: the command waits for watch mode to stop. */
    it("should not read keys without a terminal", async () => {
        const state: { builds: Array<Record<string, unknown>>; stop?: () => void } = { builds: [] };
        const io = fakeIo();
        const done = runCli([watchPlugin(state)], ["build", "--watch"], { io });

        await waitFor(() => state.stop !== undefined);
        expect(io.err.join("")).not.toContain("Press Q");
        state.stop?.();
        await done;
        expect(state.builds).toHaveLength(1);
    });
});

async function waitFor(check: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
        if (check()) {
            return;
        }

        await new Promise((resolve) => setTimeout(resolve, 5));
    }

    throw new Error("Timed out waiting.");
}
