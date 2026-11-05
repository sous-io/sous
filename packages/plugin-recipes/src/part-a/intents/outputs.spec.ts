import { BufferedReporter, IntentOutput, IntentOutputs, ItemList, ReportEntryStyle, Table, TextBlock, VariableSet, type Context } from "@sous-io/plugin-api";
import { describe, expect, it } from "vitest";
import { lockShowOutputs, storeGcOutputs } from "../../part-b/intents/lock-intents.js";
import type { LockDiff, LockShowResult, PlannedQuestions, RecipeUpdatePlan, RepoAddResult, StoreGcReport, SubscriptionAddResult, SubscriptionListing } from "../../types.js";
import { describeSize, finish, lockDiffLines, plainFollowUps, questionPlanOutputs, underHeading, type RanFollowUp } from "../outputs.js";
import { namespaceListOutputs, recipeListOutputs, repoSearchOutputs, subscriptionListOutputs } from "./catalog-outputs.js";
import { repoAddOutputs } from "./repo-outputs.js";
import { subscriptionAddOutputs, updatePlanOutputs } from "./subscription-outputs.js";
import { reportSubscriptionPlan } from "./subscription.js";

/** A context outside any project, with a buffering reporter. */
function fakeContext(): Context & { reporter: BufferedReporter } {
    return { project: undefined, config: { get: () => undefined }, reporter: new BufferedReporter() } as unknown as Context & { reporter: BufferedReporter };
}

const unchanged: LockDiff = { added: [], removed: [], updated: [], reposAdded: [], reposRemoved: [], unchanged: true };

describe("the browsing outputs", () => {
    /** Every browsing command opens with its Command Variables, then the listing as a titled table. */
    it("should open with the command variables, then a titled table, and give machines an object", () => {
        const outputs = namespaceListOutputs(fakeContext(), {}, [{ repo: "acme", namespace: "workflow", recipeCount: 2, subscribed: "some recipes" }]);
        const [variables, table] = outputs.toArray();

        expect(variables?.title).toBe("Command Variables");
        expect(variables?.style).toBe(ReportEntryStyle.CommandVariables);
        expect((variables?.result as VariableSet).toObject()).toEqual({ Reading: "the cached indexes" });
        expect(table?.title).toBe("Namespaces in the repositories this project trusts");
        expect((table?.result as Table).rows).toEqual([{ namespace: "workflow", repo: "acme", recipes: "2", subscribed: "some recipes", description: "no description published" }]);
        expect(outputs.toPlain()).toEqual({ namespaces: [{ repo: "acme", namespace: "workflow", recipeCount: 2, subscribed: "some recipes" }] });
    });

    /** The Kind column must be wide enough for its longest word, or a narrow terminal breaks "recipe" in two. */
    it("should keep the search Kind column wide enough for every kind", () => {
        const [, table] = repoSearchOutputs(fakeContext(), { text: "x" }, []).toArray();
        const kind = (table?.result as Table).columns.find((column) => column.key === "kind");

        expect(kind?.minWidth).toBeGreaterThanOrEqual("namespace".length);
        expect(kind?.overflow).toBe("truncate");
    });

    /** `--installed` and `--latest` change what the Command Variables and the empty text say. */
    it("should say what --installed and --latest narrow to", () => {
        const [variables, table] = recipeListOutputs(fakeContext(), { installed: true, latest: true }, []).toArray();

        expect((variables?.result as VariableSet).toObject()).toEqual({ Reading: "each repository, upstream", Showing: "only what this project has installed" });
        expect((table?.result as Table).empty).toBe("This project has installed no recipe from the repositories it trusts.");
    });

    /** A linked recipe adds the note that explains the marker. */
    it("should add a note when a listed recipe is linked", () => {
        const outputs = recipeListOutputs(fakeContext(), {}, [
            { key: "workflow/a", namespace: "workflow", name: "a", repo: "acme", latest: "1.0.0", pinned: "1.0.0", linkedPath: "/work/acme", subscribed: true },
        ]).toArray();

        expect(((outputs[1]?.result as Table).rows[0] as { pinned: string }).pinned).toBe("1.0.0 linked");
        expect(outputs[2]?.style).toBe(ReportEntryStyle.Note);
        expect(outputs[2]?.result).toBeInstanceOf(TextBlock);
    });

    /** With `--installed`, a subscription that installed nothing is left out of the table and of the data. */
    it("should list only the subscriptions that installed something with --installed", () => {
        const listings: SubscriptionListing[] = [
            { key: "workflow/a", range: "^1", enabled: true, addedBy: "user", pinned: [{ key: "workflow/a", version: "1.0.0" }] },
            { key: "workflow/b", range: undefined, enabled: false, addedBy: "sous", pinned: [] },
        ];
        const outputs = subscriptionListOutputs(fakeContext(), { installed: true }, listings);
        const table = outputs.toArray()[1]?.result as Table;

        expect(table.columns.find((column) => column.key === "pinned")?.header).toBe("Installed version");
        expect(table.rows.map((row) => row.key)).toEqual(["workflow/a"]);
        expect(outputs.toPlain().subscriptions.map((entry) => entry.key)).toEqual(["workflow/a"]);
    });
});

