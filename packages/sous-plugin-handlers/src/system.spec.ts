import { describe, expect, it } from "vitest";
import type { HostProcesses, ProcessResult } from "@sous-io/sous-plugin-host/types";
import { createHandlersSystem, versionIn } from "./system.js";

/** A `host.processes` that knows some commands and records what it is asked. */
function fakeProcesses(installed: Record<string, { file: string; output: string }>) {
    const asked = { which: [] as string[], run: [] as string[] };
    const processes = {
        async which(command: string) {
            asked.which.push(command);

            return installed[command]?.file;
        },
        async run(command: string, args: readonly string[]) {
            asked.run.push([command, ...args].join(" "));

            const output = Object.values(installed).find((one) => one.file === command)?.output ?? "";

            return { command, args, exitCode: 0, signal: null, stdout: output, stderr: "", durationMs: 1, timedOut: false } as ProcessResult;
        },
    } as unknown as HostProcesses;

    return { processes, asked };
}

describe("versionIn()", () => {
    /**
     * versionIn finds the first version number in a command's output.
     *
     * versionIn("git version 2.43.0")  // -> "2.43.0"
     * versionIn("jq-1.7.1")            // -> "1.7.1"
     * versionIn("v20.11.1-rc.1")       // -> "20.11.1-rc.1"
     * versionIn("no version here")     // -> undefined
     */
    it("should give the first version number in the output, or undefined", () => {
        expect(versionIn("git version 2.43.0")).toBe("2.43.0");
        expect(versionIn("jq-1.7.1")).toBe("1.7.1");
        expect(versionIn("v20.11.1-rc.1")).toBe("20.11.1-rc.1");
        expect(versionIn("pandoc 3.1\nCopyright")).toBe("3.1");
        expect(versionIn("no version here")).toBeUndefined();
    });
});

describe("createHandlersSystem()", () => {
    /**
     * isAppAvailable asks host.processes.which once per command, however often it is asked;
     * appVersion runs `<path> --version` once per command, and a missing command has no version.
     *
     * isAppAvailable("git") x2  // -> true, which("git") asked once
     * appVersion("git") x2      // -> "2.43.0", run once
     * appVersion("jira")        // -> undefined, nothing run
     */
    it("should answer each command once per run", async () => {
        const { processes, asked } = fakeProcesses({ git: { file: "/usr/bin/git", output: "git version 2.43.0\n" } });
        const system = createHandlersSystem(() => processes, {});

        expect(await system.isAppAvailable("git")).toBe(true);
        expect(await system.isAppAvailable("git")).toBe(true);
        expect(await system.appVersion("git")).toBe("2.43.0");
        expect(await system.appVersion("git")).toBe("2.43.0");
        expect(await system.isAppAvailable("jira")).toBe(false);
        expect(await system.appVersion("jira")).toBeUndefined();

        expect(asked.which).toEqual(["git", "jira"]);
        expect(asked.run).toEqual(["/usr/bin/git --version"]);
    });
});
