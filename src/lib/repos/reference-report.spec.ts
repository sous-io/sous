import { describe, expect, it } from "vitest";
import { formatResolvedReference } from "./reference-report.js";

/** Strips ANSI escape codes so assertions are not brittle against color changes. */
const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

/** What a resolved reference is reported as. */
describe("formatResolvedReference()", () => {
  /**
   * What a reference resolved to is a set of facts, so it is a key and value
   * list with the colons lined up, not a sentence with the facts buried in it.
   */
  it("should write the facts as an aligned key and value list", () => {
    const lines = formatResolvedReference({
      search: "task-files",
      resolvedTo: "sous-recipes:workflow/task-files",
      kind: "recipe",
      repository: "sous-recipes",
      namespace: "workflow",
      recipe: "task-files",
      description: "keeps one task file per branch",
    }).map(strip);

    expect(lines[0]).toBe("    Resolved to: sous-recipes:workflow/task-files");
    expect(lines[1]).toBe("    Recipe     : task-files");
    expect(lines[2]).toBe("    Namespace  : workflow");
    expect(lines[3]).toBe("    Repository : sous-recipes");
    expect(lines[4]).toBe("    Description: keeps one task file per branch");
  });

  /** One short sentence follows the list, saying why that candidate won. */
  it("should close with one sentence naming what was searched for", () => {
    const lines = formatResolvedReference({
      search: "workflow",
      resolvedTo: "sous-recipes:workflow",
      kind: "namespace",
      repository: "sous-recipes",
      namespace: "workflow",
    }).map(strip);

    expect(lines[lines.length - 2]).toBe("");
    expect(lines[lines.length - 1]).toBe(
      "  'workflow' named one namespace, and nothing else, so that is what is being used."
    );
  });

  /** A fact the reference does not have is left out rather than shown empty. */
  it("should leave out the facts a reference does not carry", () => {
    const lines = formatResolvedReference({
      search: "sous-recipes",
      resolvedTo: "sous-recipes",
      kind: "repository",
      repository: "sous-recipes",
    })
      .map(strip)
      .join("\n");

    expect(lines).not.toContain("Recipe");
    expect(lines).not.toContain("Namespace");
    expect(lines).not.toContain("Description");
  });
});
