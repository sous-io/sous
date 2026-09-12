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

/** The machine-wide sous home for this file, inside its temp directory. */
let sousHome = "";

/**
 * Runs `sous <args...>` through the real published bin, from `cwd`, with the
 * child's stdin closed so the CLI sees no terminal. SOUS_* variables are
 * stripped so config discovery is a clean walk up from `cwd`, and SOUS_HOME
 * points into the temp tree so nothing reaches the home directory of whoever
 * runs the suite.
 */
function runSous(cwd: string, args: string[], extraEnv: Record<string, string> = {}): RunResult {
  const env = { ...process.env, ...extraEnv, SOUS_HOME: sousHome };
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
    sousHome = path.join(root, "sous-home");
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
   * The canonical spellings print the same two reports and take the same
   * `--file` flag. Bare `sous vars` and `sous vars <name>` above are the
   * shorthands for them.
   *
   * sous vars list --file questions.yaml
   * sous vars show apiUrl --file questions.yaml
   */
  it(
    "should list and show under the canonical commands",
    () => {
      const listed = runSous(root, ["vars", "list", "--file", "questions.yaml"]);
      expect(listed.status).toBe(0);
      expect(listed.stdout).toContain("Variables in play");
      expect(listed.stdout).toContain("apiUrl");

      const shown = runSous(root, ["vars", "show", "apiUrl", "--file", "questions.yaml"]);
      expect(shown.status).toBe(0);
      expect(shown.stdout).toContain("Which API should sous talk to?");
      expect(shown.stdout).toContain("SOUS_VAR_LOCAL_QUESTIONS_API_URL");

      // The singular spelling of the topic reaches the same commands.
      const singular = runSous(root, ["var", "show", "apiUrl", "--file", "questions.yaml"]);
      expect(singular.status).toBe(0);
      expect(singular.stdout).toContain("Which API should sous talk to?");
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
   * `sous vars ask <name>` resolves its argument through the shared reference
   * module, so a variable can be named by its own name, by the environment
   * variable that answers it, by the recipe that declares it or by the
   * namespace the recipe lives in. Naming one variable asks one question;
   * naming the recipe asks both of its questions.
   *
   * sous vars ask apiUrl --file questions.yaml
   * sous vars ask SOUS_VAR_API_URL --file questions.yaml
   * sous vars ask questions --file questions.yaml
   */
  it(
    "should resolve the name it is asked about at every scope",
    () => {
      const byVariable = runSous(root, ["vars", "ask", "apiUrl", "--file", "questions.yaml"]);
      expect(byVariable.status).toBe(1);
      expect(byVariable.stdout).toContain("One variable still needs an answer");
      expect(byVariable.stdout).toContain("SOUS_VAR_LOCAL_QUESTIONS_API_URL");
      expect(byVariable.stdout).not.toContain("SOUS_VAR_LOCAL_QUESTIONS_API_TOKEN");

      // The '.env' file sets this generated name, so it names the variable it
      // answers.
      const byEnvName = runSous(root, [
        "vars",
        "ask",
        "SOUS_VAR_API_URL",
        "--file",
        "questions.yaml",
      ]);
      expect(byEnvName.status).toBe(1);
      expect(byEnvName.stdout).toContain("SOUS_VAR_LOCAL_QUESTIONS_API_URL");
      expect(byEnvName.stdout).not.toContain("SOUS_VAR_LOCAL_QUESTIONS_API_TOKEN");

      // The definitions file is attributed to a recipe named after the file, so
      // naming it asks everything the file declares.
      const byRecipe = runSous(root, ["vars", "ask", "questions", "--file", "questions.yaml"]);
      expect(byRecipe.status).toBe(1);
      expect(byRecipe.stdout).toContain("2 variables still need answers");

      // The same definitions sit in a namespace of their own, reached the same way.
      const byNamespace = runSous(root, [
        "vars",
        "ask",
        "--namespace",
        "local",
        "--file",
        "questions.yaml",
      ]);
      expect(byNamespace.status).toBe(1);
      expect(byNamespace.stdout).toContain("2 variables still need answers");
    },
    CLI_TIMEOUT
  );

  /**
   * A name that means more than one thing is a question, and a run with no
   * terminal cannot ask it: it fails naming every candidate and the flag that
   * decides. With `--accept-first` the same run takes the first candidate and
   * says so.
   *
   * sous vars ask local --file questions.yaml                  // -> exits non-zero
   * sous vars ask local --accept-first --file questions.yaml   // -> takes the first
   */
  it(
    "should fail on an ambiguous name and take the first with --accept-first",
    () => {
      // 'local' is both the repository a definitions file is attributed to and
      // the namespace inside it.
      const ambiguous = runSous(root, ["vars", "ask", "local", "--file", "questions.yaml"]);
      const output = ambiguous.stdout + ambiguous.stderr;

      expect(ambiguous.status).not.toBe(0);
      expect(output).toContain("which 'local' you meant");
      expect(output).toContain("matched 2 things");
      expect(output).toContain("--accept-first");
      // The command's own help, printed underneath the error.
      expect(ambiguous.stderr).toContain("USAGE");

      const accepted = runSous(root, [
        "vars",
        "ask",
        "local",
        "--accept-first",
        "--file",
        "questions.yaml",
      ]);
      expect(accepted.stdout).toContain("taking the first");
      expect(accepted.stdout).toContain("2 variables still need answers");
    },
    CLI_TIMEOUT
  );

  /**
   * `--repo`, `--namespace` and `--var` say outright which kind of thing is
   * meant, and narrow to the same set the argument would.
   *
   * sous vars ask --namespace local --var apiToken --file questions.yaml
   */
  it(
    "should narrow by repository, namespace and variable flags",
    () => {
      const result = runSous(root, [
        "vars",
        "ask",
        "--repo",
        "local",
        "--namespace",
        "local",
        "--var",
        "apiToken",
        "--file",
        "questions.yaml",
      ]);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("One variable still needs an answer");
      expect(result.stdout).toContain("SOUS_VAR_LOCAL_QUESTIONS_API_TOKEN");
      expect(result.stdout).not.toContain("SOUS_VAR_LOCAL_QUESTIONS_API_URL");
    },
    CLI_TIMEOUT
  );

  /**
   * A name nothing declares is refused, quoting what was typed rather than
   * asking every question as though no name had been given.
   *
   * sous vars ask nothingLikeThis --file questions.yaml   // -> exits non-zero
   */
  it(
    "should refuse a name that matches nothing",
    () => {
      const result = runSous(root, [
        "vars",
        "ask",
        "nothingLikeThis",
        "--file",
        "questions.yaml",
      ]);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("Nothing called 'nothingLikeThis' was found");
      expect(result.stdout).toContain("sous vars");
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
      // The message is wrapped to the terminal, so it is matched a phrase at a
      // time rather than as one long line.
      expect(result.stdout).toContain("every published variable must explain");
      expect(result.stdout).toContain("every published variable must show what a real");
    },
    CLI_TIMEOUT
  );
});
