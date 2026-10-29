import { describe, expect, it } from "vitest";
import { colorizeJson, renderJson, truncateJson } from "./json.js";
import { Printer, withErrorPrefix } from "./printer.js";
import { colorEnabled, createStyle } from "./style.js";
import { DEFAULT_WRAP_COLUMNS, indent, stripAnsi, terminalColumns, wrapText } from "./text.js";

const plain = () => new Printer(createStyle(false), 100);

describe("text helpers (ported from formatting.spec.ts)", () => {
    it("should indent each line, by 2 spaces by default", () => {
        expect(indent("a")).toBe("  a");
        expect(indent("a\nb", 4)).toBe("    a\n    b");
        expect(indent("a", 2, "-")).toBe("--a");
        expect(indent("")).toBe("  ");
    });

    it("should wrap a paragraph on spaces, hanging continuation lines two spaces by default", () => {
        expect(wrapText("one two three", 7, { hangingIndent: 0 })).toEqual(["one two", "three"]);
        expect(wrapText("one two three", 7)).toEqual(["one two", "  three"]);
        expect(wrapText("    one two three", 11)).toEqual(["    one two", "      three"]);
        expect(wrapText("a b\nc d", 3)).toEqual(["a b", "c d"]);
    });

    it("should leave a word longer than the width whole, and measure without color", () => {
        expect(wrapText("see https://example.com/a/very/long/path now", 10, { hangingIndent: 0 })).toEqual(["see", "https://example.com/a/very/long/path", "now"]);

        const colored = "\u001b[36mone\u001b[39m two";

        expect(wrapText(colored, 7, { hangingIndent: 0 })).toEqual([colored]);
    });

    it("should use the stream width when there is one and the default otherwise", () => {
        expect(terminalColumns({ columns: 60 })).toBe(60);
        expect(terminalColumns({})).toBe(DEFAULT_WRAP_COLUMNS);
        expect(terminalColumns({ columns: 0 })).toBe(DEFAULT_WRAP_COLUMNS);
    });

    it("should add the error prefix once", () => {
        expect(withErrorPrefix("Something broke.")).toBe("Error: Something broke.");
        expect(withErrorPrefix("Error: Something broke.")).toBe("Error: Something broke.");
    });
});

describe("Printer", () => {
    /**
     * ```text
     *  (blank)
     * ▶ Compiling targets:
     * ```
     */
    it("should write headings with a symbol and a colon, sections with a blank line under them", () => {
        expect(plain().heading("Compiling targets").lines).toEqual([" ", "▶ Compiling targets:"]);
        expect(plain().heading("Config is valid.").lines).toEqual([" ", "▶ Config is valid."]);
        expect(plain().section("Adding a repository").lines).toEqual([" ", "▶ Adding a repository:", " "]);
        expect(plain().subheading("Target 1").lines).toEqual([" ", "➔ Target 1:"]);
        expect(plain().footer().lines).toEqual([" ", " "]);
    });

    it("should indent key and value pairs by four and line their colons up", () => {
        const out = plain();

        expect(out.formatVariable({ label: "Repo", value: "qa" }, { labelWidth: 8 })).toEqual(["    Repo    : qa"]);
        expect(out.formatVariable({ label: "required-by", value: "core/sous-skills", detail: "https://example.com/x" }, { labelWidth: 11 })).toEqual([
            "    required-by: core/sous-skills https://example.com/x",
        ]);
        expect(out.formatVariable({ label: "", value: "second" }, { labelWidth: 5 })).toEqual(["           second"]);

        const wrapped = out.formatVariable({ label: "About", value: "one two three four five six" }, { labelWidth: 5, width: 30 });

        expect(wrapped[0]).toBe("    About: one two three four");
        expect(wrapped[1]).toBe("           five six");
        expect(plain().variables({ Config: "./my-config.js", Strict: "false" }).lines).toEqual(["    Config: ./my-config.js", "    Strict: false"]);
    });

    it("should write counts, errors, dry-run notices and warnings", () => {
        expect(plain().count(5, "tokens").lines).toEqual(["Found [5] tokens"]);
        expect(plain().count(5, "tokens", "", "Deleted").lines).toEqual(["Deleted [5] tokens"]);
        expect(plain().count(5, "tokens", "Totals").lines).toEqual([" ", "➔ Totals:", "  Found [5] tokens"]);
        expect(plain().error("Something broke.\nTry again.").lines).toEqual(["", "  Error: Something broke.", "  Try again.", "", ""]);
        expect(plain().dryRunNotice("File will not be written.").lines).toEqual(["    [Dry Run] File will not be written."]);
        expect(plain().warning("This is RISKY.").lines).toEqual(["", "", "   WARNING:   ", "  This is RISKY.", ""]);
    });

    it("should color through the style, and only when it is on", () => {
        const colored = new Printer(createStyle(true), 100).heading("Building");

        expect(colored.lines[1]).toBe("\u001b[93m▶ Building:\u001b[39m");
        expect(stripAnsi(new Printer(createStyle(true), 100).warning("A RISK").lines.join("\n"))).toBe(plain().warning("A RISK").lines.join("\n"));
    });

    it("should indent every line of a table, row notes included", () => {
        const out = plain().table([{ key: "name", header: "Name" }], [{ name: "a" }], { indent: 2, rowNote: () => "  one\n  two" });

        expect(out.lines).toEqual(["  Name", "  ----", "  a", "    one", "    two"]);
    });

    it("should end its text with a newline, and give nothing when empty", () => {
        expect(plain().log("a").text()).toBe("a\n");
        expect(plain().text()).toBe("");
    });
});

describe("colors and JSON", () => {
    it("should color a terminal, and honor NO_COLOR and FORCE_COLOR", () => {
        expect(colorEnabled({ isTTY: true }, {})).toBe(true);
        expect(colorEnabled({ isTTY: false }, {})).toBe(false);
        expect(colorEnabled({ isTTY: true }, { NO_COLOR: "1" })).toBe(false);
        expect(colorEnabled({ isTTY: false }, { FORCE_COLOR: "1" })).toBe(true);
        expect(colorEnabled({ isTTY: true }, { FORCE_COLOR: "0" })).toBe(false);
    });

    /** Keys cyan, strings green, numbers yellow, booleans and null magenta (config-inspect.ts). */
    it("should color JSON by token without changing it", () => {
        const style = createStyle(true);
        const json = JSON.stringify({ a: "x", n: 1, b: true, z: null }, null, 2);
        const colored = colorizeJson(json, style);

        expect(colored).toContain('\u001b[36m"a"\u001b[39m');
        expect(colored).toContain('\u001b[32m"x"\u001b[39m');
        expect(colored).toContain("\u001b[33m1\u001b[39m");
        expect(colored).toContain("\u001b[35mtrue\u001b[39m");
        expect(stripAnsi(colored)).toBe(json);
        expect(renderJson({ a: 1 }, createStyle(false))).toBe('{\n  "a": 1\n}');
    });

    it("should cut one-line JSON with an ellipsis", () => {
        expect(truncateJson("abc", 4)).toBe('"ab…');
        expect(truncateJson({ a: 1 })).toBe('{"a":1}');
        expect(truncateJson(undefined)).toBe("undefined");
    });
});
