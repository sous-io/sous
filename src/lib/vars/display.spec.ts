import { describe, expect, it } from "vitest";
import {
  BASIC_FACT_LABELS,
  recipeLink,
  renderFacts,
  selectFacts,
  variableFacts,
  type LabeledFact,
} from "./display.js";
import type { DefinedVariable, DefiningRecipe } from "./definition-source.js";

/** Strips ANSI escape codes so assertions are not brittle against color changes. */
const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

/** The recipe that publishes the variable under test. */
function recipe(overrides: Partial<DefiningRecipe> = {}): DefiningRecipe {
  return {
    repo: "sous-recipes",
    namespace: "workflow",
    name: "task-files",
    version: "1.2.0",
    ...overrides,
  };
}

/** A defined variable, with the fields the facts renderer reads. */
function defined(overrides: Partial<DefinedVariable> = {}): DefinedVariable {
  return {
    definition: {
      name: "taskFileRoot",
      type: "path",
      prompt: "Where should task files be stored?",
      description: "Where agents store and search for task files.",
      example: "~/my-task-files",
      default: ".sous/tasks",
      required: true,
      secret: false,
      scope: "shared",
      validate: { minLength: 1 },
    },
    recipe: recipe(),
    ...overrides,
  } as DefinedVariable;
}

/** The facts block, which the advanced view and `sous vars show` both print. */
describe("variableFacts()", () => {
  /**
   * variableFacts should list the default, the example, who required the
   * variable, who defined it, where the answer is stored, under what name, and
   * one bullet per constraint, in that order.
   */
  it("should produce the labeled facts in a fixed order", () => {
    const facts = variableFacts({
      defined: defined(),
      storagePath: "/home/me/project/.sous/.env",
      storedAs: "SOUS_VAR_TASK_FILE_ROOT",
    });

    expect(facts.map((fact: LabeledFact) => fact.label)).toEqual([
      "default",
      "example",
      "required-by",
      "defined-by",
      "storage-path",
      "stored-as",
      "constraints",
    ]);
    expect(facts.find((fact) => fact.label === "storage-path")?.lines).toEqual([
      "/home/me/project/.sous/.env",
    ]);
    expect(facts.find((fact) => fact.label === "constraints")?.lines).toEqual([
      "\u2022 must be a value of the type path (type: path)",
      "\u2022 must be at least 1 character long (minLength: 1)",
    ]);
  });

  /**
   * A variable with no default should not print a `default` line at all, since
   * an empty label reads as though the default were blank.
   */
  it("should leave out the default when the definition has none", () => {
    const entry = defined();
    delete entry.definition.default;
    const labels = variableFacts({
      defined: entry,
      storagePath: "/tmp/.env",
      storedAs: "SOUS_VAR_TASK_FILE_ROOT",
    }).map((fact) => fact.label);
    expect(labels).not.toContain("default");
  });

  /**
   * When a dependency pulled the variable in, `required-by` should name the
   * subscribed recipe and then spell out the chain that reached the definition.
   */
  it("should show the chain when the variable arrived indirectly", () => {
    const entry = defined({
      recipe: recipe({ name: "sub-agent-delegation" }),
      requiredBy: [recipe(), recipe({ name: "sub-agent-delegation" })],
    });
    const lines =
      variableFacts({ defined: entry, storagePath: "/tmp/.env", storedAs: "X" }).find(
        (fact) => fact.label === "required-by"
      )?.lines ?? [];

    expect(lines[0]).toEqual({ text: "workflow/task-files" });
    expect(lines[1]).toBe(
      "pulled in through workflow/task-files then workflow/sub-agent-delegation"
    );
  });
});

/** How a recipe is written as a link. */
describe("recipeLink()", () => {
  /**
   * A hosted repository should carry its URL with the recipe's folder appended
   * as the muted detail beside the key, never in parentheses.
   *
   * recipeLink({ url: "https://example.com/repo", path: "recipes/x" });
   * // -> { text: "workflow/task-files", detail: "https://example.com/repo/recipes/x" }
   */
  it("should append the recipe path to a hosted repository URL", () => {
    const link = recipeLink(
      recipe({ url: "https://example.com/repo/", path: "recipes/workflow/task-files" })
    );
    expect(link).toEqual({
      text: "workflow/task-files",
      detail: "https://example.com/repo/recipes/workflow/task-files",
    });
  });

  /**
   * A repository read from this machine should carry a filesystem path, and a
   * recipe with no location at all should carry its key alone.
   */
  it("should show a filesystem path for a local repository", () => {
    expect(recipeLink(recipe({ url: "/srv/recipes", path: "workflow/task-files" }))).toEqual({
      text: "workflow/task-files",
      detail: "/srv/recipes/workflow/task-files",
    });
    expect(recipeLink(recipe({ dir: "/store/workflow/task-files/1.2.0" }))).toEqual({
      text: "workflow/task-files",
      detail: "/store/workflow/task-files/1.2.0",
    });
    expect(recipeLink(recipe())).toEqual({ text: "workflow/task-files" });
  });
});

/** The layout of the facts block. */
describe("renderFacts()", () => {
  /**
   * renderFacts should align every label, line the colons up, hang continuation
   * lines under the value column, and wrap text to the width it was given.
   */
  it("should align the labels and hang continuation lines", () => {
    const lines = renderFacts(
      [
        { label: "default", lines: [".sous/tasks"] },
        { label: "constraints", lines: ["• one", "• two"] },
      ],
      40
    ).map(strip);

    expect(lines[0]).toBe("    default    : .sous/tasks");
    expect(lines[1]).toBe("    constraints: • one");
    expect(lines[2]).toBe("                 • two");
  });

  /**
   * A fact line carrying a detail should write it after the value rather than
   * in parentheses.
   */
  it("should write a fact's detail after its value", () => {
    const lines = renderFacts(
      [{ label: "defined-by", lines: [{ text: "core/sous-skills", detail: "/srv/recipes" }] }],
      60
    ).map(strip);

    expect(lines[0]).toBe("    defined-by: core/sous-skills /srv/recipes");
  });

  /**
   * The block indents itself, so every view that prints facts puts them at the
   * same depth without each caller remembering to.
   */
  it("should indent every line it renders", () => {
    const lines = renderFacts([{ label: "example", lines: ["~/tasks"] }], 40).map(strip);
    for (const line of lines) expect(line.startsWith("    ")).toBe(true);
  });
});

/** The subset of facts the basic view of a question shows. */
describe("selectFacts()", () => {
  /**
   * selectFacts should return the named facts in the order they were asked for,
   * and quietly drop one the variable does not have.
   */
  it("should keep the named facts in order and skip missing ones", () => {
    const facts = variableFacts({
      defined: defined(),
      storagePath: "/home/me/project/.sous/.env",
      storedAs: "SOUS_VAR_TASK_FILE_ROOT",
    });

    expect(selectFacts(facts, BASIC_FACT_LABELS).map((fact) => fact.label)).toEqual([
      "default",
      "example",
      "stored-as",
      "storage-path",
    ]);
    expect(selectFacts(facts, ["nothing-defines-this"])).toEqual([]);
  });
});
