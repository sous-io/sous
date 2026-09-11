import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseJsonc } from "jsonc-parser";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { parseEnvLocal } from "../../lib/env-local.js";
import {
  applyProvidedAnswers,
  askForMissing,
  collectProvidedAnswers,
  formatAskReport,
  formatQuestionPlan,
  loadLadderContext,
  planQuestions,
  VAR_MAPPINGS_LAYER_FILENAME,
  type DefinedVariable,
} from "../../lib/vars/index.js";

// The questions themselves are inquirer's job; these tests are about what sous
// does with the answers, so every prompt is replaced by queued replies. The
// value question is sous's own prompt, mocked at its module boundary; queueing
// the TAB sentinel is how a test presses Tab.
const answers: string[] = [];
const choices: unknown[] = [];

/** Queue this in place of an answer to press Tab and open the advanced view. */
const TAB = "<tab>";

vi.mock("@inquirer/prompts", () => ({
  input: vi.fn(async () => answers.shift() ?? ""),
  password: vi.fn(async () => answers.shift() ?? ""),
  confirm: vi.fn(async () => (answers.shift() ?? "true") === "true"),
  select: vi.fn(async () => choices.shift()),
}));

vi.mock("../../utils/value-prompt.js", () => ({
  valuePrompt: vi.fn(async () => {
    const next = answers.shift() ?? "";
    return next === TAB ? { kind: "advanced" } : { kind: "value", value: next };
  }),
}));

let tmp: TmpDir;
let sousDir: string;
let confDir: string;

beforeEach(() => {
  tmp = makeTmpDir("sous-vars-ask-");
  sousDir = path.join(tmp.path, ".sous");
  confDir = path.join(sousDir, "conf.d");
  fs.mkdirSync(sousDir, { recursive: true });
  answers.length = 0;
  choices.length = 0;
});

afterEach(() => {
  tmp.cleanup();
});

/** Builds a defined variable published by `misc/stuff`. */
function defined(overrides: Partial<DefinedVariable["definition"]> = {}): DefinedVariable {
  return {
    definition: {
      name: "apiUrl",
      type: "url",
      prompt: "Which API should sous talk to?",
      description: "The service every request this recipe generates is sent to.",
      example: "https://api.example.com",
      required: true,
      secret: false,
      scope: "shared",
      ...overrides,
    },
    recipe: { repo: "sous-recipes", namespace: "misc", name: "stuff", version: "1.0.0" },
  } as DefinedVariable;
}

/** The ladder context for the temp project, with an empty shell environment. */
function context() {
  return loadLadderContext({ sousDir, shellEnv: {} });
}