describe("the repository outputs", () => {
    const added: RepoAddResult = { name: "acme", url: "https://github.com/acme/r", provider: "github", alreadyTrusted: false, namespaces: ["workflow"], recipeCount: 3, dryRun: false };

    /** The heading is the first output's title; the facts are a variable set, then a note. */
    it("should show the repository it trusted, then a note", () => {
        const [facts, note] = repoAddOutputs(added).toArray();

        expect(facts?.title).toBe("Adding a repository");
        expect((facts?.result as VariableSet).toObject()).toMatchObject({ Repository: "acme", Provider: "github", Namespaces: "workflow", Recipes: "3" });
        expect(note?.style).toBe(ReportEntryStyle.Note);
        expect(note?.result?.toText()).toBe("This project now trusts 'acme'. Nothing from it has been installed.");
    });

    /** A dry run says it trusts nothing, in the dry-run style. */
    it("should say a dry run trusts nothing", () => {
        const [first] = repoAddOutputs({ ...added, dryRun: true }).toArray();

        expect(first?.title).toBe("Adding a repository");
        expect(first?.style).toBe(ReportEntryStyle.DryRun);
        expect(first?.result?.toText()).toBe("Nothing will be trusted, written or downloaded.");
    });

    /** The store report shows its counts and sizes, then every evicted entry, then a closing sentence. */
    it("should show the counts, the sizes and every evicted entry of a store collection", () => {
        const entry = { repo: "acme", namespace: "workflow", name: "a", version: "1.0.0", lastAccessAt: "2026-01-01", sizeBytes: 2048 };
        const report = { evicted: [entry], kept: [], bytesBefore: 2048, bytesAfter: 0, dryRun: true } as unknown as StoreGcReport;
        const outputs = storeGcOutputs(report).toArray();

        expect(outputs[0]?.title).toBe("Collecting the recipe store");
        expect(outputs[0]?.style).toBe(ReportEntryStyle.DryRun);
        expect((outputs[1]?.result as VariableSet).toObject()).toMatchObject({ "Entries evicted": "1", "Size before": "2.0 KB", "Size after": "0 bytes" });
        expect((outputs[2]?.result as Table).rows).toEqual([{ repo: "acme", recipe: "workflow/a", version: "1.0.0", size: "2.0 KB", lastUsed: "2026-01-01" }]);
        expect(outputs[3]?.summary).toBe("Nothing was removed. Everything listed above is re-fetchable from the lockfile that pins it.");
    });

    /**
     * The download folders an interrupted build left behind are listed before the closing
     * sentence, which then says no recipe versions were removed rather than nothing.
     */
    it("should list the download folders an interrupted build left behind", () => {
        const report = { evicted: [], kept: [], bytesBefore: 0, bytesAfter: 0, dryRun: false, abandoned: ["/h/cache/.sous-restore-x"] } as unknown as StoreGcReport;
        const outputs = storeGcOutputs(report).toArray();

        expect(outputs[1]?.result?.toText()).toContain("/h/cache/.sous-restore-x");
        expect(outputs[1]?.result?.toText()).toContain("Download folders an interrupted build left behind, removed:");
        expect(outputs[2]?.summary).toBe("The store is already inside its size cap, so no recipe versions were removed.");
    });

    /** Pins show under the recipe, and a recipe not built here carries its reason as a row note. */
    it("should show what the lockfile pins, with a row note for a recipe not built here", () => {
        const result = {
            path: "/p/.sous/sous.lock.json",
            lockfile: {},
            recipes: [
                { key: "workflow/b", entry: { repo: "acme", version: "2.0.0", requestedBy: ["workflow/a"] }, active: false, skipped: { message: "Switched off." } },
                { key: "workflow/a", entry: { repo: "acme", version: "1.0.0", requestedBy: ["project"] }, active: true },
            ],
        } as unknown as LockShowResult;
        const [table, closing] = lockShowOutputs(result).toArray();
        const payload = table?.result as Table;

        expect(table?.title).toBe("Recipe versions this project pins");
        expect(payload.rows.map((row) => [row.key, row.heldBy])).toEqual([["workflow/a", "this project"], ["workflow/b", "workflow/a"]]);
        expect(payload.rowNotes).toEqual([undefined, "not built here: Switched off."]);
        expect(closing?.summary).toBe("This project's lockfile is /p/.sous/sous.lock.json.");
    });
});

