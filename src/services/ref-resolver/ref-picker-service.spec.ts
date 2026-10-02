import { describe, expect, it, vi } from "vitest";
import { recipeRef, variableOf } from "../../test/utils/ref-fixtures.js";
import { variableRefOf } from "./lookups/variable-lookup.js";
import { RefPickArguments, RefPickerService, resolvedRefFacts } from "./ref-picker-service.js";
import type { SousRef } from "./types.js";

/** Strips ANSI escape codes so assertions are not brittle against color changes. */
const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

const picker = new RefPickerService();

describe("RefPickerService.pick()", () => {
  /**
   * One match is the answer, reported as an aligned key and value list, then
   * one sentence saying why that candidate won.
   *
   * pick([one], { search: "task-files" }) // -> the ref, having written "Resolved to: ..."
   */
  it("should take the only match and report the facts about it", async () => {
    const written: string[] = [];
    const only = {
      ...recipeRef("workflow", "task-files", "fixtures"),
      description: "Task files",
    };

    const chosen = await picker.pick(
      [only],
      new RefPickArguments({
        search: "task-files",
        interactive: true,
        write: (message) => written.push(message),
      })
    );

    const report = strip(written.join("\n"));
    expect(chosen).toBe(only);
    expect(report).toContain("Resolved to: fixtures:workflow/task-files");
    expect(report).toContain("Recipe     : task-files");
    expect(report).toContain("Namespace  : workflow");
    expect(report).toContain("Repository : fixtures");
    expect(report).toContain("Description: Task files");
    expect(report).toContain(
      "'task-files' named one recipe, and nothing else, so that is what is being used."
    );
  });

  /**
   * A ref that matched nothing is refused, quoting what was searched for and
   * any extra context the caller supplied.
   *
   * pick([], { search: "nope" }) // throws
   */
  it("should refuse a ref that matched nothing", async () => {
    await expect(
      picker.pick(
        [],
        new RefPickArguments({
          search: "nope",
          interactive: true,
          details: ["  Searched the recipes of: fixtures."],
        })
      )
    ).rejects.toThrow(/Nothing called 'nope' was found[\s\S]*fixtures/);
  });

  /**
   * Several matches ask which one was meant, offering them in the order they
   * were given.
   *
   * pick([a, b], { search: "formatter" }) // -> asks, and returns the answer
   */
  it("should ask which one was meant when several match", async () => {
    const first = recipeRef("workflow", "formatter", "fixtures");
    const second = recipeRef("tooling", "formatter", "extras");
    const choose = vi.fn(async (_message: string, _offered: SousRef[]) => second);

    const chosen = await picker.pick(
      [first, second],
      new RefPickArguments({ search: "formatter", interactive: true, write: () => {}, choose })
    );

    expect(chosen).toBe(second);
    expect(choose).toHaveBeenCalledOnce();
    expect(choose.mock.calls[0]![0]).toContain("formatter");
    expect(choose.mock.calls[0]![1]).toHaveLength(2);
  });

  /**
   * `--accept-first` takes the first match in the documented order and says
   * that is what it did.
   *
   * pick([a, b], { acceptFirst: true }) // -> a
   */
  it("should take the first match with --accept-first", async () => {
    const written: string[] = [];
    const first = recipeRef("workflow", "formatter", "fixtures");
    const second = recipeRef("tooling", "formatter", "extras");
    const choose = vi.fn(async () => second);

    const chosen = await picker.pick(
      [first, second],
      new RefPickArguments({
        search: "formatter",
        interactive: true,
        acceptFirst: true,
        write: (message) => written.push(message),
        choose,
      })
    );

    const report = strip(written.join("\n"));
    expect(chosen).toBe(first);
    expect(choose).not.toHaveBeenCalled();
    expect(report).toContain("Resolved to: fixtures:workflow/formatter");
    expect(report).toContain("'formatter' named 2 things, and '--accept-first' was passed");
  });

  /**
   * A caller that reports the resolution itself is still told the word was
   * ambiguous, and one that turns announcing off hears nothing otherwise.
   *
   * pick([a, b], { acceptFirst: true, announce: false }) // -> only the sentence
   */
  it("should still say --accept-first chose, with announcing turned off", async () => {
    const written: string[] = [];
    const first = recipeRef("workflow", "formatter", "fixtures");
    const second = recipeRef("tooling", "formatter", "extras");

    await picker.pick(
      [first, second],
      new RefPickArguments({
        search: "formatter",
        interactive: true,
        acceptFirst: true,
        announce: false,
        write: (message) => written.push(message),
      })
    );
    const report = strip(written.join("\n"));
    expect(report).toContain("--accept-first");
    expect(report).not.toContain("Resolved to");

    const silent: string[] = [];
    await picker.pick(
      [first],
      new RefPickArguments({
        search: "formatter",
        interactive: true,
        announce: false,
        write: (message) => silent.push(message),
      })
    );
    expect(silent).toEqual([]);
  });

  /**
   * A run that cannot ask fails rather than guessing, naming the question,
   * every candidate and the flag that would have answered it.
   *
   * pick([a, b], { interactive: false }) // throws
   */
  it("should fail without a terminal, naming --accept-first and the candidates", async () => {
    const first = recipeRef("workflow", "formatter", "fixtures");
    const second = recipeRef("tooling", "formatter", "extras");
    const args = new RefPickArguments({ search: "formatter", interactive: false });

    await expect(picker.pick([first, second], args)).rejects.toThrow(/--accept-first/);
    await expect(picker.pick([first, second], args)).rejects.toThrow(/extras:tooling\/formatter/);
  });
});

describe("resolvedRefFacts()", () => {
  /**
   * An environment variable name resolves to the variable it answers.
   *
   * facts(envVar answering fixtures:workflow/task-files.apiUrl)
   */
  it("should report the variable an environment name answers", () => {
    const variable = variableRefOf(variableOf("fixtures", "workflow", "task-files", "apiUrl"));
    const facts = resolvedRefFacts(
      { kind: "envVar", name: "SOUS_VAR_API_URL", variables: [variable] },
      "SOUS_VAR_API_URL"
    );
    expect(facts).toMatchObject({
      resolvedTo: "fixtures:workflow/task-files.apiUrl",
      kind: "environment variable",
      variable: "apiUrl",
      recipe: "task-files",
      namespace: "workflow",
      repository: "fixtures",
    });
  });

  /**
   * A repository reports where it lives and does not repeat its own name.
   *
   * facts(repo fixtures at https://github.com/o/f) // location, no repository line
   */
  it("should report a repository's location", () => {
    const facts = resolvedRefFacts(
      {
        kind: "repo",
        name: "fixtures",
        location: {
          provider: "github",
          host: "github.com",
          repoPath: "o/f",
          identity: "github.com/o/f",
          url: "https://github.com/o/f",
        },
      },
      "fixtures",
      "because"
    );
    expect(facts).toMatchObject({ resolvedTo: "fixtures", location: "https://github.com/o/f", reason: "because" });
    expect(facts.repository).toBeUndefined();
  });
});
