import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const binPath = path.join(repoRoot, "bin", "run.js");

/** Per-test timeout: each test boots the real CLI (tsx plus oclif) in a subprocess. */
const CLI_TIMEOUT = 30_000;

type RunResult = { stdout: string; stderr: string; status: number | null };

/**
 * Runs `sous <args...>` through the real published bin, from `cwd`, with the
 * child's stdin closed so the CLI sees no terminal. SOUS_* variables are
 * stripped so config discovery is a clean walk up from `cwd`.
 */
function runSous(cwd: string, args: string[], extraEnv: Record<string, string> = {}): RunResult {
  const env = { ...process.env, ...extraEnv };
  delete env.SOUS_CONFIG;
  delete env.SOUS_DIR;
  delete env.SOUS_CONFD;
  for (const key of Object.keys(env)) {
    if (key.startsWith("SOUS_VAR_") && !(key in extraEnv)) delete env[key];
  }

  const result = spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: "utf8",
    env,
    input: "",
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

/**
 * The `sous vars` command family, end to end through the real CLI against a
 * temp project. The definitions come from a standalone definitions file, which
 * is the source that exists today; the project source resolves subscriptions
 * and is wired in a later phase.
 */
describe("sous vars commands", () => {
  let tmp: TmpDir;
  let root: string;
  let definitionsPath: string;

  beforeAll(() => {
    tmp = makeTmpDir("sous-vars-cli-");
    root = tmp.path;
    const sousDir = path.join(root, ".sous");
    fs.mkdirSync(sousDir, { recursive: true });

    fs.writeFileSync(
      path.join(sousDir, "sous.config.json"),
      JSON.stringify({ name: "Vars test project", compilation: { targets: [] } }, null, 2),
      "utf8"
    );

    definitionsPath = path.join(root, "questions.yaml");
    fs.writeFileSync(
      definitionsPath,
      [
        "variables:",
        "  - name: apiUrl",
        "    type: url",
        "    prompt: Which API should sous talk to?",
        "    description: The service every request this recipe generates is sent to.",
        "    example: https://api.example.com",
        "  - name: apiToken",
        "    type: string",
        "    prompt: What is the API token?",
        "    description: The token sous authenticates to the API with.",
        "    example: tok_0123456789abcdef",
        "    secret: true",
        "    scope: local",
        "",
      ].join("\n"),
      "utf8"
    );

    fs.writeFileSync(
      path.join(sousDir, ".env"),
      "SOUS_VAR_API_URL=https://example.com\n",
      "utf8"
    );
  });

  afterAll(() => {
    tmp.cleanup();
  });

  /**
   * `sous vars` should print one row per variable, naming the environment
   * variable that answered it and where the value came from, and should hide a
   * secret's value.
   */
  it(
    "should list every variable with its answer and source",
    () => {
      const result = runSous(root, ["vars", "--file", "questions.yaml"]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Variables in play");
      expect(result.stdout).toContain("apiUrl");
      expect(result.stdout).toContain("SOUS_VAR_API_URL");
      expect(result.stdout).toContain("https://example.com");
      expect(result.stdout).toContain("(unanswered)");
      expect(result.stdout).toContain("the .env file");
    },
    CLI_TIMEOUT
  );

  /**
   * `sous vars <name>` should show one variable in full, including the
   * publisher's description and example, every environment variable name on the
   * ladder, and which rung answered.
   */
  it(
    "should show one variable with every candidate name",
    () => {
      const result = runSous(root, ["vars", "apiUrl", "--file", "questions.yaml"]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Which API should sous talk to?");
      expect(result.stdout).toContain(
        "The service every request this recipe generates is sent to."
      );
      expect(result.stdout).toContain("For example");
      expect(result.stdout).toContain("https://api.example.com");
      expect(result.stdout).toContain("SOUS_VAR_LOCAL_QUESTIONS_API_URL");
      expect(result.stdout).toContain("SOUS_VAR_LOCAL_API_URL");
      expect(result.stdout).toContain("answered it, from the .env file");
    },
    CLI_TIMEOUT
  );

  /**
   * A secret's value should never reach the terminal, even when it IS answered.
   */
  it(
    "should hide a secret's value",
    () => {
      const result = runSous(root, ["vars", "apiToken", "--file", "questions.yaml"], {
        SOUS_VAR_API_TOKEN: "super-secret-token",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("super-secret-token");
      expect(result.stdout).toContain("(hidden)");
      expect(result.stdout).toContain("the shell environment");
    },
    CLI_TIMEOUT
  );

  /**
   * `sous vars ask` with no terminal should fail rather than hang, naming every
   * environment variable that would answer the question, most specific first.
   */
  it(
    "should fail without a terminal and name the variables that would answer",
    () => {
      const result = runSous(root, ["vars", "ask", "--file", "questions.yaml"]);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("no terminal to ask on");
      expect(result.stdout).toContain("SOUS_VAR_LOCAL_QUESTIONS_API_TOKEN");
      expect(result.stdout).toContain("(recipe scope)");
    },
    CLI_TIMEOUT
  );

  /**
   * `sous vars ask` should succeed with nothing to ask when every variable is
   * already answered, listing the inherited answers and their sources.
   */
  it(
    "should report inherited answers and ask nothing when all are answered",
    () => {
      const result = runSous(root, ["vars", "ask", "--file", "questions.yaml"], {
        SOUS_VAR_API_TOKEN: "super-secret-token",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Answers already in scope:");
      expect(result.stdout).not.toContain("super-secret-token");
    },
    CLI_TIMEOUT
  );

  /**
   * A definitions file that does not fit the schema should be refused with a
   * readable message naming the file and the field, not a stack trace.
   */
  it(
    "should report a malformed definitions file readably",
    () => {
      const badPath = path.join(root, "bad.yaml");
      fs.writeFileSync(badPath, "variables:\n  - name: apiUrl\n    type: nonsense\n", "utf8");

      const result = runSous(root, ["vars", "--file", "bad.yaml"]);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("Invalid variable definitions file");
      expect(result.stdout).toContain("variables[0]");
      expect(result.stdout).not.toContain("at Object.");
    },
    CLI_TIMEOUT
  );

  /**
   * A definitions file is held to the same rule a published recipe is: every
   * variable explains itself, and the refusal says why rather than reporting a
   * missing key.
   */
  it(
    "should refuse a definition with no description and no example",
    () => {
      const badPath = path.join(root, "undocumented.yaml");
      fs.writeFileSync(
        badPath,
        "variables:\n  - name: apiUrl\n    type: url\n    prompt: Which API?\n",
        "utf8"
      );

      const result = runSous(root, ["vars", "--file", "undocumented.yaml"]);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("every published variable must explain itself");
      expect(result.stdout).toContain(
        "every published variable must show what a real answer looks like"
      );
    },
    CLI_TIMEOUT
  );
});