/** Reads one of the project's env files, or an empty string when it is missing. */
function readEnv(name: string): string {
  const filePath = path.join(sousDir, name);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

/** Runs something with console.log captured, and hands back the plain-text lines. */
async function captureLog(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const spy = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) =>
      lines.push(args.join(" ").replace(/\x1b\[[0-9;]*m/g, ""))
    );
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

/**
 * Asking, storing and inheriting answers, end to end against real env files in
 * a temp project.
 */
describe("asking for missing variable answers", () => {
  /**
   * askForMissing should store a shared answer in `.sous/.env`, under the
   * derived name, with a plain-language header comment above it.
   */
  it("should store a shared answer in the committed env file", async () => {
    answers.push("https://example.com");

    const report = await askForMissing([defined()], context(), {
      sousDir,
      confDir,
      interactive: true,
    });

    expect(report.answered).toHaveLength(1);
    expect(report.answered[0]!.envName).toBe("SOUS_VAR_API_URL");
    expect(report.answered[0]!.file).toBe(".env");

    const content = readEnv(".env");
    expect(parseEnvLocal(content).SOUS_VAR_API_URL).toBe("https://example.com");
    expect(content).toContain("# Set by sous for misc/stuff: Which API should sous talk to?");
    expect(content).toContain("# Edit freely; sous only rewrites the value line.");
  });

  /**
   * A secret should go to the gitignored `.sous/.env.local`, never to the
   * committed `.sous/.env`, and its value should not appear in the report text.
   */
  it("should store a secret in the gitignored env file and never print it", async () => {
    answers.push("super-secret-token");

    const report = await askForMissing(
      [defined({ name: "apiToken", type: "string", secret: true, scope: "local" })],
      context(),
      { sousDir, confDir, interactive: true }
    );

    expect(report.answered[0]!.file).toBe(".env.local");
    expect(parseEnvLocal(readEnv(".env.local")).SOUS_VAR_API_TOKEN).toBe("super-secret-token");
    expect(readEnv(".env")).toBe("");
    expect(formatAskReport(report).join("\n")).not.toContain("super-secret-token");
    expect(formatAskReport(report).join("\n")).toContain("(hidden)");
  });

  /**
   * A variable that already has a valid answer should be reported as inherited,
   * with its source shown, and should never be asked about again.
   */
  it("should inherit an answer that already fits, without asking", async () => {
    fs.writeFileSync(path.join(sousDir, ".env"), "SOUS_VAR_API_URL=https://example.com\n", "utf8");

    const report = await askForMissing([defined()], context(), {
      sousDir,
      confDir,
      interactive: true,
    });

    expect(report.answered).toHaveLength(0);
    expect(report.inherited).toHaveLength(1);
    expect(formatAskReport(report).join("\n")).toContain(
      "from the shared scope name SOUS_VAR_API_URL, from the .env file"
    );
    expect(answers).toHaveLength(0);
  });

  /**
   * When the name an answer would use is already bound to a value that does not
   * fit this definition, sous should offer to record a mapping and, on
   * acceptance, store the answer under the recipe-scoped name and write the
   * record into the machine-written conf.d layer.
   */
  it("should record a mapping when the declared name is already taken", async () => {
    fs.writeFileSync(path.join(sousDir, ".env"), "SOUS_VAR_API_URL=not-a-url\n", "utf8");
    choices.push(true); // Record a mapping (the recommended option).
    answers.push("https://example.com");

    const report = await askForMissing([defined()], context(), {
      sousDir,
      confDir,
      interactive: true,
    });

    const answered = report.answered[0]!;
    expect(answered.envName).toBe("SOUS_VAR_MISC_STUFF_API_URL");
    expect(answered.mapping?.target).toBe("sous-recipes:misc/stuff/apiUrl");

    const layer = parseJsonc(
      fs.readFileSync(path.join(confDir, VAR_MAPPINGS_LAYER_FILENAME), "utf8")
    ) as { varMappings: Record<string, string> };
    expect(layer.varMappings).toEqual({
      SOUS_VAR_MISC_STUFF_API_URL: "sous-recipes:misc/stuff/apiUrl",
    });
    expect(parseEnvLocal(readEnv(".env")).SOUS_VAR_API_URL).toBe("not-a-url");
  });

  /**
   * A dry run should work out and report everything it would do, and write
   * nothing at all.
   */
  it("should write nothing on a dry run", async () => {
    answers.push("https://example.com");

    const report = await askForMissing([defined()], context(), {
      sousDir,
      confDir,
      interactive: true,
      dryRun: true,
    });

    expect(report.answered[0]!.outcome).toBe("not written");
    expect(fs.readdirSync(sousDir)).toEqual([]);
    expect(formatAskReport(report, true).join("\n")).toContain("Answers that would be stored:");
  });

  /**
   * An optional variable with no answer should be left alone rather than asked
   * about, since a definition is inert until something needs it.
   */
  it("should leave an unanswered optional variable alone", async () => {
    const report = await askForMissing([defined({ required: false })], context(), {
      sousDir,
      confDir,
      interactive: true,
    });

    expect(report.answered).toHaveLength(0);
    expect(report.skipped[0]!.reason).toContain("optional");
  });

  /**
   * A non-interactive run with an unanswered required variable should fail,
   * naming every environment variable that would satisfy it, most specific
   * first, and nothing should be written.
   */
  it("should fail without a terminal and name the variables that would answer", async () => {
    await expect(
      askForMissing([defined()], context(), { sousDir, confDir, interactive: false })
    ).rejects.toThrow(/SOUS_VAR_MISC_STUFF_API_URL/);

    await expect(
      askForMissing([defined()], context(), { sousDir, confDir, interactive: false })
    ).rejects.toThrow(/no terminal to ask on/);

    expect(fs.readdirSync(sousDir)).toEqual([]);
  });

  /**
   * Answering one variable should make its value visible to the variables asked
   * after it in the same run, exactly as it would be on the next run.
   */
  it("should let a stored answer be inherited later in the same run", async () => {
    answers.push("https://example.com");
    const sameName = {
      ...defined(),
      recipe: { repo: "sous-recipes", namespace: "misc", name: "other", version: "1.0.0" },
    } as DefinedVariable;

    const report = await askForMissing([defined(), sameName], context(), {
      sousDir,
      confDir,
      interactive: true,
    });

    expect(report.answered).toHaveLength(1);
    expect(report.inherited).toHaveLength(1);
    expect(report.inherited[0]!.resolved.source.envName).toBe("SOUS_VAR_API_URL");
  });
});

/**
 * The advanced view: what Tab opens, what its menu changes, and what happens to
 * those changes when they are saved and when they are discarded.
 */
describe("the advanced view of a question", () => {
  /**
   * Tab, then "Change the stored variable name", then the recipe-scoped name,
   * then "Save changes and return to value entry" should store the answer under
   * the chosen name, with no mapping record needed, because that name is one the
   * resolution ladder already looks at.
   */
  it("should store under the chosen name when the change is saved", async () => {
    answers.push(TAB, "https://example.com");
    choices.push("name", "SOUS_VAR_MISC_STUFF_API_URL", "save");

    const report = await askForMissing([defined()], context(), {
      sousDir,
      confDir,
      interactive: true,
    });

    expect(report.answered[0]!.envName).toBe("SOUS_VAR_MISC_STUFF_API_URL");
    expect(report.answered[0]!.mapping).toBeUndefined();
    expect(parseEnvLocal(readEnv(".env")).SOUS_VAR_MISC_STUFF_API_URL).toBe(
      "https://example.com"
    );
  });

  /**
   * Discarding the change should put the plan back exactly as it was, so the
   * answer lands under the name the definition asked for.
   */
  it("should keep the original name when the change is discarded", async () => {
    answers.push(TAB, "https://example.com");
    choices.push("name", "SOUS_VAR_MISC_STUFF_API_URL", "discard");

    const report = await askForMissing([defined()], context(), {
      sousDir,
      confDir,
      interactive: true,
    });

    expect(report.answered[0]!.envName).toBe("SOUS_VAR_API_URL");
    expect(parseEnvLocal(readEnv(".env")).SOUS_VAR_API_URL).toBe("https://example.com");
  });

  /**
   * A secret may be pointed at the committed env file, because the rule is
   * informed consent rather than prevention: the warning is printed, the
   * question is asked, and a yes moves the answer to `.sous/.env`.
   */
  it("should move a secret to the committed file after a confirmation", async () => {
    answers.push(TAB, "true", "super-secret-token");
    choices.push("file", ".env", "save");

    const report = await askForMissing(
      [defined({ name: "apiToken", type: "string", secret: true, scope: "local" })],
      context(),
      { sousDir, confDir, interactive: true }
    );

    expect(report.answered[0]!.file).toBe(".env");
    expect(parseEnvLocal(readEnv(".env")).SOUS_VAR_API_TOKEN).toBe("super-secret-token");
    expect(readEnv(".env.local")).toBe("");
  });

  /**
   * Refusing the confirmation should leave the secret where the definition put
   * it, in the gitignored file.
   */
  it("should keep a secret local when the confirmation is refused", async () => {
    answers.push(TAB, "false", "super-secret-token");
    choices.push("file", ".env", "return");

    const report = await askForMissing(
      [defined({ name: "apiToken", type: "string", secret: true, scope: "local" })],
      context(),
      { sousDir, confDir, interactive: true }
    );

    expect(report.answered[0]!.file).toBe(".env.local");
    expect(readEnv(".env")).toBe("");
  });
});

/**
 * How a run that spans several recipes introduces itself before it asks
 * anything.
 */
describe("questions grouped by recipe", () => {
  /**
   * A closure covering more than one recipe should print one lead-in naming
   * every recipe and its count, then one opening line per recipe before its
   * own questions.
   */
  it("should print the lead-in and one opening line per recipe", async () => {
    const dependency = {
      ...defined({ name: "retries", type: "number", prompt: "How many retries?" }),
      recipe: { repo: "sous-recipes", namespace: "misc", name: "helper", version: "1.0.0" },
      requiredBy: [
        { repo: "sous-recipes", namespace: "misc", name: "stuff", version: "1.0.0" },
        { repo: "sous-recipes", namespace: "misc", name: "helper", version: "1.0.0" },
      ],
    } as DefinedVariable;

    answers.push("https://example.com", "3");

    const lines = await captureLog(async () => {
      await askForMissing([defined(), dependency], context(), {
        sousDir,
        confDir,
        interactive: true,
      });
    });

    const joined = lines.join("\n");
    expect(joined).toContain(
      "misc/stuff needs 1 answer, and misc/helper, which it depends on, needs 1."
    );
    expect(joined).toContain("misc/stuff needs 1 answer before it can be used.");
    expect(joined).toContain("misc/helper needs 1 answer before it can be used.");
    expect(joined).toContain("Question 1 of 1: apiUrl");
  });

  /**
   * A run covering one recipe needs no lead-in: its opening line already says
   * everything the lead-in would.
   */
  it("should print no lead-in for a single recipe", async () => {
    answers.push("https://example.com");

    const lines = await captureLog(async () => {
      await askForMissing([defined()], context(), { sousDir, confDir, interactive: true });
    });

    expect(lines.join("\n")).not.toContain("which it depends on");
    expect(lines.join("\n")).toContain("misc/stuff needs 1 answer before it can be used.");
  });
});

/**
 * Answering the questions before they are asked: what `--answer` and
 * `--answers-file` do once the command layer has collected them.
 */
describe("answering variables ahead of the questions", () => {
  /** An optional second variable, published by the same recipe. */
  function taskFileRoot(): DefinedVariable {
    return defined({
      name: "taskFileRoot",
      type: "path",
      prompt: "Where do task files live?",
      example: ".sous/tasks",
      required: false,
    });
  }

  /**
   * A supplied answer should be stored in the project's env file and should
   * then settle the question, so a run with no terminal succeeds where it would
   * otherwise have failed.
   *
   * applyProvidedAnswers, then askForMissing({ skip })
   * // -> .sous/.env holds both answers, and nothing is asked
   */
  it("should store every supplied answer and ask nothing else", async () => {
    const entries = [defined(), taskFileRoot()];
    const ladder = context();
    const options = { sousDir, confDir, interactive: false };

    const supplied = applyProvidedAnswers(
      entries,
      collectProvidedAnswers({
        answer: ["apiUrl=https://supplied.example.com", "taskFileRoot=.sous/tasks"],
      }),
      ladder,
      options
    );

    const report = await askForMissing(entries, ladder, {
      ...options,
      skip: supplied.keys,
    });
    report.answered.unshift(...supplied.stored);

    expect(report.answered).toHaveLength(2);
    expect(report.inherited).toHaveLength(0);

    const stored = parseEnvLocal(readEnv(".env"));
    expect(stored["SOUS_VAR_API_URL"]).toBe("https://supplied.example.com");
    expect(stored["SOUS_VAR_TASK_FILE_ROOT"]).toBe(".sous/tasks");

    const lines = formatAskReport(report).join("\n");
    expect(lines).toContain("Answers stored:");
    expect(lines).toContain("apiUrl = https://supplied.example.com");
  });

  /**
   * A required variable no supplied answer covers should still fail a run with
   * no terminal, naming the environment variables that would answer it.
   */
  it("should still fail on a variable no supplied answer covers", async () => {
    const entries = [defined(), defined({ name: "apiToken", type: "string" })];
    const ladder = context();
    const options = { sousDir, confDir, interactive: false };

    const supplied = applyProvidedAnswers(
      entries,
      collectProvidedAnswers({ answer: ["apiUrl=https://supplied.example.com"] }),
      ladder,
      options
    );

    await expect(
      askForMissing(entries, ladder, { ...options, skip: supplied.keys })
    ).rejects.toThrow(/apiToken[\s\S]*SOUS_VAR_MISC_STUFF_API_TOKEN/);
  });

  /**
   * An answer that does not fit its definition should fail the run, naming the
   * constraint it violated and the publisher's example, and nothing at all
   * should be written.
   */
  it("should fail on an answer that does not fit, writing nothing", () => {
    const entries = [defined(), taskFileRoot()];

    expect(() =>
      applyProvidedAnswers(
        entries,
        collectProvidedAnswers({
          answer: ["taskFileRoot=.sous/tasks", "apiUrl=example.com"],
        }),
        context(),
        { sousDir, confDir, interactive: false }
      )
    ).toThrow(/apiUrl must be a URL[\s\S]*For example: https:\/\/api\.example\.com/);

    expect(fs.readdirSync(sousDir)).toEqual([]);
  });

  /**
   * The question plan should describe every variable in play: what it is for,
   * where its answer would be stored, whether anything answers it already, and
   * the flag that answers it ahead of time.
   */
  it("should describe every question in the plan", () => {
    fs.writeFileSync(
      path.join(sousDir, ".env"),
      "SOUS_VAR_TASK_FILE_ROOT=.sous/tasks\n",
      "utf8"
    );

    const planned = planQuestions([defined(), taskFileRoot()], context(), { sousDir });
    const lines = formatQuestionPlan(planned, 100)
      .join("\n")
      .replace(/\x1b\[[0-9;]*m/g, "");

    expect(lines).toContain("These recipes ask 2 questions, 1 of which nothing answers yet.");
    expect(lines).toContain("misc/stuff asks 2 questions:");
    expect(lines).toContain("SOUS_VAR_API_URL");
    expect(lines).toContain("--answer apiUrl=<value>");
    expect(lines).toContain("no, and this recipe requires an answer");
    expect(lines).toContain("yes, from the shared scope name SOUS_VAR_TASK_FILE_ROOT");
  });
});
