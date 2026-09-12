import { describe, expect, it } from "vitest";
import {
  advancedViewLines,
  ANOTHER_NAME,
  askLeadIn,
  basicViewLines,
  committedFileWarning,
  fileChoices,
  nameChoices,
  questionHint,
  recipeOpeningLine,
} from "./ask.js";
import type { DefinedVariable } from "./definition-source.js";

/** Strips ANSI escape codes so assertions are not brittle against color changes. */
const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

/** A defined variable published by `workflow/task-files`. */
function defined(overrides: Partial<DefinedVariable["definition"]> = {}): DefinedVariable {
  return {
    definition: {
      name: "taskFileRoot",
      type: "path",
      prompt: "Where should task files be stored?",
      description: "This recipe stores task files locally.",
      example: "~/my-task-files",
      default: ".sous/tasks",
      required: true,
      secret: false,
      scope: "shared",
      ...overrides,
    },
    recipe: {
      repo: "sous-recipes",
      namespace: "workflow",
      name: "task-files",
      version: "1.0.0",
    },
  } as DefinedVariable;
}

/** The sentence printed before a run that spans more than one recipe. */
describe("askLeadIn()", () => {
  /**
   * askLeadIn should name each recipe and its count, marking a recipe that only
   * arrived as a dependency as one the first recipe depends on.
   *
   * askLeadIn([{ key: "a", count: 4, direct: true }, { key: "b", count: 2, direct: false }]);
   * // -> "a needs 4 answers, and b, which it depends on, needs 2."
   */
  it("should name every recipe, its count, and how it got here", () => {
    expect(
      askLeadIn([
        { key: "workflow/task-files", count: 4, direct: true },
        { key: "workflow/sub-agent-delegation", count: 2, direct: false },
      ])
    ).toBe(
      "workflow/task-files needs 4 answers, and workflow/sub-agent-delegation, " +
        "which it depends on, needs 2."
    );
  });

  /**
   * One recipe needs no lead-in, because its own opening line already says how
   * many answers it needs.
   */
  it("should produce nothing for a single recipe", () => {
    expect(askLeadIn([{ key: "workflow/task-files", count: 4, direct: true }])).toBeUndefined();
  });
});

/** The line that opens one recipe's questions. */
describe("recipeOpeningLine()", () => {
  /**
   * recipeOpeningLine should use the right noun for the count, so a single
   * question never reads "1 answers".
   *
   * recipeOpeningLine("workflow/task-files", 1);
   * // -> "workflow/task-files needs 1 answer before it can be used."
   */
  it("should count answers with the right noun", () => {
    expect(recipeOpeningLine("workflow/task-files", 4)).toBe(
      "workflow/task-files needs 4 answers before it can be used."
    );
    expect(recipeOpeningLine("workflow/task-files", 1)).toBe(
      "workflow/task-files needs 1 answer before it can be used."
    );
  });
});

