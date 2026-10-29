import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/main.js";

let project: string;

beforeAll(() => {
    project = mkdtempSync(path.join(tmpdir(), "sous-all-"));
    mkdirSync(path.join(project, ".sous"));
    writeFileSync(path.join(project, "sous.config.yaml"), "{}\n");
});

afterAll(() => {
    rmSync(project, { recursive: true, force: true });
});

/** Runs the real `main` with every built-in plugin, capturing stderr and the exit code. */
async function run(args: string[]) {
    let stderr = "";
    let code = 0;

    await main(args, {
        cwd: project,
        env: { HOME: project },
        stderr: { write: (text) => (stderr += text) },
        setExitCode: (value) => (code = value),
    });

    return { stderr, code };
}

describe("an engine with every built-in plugin", () => {
    /**
     * run(["build"]) // -> { stderr: "", code: 0 } in an empty project
     */
    it("starts and builds an empty project", async () => {
        const result = await run(["build"]);

        expect(result.stderr).not.toMatch(/ConfigError|does not match/);
        expect(result.code).toBe(0);
    }, 30_000);
});
