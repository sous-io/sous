import { describe, expect, it } from "vitest";
import { BufferedReporter, LogLevel, ReportEntryStyle } from "@sous-io/plugin-api";
import type { DefinedVariable } from "@sous-io/plugin-recipe-answers/types";
import { prunedForSkippedLine, reportLinkedRepos, reportPrepared, reportUnanswered, reportUnincludedMemories, skippedLine } from "./report.js";
import type { BuildPrepareResult } from "./types.js";
import { nestedBuildHeading } from "./build.js";
import { NO_CHANGE, NOTHING_RESTORED } from "./prepare.js";

describe("skippedLine()", () => {
    /**
     * A switched-off subscription is named with the file that switched it off.
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

describe("reportUnanswered()", () => {
    const variable = (name: string) => ({ definition: { name }, recipe: { namespace: "acme", name: "jira" } }) as unknown as DefinedVariable;

    /**
     * Required variables with no answer are listed with the recipe asking, and the fix.
     *
     * reportUnanswered([jiraKey], reporter);
     * // -> a warning list: title "1 required recipe variable has no answer, ...", item "jiraKey (asked by acme/jira)"
     */
    it("should list each unanswered variable and say how to answer", () => {
        const none = new BufferedReporter();

        reportUnanswered([], none);
        expect(none.messages).toEqual([]);

        const one = new BufferedReporter();

        reportUnanswered([variable("jiraKey")], one);
        expect(one.messages).toEqual([
            {
                level: "warning",
                style: ReportEntryStyle.List,
                message:
                    "1 required recipe variable has no answer, so the templates that use it render an empty value:\n  - jiraKey (asked by acme/jira)\nRun 'sous vars ask' to answer it.",
                details: {
                    title: "1 required recipe variable has no answer, so the templates that use it render an empty value:",
                    footer: "Run 'sous vars ask' to answer it.",
                    items: ["jiraKey (asked by acme/jira)"],
                },
            },
        ]);

        const two = new BufferedReporter();

        reportUnanswered([variable("a"), variable("b")], two);
        expect(two.messages[0]!.message).toContain("2 required recipe variables have no answer");
    });
});