/** The view printed above every value question. */
describe("basicViewLines()", () => {
  /**
   * The basic view should carry the question header, the description, the four
   * labeled facts a person needs before typing an answer, and the hint naming
   * both keys that do anything. The facts are indented and labeled exactly as
   * the advanced view draws them.
   */
  it("should draw the header, the labeled facts and the hint", () => {
    const lines = basicViewLines(
      {
        defined: defined(),
        index: 1,
        total: 4,
        plan: { file: ".env", envName: "SOUS_VAR_TASK_FILE_ROOT" },
        suggestion: ".sous/tasks",
        width: 80,
      },
      "/home/me/project/.sous/.env"
    ).map(strip);

    expect(lines[0]).toBe("Question 1 of 4: taskFileRoot");
    expect(lines).toContain("This recipe stores task files locally.");
    expect(lines).toContain("    default     : .sous/tasks");
    expect(lines).toContain("    example     : ~/my-task-files");
    expect(lines).toContain("    stored-as   : SOUS_VAR_TASK_FILE_ROOT");
    expect(lines).toContain("    storage-path: /home/me/project/.sous/.env");
    // The keys are named by the legend the prompt draws under its input line,
    // so the view itself ends with the facts.
    expect(lines.join("\n")).not.toContain("TAB for advanced");
  });

  /**
   * The muted sentence that used to say where the answer would be stored is
   * gone; the two labeled facts say it instead.
   */
  it("should not repeat the storage facts as a sentence", () => {
    const lines = basicViewLines(
      {
        defined: defined(),
        index: 1,
        total: 4,
        plan: { file: ".env", envName: "SOUS_VAR_TASK_FILE_ROOT" },
        width: 80,
      },
      "/home/me/project/.sous/.env"
    ).map(strip);

    expect(lines.join("\n")).not.toContain("Stored as");
  });

  /**
   * The basic and the advanced view draw their shared facts identically, down
   * to the indentation and the label column, because both come from the one
   * renderer.
   */
  it("should draw its facts exactly as the advanced view draws them", () => {
    const input = {
      defined: defined(),
      index: 1,
      total: 4,
      plan: { file: ".env", envName: "SOUS_VAR_TASK_FILE_ROOT" },
      width: 80,
    };
    const storagePath = "/home/me/project/.sous/.env";

    const basic = basicViewLines(input, storagePath).map(strip);
    const advanced = advancedViewLines(input, storagePath).map(strip);

    for (const line of basic.filter((text) => /^ {4}[a-z-]+ *:/.test(text))) {
      expect(advanced).toContain(line);
    }
  });

  /**
   * Without a default there is nothing for Enter alone to accept, so the legend
   * names Tab only and no `default` line is drawn.
   */
  it("should drop the Enter half of the hint when there is no default", () => {
    const entry = defined();
    delete entry.definition.default;
    const lines = basicViewLines(
      {
        defined: entry,
        index: 2,
        total: 2,
        plan: { file: ".env.local", envName: "SOUS_VAR_TASK_FILE_ROOT" },
        width: 80,
      },
      "/home/me/project/.sous/.env.local"
    ).map(strip);

    expect(lines.join("\n")).not.toContain("default     :");
    expect(strip(questionHint(entry.definition))).toBe("\u21e5 advanced");
  });

  /**
   * A question answered from a list names the arrow keys, and a yes-or-no
   * question names the two letters; Tab means the same thing at every kind of
   * question, and every legend is written in the style the stock prompts use.
   */
  it("should say the answer is chosen for an enum and a boolean question", () => {
    const enumHint = questionHint(
      defined({ type: "enum" as const, validate: { enum: ["red", "blue"] } }).definition,
      "red"
    );
    const booleanHint = questionHint(defined({ type: "boolean" as const }).definition, "red");

    expect(strip(enumHint)).toBe("\u2191\u2193 navigate \u2022 \u23ce select \u2022 \u21e5 advanced");
    expect(strip(booleanHint)).toBe(
      "y/n answer \u2022 \u23ce accept default \u2022 \u21e5 advanced"
    );
  });
});

/** The pick lists the advanced view offers. */
describe("nameChoices()", () => {
  /**
   * Every rung the ladder looks up should be offered, most specific first, with
   * a free-text option at the end for a name of the person's own choosing.
   */
  it("should offer every ladder rung and a free-text option", () => {
    const choices = nameChoices(defined());
    expect(choices.map((choice) => choice.value)).toEqual([
      "SOUS_VAR_WORKFLOW_TASK_FILES_TASK_FILE_ROOT",
      "SOUS_VAR_WORKFLOW_TASK_FILE_ROOT",
      "SOUS_VAR_TASK_FILE_ROOT",
      ANOTHER_NAME,
    ]);
    expect(choices[0]!.name).toContain("recipe scope");
    expect(choices[choices.length - 1]!.name).toContain("Another name");
  });

  /**
   * A definition that names an environment variable of its own should offer it
   * too, as the declared name.
   */
  it("should offer a declared name when the definition has one", () => {
    const choices = nameChoices(defined({ env: "TASK_FILE_ROOT" }));
    expect(choices.map((choice) => choice.value)).toContain("TASK_FILE_ROOT");
    expect(choices.find((choice) => choice.value === "TASK_FILE_ROOT")!.name).toContain(
      "declared name"
    );
  });
});

/** The two env files, and what choosing the committed one means. */
describe("fileChoices() and committedFileWarning()", () => {
  /**
   * Both files should be offered, each described by what it means for the team
   * rather than by its name alone.
   */
  it("should describe both files by what they mean", () => {
    const choices = fileChoices();
    expect(choices.map((choice) => choice.value)).toEqual([".env", ".env.local"]);
    expect(choices[0]!.name).toContain("committed");
    expect(choices[1]!.name).toContain("gitignored");
  });

  /**
   * The warning for a secret should say plainly what storing it in the
   * committed file does, without refusing to do it.
   */
  it("should say what committing a secret would do", () => {
    const text = committedFileWarning(defined({ secret: true }));
    expect(text).toContain("declared this variable a secret");
    expect(text).toContain("git history");

    const local = committedFileWarning(defined({ scope: "local" }));
    expect(local).toContain("machine-specific");
  });
});