describe("the subscription outputs", () => {
    const resolved = [{ key: "workflow/a", repo: "acme", version: "1.0.0", kind: "subscribes", requestedBy: ["project"] }] as unknown as SubscriptionAddResult["resolved"];
    const base: SubscriptionAddResult = { ref: "workflow/a", key: "workflow/a", resolved, trusted: [], unreadable: [], cycles: [], dryRun: false, diff: unchanged, followUps: [] };

    /** The follow-up outputs come after the subscription's own, and the machine data closes them. */
    it("should show the follow-ups' outputs after its own, with vars.ask under 'Variables', and end with the data", () => {
        const ask = IntentOutputs.of({ answered: 1 }, { summary: "Answered 1." });
        const build = new IntentOutputs([new IntentOutput({ title: "Build", summary: "Built." })]);
        const followUps: RanFollowUp[] = [
            { intent: "vars.ask", result: { answered: 1 }, outputs: ask },
            { intent: "build", result: { ok: true }, outputs: build },
        ];
        const outputs = subscriptionAddOutputs(fakeContext(), { ...base, followUps });
        const titles = outputs.toArray().map((output) => output.title);

        expect(titles).toEqual(["Subscribing", "Lockfile", undefined, "Variables", "Build"]);
        expect(outputs.exitCode).toBeUndefined();
        expect(outputs.toPlain().followUps).toEqual([
            { intent: "vars.ask", result: { answered: 1 } },
            { intent: "build", result: { ok: true } },
        ]);
    });

    /**
     * When vars.ask asked nothing, its outputs should show no heading without content: neither its
     * own "Answering variables" nor a "Variables" heading over a block that has a title (gh-229).
     *
     * vars.ask outputs: ["Answering variables" (title only), "Left unanswered" (a list)]
     * // -> titles: [..., "Left unanswered", "Build"]
     */
    it("should leave out headings with nothing under them when vars.ask asked nothing", () => {
        const ask = new IntentOutputs([
            new IntentOutput({ title: "Answering variables" }),
            new IntentOutput({ title: "Left unanswered", result: new VariableSet([{ label: "extra", value: "no answer yet, and this variable is optional" }]) }),
        ]);
        const build = new IntentOutputs([new IntentOutput({ title: "Build", summary: "Built." })]);
        const followUps: RanFollowUp[] = [
            { intent: "vars.ask", result: {}, outputs: ask },
            { intent: "build", result: { ok: true }, outputs: build },
        ];
        const outputs = subscriptionAddOutputs(fakeContext(), { ...base, followUps }).toArray();
        const titleOnly = outputs.filter((output) => output.title !== undefined && output.result === undefined && output.summary === undefined);

        expect(titleOnly).toEqual([]);
        expect(outputs.map((output) => output.title)).toEqual(["Subscribing", "Lockfile", undefined, "Left unanswered", "Build"]);
    });

    /**
     * Before the subscribe question, the plan should not promise questions: a recipe whose
     * variables are all optional, or already answered, asks none (gh-229).
     *
     * reportSubscriptionPlan(reporter, "misc/stuff", recipe ref)
     * // -> a line saying only variables that need an answer and have none are asked
     */
    it("should not promise questions before subscribing", () => {
        const reporter = new BufferedReporter();

        reportSubscriptionPlan(reporter, "misc/stuff", { kind: "recipe", name: "stuff", namespace: { kind: "namespace", name: "misc" } } as unknown as Parameters<typeof reportSubscriptionPlan>[2]);

        const text = JSON.stringify(reporter.messages);

        expect(text).not.toContain("The variables it publishes are asked about afterwards");
        expect(text).toContain("that require an answer and have none yet are asked about afterwards");
    });

    /** A build that failed ends the command with exit code 1 and an error saying what is recorded. */
    it("should exit 1 and report an error when the build that followed failed", () => {
        const ctx = fakeContext();
        const failed = new IntentOutputs([new IntentOutput({ summary: "Build failed." })], { exitCode: 1 });
        const outputs = subscriptionAddOutputs(ctx, { ...base, followUps: [{ intent: "build", result: { ok: false }, outputs: failed } as RanFollowUp] });

        expect(outputs.exitCode).toBe(1);
        expect(ctx.reporter.messages.some((entry) => String(entry.message).startsWith("The subscription to 'workflow/a' was saved, but the build that followed it failed"))).toBe(true);
    });

    /** Without a build, the closing sentence says to run one. */
    it("should say to run 'sous build' when no build ran", () => {
        const outputs = subscriptionAddOutputs(fakeContext(), { ...base, followUps: [{ intent: "build", skipped: "--no-build" }] }).toArray();

        expect(outputs[outputs.length - 1]?.summary).toContain("Run 'sous build' to compile what they contribute.");
    });
});

