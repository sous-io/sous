import { createEngine } from "@sous-io/core";
import { ConfigError, definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import { describe, expect, it } from "vitest";
import { createCliPlugin } from "../src/plugin.js";
import { fakeIo, runCli } from "./helpers.js";

/** A plugin with a background intent that returns a value, like `mcp.serve`. */
const servePlugin: PluginDefinition = definePlugin({
    name: "test-serve",
    register(sous) {
        sous.intents.add({ intent: "serve", background: true, handle: () => ({ served: true }) });
        sous.intents.add({ intent: "where", handle: (_input, ctx) => ctx.cwd });
    },
});

/** A plugin whose contributor fails, with one intent that tolerates it and one that does not. */
function brokenPlugin(): PluginDefinition {
    return definePlugin({
        name: "test-broken",
        register(sous) {
            sous.config.contribute({
                id: "broken",
                contribute() {
                    throw new ConfigError("The config file is broken.", { details: ["Fix line 3."] });
                },
            });
            sous.intents.add({ intent: "update", toleratesConfigErrors: true, handle: () => "updated" });
            sous.intents.add({ intent: "build", handle: () => "built" });
        },
    });
}

/** Builds the config the way the bin does: a failed build still starts the front end. */
async function runBroken(argv: readonly string[]) {
    const io = fakeIo();
    const engine = createEngine({ builtIns: [createCliPlugin({ io: () => io }), brokenPlugin()], app: { name: "sous", version: "9.8.7" } });

    await engine.buildConfig().catch(() => undefined);
    await engine.frontEnd("cli").start(argv);

    return { stdout: io.out.join(""), stderr: io.err.join(""), exitCode: io.exitCode };
}

describe("the CLI and the engine", () => {
    /** A background intent's result is never printed: standard output belongs to it (sous mcp). */
    it("should not print a background intent's result", async () => {
        const run = await runCli([servePlugin], ["serve"]);

        expect(run.stdout).toBe("");
        expect(run.exitCode ?? 0).toBe(0);
    });

    /** Chains get the process's working directory as ctx.cwd. */
    it("should give chains the process's working directory", async () => {
        const run = await runCli([servePlugin], ["where"]);

        expect(run.stdout.trim()).toContain(process.cwd());
    });

    /** With a broken config, an ordinary command fails with the build's error, as before. */
    it("should fail an ordinary command with the config's error", async () => {
        const run = await runBroken(["build"]);

        expect(run.stdout).toBe("");
        expect(run.stderr).toContain("Error: The config file is broken.\n  Fix line 3.");
        expect(run.exitCode).not.toBe(0);
    });

    /** --help also reports the broken config, as the bin did before the front end started. */
    it("should report the config's error for --help", async () => {
        const run = await runBroken(["--help"]);

        expect(run.stderr).toContain("Error: The config file is broken.");
        expect(run.exitCode).not.toBe(0);
    });

    /** An intent that tolerates config errors runs, with the error as a warning. */
    it("should run an intent that tolerates config errors", async () => {
        const run = await runBroken(["update"]);

        expect(run.stdout).toContain("updated");
        expect(run.stderr).toContain("The config could not be built, so update runs");
        expect(run.exitCode ?? 0).toBe(0);
    });
});
