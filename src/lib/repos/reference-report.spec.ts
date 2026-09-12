import { describe, expect, it } from "vitest";
import { formatResolvedReference, resolvedReferenceFacts } from "./reference-report.js";
import { Qualification, type ReferenceMatch } from "../refs/find.js";
import { SousScope } from "../refs/scopes.js";

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

/** What one match contributes to the report. */
describe("resolvedReferenceFacts()", () => {
  /** A recipe carries its whole identity, and its summary is a description. */
  it("should take the identity and the summary from a recipe match", () => {
    const match: ReferenceMatch = {
      scope: SousScope.Recipe,
      key: "sous-recipes:workflow/task-files",
      label: "task-files",
      repo: "sous-recipes",
      namespace: "workflow",
      recipe: "task-files",
      detail: "keeps one task file per branch",
      qualification: Qualification.Bare,
    };

    expect(resolvedReferenceFacts(match, "task-files")).toEqual({
      search: "task-files",
      resolvedTo: "sous-recipes:workflow/task-files",
      kind: "recipe",
      recipe: "task-files",
      namespace: "workflow",
      repository: "sous-recipes",
      description: "keeps one task file per branch",
    });
  });

  /**
   * A repository's detail is where it lives rather than a summary of it, and its
   * name is already the resolved spelling, so it is not repeated.
   */
  it("should report a repository's detail as where it lives", () => {
    const match: ReferenceMatch = {
      scope: SousScope.Repository,
      key: "sous-recipes",
      label: "sous-recipes",
      repo: "sous-recipes",
      detail: "https://example.invalid/sous-recipes.git",
      qualification: Qualification.Full,
    };

    expect(resolvedReferenceFacts(match, "sous-recipes")).toEqual({
      search: "sous-recipes",
      resolvedTo: "sous-recipes",
      kind: "repository",
      location: "https://example.invalid/sous-recipes.git",
    });
  });

  /** A caller that settled the reference some other way supplies its own sentence. */
  it("should carry a caller's own closing sentence", () => {
    const match: ReferenceMatch = {
      scope: SousScope.Namespace,
      key: "sous-recipes:workflow",
      label: "workflow",
      repo: "sous-recipes",
      namespace: "workflow",
      qualification: Qualification.Bare,
    };

    const lines = formatResolvedReference(
      resolvedReferenceFacts(match, "workflow", "Two things matched, and the first won.")
    ).map(strip);

    expect(lines[lines.length - 1]).toBe("  Two things matched, and the first won.");
  });
});