describe("the update plan outputs", () => {
    const plan = {
        scope: { kind: "all" },
        diff: { ...unchanged, unchanged: false, updated: [{ key: "workflow/a", from: "1.0.0", to: "1.1.0" }] },
        lockfile: {},
        missingRepos: [{ name: "other", url: "https://x/other", requiredBy: [{ ref: "workflow/a", requestedBy: "workflow/a" }] }],
        newVariables: [],
        unreadable: [],
        unreachable: [{ repo: "acme", reason: "offline\nmore" }],
        linked: [],
        builtIn: [],
        switchedOff: ["workflow/b"],
        failed: [],
        cycles: [],
    } as unknown as RecipeUpdatePlan;

    /** Pin changes first, then repositories to trust, then notes about what the update left alone. */
    it("should list the changes, the repositories to trust and the notes, in that order", () => {
        const outputs = updatePlanOutputs(plan);

        expect((outputs[0]?.result as ItemList).items).toEqual(["Updating workflow/a from version 1.0.0 to version 1.1.0"]);
        expect((outputs[0]?.result as ItemList).title).toBe("Updating every subscription in this project changes the lockfile:");
        expect((outputs[1]?.result as ItemList).items).toEqual(["other at https://x/other, needed by workflow/a"]);
        expect(outputs.slice(2).map((output) => output.result?.toText())).toEqual(["The index of 'acme' could not be fetched, so its pins stay where they are. offline", "Switched off, so left alone: workflow/b."]);
    });

    /**
     * When an index could not be read and nothing moves, the headline does not claim every pin is
     * the newest: sous could not check the pins of that repository (#204 bug 33).
     *
     * // nothing moves; 'sous-recipes' unreachable, no repository read
     * // -> "Sous could not check for updates: it could not read the index of 'sous-recipes'."
     */
    it("should not say there is nothing to update when an index could not be read", () => {
        const offline = {
            ...plan,
            diff: unchanged,
            missingRepos: [],
            switchedOff: [],
            unreachable: [{ repo: "sous-recipes", reason: "Sous could not read github.com/sous-io/sous-recipes: git: Could not resolve host: github.com." }],
        } as unknown as RecipeUpdatePlan;
        const texts = updatePlanOutputs(offline).map((output) => output.result?.toText() ?? output.summary);

        expect(texts.join("\n")).not.toContain("Nothing to update");
        expect(texts[0]).toBe("Sous could not check for updates: it could not read the index of 'sous-recipes'.");

        const partly = updatePlanOutputs({ ...offline, checked: ["acme"] } as RecipeUpdatePlan).map((output) => output.result?.toText() ?? output.summary);

        expect(partly[0]).toBe("No updates found in the repositories sous could read. It could not read the index of 'sous-recipes', so the pins from it were not checked.");
    });
});

