import { describe, it, expect, vi } from "vitest";
import { pickReference } from "./pick.js";
import { Qualification, type ReferenceMatch } from "./find.js";
import { SousScope } from "./scopes.js";

/**
 * Unit tests for choosing between the things a reference could have meant.
 * Every command resolves a reference through this, so the four outcomes (one
 * match, several with a question, several with `--accept-first`, and several
 * with no terminal) are covered here once for all of them.
 */

/** Builds a recipe match in one repository. */
function recipeMatch(repo: string, namespace: string, recipe: string): ReferenceMatch {
  return {
    scope: SousScope.Recipe,
    key: `${repo}:${namespace}/${recipe}`,
    label: recipe,
    repo,
    namespace,
    recipe,
    qualification: Qualification.Bare,
  };
}

describe("pickReference()", () => {
  /**
   * One match is the answer, and is reported so the reader sees what the word
   * they typed actually meant.
   *
   * pickReference([one], { search: "task-files", interactive: true })
   * // -> the match, having written "'task-files' resolves to ..."
   */
  it("should take the only match and say what it resolved to", async () => {
    const written: string[] = [];
    const only = recipeMatch("fixtures", "workflow", "task-files");

    const chosen = await pickReference([only], {
      search: "task-files",
      interactive: true,
      write: (message) => written.push(message),
    });

    expect(chosen).toBe(only);
    expect(written.join("\n")).toContain("resolves to");
    expect(written.join("\n")).toContain("fixtures:workflow/task-files");
  });

  /**
   * A reference that matched nothing is refused, quoting what was searched for
   * and any extra context the caller supplied.
   *
   * pickReference([], { search: "nope", interactive: true })  // -> throws
   */
  it("should refuse a reference that matched nothing", async () => {
    await expect(
      pickReference([], {
        search: "nope",
        interactive: true,
        details: ["  Searched the recipes of: fixtures."],
      })
    ).rejects.toThrow(/Nothing called 'nope' was found[\s\S]*fixtures/);
  });

  /**
   * Several matches ask which one was meant, offering them in the order they
   * were given.
   *
   * pickReference([a, b], { search: "formatter", interactive: true })
   * // -> asks, and returns what the answer named
   */
  it("should ask which one was meant when several match", async () => {
    const first = recipeMatch("fixtures", "workflow", "formatter");
    const second = recipeMatch("extras", "tooling", "formatter");
    const choose = vi.fn(async () => second);

    const chosen = await pickReference([first, second], {
      search: "formatter",
      interactive: true,
      write: () => {},
      choose,
    });

    expect(chosen).toBe(second);
    expect(choose).toHaveBeenCalledOnce();
    expect(choose.mock.calls[0]![0]).toContain("formatter");
    expect(choose.mock.calls[0]![1]).toHaveLength(2);
  });

  /**
   * `--accept-first` answers the question ahead of time by taking the first
   * match in the documented order, and says that is what it did.
   *
   * pickReference([a, b], { search: "formatter", acceptFirst: true })
   * // -> a, having written "taking the first, because '--accept-first' was passed"
   */
  it("should take the first match with --accept-first", async () => {
    const written: string[] = [];
    const first = recipeMatch("fixtures", "workflow", "formatter");
    const second = recipeMatch("extras", "tooling", "formatter");
    const choose = vi.fn(async () => second);

    const chosen = await pickReference([first, second], {
      search: "formatter",
      interactive: true,
      acceptFirst: true,
      write: (message) => written.push(message),
      choose,
    });

    expect(chosen).toBe(first);
    expect(choose).not.toHaveBeenCalled();
    expect(written.join("\n")).toContain("--accept-first");
  });

  /**
   * A run that cannot ask fails rather than guessing, naming the question, every
   * candidate, and the flag that would have answered it.
   *
   * pickReference([a, b], { search: "formatter", interactive: false })  // -> throws
   */
  it("should fail without a terminal, naming --accept-first and the candidates", async () => {
    const first = recipeMatch("fixtures", "workflow", "formatter");
    const second = recipeMatch("extras", "tooling", "formatter");

    await expect(
      pickReference([first, second], {
        search: "formatter",
        interactive: false,
        write: () => {},
      })
    ).rejects.toThrow(/--accept-first/);

    await expect(
      pickReference([first, second], {
        search: "formatter",
        interactive: false,
        write: () => {},
      })
    ).rejects.toThrow(/extras:tooling\/formatter/);
  });

  /** A caller that reports the resolution itself can turn the notice off. */
  it("should stay silent when announcing is turned off", async () => {
    const written: string[] = [];
    const only = recipeMatch("fixtures", "workflow", "task-files");

    await pickReference([only], {
      search: "task-files",
      interactive: true,
      announce: false,
      write: (message) => written.push(message),
    });

    expect(written).toEqual([]);
  });
});
