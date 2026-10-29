import { describe, expect, it } from "vitest";
import { BufferedReporter } from "@sous-io/plugin-api";
import type { DefinedVariable } from "@sous-io/plugin-recipe-answers/types";
import { linkedReposMessage, lockedMessage, newerMessage, prunedForSkippedLine, reportPrepared, skippedLine, unansweredMessage } from "./report.js";
import { NO_CHANGE, NOTHING_RESTORED } from "./prepare.js";

describe("skippedLine()", () => {
    /**
     * A switched-off subscription is named with the file that switched it off (S4, 3).
     *
     * skippedLine({ key: "tool-usage/automated-browser-tasks", reason: "subscription-disabled", setBy: "conf.d/610-mac.jsonc" });
     * // -> "Skipped tool-usage/automated-browser-tasks: its subscription is switched off (conf.d/610-mac.jsonc)."
     */
    it("should say a recipe was skipped because its subscription is switched off", () => {
        expect(skippedLine({ key: "tool-usage/automated-browser-tasks", reason: "subscription-disabled", setBy: "conf.d/610-mac.jsonc", message: "x" })).toBe(
            "Skipped tool-usage/automated-browser-tasks: its subscription is switched off (conf.d/610-mac.jsonc).",
        );
    });

    /**
     * Any other reason uses the recipe plugin's own sentence.
     *
     * skippedLine({ key: "a/b", reason: "untrusted", message: "Its repository is not trusted." });
     * // -> "Skipped a/b: its repository is not trusted."
     */
    it("should use the message for other reasons", () => {
        expect(skippedLine({ key: "a/b", reason: "untrusted", message: "Its repository is not trusted." })).toBe("Skipped a/b: its repository is not trusted.");
        expect(skippedLine({ key: "a/b", reason: "repository-disabled", message: "" })).toBe("Skipped a/b: its repository is switched off.");
    });

    /**
     * The follow-up line counts the outputs pruned.
     *
     * prunedForSkippedLine(4, false); // -> "Pruned 4 outputs it had written."
     */
    it("should count the outputs pruned", () => {
        expect(prunedForSkippedLine(4, false)).toBe("Pruned 4 outputs it had written.");
        expect(prunedForSkippedLine(1, true)).toBe("Would prune 1 output it had written.");
    });
});

describe("unansweredMessage()", () => {
    const variable = (name: string) => ({ definition: { name }, recipe: { namespace: "acme", name: "jira" } }) as unknown as DefinedVariable;

    /**
     * Required variables with no answer are listed with the recipe asking, and the fix.
     *
     * unansweredMessage([jiraKey]);
     * // -> "1 required recipe variable has no answer, ...\n  • jiraKey (asked by acme/jira)\nRun 'sous vars ask' to answer it."
     */
    it("should list each unanswered variable and say how to answer", () => {
        expect(unansweredMessage([])).toBeUndefined();
        expect(unansweredMessage([variable("jiraKey")])).toBe(
            "1 required recipe variable has no answer, so the templates that use it render an empty value:\n  • jiraKey (asked by acme/jira)\nRun 'sous vars ask' to answer it.",
        );
        expect(unansweredMessage([variable("a"), variable("b")])).toContain("2 required recipe variables have no answer");
    });
});

describe("messages about preparing", () => {
    /**
     * Linked repositories are announced, one line each.
     *
     * linkedReposMessage({ acme: { path: "/src/acme" } }); // -> "One repository is LINKED...\nacme -> /src/acme..."
     */
    it("should announce linked repositories", () => {
        expect(linkedReposMessage({})).toBeUndefined();
        expect(linkedReposMessage({ acme: { path: "/src/acme" } as never })).toContain("One repository is LINKED to a working copy on this machine.\n");
        expect(linkedReposMessage({ a: { path: "/a" } as never, b: { path: "/b" } as never })).toContain("2 repositories are LINKED");
    });

    /**
     * New and moved pins are listed, with the reminder to commit the lockfile.
     *
     * lockedMessage({ added: [{ key: "a/b", to: "1.0.0" }], ... }); // -> "  pinned: a/b at version 1.0.0.\n..."
     */
    it("should list pins added and moved", () => {
        expect(lockedMessage(NO_CHANGE)).toBeUndefined();

        const text = lockedMessage({ ...NO_CHANGE, unchanged: false, added: [{ key: "a/b", to: "1.0.0" }], updated: [{ key: "a/c", from: "1.0.0", to: "1.1.0" }] });

        expect(text).toContain("  pinned: a/b at version 1.0.0.");
        expect(text).toContain("  a/c moved from version 1.0.0 to version 1.1.0.");
        expect(text).toContain("Commit it");
    });

    /**
     * Ported from build-preparation.spec.ts: nothing when nothing is newer; otherwise each newer
     * version beside the pinned one, and that no pin changed.
     *
     * newerMessage([{ key: "a/b", from: "1.0.0", to: "1.2.0" }]); // -> "...a/b: 1.2.0 (this project pins 1.0.0)..."
     */
    it("should list newer versions and say nothing moved", () => {
        expect(newerMessage([])).toBeUndefined();

        const one = newerMessage([{ key: "a/b", from: "1.0.0", to: "1.2.0" }]);

        expect(one).toContain("a/b: 1.2.0 (this project pins 1.0.0)");
        expect(one).toContain("No pin was changed, so this build uses the pinned version.");
        expect(newerMessage([{ key: "a/b", from: "1", to: "2" }, { key: "a/c", from: "1", to: "2" }])).toContain("uses the pinned versions.");
    });

    /**
     * reportPrepared sends each part to the reporter: notes for facts, warnings for failures.
     *
     * reportPrepared({ restored: { restored: ["a/b"], failed: [...] }, ... }, reporter);
     */
    it("should report restored recipes, failures and unanswered variables", () => {
        const reporter = new BufferedReporter();

        reportPrepared(
            {
                seeded: [],
                locked: NO_CHANGE,
                restored: { ...NOTHING_RESTORED, restored: ["a/b"], failed: [{ key: "a/c", reason: "offline" }] },
                newer: [],
                checkedUpstream: false,
                skipped: [],
                unanswered: [{ definition: { name: "x" }, recipe: { namespace: "a", name: "b" } } as never],
            },
            reporter,
        );

        expect(reporter.at("notice").join("\n")).toContain("  restored: a/b");
        expect(reporter.at("warning").join("\n")).toContain("Sous could not restore 'a/c'");
        expect(reporter.at("warning").join("\n")).toContain("1 required recipe variable has no answer");
    });
});
