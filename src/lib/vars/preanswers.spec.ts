import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTmpDir, type TmpDir } from "../../test/utils/tmp.js";
import { parseEnvLocal } from "../env-local.js";
import { loadLadderContext } from "./ladder.js";
import type { DefinedVariable } from "./definition-source.js";
import {
  applyProvidedAnswers,
  collectProvidedAnswers,
  loadAnswersFile,
  parseAnswerPair,
} from "./preanswers.js";

let tmp: TmpDir;
let sousDir: string;
let confDir: string;

beforeEach(() => {
  tmp = makeTmpDir("sous-preanswers-");
  sousDir = path.join(tmp.path, ".sous");
  confDir = path.join(sousDir, "conf.d");
  fs.mkdirSync(sousDir, { recursive: true });
});

afterEach(() => {
  tmp.cleanup();
});

/** Builds a variable definition published by `misc/stuff`. */
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
function context(shellEnv: NodeJS.ProcessEnv = {}) {
  return loadLadderContext({ sousDir, shellEnv });
}

/** Where answers are written, with the directories the writer needs. */
function options(dryRun = false) {
  return { sousDir, confDir, interactive: false, dryRun };
}

/** Reads one of the project's env files as a key-to-value map. */
function readEnv(name: string): Record<string, string> {
  const filePath = path.join(sousDir, name);
  return fs.existsSync(filePath)
    ? parseEnvLocal(fs.readFileSync(filePath, "utf8"))
    : {};
}

describe("parseAnswerPair()", () => {
  /**
   * parseAnswerPair should split a pair on its FIRST '=' only, so a value may
   * hold as many more as it likes.
   *
   * parseAnswerPair("apiUrl=https://x.test/?a=1&b=2");
   * // -> { name: "apiUrl", value: "https://x.test/?a=1&b=2", from: "--answer <name>=<value>" }
   */
  it("should split on the first equals sign only", () => {
    const parsed = parseAnswerPair("apiUrl=https://x.test/?a=1&b=2");

    expect(parsed.name).toBe("apiUrl");
    expect(parsed.value).toBe("https://x.test/?a=1&b=2");
  });

  /**
   * parseAnswerPair should keep an empty value, which is how an optional
   * variable is deliberately answered with nothing.
   */
  it("should keep an empty value", () => {
    expect(parseAnswerPair("taskFileRoot=").value).toBe("");
  });

  /**
   * parseAnswerPair should refuse a pair with no '=' at all, and show the form
   * it wanted.
   */
  it("should refuse a pair with no equals sign", () => {
    expect(() => parseAnswerPair("apiUrl")).toThrow(/--answer <name>=<value>/);
  });
});

describe("loadAnswersFile()", () => {
  /**
   * loadAnswersFile should read a YAML map of pairs, converting every scalar to
   * the text an env file holds.
   */
  it("should read a YAML map of answers", () => {
    const filePath = path.join(tmp.path, "answers.yaml");
    fs.writeFileSync(filePath, "apiUrl: https://api.example.com\nretries: 3\n", "utf8");

    expect(loadAnswersFile(filePath)).toEqual([
      { name: "apiUrl", value: "https://api.example.com", from: filePath },
      { name: "retries", value: "3", from: filePath },
    ]);
  });

  /**
   * loadAnswersFile should read JSON with comments in it, because it goes
   * through the same permissive loader every hand-written manifest uses.
   */
  it("should read JSON with comments in it", () => {
    const filePath = path.join(tmp.path, "answers.json");
    fs.writeFileSync(
      filePath,
      '{\n  // the service this project talks to\n  "apiUrl": "https://api.example.com",\n}\n',
      "utf8"
    );

    expect(loadAnswersFile(filePath)).toEqual([
      { name: "apiUrl", value: "https://api.example.com", from: filePath },
    ]);
  });

  /**
   * loadAnswersFile should refuse a nested value, since an answer is a single
   * value written into an env file.
   */
  it("should refuse a nested value", () => {
    const filePath = path.join(tmp.path, "nested.yaml");
    fs.writeFileSync(filePath, "apiUrl:\n  host: example.com\n", "utf8");

    expect(() => loadAnswersFile(filePath)).toThrow(/single value/);
  });
});

describe("collectProvidedAnswers()", () => {
  /**
   * collectProvidedAnswers should lay the flags over the file, so an --answer
   * wins over the same name in an --answers-file.
   *
   * file: { apiUrl: "https://file.example.com" }
   * flags: ["apiUrl=https://flag.example.com"]
   * // -> the flag's value
   */
  it("should let an --answer win over the same name in the file", () => {
    const filePath = path.join(tmp.path, "answers.yaml");
    fs.writeFileSync(
      filePath,
      "apiUrl: https://file.example.com\ntaskFileRoot: .sous/tasks\n",
      "utf8"
    );

    const collected = collectProvidedAnswers({
      answer: ["apiUrl=https://flag.example.com"],
      answersFile: filePath,
    });

    expect(collected).toEqual([
      { name: "apiUrl", value: "https://flag.example.com", from: "--answer <name>=<value>" },
      { name: "taskFileRoot", value: ".sous/tasks", from: filePath },
    ]);
  });

  /**
   * collectProvidedAnswers should resolve a relative answers file against the
   * directory it was given, not the process's own.
   */
  it("should resolve a relative answers file against the given directory", () => {
    fs.writeFileSync(path.join(tmp.path, "answers.yaml"), "apiUrl: https://x.test\n", "utf8");

    const collected = collectProvidedAnswers({
      answersFile: "answers.yaml",
      cwd: tmp.path,
    });

    expect(collected[0]!.value).toBe("https://x.test");
  });
});

