import { describe, expect, it } from "vitest";
import { type CapturedView, type CaptureOptions, captureView } from "../testing.js";
import { views } from "./build.js";

/** Runs a view and returns what a terminal would get (both streams, colors off). */
async function run(intent: string, result: unknown, options: CaptureOptions = {}): Promise<CapturedView & { text: string }> {
    const shown = await captureView(views[intent]!, result, { intent, ...options });

    return { ...shown, text: shown.stdout + shown.stderr };
}

describe("the build views", () => {
    /**
     * A build reports its progress as it runs, so a clean one prints nothing more; a failed one
     * exits 1, as `sous build` did.
     */
    it("should exit 1 for a failed build or compile and print nothing for a clean one", async () => {
        expect(await run("build", { ok: true })).toMatchObject({ text: "" });
        expect((await run("build", { ok: true })).exitCode).toBeUndefined();
        expect((await run("build", { ok: false })).exitCode).toBe(1);
        expect((await run("compile", { ok: false })).exitCode).toBe(1);
    });

    /** Flags that change a build are listed in the "Command Variables" block. */
    it("should list the project and the flags a build ran with", async () => {
        const shown = await run("build", { ok: true }, { input: { dryRun: true, rebuild: true } });

        expect(shown.text).toContain("Command Variables");
        expect(shown.text).toMatch(/Dry Run\s*:?\s*true/);
        expect(shown.text).toMatch(/Rebuild\s*:?\s*true/);
    });

    /** `prune`, `clear`, `build.watch` and `launch` reported everything while they ran. */
    it("should print nothing for prune, clear, build.watch and launch", async () => {
        for (const intent of ["prune", "clear", "build.watch", "launch"]) {
            expect(await run(intent, { removed: ["/p/AGENTS.md"], dirsRemoved: [], dryRun: false })).toMatchObject({ text: "" });
        }
    });
});
