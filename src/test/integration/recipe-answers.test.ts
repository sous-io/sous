import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { buildFixtureRepo, writeFixtureFile } from "../utils/fixture-repo.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const binPath = path.join(repoRoot, "bin", "run.js");

/** Per-test budget: every one of these boots the real CLI. */
const CLI_TIMEOUT = 90_000;

type RunResult = { stdout: string; stderr: string; status: number | null };

let tmp: TmpDir;
let projectRoot: string;
let sousDir: string;
let sousHome: string;

/** Runs `sous <args...>` through the real published bin, against this test's store. */
function sous(cwd: string, args: string[], extraEnv: Record<string, string> = {}): RunResult {
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

/** Reads a compiled file under the project. */
function compiled(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), "utf8");
}

/** Writes the two env files. */
function writeEnvFiles(shared: string, local: string): void {
  fs.writeFileSync(path.join(sousDir, ".env"), shared, "utf8");
  fs.writeFileSync(path.join(sousDir, ".env.local"), local, "utf8");
}

/** The answers every build in this file starts from. */
const SHARED_ENV = "API_URL=https://shared.example\nSOUS_VAR_GREETING=hello-from-env\n";
const LOCAL_ENV = "OWNER_LOGIN=luke\n";

/**
 * A recipe's answers reach its templates.
 *
 * The recipes here publish variable definitions, the project answers them in
 * `.sous/.env` and `.sous/.env.local`, and `sous build` renders the answers into
 * the compiled skills with no `_env` mapping anywhere in the config. Two fixture
 * recipes share one variable name so the per-recipe view can be seen. The whole
 * thing runs through the real CLI against a local fixture repository, so no
 * test here touches the network.
 */