describe("messages about preparing", () => {
    const prepared = (overrides: Partial<BuildPrepareResult>): BuildPrepareResult => ({
        seeded: [],
        locked: NO_CHANGE,
        restored: NOTHING_RESTORED,
        newer: [],
        checkedUpstream: false,
        skipped: [],
        unanswered: [],
        ...overrides,
    });

    /**
     * Linked repositories are announced as a list, one item each, at the level given.
     *
     * reportLinkedRepos({ acme: { path: "/src/acme" } }, reporter, "notice");
     * // -> list item "acme -> /src/acme"
     */
    it("should announce linked repositories", () => {
        const none = new BufferedReporter();

        reportLinkedRepos({}, none, LogLevel.Warning);
        expect(none.messages).toEqual([]);

        const one = new BufferedReporter();

        reportLinkedRepos({ acme: { path: "/src/acme" } as never }, one, LogLevel.Warning);
        expect(one.messages[0]).toMatchObject({ level: "warning", style: ReportEntryStyle.List });
        expect(one.messages[0]!.message).toContain("One repository is LINKED to a working copy on this machine.");
        expect(one.messages[0]!.message).toContain("acme -> /src/acme");

        const two = new BufferedReporter();

        reportLinkedRepos({ a: { path: "/a" } as never, b: { path: "/b" } as never }, two, LogLevel.Notice);
        expect(two.messages[0]).toMatchObject({ level: "notice" });
        expect(two.messages[0]!.message).toContain("2 repositories are LINKED");
    });

    /**
     * New and moved pins are listed, with the reminder to commit the lockfile.
     *
     * reportPrepared({ locked: { added: [{ key: "a/b", to: "1.0.0" }], ... } }, reporter);
     * // -> list item "pinned: a/b at version 1.0.0."
     */
    it("should list pins added and moved", () => {
        const none = new BufferedReporter();

        reportPrepared(prepared({}), none);
        expect(none.messages).toEqual([]);

        const reporter = new BufferedReporter();

        reportPrepared(prepared({ locked: { ...NO_CHANGE, unchanged: false, added: [{ key: "a/b", to: "1.0.0" }], updated: [{ key: "a/c", from: "1.0.0", to: "1.1.0" }] } }), reporter);

        const text = reporter.messages.map((entry) => entry.message).join("\n");

        expect(text).toContain("pinned: a/b at version 1.0.0.");
        expect(text).toContain("a/c moved from version 1.0.0 to version 1.1.0.");
        expect(text).toContain("Commit it");
    });

    /**
     * Nothing is said when nothing is newer; otherwise each newer version is listed with the pinned
     * one beside it, and a note says no pin changed.
     *
     * reportPrepared({ newer: [{ key: "a/b", from: "1.0.0", to: "1.2.0" }] }, reporter);
     * // -> variable list entry { label: "a/b", value: "1.2.0", detail: "this project pins 1.0.0" }
     */
    it("should list newer versions and say nothing moved", () => {
        const one = new BufferedReporter();

        reportPrepared(prepared({ newer: [{ key: "a/b", from: "1.0.0", to: "1.2.0" }] }), one);
        expect(one.styled(ReportEntryStyle.VariableList)[0]!.details).toMatchObject({ entries: [{ label: "a/b", value: "1.2.0", detail: "this project pins 1.0.0" }] });
        expect(one.styled(ReportEntryStyle.Note)[0]!.message).toContain("No pin was changed, so this build uses the pinned version.");

        const two = new BufferedReporter();

        reportPrepared(prepared({ newer: [{ key: "a/b", from: "1", to: "2" }, { key: "a/c", from: "1", to: "2" }] }), two);
        expect(two.styled(ReportEntryStyle.Note)[0]!.message).toContain("uses the pinned versions.");
    });

    /**
     * reportPrepared sends each part to the reporter: notices for facts, problems for failures.
     *
     * reportPrepared({ restored: { restored: ["a/b"], failed: [...] }, ... }, reporter);
     */
    it("should report restored recipes, failures and unanswered variables", () => {
        const reporter = new BufferedReporter();

        reportPrepared(
            prepared({
                restored: { ...NOTHING_RESTORED, restored: ["a/b"], failed: [{ key: "a/c", reason: "offline" }] },
                unanswered: [{ definition: { name: "x" }, recipe: { namespace: "a", name: "b" } } as never],
            }),
            reporter,
        );

        expect(reporter.at("notice").join("\n")).toContain("restored: a/b");
        expect(reporter.styled(ReportEntryStyle.Problem)[0]).toMatchObject({
            level: "warning",
            details: { subject: "a/c", cause: "offline" },
        });
        expect(reporter.at("warning").join("\n")).toContain("Sous could not restore 'a/c'");
        expect(reporter.at("warning").join("\n")).toContain("1 required recipe variable has no answer");
    });
});

/** Ported from src/test/integration/memories-warning.test.ts. */
describe("reportUnincludedMemories()", () => {
    /**
     * Nothing is said when nothing is missing; otherwise each memory is named with its recipe, and
     * both fixes are given.
     *
     * reportUnincludedMemories([], reporter) // -> no message
     */
    it("should say nothing for an empty list and name each memory and both fixes otherwise", () => {
        const none = new BufferedReporter();

        reportUnincludedMemories([], none);
        expect(none.messages).toEqual([]);

        const reporter = new BufferedReporter();

        reportUnincludedMemories(
            [
                { recipe: "aaa/app", name: "m.md", path: "/store/aaa/app/memories/m.md" },
                { recipe: "tool/user", name: "m.md", path: "/store/tool/user/memories/m.md" },
            ],
            reporter,
        );

        const text = reporter.at("warning").join("\n");

        expect(text).toContain("2 memories published by your subscribed recipes are not included in any output");
        expect(text).toContain("aaa/app: memories/m.md");
        expect(text).toContain("tool/user: memories/m.md");
        expect(text).toContain('"@#memories/**/*.md"');
        expect(text).toContain("recipes.memories.exclude");
    });
});

describe("nestedBuildHeading()", () => {
    /**
     * A build another command starts says so first, as before the refactor; a build that is the
     * command itself says nothing extra.
     *
     * subscription add -> "Building the project"; launch -> "Building"; build -> none
     */
    it("should name the build only when another command started it", () => {
        const chain = (intent: string) => ({ chain: { id: 1, intent, parallel: false } });

        expect(nestedBuildHeading(chain("subscription.add"))).toBe("Building the project");
        expect(nestedBuildHeading(chain("launch"))).toBe("Building");
        expect(nestedBuildHeading(chain("build"))).toBeUndefined();
        expect(nestedBuildHeading(chain("prune"))).toBeUndefined();
        expect(nestedBuildHeading({ chain: undefined })).toBeUndefined();
    });
});
