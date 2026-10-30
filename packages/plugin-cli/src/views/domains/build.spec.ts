import { describe, expect, it } from "vitest";
import { type CapturedView, type CaptureOptions, captureView } from "../testing.js";
import { type BuildPrepareResultShape, views } from "./build.js";

/** Runs a view and returns what a terminal would get (both streams, colors off). */
async function run(intent: string, result: unknown, options: CaptureOptions = {}): Promise<CapturedView & { text: string }> {
    const shown = await captureView(views[intent]!, result, { intent, ...options });

    return { ...shown, text: shown.stdout + shown.stderr };
}

const NOTHING: BuildPrepareResultShape = {
    seeded: [],
    locked: { added: [], updated: [], unchanged: true },
    restored: { restored: [], failed: [] },
    newer: [],
    skippedLines: [],
};

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

    /** Preparing that changed nothing says nothing. */
    it("should print nothing for a build.prepare that changed nothing", async () => {
        expect((await run("build.prepare", NOTHING)).text).toBe("");
    });

    /** New pins are announced as today's build-preparation did. */
    it("should show new and moved pins, restored recipes and newer versions", async () => {
        const { text } = await run("build.prepare", {
            ...NOTHING,
            locked: { added: [{ key: "core/sous-skills", to: "0.2.34" }], updated: [{ key: "acme/jira", from: "1.0.0", to: "1.1.0" }], unchanged: false },
            restored: { restored: ["acme/git"], failed: [{ key: "acme/gone", reason: "It is not published." }] },
            newer: [{ key: "acme/jira", from: "1.1.0", to: "1.2.0" }],
        });
        const flat = text.replace(/\s+/g, " ");

        expect(flat).toContain("Locking subscribed recipes");
        expect(flat).toContain("pinned: core/sous-skills at version 0.2.34.");
        expect(flat).toContain("acme/jira moved from version 1.0.0 to version 1.1.0.");
        expect(flat).toContain("The lockfile has been updated. Commit it, so everyone building this project gets exactly these versions.");
        expect(flat).toContain("Restoring recipes");
        expect(flat).toContain("restored: acme/git");
        expect(flat).toContain("Sous could not restore 'acme/gone'");
        expect(flat).toContain("It is not published.");
        expect(flat).toContain("Newer versions published");
        expect(flat).toMatch(/acme\/jira\s*:?\s*1\.2\.0/);
        expect(flat).toContain("this project pins 1.1.0");
        expect(flat).toContain("This version is within the range declared for the recipe.");
    });

    /** Unanswered required variables and skipped recipes are listed. */
    it("should warn about unanswered variables and list skipped recipes", async () => {
        const shown = await run("build.prepare", {
            ...NOTHING,
            unansweredWarning: {
                title: "1 required recipe variable has no answer, so the templates that use it render an empty value:",
                items: ["jiraKey (asked by acme/jira)"],
                footer: "Run 'sous vars ask' to answer it.",
            },
            skippedLines: ["Skipped tools/browser: its subscription is switched off (conf.d/610-mac.jsonc)."],
        });

        // The warning goes to standard error, the skipped line to standard output.
        expect(shown.stderr).toContain("jiraKey (asked by acme/jira)");
        expect(shown.stdout).toContain("Skipped tools/browser: its subscription is switched off (conf.d/610-mac.jsonc).");
    });
});