describe("applyProvidedAnswers()", () => {
  /**
   * applyProvidedAnswers should store a supplied answer exactly where the
   * interactive flow would: under the derived name, in the committed env file
   * for a shared variable.
   *
   * applyProvidedAnswers([apiUrl], [{ name: "apiUrl", value: "https://x.test" }], ...);
   * // -> .sous/.env holds SOUS_VAR_API_URL=https://x.test
   */
  it("should store a supplied answer in the file its scope asks for", () => {
    const applied = applyProvidedAnswers(
      [defined()],
      [{ name: "apiUrl", value: "https://x.test", from: "--answer" }],
      context(),
      options()
    );

    expect(applied.keys).toEqual(["misc/stuff.apiUrl"]);
    expect(applied.stored[0]!.envName).toBe("SOUS_VAR_API_URL");
    expect(readEnv(".env")["SOUS_VAR_API_URL"]).toBe("https://x.test");
  });

  /**
   * applyProvidedAnswers should write a secret to the gitignored local file,
   * and should never echo its value.
   */
  it("should store a secret in the gitignored local file", () => {
    const secret = defined({ name: "apiToken", type: "string", secret: true });

    const applied = applyProvidedAnswers(
      [secret],
      [{ name: "apiToken", value: "t0ken", from: "--answer" }],
      context(),
      options()
    );

    expect(applied.stored[0]!.file).toBe(".env.local");
    expect(readEnv(".env.local")["SOUS_VAR_API_TOKEN"]).toBe("t0ken");
  });

  /**
   * applyProvidedAnswers should replace an answer that is already stored, where
   * that answer lives, and report what it replaced.
   */
  it("should overwrite an answer that is already stored, and say so", () => {
    fs.writeFileSync(
      path.join(sousDir, ".env"),
      "SOUS_VAR_MISC_STUFF_API_URL=https://old.test\n",
      "utf8"
    );

    const applied = applyProvidedAnswers(
      [defined()],
      [{ name: "apiUrl", value: "https://new.test", from: "--answer" }],
      context(),
      options()
    );

    expect(applied.stored[0]!.envName).toBe("SOUS_VAR_MISC_STUFF_API_URL");
    expect(applied.stored[0]!.replaced).toBe("https://old.test");
    expect(readEnv(".env")["SOUS_VAR_MISC_STUFF_API_URL"]).toBe("https://new.test");
  });

  /**
   * applyProvidedAnswers should name the environment variable that outranks a
   * stored answer when the shell environment already answers the variable,
   * because the stored answer does nothing until it is unset.
   */
  it("should name a shell variable that outranks the stored answer", () => {
    const applied = applyProvidedAnswers(
      [defined()],
      [{ name: "apiUrl", value: "https://new.test", from: "--answer" }],
      context({ SOUS_VAR_API_URL: "https://shell.test" }),
      options()
    );

    expect(applied.stored[0]!.shadowedBy).toBe("SOUS_VAR_API_URL");
    expect(readEnv(".env")["SOUS_VAR_API_URL"]).toBe("https://new.test");
  });

  /**
   * applyProvidedAnswers should refuse an answer that does not fit its
   * definition, naming the variable, the constraint it violated and the
   * publisher's example, and should write nothing at all.
   */
  it("should refuse an answer that does not fit its definition", () => {
    const entries = [defined(), defined({ name: "taskFileRoot", type: "path" })];

    expect(() =>
      applyProvidedAnswers(
        entries,
        [
          { name: "taskFileRoot", value: ".sous/tasks", from: "--answer" },
          { name: "apiUrl", value: "not-a-url", from: "--answer" },
        ],
        context(),
        options()
      )
    ).toThrow(/apiUrl must be a URL[\s\S]*https:\/\/api\.example\.com/);

    // Validation happens for every answer before any of them is written.
    expect(readEnv(".env")).toEqual({});
  });

  /**
   * applyProvidedAnswers should refuse a name no recipe declares, and list
   * every variable that IS in play, grouped by the recipe that declares it, so
   * a typo can never become a stored value.
   */
  it("should refuse an unknown name and list the variables in play", () => {
    const entries = [defined(), defined({ name: "taskFileRoot", type: "path" })];

    expect(() =>
      applyProvidedAnswers(
        entries,
        [{ name: "apiURL", value: "https://x.test", from: "--answer" }],
        context(),
        options()
      )
    ).toThrow(/'apiURL'[\s\S]*misc\/stuff[\s\S]*apiUrl[\s\S]*taskFileRoot/);
  });

  /**
   * applyProvidedAnswers should write nothing on a dry run, while still
   * reporting what it would have written and recording it in the context, so
   * the rest of the run plans as though the answer were stored.
   */
  it("should write nothing on a dry run", () => {
    const ladder = context();
    const applied = applyProvidedAnswers(
      [defined()],
      [{ name: "apiUrl", value: "https://x.test", from: "--answer" }],
      ladder,
      options(true)
    );

    expect(applied.stored[0]!.outcome).toBe("not written");
    expect(fs.existsSync(path.join(sousDir, ".env"))).toBe(false);
    expect(ladder.sharedEnv["SOUS_VAR_API_URL"]).toBe("https://x.test");
  });
});
