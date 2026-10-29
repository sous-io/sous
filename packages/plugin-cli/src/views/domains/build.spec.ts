import { describe, expect, it } from "vitest";
import type { CliViewContext } from "../../types.js";
import { Printer } from "../printer.js";
import { createStyle } from "../style.js";
import { type BuildPrepareResultShape, skippedLine, unansweredMessage, views } from "./build.js";

/** A plain, uncolored view context 100 columns wide. */
function context(intent: string): CliViewContext {
    const style = createStyle(false);

    return {
        intent,
        input: {},
        globals: {},
        style,
        columns: 100,
        isTTY: false,
        printer: () => new Printer(style, 100, false),
        render: async () => "",
    };
}

const NOTHING: BuildPrepareResultShape = {
    seeded: [],
    locked: { added: [], updated: [], unchanged: true },
    restored: { restored: [], failed: [] },
    newer: [],
    skipped: [],
    unanswered: [],
};

describe("the build views", () => {
    /**
     * A build reports its progress as it runs, so a clean one prints nothing more; a failed one
     * exits 1, as `sous build` did.
     */
    it("should exit 1 for a failed build or compile and print nothing for a clean one", async () => {
        expect(await views.build!({ ok: true }, context("build"))).toBeUndefined();
        expect(await views.build!({ ok: false }, context("build"))).toEqual({ exitCode: 1 });
        expect(await views.compile!({ ok: false }, context("compile"))).toEqual({ exitCode: 1 });
    });

    /** `prune`, `clear`, `build.watch` and `launch` reported everything while they ran. */
    it("should print nothing for prune, clear, build.watch and launch", async () => {
        for (const intent of ["prune", "clear", "build.watch", "launch"]) {
            expect(await views[intent]!({ removed: ["/p/AGENTS.md"], dirsRemoved: [], dryRun: false }, context(intent))).toBeUndefined();
        }
    });

    /** Preparing that changed nothing says nothing. */
    it("should print nothing for a build.prepare that changed nothing", async () => {
        expect(await views["build.prepare"]!(NOTHING, context("build.prepare"))).toBe("");
    });

    /**
     * New pins are announced as today's build-preparation did.
     *
     * ▶ Locking subscribed recipes:
     *   pinned: core/sous-skills at version 0.2.34.
     */
    it("should show new and moved pins, restored recipes and newer versions", async () => {
        const text = (await views["build.prepare"]!(
            {
                ...NOTHING,
                locked: { added: [{ key: "core/sous-skills", to: "0.2.34" }], updated: [{ key: "acme/jira", from: "1.0.0", to: "1.1.0" }], unchanged: false },
                restored: { restored: ["acme/git"], failed: [{ key: "acme/gone", reason: "It is not published." }] },
                newer: [{ key: "acme/jira", from: "1.1.0", to: "1.2.0" }],
            },
            context("build.prepare"),
        )) as string;
        const lines = text.split("\n");

        expect(lines).toContain("▶ Locking subscribed recipes:");
        expect(lines).toContain("    pinned: core/sous-skills at version 0.2.34.");
        expect(lines).toContain("    acme/jira moved from version 1.0.0 to version 1.1.0.");
        expect(text).toContain("The lockfile has been updated. Commit it, so everyone building this project gets exactly these");
        expect(lines).toContain("▶ Restoring recipes:");
        expect(lines).toContain("    restored: acme/git");
        expect(lines).toContain("   WARNING:   ");
        expect(text).toContain("Sous could not restore 'acme/gone'");
        expect(lines).toContain("▶ Newer versions published:");
        expect(lines).toContain("    acme/jira: 1.2.0 this project pins 1.1.0");
        expect(text).toContain("This version is within the range declared for the recipe.");
    });

    /** Unanswered required variables and skipped recipes are listed. */
    it("should warn about unanswered variables and list skipped recipes", async () => {
        const text = (await views["build.prepare"]!(
            {
                ...NOTHING,
                unanswered: [{ definition: { name: "jiraKey" }, recipe: { namespace: "acme", name: "jira" } }],
                skipped: [{ key: "tools/browser", reason: "subscription-disabled", setBy: "conf.d/610-mac.jsonc", message: "Switched off." }],
            },
            context("build.prepare"),
        )) as string;

        expect(text).toContain("jiraKey (asked by acme/jira)");
        expect(text).toContain("Skipped tools/browser: its subscription is switched off (conf.d/610-mac.jsonc).");
    });

    it("should word the unanswered warning and skipped lines as before", () => {
        expect(unansweredMessage([{ definition: { name: "a" }, recipe: { namespace: "n", name: "r" } }])).toBe(
            "1 required recipe variable has no answer, so the templates that use it render an empty value:\n  • a (asked by n/r)\nRun 'sous vars ask' to answer it.",
        );
        expect(skippedLine({ key: "n/r", reason: "untrusted", message: "Its repository is not trusted." })).toBe("Skipped n/r: its repository is not trusted.");
        expect(skippedLine({ key: "n/r", reason: "repository-disabled", message: "" })).toBe("Skipped n/r: its repository is switched off.");
    });
});
