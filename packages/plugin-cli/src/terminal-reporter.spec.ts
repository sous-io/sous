import { LOG_LEVELS } from "@sous-io/plugin-api";
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
     * debug, info and notice go to standard output; warning and above go to standard error. Messages
     * below the threshold are dropped, and an error carries its literal prefix.
     *
     * reporter.error("x"); // stderr: "Error: x\n"
     */
    it("should route by level and filter by threshold", () => {
        const { stdout, stderr, reporter } = make({ threshold: "notice" });

        for (const level of LOG_LEVELS) {
            reporter.log(level, level);
        }

        expect(stdout.text).toBe("  notice\n");
        expect(stderr.text).toContain("WARNING:");
        expect(stderr.text).toContain("Error: error");
        expect(stderr.text).toContain("Critical: critical");
        expect(stderr.text).toContain("Alert: alert");
        expect(stderr.text).toContain("Emergency: emergency");
        expect(stdout.text).not.toContain("debug");
    });

    /** Under `json`, every message goes to standard error and standard output stays empty. */
    it("should send everything to standard error under json", () => {
        const { stdout, stderr, reporter } = make({ json: true });

        reporter.info("a");
        reporter.text("b");

        expect(stdout.text).toBe("");
        expect(stderr.text).toBe("  a\nb\n");
    });

    /** Text is exactly as given; Data is JSON; neither gets the closing spacing. */
    it("should print text as given and data as JSON", () => {
        const { stdout, reporter } = make();

        reporter.text("v1\n");
        reporter.data({ a: 1 });
        reporter.finish();

        expect(stdout.text).toBe('v1\n{\n  "a": 1\n}\n');
    });

    /**
     * An operation opens with a heading, its actions sit under it with a glyph each, and finish() ends
     * the output with two blank lines.
     */
    it("should draw an operation with glyphs and close with spacing", () => {
        const { stdout, reporter } = make();

        reporter.operationStart("Building the project");
        reporter.operation("written", "/a/CLAUDE.md", { tokens: 1840 });
        reporter.operation("unchanged", "/a/AGENTS.md");
        reporter.operation("would-write", "/a/B.md");
        reporter.operation("skipped", "/a/C.md", { note: "left out" });
        reporter.operation("removed", "/a/D.md");
        reporter.operationEnd("Done.");
        reporter.finish();

        expect(stdout.text).toBe(
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
        const { stdout, reporter } = make();

        reporter.operationStart("Compiling");
        reporter.stepStart("CLAUDE.md");
        reporter.detail("Read 3 recipes.");
        reporter.operation("written", "/a/x");

        expect(stdout.text).toContain("  ▷ CLAUDE.md\n    Read 3 recipes.\n    ✓ /a/x\n");
    });

    /** Labels line their colons up; a title becomes a subheading; command variables have their own heading. */
    it("should draw variables, lists, counts and dry-run notices", () => {
        const { stdout, reporter } = make();

        reporter.variables({ Name: "main", Repository: "acme" }, "Facts");
        reporter.commandVariables({ Project: "app" });
        reporter.list(["one", "two"], { title: "Items:" });
        reporter.count(5, "items");
        reporter.dryRun("Nothing was written.");

        expect(stdout.text).toBe(
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
        const { stdout, reporter } = make();

        reporter.table([{ key: "name", header: "Name" }], [{ name: "a" }, { name: "b" }], { title: "Repos", rowNotes: [undefined, "careful"] });
        reporter.table([{ key: "name", header: "Name" }], [], { empty: "No repositories are added." });

        expect(stdout.text).toContain("➔ Repos:\n  Name\n  ----\n  a\n  b\n  careful\n");
        expect(stdout.text).toContain("No repositories are added.");
    });

    /** A tree nests two spaces per level, with the detail after the label. */
    it("should draw a tree", () => {
        const { stdout, reporter } = make();

        reporter.tree([{ label: "core", detail: "1.0.0", children: [{ label: "skills" }] }], "Recipes");

        expect(stdout.text).toBe("➔ Recipes:\n  • core 1.0.0\n    • skills\n");
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
        const { stdout, reporter } = make({ color: true });

        reporter.operationStart("Building");

        expect(stdout.text).toBe("\u001b[93m▶ Building:\u001b[39m\n");
    });

    /** A resolved reference shows its facts above the reason. */
    it("should show a resolved reference's facts above the reason", () => {
        const { stdout, reporter } = make();
        const facts = { search: "git", resolvedTo: "github.com/acme/recipes/workflow/git", kind: "recipe", namespace: "workflow", repository: "acme" };

        reporter.resolvedReference("'git' named one recipe, and nothing else, so that is what is being used.", facts);

        expect(stdout.text).toBe(
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
        const { stdout, stderr, reporter } = make();

        reporter.question({ index: 1, total: 4, name: "root", description: "Where it lives.", storedAs: "SOUS_VAR_ROOT" });
        reporter.command("git", ["status"], { cwd: "/work" });
        reporter.command("git", ["push"], { dryRun: true });

        expect(stderr.text).toBe("  Question 1 of 4: root\n \n  Where it lives.\n \n    Stored as: SOUS_VAR_ROOT\n");
        expect(stdout.text).toBe("  Running: git status (in /work)\n  Would run: git push\n");
    });

    /** On a terminal, progress is redrawn in place and the finish leaves one line; elsewhere only the finish prints. */
    it("should show progress in place on a terminal and only the finish elsewhere", () => {
        const tty = make({ tty: true });

        tty.reporter.progress({ label: "Downloading", done: 1, total: 3, item: "a" });
        tty.reporter.info("hello");
        tty.reporter.progress({ label: "Downloading", done: 3, total: 3, finished: true });

        expect(tty.stderr.chunks[0]).toMatch(/^\r\u001b\[2K {2}Downloading .* 1\/3 a$/);
        expect(tty.stdout.text).toBe("  hello\n");
        expect(tty.stderr.chunks.join("")).toContain("  ✓ Downloading 3/3\n");

        const pipe = make();

        pipe.reporter.progress({ label: "Downloading", done: 1, total: 3 });
        pipe.reporter.progress({ label: "Downloading", done: 3, total: 3, finished: true });
        expect(pipe.stderr.text).toBe("  ✓ Downloading 3/3\n");
    });
});
