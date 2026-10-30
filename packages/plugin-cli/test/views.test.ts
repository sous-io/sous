import { ConfigError, definePlugin } from "@sous-io/plugin-api";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fakeIo, runCli } from "./helpers.js";

/** An intent with a result a view can show, and a plugin view for it. */
const reportPlugin = definePlugin({
    name: "sous-plugin-report",

    register(sous) {
        sous.intents.add({
            intent: "report.make",
            summary: "Make a report",
            input: z.object({ fail: z.boolean().default(false) }),
            handle: (input) => ({ files: ["a.md", "b.md"], ok: !input.fail }),
        });
        sous.entities.add("cli-view", {
            id: "report.make",
            render: (result: { files: string[]; ok: boolean }, view) => {
                const out = view.printer();

                out.section("Wrote");
                for (const file of result.files) {
                    out.log(`  ✓ ${file}`);
                }

                return result.ok ? out.text() : { stdout: out.text(), stderr: "Warning: the report failed.\n", exitCode: 1 };
            },
        });
    },
});

/** A plugin that replaces another's view: the later entity wins. */
const otherViewPlugin = definePlugin({
    name: "sous-plugin-other-view",

    register(sous) {
        sous.entities.add("cli-view", { id: "report.make", render: (result: { files: string[] }) => `${result.files.length} files` });
    },
});

/** `config.get`-alike, to show a view's error failing the command. */
const missingPlugin = definePlugin({
    name: "sous-plugin-missing",

    register(sous) {
        sous.intents.add({
            intent: "lookup",
            summary: "Look a value up",
            handle: () => ({ exists: false }),
        });
        sous.entities.add("cli-view", {
            id: "lookup",
            render: () => {
                throw new ConfigError("No value at config path 'x'.");
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
            handle: (input) => (input.force ? "forced" : "asked"),
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

                    return { ok: true, watching: input.watch };
                },
            });
            sous.intents.add({
                intent: "watcher",
                summary: "Watch",
                background: true,
                internal: true,
                handle: () =>
                    new Promise<string>((resolve) => {
                        state.stop = () => resolve("stopped");
                    }),
            });
            sous.entities.add("cli-view", { id: "build", render: (result: { ok: boolean }) => (result.ok ? "built" : undefined) });
        },
    });
}

describe("views (cli-view entities)", () => {
    /** A plugin's view shows its intent's result instead of the JSON. */
    it("should show a result through its intent's view", async () => {
        const run = await runCli([reportPlugin], ["report", "make"]);

        expect(run.stdout).toBe(" \n▶ Wrote:\n \n  ✓ a.md\n  ✓ b.md\n");
        expect(run.exitCode).toBeUndefined();
    });

    /** A view can write to standard error and set the exit code (a failed build exits 1). */
    it("should let a view set the exit code and write to standard error", async () => {
        const run = await runCli([reportPlugin], ["report", "make", "--fail"]);

        expect(run.exitCode).toBe(1);
        expect(run.stderr).toContain("Warning: the report failed.");
    });

    /** `--json` prints the plain result, whatever view the intent has. */
    it("should print JSON with --json", async () => {
        const run = await runCli([reportPlugin], ["report", "make", "--json"]);

        expect(JSON.parse(run.stdout)).toEqual({ files: ["a.md", "b.md"], ok: true });
    });

    /** The later view wins, so any plugin can restyle another's result. */
    it("should use the view added last", async () => {
        const run = await runCli([reportPlugin, otherViewPlugin], ["report", "make"]);

        expect(run.stdout).toBe("2 files\n");
    });

    /** An error a view throws fails the command like the intent's own error. */
    it("should fail the command when a view throws a sous error", async () => {
        const run = await runCli([missingPlugin], ["lookup"]);

        expect(run.stderr).toContain("Error: No value at config path 'x'.");
        expect(run.exitCode).toBe(1);
    });

    /** A built-in view given a result of a shape it does not know prints it as JSON instead. */
    it("should print an unexpected result as JSON through a built-in view", async () => {
        const plugin = definePlugin({
            name: "sous-plugin-odd-list",
            register(sous) {
                sous.intents.add({ intent: "vars.list", summary: "Odd", handle: () => ({ odd: true }) });
            },
        });
        const run = await runCli([plugin], ["vars", "list"]);

        expect(JSON.parse(run.stdout)).toEqual({ odd: true });
    });

    /** The banner opens a viewed command on a terminal, on standard error. */
    it("should draw the banner on a terminal only", async () => {
        const io = fakeIo();
        (io.stderr as { isTTY?: boolean }).isTTY = true;

        const run = await runCli([reportPlugin], ["report", "make"], { io });

        expect(run.stderr).toContain("Agent Configuration Manager");
        expect((await runCli([reportPlugin], ["report", "make"])).stderr).not.toContain("Agent Configuration Manager");
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
        expect(run.stdout).toBe("built\nbuilt\n");
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
