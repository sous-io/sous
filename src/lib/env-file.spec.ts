import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTmpDir, type TmpDir } from "../test/utils/tmp.js";
import { parseEnvLocal } from "./env-local.js";
import {
  parseEnvFile,
  quoteEnvValue,
  removeEntry,
  renderEnvFile,
  setEntry,
  updateEnvFile,
} from "./env-file.js";

let tmp: TmpDir;

beforeEach(() => {
  tmp = makeTmpDir("sous-env-file-");
});

afterEach(() => {
  tmp.cleanup();
});

/** A hand-written env file with comments, blanks, quoting and an export line. */
const HAND_WRITTEN = [
  "# The team's shared answers.",
  "# Edit these freely.",
  "",
  "SOUS_VAR_API_URL=https://example.com",
  "export SOUS_VAR_REGION=eu-west-1  # closest to the office",
  "",
  "# A quoted value, because it has spaces in it.",
  "SOUS_VAR_GREETING=\"good morning\"",
  "",
].join("\n");

describe("parseEnvFile() and renderEnvFile()", () => {
  /**
   * parseEnvFile followed by renderEnvFile should return the file's bytes
   * unchanged, which is what makes editing safe: comments, blank lines, order,
   * quoting and the export prefix all survive.
   */
  it("should round-trip a hand-written file byte for byte", () => {
    expect(renderEnvFile(parseEnvFile(HAND_WRITTEN))).toBe(HAND_WRITTEN);
  });

  /**
   * parseEnvFile should classify each line, keeping anything it does not
   * recognize verbatim rather than discarding it.
   */
  it("should classify comments, blanks and assignments", () => {
    const model = parseEnvFile(HAND_WRITTEN);
    const kinds = model.lines.map((line) => line.kind);
    expect(kinds.slice(0, 5)).toEqual(["comment", "comment", "blank", "assignment", "assignment"]);

    const exported = model.lines.find(
      (line) => line.kind === "assignment" && line.key === "SOUS_VAR_REGION"
    );
    expect(exported?.kind === "assignment" && exported.exported).toBe(true);
    expect(exported?.kind === "assignment" && exported.inlineComment).toBe(
      "  # closest to the office"
    );
  });

  /**
   * An empty file should round-trip as an empty file rather than gaining a
   * stray newline.
   */
  it("should round-trip an empty file", () => {
    expect(renderEnvFile(parseEnvFile(""))).toBe("");
  });
});

describe("setEntry()", () => {
  /**
   * setEntry should rewrite an existing assignment where it stands, leaving
   * every other line, its export prefix and its trailing comment untouched.
   */
  it("should update an existing entry in place", () => {
    const model = parseEnvFile(HAND_WRITTEN);
    expect(setEntry(model, "SOUS_VAR_REGION", "us-east-1")).toBe("updated");

    const rendered = renderEnvFile(model);
    expect(rendered).toContain("export SOUS_VAR_REGION=us-east-1  # closest to the office");
    expect(rendered.split("\n").length).toBe(HAND_WRITTEN.split("\n").length);
    expect(rendered).toContain("# The team's shared answers.");
  });

  /**
   * setEntry should append a new entry at the end, under the generated header
   * comment, separated from what came before by one blank line.
   */
  it("should append a new entry under its header comment", () => {
    const model = parseEnvFile(HAND_WRITTEN);
    expect(
      setEntry(model, "SOUS_VAR_TOKEN", "abc123", {
        header: "Set by sous for misc/stuff: What is the API token?",
      })
    ).toBe("appended");

    const lines = renderEnvFile(model).split("\n");
    expect(lines.at(-2)).toBe("SOUS_VAR_TOKEN=abc123");
    expect(lines.at(-3)).toBe("# Set by sous for misc/stuff: What is the API token?");
  });

  /**
   * setEntry should rewrite the LAST assignment of a repeated key, because the
   * env file parser lets the last one win.
   */
  it("should rewrite the last of a repeated key", () => {
    const model = parseEnvFile("A=one\nA=two\n");
    setEntry(model, "A", "three");
    expect(renderEnvFile(model)).toBe("A=one\nA=three\n");
  });

  /**
   * A value that needs quoting should be written quoted, so the parser reads
   * back exactly what was stored.
   */
  it("should quote a value that needs it", () => {
    const model = parseEnvFile("");
    setEntry(model, "GREETING", "good # morning");
    expect(parseEnvLocal(renderEnvFile(model)).GREETING).toBe("good # morning");
  });
});

describe("quoteEnvValue()", () => {
  /**
   * quoteEnvValue should leave an ordinary word bare and quote anything that
   * would otherwise be misread.
   *
   * quoteEnvValue("plain");        // -> "plain"
   * quoteEnvValue("two words");    // -> "\"two words\""
   */
  it("should quote only what needs quoting", () => {
    expect(quoteEnvValue("plain")).toBe("plain");
    expect(quoteEnvValue("two words")).toBe('"two words"');
    expect(quoteEnvValue("")).toBe('""');
    expect(quoteEnvValue("line\nbreak")).toBe('"line\\nbreak"');
  });
});

describe("removeEntry()", () => {
  /**
   * removeEntry should drop every assignment of one key and leave the
   * surrounding comments and blank lines where they are, since sous never
   * parses comments and cannot know which ones belonged to the entry.
   */
  it("should remove the assignments and nothing else", () => {
    const model = parseEnvFile("# note\nA=one\nB=two\n");
    expect(removeEntry(model, "A")).toBe(1);
    expect(renderEnvFile(model)).toBe("# note\nB=two\n");
  });
});

describe("updateEnvFile()", () => {
  /**
   * updateEnvFile should create the file when it does not exist, and should
   * preserve every existing byte when it does, so repeated answers never churn
   * the file.
   */
  it("should create then update a file on disk", () => {
    const filePath = path.join(tmp.path, ".env");
    expect(updateEnvFile(filePath, "SOUS_VAR_API_URL", "https://example.com")).toBe("appended");
    expect(updateEnvFile(filePath, "SOUS_VAR_API_URL", "https://other.example.com")).toBe(
      "updated"
    );

    const content = fs.readFileSync(filePath, "utf8");
    expect(parseEnvLocal(content).SOUS_VAR_API_URL).toBe("https://other.example.com");
    expect(content.match(/SOUS_VAR_API_URL=/g)).toHaveLength(1);
  });

  /**
   * updateEnvFile should leave no temporary files behind, since it writes to a
   * temporary path in the same directory and renames it over the original.
   */
  it("should leave no temporary files behind", () => {
    const filePath = path.join(tmp.path, ".env.local");
    updateEnvFile(filePath, "SOUS_VAR_TOKEN", "abc123");
    expect(fs.readdirSync(tmp.path)).toEqual([".env.local"]);
  });
});
