import { IntentOutput, IntentOutputs, ItemList, LOG_LEVELS, ReportEntryStyle, SousError, Table, TextBlock, Tree, VariableSet } from "@sous-io/plugin-api";
import { describe, expect, it } from "vitest";
import { TerminalReporter } from "./terminal-reporter.js";

function stream(isTTY = false, columns?: number) {
    const chunks: string[] = [];

    return {
        chunks,
        isTTY,
        ...(columns === undefined ? {} : { columns }),
        write: (text: string) => chunks.push(text),
        get text() {
            return chunks.join("");
        },
    };
}

function make(options: { tty?: boolean; threshold?: Parameters<typeof LOG_LEVELS.includes>[0]; json?: boolean; color?: boolean } = {}) {
    const stdout = stream();
    const stderr = stream(options.tty ?? false);
    const reporter = new TerminalReporter({
        stdout,
        stderr,
        color: options.color ?? false,
        columns: 100,
        ...(options.threshold === undefined ? {} : { threshold: options.threshold }),
        ...(options.json === undefined ? {} : { json: options.json }),
    });

    return { stdout, stderr, reporter };
}

describe("TerminalReporter", () => {
    /**
     * A message at any level goes to standard error and is dropped below the threshold; an error
     * carries its literal prefix. Standard output stays empty: only a result goes there.
     *
     * reporter.error("x"); // stderr: "Error: x\n"
     */
    it("should send every message to standard error and filter by threshold", () => {
        const { stdout, stderr, reporter } = make({ threshold: "notice" });

        for (const level of LOG_LEVELS) {
            reporter.log(level, level);
        }

        expect(stdout.text).toBe("");
        expect(stderr.text).toContain("  notice\n");
        expect(stderr.text).toContain("WARNING:");
        expect(stderr.text).toContain("Error: error");
        expect(stderr.text).toContain("Critical: critical");
        expect(stderr.text).toContain("Alert: alert");
        expect(stderr.text).toContain("Emergency: emergency");
        expect(stderr.text).not.toContain("debug");
    });

    /** Under `json`, even a result goes to standard error and standard output stays empty. */
    it("should send everything to standard error under json", () => {
        const { stdout, stderr, reporter } = make({ json: true });

        reporter.info("a");
        reporter.text("b");
        reporter.result(new IntentOutputs(new IntentOutput({ summary: "c" })));

        expect(stdout.text).toBe("");
        expect(stderr.text).toBe("  a\nb\n  c\n");
    });

    /** A command's result is the only thing on standard output. */
    it("should send a result to standard output and nothing else", () => {
        const { stdout, stderr, reporter } = make();

        reporter.info("working");
        reporter.result(new IntentOutputs(new IntentOutput({ summary: "Done." })));

        expect(stdout.text).toBe("  Done.\n");
        expect(stderr.text).toBe("  working\n");
    });

    /** Text is exactly as given; Data is JSON; neither gets the closing spacing. */
    it("should print text as given and data as JSON", () => {
        const { stderr, reporter } = make();

        reporter.text("v1\n");
        reporter.data({ a: 1 });
        reporter.finish();

        expect(stderr.text).toBe('v1\n{\n  "a": 1\n}\n');
    });

    /** A result sent to a pipe ends with the result itself, with no closing blank lines. */
    it("should not close a result on a pipe with blank lines", () => {
        const { stdout, reporter } = make();

        reporter.result(new IntentOutputs(new IntentOutput({ summary: "Done." })));
        reporter.finish();

        expect(stdout.text.endsWith("Done.\n")).toBe(true);
    });

    /**
     * An operation opens with a heading, its actions sit under it with a glyph each, and finish() ends
     * the output with two blank lines.
     */
    it("should draw an operation with glyphs and close with spacing", () => {
        const { stderr, reporter } = make();

        reporter.operationStart("Building the project");
        reporter.operation("written", "/a/CLAUDE.md", { tokens: 1840 });
        reporter.operation("unchanged", "/a/AGENTS.md");
        reporter.operation("would-write", "/a/B.md");
        reporter.operation("skipped", "/a/C.md", { note: "left out" });
        reporter.operation("removed", "/a/D.md");
        reporter.operationEnd("Done.");
        reporter.finish();

        expect(stderr.text).toBe(
            [
                "▶ Building the project:",
                " ",
                "  ✓ /a/CLAUDE.md (~1,840 tokens)",
                "  ⊘ /a/AGENTS.md (unchanged)",
                "  ○ /a/B.md (would write)",
                "  ⊘ /a/C.md (left out)",
                "  − /a/D.md (removed)",
                " ",
                "Done.",
                " ",
                " ",
                "",
            ].join("\n"),
        );
    });

    /** A failed operation goes to standard error with a cross. */
    it("should send a failed operation to standard error", () => {
        const { stderr, reporter } = make();

        reporter.operation("failed", "/a/x.md", { note: "broken" });

        expect(stderr.text).toBe("  ✗ /a/x.md (broken)\n");
    });

    /** Steps put the actions under them one level deeper. */
    it("should indent under a step", () => {
        const { stderr, reporter } = make();

        reporter.operationStart("Compiling");
        reporter.stepStart("CLAUDE.md");
        reporter.detail("Read 3 recipes.");
        reporter.operation("written", "/a/x");

        expect(stderr.text).toContain("  ▷ CLAUDE.md\n    Read 3 recipes.\n    ✓ /a/x\n");
    });

    /** Labels line their colons up; a title becomes a subheading; command variables have their own heading. */
    it("should draw variables, lists, counts and dry-run notices", () => {
        const { stderr, reporter } = make();

        reporter.variables({ Name: "main", Repository: "acme" }, "Facts");
        reporter.commandVariables({ Project: "app" });
        reporter.list(["one", "two"], { title: "Items:" });
        reporter.count(5, "items");
        reporter.dryRun("Nothing was written.");

        expect(stderr.text).toBe(
            [
                "➔ Facts:",
                "    Name      : main",
                "    Repository: acme",
                " ",
                "$ Command Variables:",
                "    Project: app",
                "  Items:",
                "    • one",
                "    • two",
                "Found [5] items",
                "    [Dry Run] Nothing was written.",
                "",
            ].join("\n"),
        );
    });

    /** A table shows its title, its rows and a note under a row; with no rows it shows the `empty` sentence. */
    it("should draw tables, row notes, and the empty sentence", () => {
        const { stderr, reporter } = make();

        reporter.table([{ key: "name", header: "Name" }], [{ name: "a" }, { name: "b" }], { title: "Repos", rowNotes: [undefined, "careful"] });
        reporter.table([{ key: "name", header: "Name" }], [], { empty: "No repositories are added." });

        expect(stderr.text).toContain("➔ Repos:\n  Name\n  ----\n  a\n  b\n    careful\n");
        expect(stderr.text).toContain("No repositories are added.");
    });

    /** A styled entry at warning level or above opens with the level's literal prefix, so it reads as a warning. */
    it("should mark a styled entry at warning level or above with its level", () => {
        const { stderr, reporter } = make();

        reporter.list(["a", "b"], { title: "Unanswered variables" }, "warning");
        reporter.list(["c"], { title: "Fine" }, "info");
        reporter.table([{ key: "name", header: "Name" }], [{ name: "x" }], undefined, "error");

        expect(stderr.text).toContain("Warning: Unanswered variables\n");
        expect(stderr.text).toContain("Error: ");
        expect(stderr.text).not.toContain("Warning: Fine");
    });

    /** A table is indented two spaces under its heading, titled or not. */
    it("should indent a table without a title", () => {
        const { stderr, reporter } = make();

        reporter.table([{ key: "name", header: "Name" }], [{ name: "a" }]);

        expect(stderr.text).toContain("  Name\n  ----\n  a\n");
    });

    /** Two terminal streams are one screen: a warning on one and a block on the other are separated by a blank line. */
    it("should share spacing between two terminal streams", () => {
        const out = stream(true, 100);
        const err = stream(true, 100);
        const reporter = new TerminalReporter({ stdout: out, stderr: err, color: false, columns: 100 });

        reporter.warn("careful");
        reporter.result(new IntentOutputs(new IntentOutput({ title: "Command Variables", style: ReportEntryStyle.CommandVariables, result: new VariableSet({ "Dry Run": "false" }) })));

        expect(out.text.split("\n")[0]!.trim()).toBe("");
    });

    /** A tree nests two spaces per level, with the detail after the label. */
    it("should draw a tree", () => {
        const { stderr, reporter } = make();

        reporter.tree([{ label: "core", detail: "1.0.0", children: [{ label: "skills" }] }], "Recipes");

        expect(stderr.text).toBe("➔ Recipes:\n  • core 1.0.0\n    • skills\n");
    });

    /** A warning gets the WARNING banner; a problem shows its cause and hint under the summary. */
    it("should draw warnings and problems", () => {
        const { stderr, reporter } = make();

        reporter.warn("This is RISKY.");
        reporter.problem("Could not read it.", { cause: "No such file.", hint: "Check the path." }, "error");

        expect(stderr.text).toBe(["   WARNING:   ", "  This is RISKY.", " ", "Error: Could not read it.", "  No such file.", "  Check the path.", ""].join("\n"));
    });

    /** Color is decided with the stream: on, the text is painted. */
    it("should paint when color is on", () => {
        const { stderr, reporter } = make({ color: true });

        reporter.operationStart("Building");

        expect(stderr.text).toBe("\u001b[93m▶ Building:\u001b[39m\n");
    });

    /** A resolved reference shows its facts above the reason. */
    it("should show a resolved reference's facts above the reason", () => {
        const { stderr, reporter } = make();
        const facts = { search: "git", resolvedTo: "github.com/acme/recipes/workflow/git", kind: "recipe", namespace: "workflow", repository: "acme" };

        reporter.resolvedReference("'git' named one recipe, and nothing else, so that is what is being used.", facts);

        expect(stderr.text).toBe(
            [
                "    Resolved to: github.com/acme/recipes/workflow/git",
                "    Namespace  : workflow",
                "    Repository : acme",
                " ",
                "  'git' named one recipe, and nothing else, so that is what is being used.",
                "",
            ].join("\n"),
        );
    });

    /** A question and the command lines. */
    it("should draw a question header and commands", () => {
        const { stderr, reporter } = make();

        reporter.question({ index: 1, total: 4, name: "root", description: "Where it lives.", storedAs: "SOUS_VAR_ROOT" });
        reporter.command("git", ["status"], { cwd: "/work" });
        reporter.command("git", ["push"], { dryRun: true });

        expect(stderr.text).toBe(
            "  Question 1 of 4: root\n \n  Where it lives.\n \n    Stored as: SOUS_VAR_ROOT\n \n  Running: git status (in /work)\n  Would run: git push\n");
    });

    /** On a terminal, progress is redrawn in place and the finish leaves one line; elsewhere only the finish prints. */
    it("should show progress in place on a terminal and only the finish elsewhere", () => {
        const tty = make({ tty: true });

        tty.reporter.progress({ label: "Downloading", done: 1, total: 3, item: "a" });
        tty.reporter.info("hello");
        tty.reporter.progress({ label: "Downloading", done: 3, total: 3, finished: true });

        expect(tty.stderr.chunks[0]).toMatch(/^\r\u001b\[2K {2}Downloading .* 1\/3 a$/);
        expect(tty.stdout.text).toBe("");
        expect(tty.stderr.chunks.join("")).toContain("  hello\n");
        expect(tty.stderr.chunks.join("")).toContain("  ✓ Downloading 3/3\n");

        const pipe = make();

        pipe.reporter.progress({ label: "Downloading", done: 1, total: 3 });
        pipe.reporter.progress({ label: "Downloading", done: 3, total: 3, finished: true });
        expect(pipe.stderr.text).toBe("  ✓ Downloading 3/3\n");
    });

    /**
     * A result draws each output in order: the title as a heading, the summary as a paragraph, then
     * the payload by its kind. Command Variables keep their own look.
     */
    it("should draw a result's outputs in order", () => {
        const { stdout, stderr, reporter } = make();

        reporter.result(
            new IntentOutputs([
                new IntentOutput({ title: "Command Variables", style: ReportEntryStyle.CommandVariables, result: new VariableSet({ Project: "app" }) }),
                new IntentOutput({ title: "Repositories", summary: "Two are added.", result: new Table([{ key: "name", header: "Name" }], [{ name: "a" }, { name: "b" }]) }),
                new IntentOutput({ result: new ItemList(["one", "two"], { title: "Items:" }) }),
                new IntentOutput({ result: new Tree([{ label: "core", detail: "1.0.0" }], { title: "Recipes" }) }),
                new IntentOutput({ summary: "Careful.", result: new TextBlock("Nothing was written.", { verbatim: false }), style: ReportEntryStyle.DryRun }),
                new IntentOutput({ result: new TextBlock("An aside.", {}), style: ReportEntryStyle.Note }),
            ]),
        );

        expect(stderr.text).toBe("");
        expect(stdout.text).toBe(
            [
                "$ Command Variables:",
                "    Project: app",
                " ",
                "▶ Repositories:",
                " ",
                "  Two are added.",
                "  Name",
                "  ----",
                "  a",
                "  b",
                "  Items:",
                "    • one",
                "    • two",
                " ",
                "➔ Recipes:",
                "  • core 1.0.0",
                "  Careful.",
                "    [Dry Run] Nothing was written.",
                "  An aside.",
                "",
            ].join("\n"),
        );
    });

    /** Verbatim text in a result is exactly as given, and empty text prints nothing. */
    it("should print verbatim text exactly and nothing for empty text", () => {
        const { stdout, reporter } = make();

        reporter.result(new IntentOutputs(new IntentOutput({ result: new TextBlock("a   b\n  c\n", { verbatim: true }) })));
        reporter.result(new IntentOutputs(new IntentOutput({ result: new TextBlock("", { verbatim: true }) })));

        expect(stdout.text).toBe("a   b\n  c\n");
    });

    /** A payload passed as the message draws the same as in a result, from its own fields. */
    it("should draw a payload given as a message while an intent runs", () => {
        const { stderr, reporter } = make();

        reporter.variables({ Name: "main" }, "Facts");
        reporter.list(["x"]);

        expect(stderr.text).toBe("➔ Facts:\n    Name: main\n    • x\n");
    });

    /** An error draws its message with the level's prefix, its details, then each cause. */
    it("should draw an error with its details and its chain of causes", () => {
        const { stderr, reporter } = make();
        const root = new Error("getaddrinfo ENOTFOUND example.com");
        const middle = new SousError("The download failed.", { details: ["Check the network."], cause: root });

        reporter.critical(new SousError("Could not add the repository.", { details: ["Check the URL."], cause: middle }));

        expect(stderr.text).toBe(
            [
                "Error: Could not add the repository.",
                "  Check the URL.",
                "  Caused by: The download failed.",
                "    Check the network.",
                "  Caused by: getaddrinfo ENOTFOUND example.com",
                "",
            ].join("\n"),
        );

        const warn = make();

        warn.reporter.warn(new Error("Slow."));
        expect(warn.stderr.text).toContain("Warning: Slow.");
    });
});