describe("recipe variable answers in compiled templates", () => {
  beforeAll(async () => {
    tmp = makeTmpDir("sous-recipe-answers-");
    sousHome = path.join(tmp.path, "sous-home");
    projectRoot = path.join(tmp.path, "project");
    sousDir = path.join(projectRoot, ".sous");
    const fixtures = path.join(tmp.path, "fixtures");

    const description = (name: string) => `The ${name} this recipe renders.`;

    await buildFixtureRepo(fixtures, "fixtures", [
      {
        namespace: "workflow",
        name: "alpha",
        version: "1.0.0",
        description: "Renders every kind of answer",
        variables: [
          {
            name: "apiUrl",
            env: "API_URL",
            type: "url",
            prompt: "Which API?",
            description: description("apiUrl"),
            example: "https://api.example.com",
          },
          {
            name: "ownerLogin",
            env: "OWNER_LOGIN",
            type: "string",
            prompt: "Who owns this?",
            description: description("ownerLogin"),
            example: "octocat",
            scope: "local",
          },
          {
            name: "greeting",
            type: "string",
            prompt: "How should the skill say hello?",
            description: description("greeting"),
            example: "hi",
            default: "hello-by-default",
          },
        ],
        files: {
          "skills/alpha/SKILL.tpl.md": [
            "apiUrl=[{{ apiUrl }}]",
            "ownerLogin=[{{ ownerLogin }}]",
            "greeting=[{{ greeting }}]",
            "projectOnly=[{{ projectOnly }}]",
            "",
          ].join("\n"),
        },
      },
      {
        namespace: "workflow",
        name: "beta",
        version: "1.0.0",
        description: "Asks the same greeting question",
        variables: [
          {
            name: "greeting",
            type: "string",
            prompt: "How should the skill say hello?",
            description: description("greeting"),
            example: "hi",
            default: "hello-by-default",
          },
        ],
        files: {
          "skills/beta/SKILL.tpl.md": "greeting=[{{ greeting }}]\n",
        },
      },
    ]);

    writeFixtureFile(
      path.join(sousDir, "sous.config.js"),
      [
        "export const config = {",
        '  name: "Recipe Answers Test Project",',
        '  _vars: { projectRoot: "${sousDir}/..", projectOnly: "from-vars" },',
        '  repos: { "sous-recipes": { enabled: false } },',
        "  compilation: {",
        "    targets: [",
        "      {",
        '        entryPoint: "${projectRoot}/src/notes.tpl.md",',
        '        outputs: [{ destinationFile: "${projectRoot}/out/notes.md", _vars: {} }],',
        "      },",
        "    ],",
        "  },",
        "};",
        "",
      ].join("\n")
    );
    writeFixtureFile(
      path.join(projectRoot, "src", "notes.tpl.md"),
      "apiUrl=[{{ apiUrl }}] greeting=[{{ greeting }}]\n"
    );

    // Every question is answered before subscribing, so a subscribe with no
    // terminal has nothing to ask.
    writeEnvFiles(SHARED_ENV, LOCAL_ENV);

    const added = sous(projectRoot, ["repo", "add", fixtures, "--trust"]);
    expect(added.status).toBe(0);
    const alpha = sous(projectRoot, ["subscribe", "workflow/alpha", "--yes", "--no-build"]);
    expect(alpha.status).toBe(0);
    const beta = sous(projectRoot, ["subscribe", "workflow/beta", "--yes", "--no-build"]);
    expect(beta.status).toBe(0);
  }, CLI_TIMEOUT);

  afterAll(() => {
    tmp.cleanup();
  });

  /**
   * The core promise: an answer in `.sous/.env`, an answer in `.sous/.env.local`
   * and a project `_vars` value all render, and none of them needed an `_env`
   * line in the config.
   *
   * sous build   // -> alpha's SKILL.md holds every value
   */
  it(
    "should render answers from both env files into a recipe's skill",
    () => {
      writeEnvFiles(SHARED_ENV, LOCAL_ENV);
      const built = sous(projectRoot, ["build"]);
      expect(built.status).toBe(0);
      expect(built.stdout + built.stderr).not.toContain("required recipe variable");

      const skill = compiled(".claude/skills/alpha/SKILL.md");
      expect(skill).toContain("apiUrl=[https://shared.example]");
      expect(skill).toContain("ownerLogin=[luke]");
      expect(skill).toContain("greeting=[hello-from-env]");
      expect(skill).toContain("projectOnly=[from-vars]");
    },
    CLI_TIMEOUT
  );

  /**
   * The project's own templates render the same merged view of the answers.
   *
   * sous build   // -> out/notes.md holds the apiUrl and greeting answers
   */
  it(
    "should render answers into the project's own templates",
    () => {
      writeEnvFiles(SHARED_ENV, LOCAL_ENV);
      const built = sous(projectRoot, ["build"]);
      expect(built.status).toBe(0);

      expect(compiled("out/notes.md")).toContain(
        "apiUrl=[https://shared.example] greeting=[hello-from-env]"
      );
    },
    CLI_TIMEOUT
  );

  /**
   * The shell outranks both files, so `API_URL=... sous build` renders the
   * shell's value for that one run.
   *
   * API_URL=https://shell.example sous build   // -> alpha renders the shell value
   */
  it(
    "should let the shell environment outrank the env files",
    () => {
      writeEnvFiles(SHARED_ENV, LOCAL_ENV);
      const built = sous(projectRoot, ["build"], { API_URL: "https://shell.example" });
      expect(built.status).toBe(0);

      expect(compiled(".claude/skills/alpha/SKILL.md")).toContain("apiUrl=[https://shell.example]");
    },
    CLI_TIMEOUT
  );

  /**
   * A definition's default is what renders when no rung answers, so removing
   * the greeting answer does not leave an empty string behind.
   *
   * .env without SOUS_VAR_GREETING; sous build   // -> greeting=[hello-by-default]
   */
  it(
    "should render a definition's default when nothing answers it",
    () => {
      writeEnvFiles("API_URL=https://shared.example\n", LOCAL_ENV);
      const built = sous(projectRoot, ["build"]);
      expect(built.status).toBe(0);
      expect(built.stdout + built.stderr).not.toContain("required recipe variable");

      expect(compiled(".claude/skills/alpha/SKILL.md")).toContain("greeting=[hello-by-default]");
      expect(compiled(".claude/skills/beta/SKILL.md")).toContain("greeting=[hello-by-default]");
    },
    CLI_TIMEOUT
  );

  /**
   * The recipe-scoped rung answers one recipe's question without touching the
   * other's, so two recipes asking the same name can render different values,
   * while the project's own templates see the merged view.
   *
   * .env: SOUS_VAR_GREETING=shared, SOUS_VAR_WORKFLOW_BETA_GREETING=beta-only
   * // -> alpha renders "shared", beta renders "beta-only", notes.md renders "shared"
   */
  it(
    "should give a recipe its own answer through the recipe-scoped name",
    () => {
      writeEnvFiles(
        "API_URL=https://shared.example\nSOUS_VAR_GREETING=shared\nSOUS_VAR_WORKFLOW_BETA_GREETING=beta-only\n",
        LOCAL_ENV
      );
      const built = sous(projectRoot, ["build"]);
      expect(built.status).toBe(0);

      expect(compiled(".claude/skills/alpha/SKILL.md")).toContain("greeting=[shared]");
      expect(compiled(".claude/skills/beta/SKILL.md")).toContain("greeting=[beta-only]");
      expect(compiled("out/notes.md")).toContain("greeting=[shared]");
    },
    CLI_TIMEOUT
  );

  /**
   * A mapping record binds any environment variable to one variable and sits
   * on the top rung of the ladder.
   *
   * conf.d layer: varMappings { MY_URL: "workflow/alpha/apiUrl" }; .env: MY_URL=...
   * // -> alpha renders the MY_URL value over API_URL
   */
  it(
    "should honor a mapping record over the declared name",
    () => {
      const layer = path.join(sousDir, "conf.d", "20-mapping.json");
      writeFixtureFile(
        layer,
        JSON.stringify({ varMappings: { MY_URL: "workflow/alpha/apiUrl" } }, null, 2)
      );
      try {
        writeEnvFiles(`MY_URL=https://mapped.example\n${SHARED_ENV}`, LOCAL_ENV);
        const built = sous(projectRoot, ["build"]);
        expect(built.status).toBe(0);

        expect(compiled(".claude/skills/alpha/SKILL.md")).toContain("apiUrl=[https://mapped.example]");
      } finally {
        fs.rmSync(layer);
      }
    },
    CLI_TIMEOUT
  );

  /**
   * An explicit config value still wins: a `_vars` entry naming a recipe
   * variable renders over the stored answer, so a project that already carries
   * its answers in the config changes nothing by upgrading.
   *
   * conf.d layer: _vars { ownerLogin: "from-config" }   // -> alpha renders "from-config"
   */
  it(
    "should let a project's _vars override an answer",
    () => {
      const layer = path.join(sousDir, "conf.d", "30-override.json");
      writeFixtureFile(layer, JSON.stringify({ _vars: { ownerLogin: "from-config" } }, null, 2));
      try {
        writeEnvFiles(SHARED_ENV, LOCAL_ENV);
        const built = sous(projectRoot, ["build"]);
        expect(built.status).toBe(0);

        expect(compiled(".claude/skills/alpha/SKILL.md")).toContain("ownerLogin=[from-config]");
      } finally {
        fs.rmSync(layer);
      }
    },
    CLI_TIMEOUT
  );

  /**
   * A required variable nothing answers is reported, once, naming the variable,
   * the recipe that asks and the command that answers; the build still succeeds
   * and the template renders an empty value.
   *
   * .env.local without OWNER_LOGIN; sous build   // -> exit 0, warning names ownerLogin
   */
  it(
    "should warn about a required variable nothing answers and still build",
    () => {
      writeEnvFiles(SHARED_ENV, "");
      const built = sous(projectRoot, ["build"]);
      expect(built.status).toBe(0);

      const output = built.stdout + built.stderr;
      expect(output).toContain("1 required recipe variable has no answer");
      expect(output).toContain("ownerLogin (asked by workflow/alpha)");
      expect(output).toContain("sous vars ask");
      expect(compiled(".claude/skills/alpha/SKILL.md")).toContain("ownerLogin=[]");
    },
    CLI_TIMEOUT
  );
});
