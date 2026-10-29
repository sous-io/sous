import { createEngine } from "@sous-io/core";
import { BufferedReporter, definePlugin, type PluginDefinition, type Sous } from "@sous-io/plugin-api";
import { hostPlugin } from "@sous-io/plugin-host";
import { gitPlugin } from "../src/index.js";
import type { GitRunner } from "../src/types.js";
import type { HostProcesses } from "@sous-io/plugin-host/types";
import { execFileSync } from "node:child_process";

/** A plugin from a register function. */
export function plugin(name: string, register: (sous: Sous) => void): PluginDefinition {
    return definePlugin({ name, version: "1.0.0", register });
}

/** The real `git.runner`, built through the engine with the real plugin-host. */
export async function realRunner(env: Record<string, string | undefined> = { PATH: process.env.PATH, HOME: process.env.HOME }): Promise<GitRunner> {
    const engine = createEngine({ builtIns: [hostPlugin, gitPlugin], reporter: new BufferedReporter(), env });

    return (await engine.buildConfig()).services.get("git.runner");
}

/** The `git.runner` over a stand-in for `host.processes`. */
export async function runnerOver(processes: HostProcesses): Promise<GitRunner> {
    const stand = plugin("sous-plugin-fake-processes", (sous) => sous.services.replace("host.processes", () => processes, { lifetime: "singleton" }));
    const engine = createEngine({ builtIns: [hostPlugin, gitPlugin, stand], reporter: new BufferedReporter(), env: { PATH: "/bin" } });

    return (await engine.buildConfig()).services.get("git.runner");
}

/** Runs git directly, to set up a fixture. */
export function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.test" },
    }).trim();
}