describe("the shared pieces", () => {
    /** Each change is a line, sorted by key, and nothing changed is said in words. */
    it("should word a lockfile diff", () => {
        expect(lockDiffLines(unchanged)).toEqual(["Nothing changed."]);
        expect(lockDiffLines({ ...unchanged, unchanged: false, added: [{ key: "b/x", to: "1.0.0" }, { key: "a/x", to: "2.0.0" }] })).toEqual(["Adding a/x version 2.0.0", "Adding b/x version 1.0.0"]);
    });

    it("should show bytes, then kilobytes and up", () => {
        expect(describeSize(10)).toBe("10 bytes");
        expect(describeSize(1536)).toBe("1.5 KB");
    });

    /** A heading takes the first output's title, or stands as an output of its own when that one has a title. */
    it("should put a heading on the first output, or ahead of it when it has a title", () => {
        expect(underHeading("Heading", [new IntentOutput({ summary: "One." })]).map((output) => [output.title, output.summary])).toEqual([["Heading", "One."]]);
        expect(underHeading("Heading", [new IntentOutput({ title: "Own", summary: "One." })]).map((output) => output.title)).toEqual(["Heading", "Own"]);
    });

    /** The data goes on the last output, or closes outputs that follow it. */
    it("should put the data on the last output, follow-ups included", () => {
        expect(finish([new IntentOutput({ summary: "One." })], { a: 1 }).toPlain()).toEqual({ a: 1 });

        const closed = finish([new IntentOutput({ summary: "One." })], { a: 1 }, { after: [new IntentOutput({ summary: "Two." })] });

        expect(closed.length).toBe(2);
        expect(closed.toPlain()).toEqual({ a: 1 });
        expect(closed.last()?.summary).toBe("Two.");
        expect(plainFollowUps([{ intent: "build", skipped: "--no-build" }])).toEqual([{ intent: "build", skipped: "--no-build" }]);
    });

    /** Questions are grouped by recipe, one variable set each, with the answering flag when asked for. */
    it("should group the questions by recipe, with answer hints", () => {
        const plan = {
            questions: [{ recipe: "workflow/a", definition: { name: "apiUrl", description: "The API. More.", example: "x", required: true }, answered: false }],
            unreadable: [],
        } as unknown as PlannedQuestions;
        const outputs = questionPlanOutputs(plan, { answerHints: true });

        expect(outputs[0]?.summary).toBe("These recipes ask 1 question, 1 of which nothing answers yet.");
        expect(outputs[1]?.title).toBe("workflow/a asks 1 question");
        expect((outputs[1]?.result as VariableSet).title).toBe("apiUrl");
        expect((outputs[1]?.result as VariableSet).toObject()).toMatchObject({ about: "The API.", "answer-with": "--answer apiUrl=<value>", answered: "no, and this recipe requires an answer" });
        expect(outputs[2]?.style).toBe(ReportEntryStyle.Note);
    });

    it("should say a required question with a default takes its default, and not count it as unanswered", () => {
        const outputs = questionPlanOutputs(
            {
                questions: [{ recipe: "core/sous-skills", definition: { name: "skillsRoot", required: true, default: "prompts/skills" }, answered: false }],
                unreadable: [],
            } as unknown as PlannedQuestions,
            { answerHints: true },
        );

        expect(outputs[0]?.summary).toBe("These recipes ask 1 question, and everything they ask is already answered.");
        expect((outputs[1]?.result as VariableSet).toObject()).toMatchObject({ answered: "no, so its default is used: prompts/skills" });
    });

    /**
     * A version of a recipe that is not asked a question (another version of the recipe is) shows
     * the warning in place of whether it is answered, and is not counted as unanswered.
     */
    it("should show a question a version is not asked as not answerable", () => {
        const warning = "The variable tone of support/base 2.0.0 cannot be answered alongside support/base 1.0.0, so it is not asked and gets no answer.";
        const plan = {
            questions: [
                { recipe: "support/base", definition: { name: "tone", example: "plain", required: true }, answered: true },
                { recipe: "support/base", definition: { name: "tone", example: "3", required: true }, answered: false, unanswerable: warning },
            ],
            unreadable: [],
        } as unknown as PlannedQuestions;
        const outputs = questionPlanOutputs(plan, { answerHints: true });
        const skipped = (outputs[2]?.result as VariableSet).toObject();

        expect(outputs[0]?.summary).toBe("These recipes ask 2 questions, and everything they ask is already answered.");
        expect(skipped).toMatchObject({ "not-answerable": warning });
        expect(skipped).not.toHaveProperty("answered");
        expect(skipped).not.toHaveProperty("answer-with");
    });
});
