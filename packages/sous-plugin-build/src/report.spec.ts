import { describe, expect, it } from "vitest";
import { BufferedReporter, ItemList, LogLevel, messageText, ReportEntryStyle } from "@sous-io/sous-plugin-api";
import type { DefinedVariable } from "@sous-io/sous-plugin-recipe-answers/types";
import { filesSummaryLine, prunedForSkippedLine, reportLinkedRepos, reportPrepared, reportUnanswered, reportUnincludedMemories, skippedLine } from "./report.js";
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
     * A recipe reached only through a switched-off subscription names that subscription, since it
     * has no subscription of its own.
     *
     * skippedLine({ key: "communication/agent-conduct", reason: "subscription-disabled", subscription: "omakase/house", indirect: true, setBy: "conf.d/520-local.jsonc" });
     * // -> "Skipped communication/agent-conduct: reached only through omakase/house, which is switched off (conf.d/520-local.jsonc)."
     */
    it("should name the switched-off subscription that reaches a dependency", () => {
        expect(
            skippedLine({ key: "communication/agent-conduct", reason: "subscription-disabled", subscription: "omakase/house", indirect: true, setBy: "conf.d/520-local.jsonc", message: "x" }),
        ).toBe("Skipped communication/agent-conduct: reached only through omakase/house, which is switched off (conf.d/520-local.jsonc).");
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
        expect(one.messages).toHaveLength(1);
        expect(one.messages[0]).toMatchObject({ level: "warning", style: ReportEntryStyle.List });
        expect(one.messages[0]!.message).toBeInstanceOf(ItemList);
        expect(one.messages[0]!.message).toMatchObject({
            title: "1 required recipe variable has no answer, so the templates that use it render an empty value:",
            footer: "Run 'sous vars ask' to answer it.",
            items: ["jiraKey (asked by acme/jira)"],
        });

        const two = new BufferedReporter();

        reportUnanswered([variable("a"), variable("b")], two);
        expect(messageText(two.messages[0]!.message)).toContain("2 required recipe variables have no answer");
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
        unanswerable: [],
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
        expect(messageText(one.messages[0]!.message)).toContain("One repository is LINKED to a working copy on this machine.");
        expect(messageText(one.messages[0]!.message)).toContain("acme -> /src/acme");
        // One repository reads "its ... that checkout", not "their ... those checkouts" (gh-229).
        expect(messageText(one.messages[0]!.message)).toContain("Its recipes are read from that checkout, so versions, the lockfile and freshness checks do not apply to it.");

        const two = new BufferedReporter();

        reportLinkedRepos({ a: { path: "/a" } as never, b: { path: "/b" } as never }, two, LogLevel.Notice);
        expect(two.messages[0]).toMatchObject({ level: "notice" });
        expect(messageText(two.messages[0]!.message)).toContain("2 repositories are LINKED");
        expect(messageText(two.messages[0]!.message)).toContain("Their recipes are read from those checkouts");
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

        const text = reporter.messages.map((entry) => messageText(entry.message)).join("\n");

        expect(text).toContain("pinned: a/b at version 1.0.0.");
        expect(text).toContain("a/c moved from version 1.0.0 to version 1.1.0.");
        expect(text).toContain("Commit it");
    });

    /**
     * A pin of the built-in `core` subscription moved to the installed sous version says why (#229).
     *
     * reportPrepared({ locked: { updated: [core/sous-skills 1.0.13 -> 1.0.16] }, followsSous: [{ key: "core/sous-skills", subscription: "core", version: "1.0.16" }] })
     * // -> "core/sous-skills moved from version 1.0.13 to version 1.0.16, because the subscription to 'core' follows the installed sous, version 1.0.16."
     */
    it("should say why a built-in pin moved", () => {
        const reporter = new BufferedReporter();

        reportPrepared(
            prepared({
                locked: { ...NO_CHANGE, unchanged: false, updated: [{ key: "core/sous-skills", from: "1.0.13", to: "1.0.16" }] },
                followsSous: [{ key: "core/sous-skills", subscription: "core", version: "1.0.16" }],
            }),
            reporter,
        );

        expect(reporter.messages.map((entry) => messageText(entry.message)).join("\n")).toContain(
            "core/sous-skills moved from version 1.0.13 to version 1.0.16, because the subscription to 'core' follows the installed sous, version 1.0.16.",
        );
    });

    /**
     * Nothing is said when nothing is newer; otherwise each newer version is listed with the pinned
     * one beside it, and a note says no pin changed.
     *
     * reportPrepared({ newer: [{ key: "a/b", from: "1.0.0", to: "1.2.0" }] }, reporter);
     * // -> variable list entry { label: "a/b", value: "1.2.0", detail: "this project pins 1.0.0" }
     * // a version pinned for lib/two alone: detail "this project pins 1.0.0 for lib/two alone"
     */
    it("should list newer versions and say nothing moved", () => {
        const one = new BufferedReporter();

        reportPrepared(prepared({ newer: [{ key: "a/b", from: "1.0.0", to: "1.2.0" }] }), one);
        expect(one.styled(ReportEntryStyle.VariableList)[0]!.message).toMatchObject({ entries: [{ label: "a/b", value: "1.2.0", detail: "this project pins 1.0.0" }] });
        expect(messageText(one.styled(ReportEntryStyle.Note)[0]!.message)).toContain("No pin was changed, so this build uses the pinned version.");

        const pinned = new BufferedReporter();

        reportPrepared(prepared({ newer: [{ key: "a/b", from: "1.0.0", to: "1.3.0", holder: "lib/two" }] }), pinned);
        expect(pinned.styled(ReportEntryStyle.VariableList)[0]!.message).toMatchObject({
            entries: [{ label: "a/b", value: "1.3.0", detail: "this project pins 1.0.0 for lib/two alone" }],
        });

        const two = new BufferedReporter();

        reportPrepared(prepared({ newer: [{ key: "a/b", from: "1", to: "2" }, { key: "a/c", from: "1", to: "2" }] }), two);
        expect(messageText(two.styled(ReportEntryStyle.Note)[0]!.message)).toContain("uses the pinned versions.");
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

describe("filesSummaryLine()", () => {
    const outputs = [
        { file: "/p/A.md", action: "created" as const },
        { file: "/p/B.md", action: "updated" as const },
        ...Array.from({ length: 13 }, (_, index) => ({ file: `/p/u${index}.md`, action: "unchanged" as const })),
    ];

    /**
     * Written files are counted with how many are new and how many updated, then the unchanged.
     *
     * filesSummaryLine({ outputs: [created, updated, 13 unchanged], dryRun: false });
     * // -> "Files: 2 written (1 new, 1 updated), 13 unchanged."
     */
    it("should count the written files, new and updated, and the unchanged ones", () => {
        expect(filesSummaryLine({ outputs, dryRun: false })).toBe("Files: 2 written (1 new, 1 updated), 13 unchanged.");
    });

    /**
     * A dry run says what would be written.
     *
     * filesSummaryLine({ outputs: [would-create, would-update, 13 unchanged], dryRun: true });
     * // -> "Files: 2 would be written (1 new, 1 updated), 13 unchanged."
     */
    it("should say what a dry run would write", () => {
        const planned = outputs.map((output) =>
            output.action === "created" ? { ...output, action: "would-create" as const } : output.action === "updated" ? { ...output, action: "would-update" as const } : output,
        );

        expect(filesSummaryLine({ outputs: planned, dryRun: true })).toBe("Files: 2 would be written (1 new, 1 updated), 13 unchanged.");
    });

    /**
     * A build that changed nothing still says so, with no breakdown in parentheses.
     *
     * filesSummaryLine({ outputs: [15 unchanged], dryRun: false });
     * // -> "Files: 0 written, 15 unchanged."
     */
    it("should report a build that changed nothing", () => {
        const unchanged = Array.from({ length: 15 }, (_, index) => ({ file: `/p/u${index}.md`, action: "unchanged" as const }));

        expect(filesSummaryLine({ outputs: unchanged, dryRun: false })).toBe("Files: 0 written, 15 unchanged.");
    });

    /**
     * Removed and not-written files join the line only when there are some, and a file removed and
     * then written again (a rebuild clears every output first) is not counted as removed.
     *
     * filesSummaryLine({ outputs, removed: ["/p/A.md", "/p/OLD.md"], notWritten: ["/p/C.md"], dryRun: false });
     * // -> "Files: 2 written (1 new, 1 updated), 13 unchanged, 1 removed, 1 not written."
     */
    it("should add removed and not-written files only when there are some", () => {
        expect(filesSummaryLine({ outputs, removed: [], notWritten: [], dryRun: false })).toBe("Files: 2 written (1 new, 1 updated), 13 unchanged.");
        expect(filesSummaryLine({ outputs, removed: ["/p/A.md", "/p/OLD.md"], notWritten: ["/p/C.md"], dryRun: false })).toBe(
            "Files: 2 written (1 new, 1 updated), 13 unchanged, 1 removed, 1 not written.",
        );
    });
});
