import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { buildFixtureRepo, writeFixtureFile } from "../utils/fixture-repo.js";

import { binPath } from "../utils/sous-bin.js";

/** Per-test budget: every one of these boots the real CLI. */
const CLI_TIMEOUT = 90_000;

type RunResult = { status: number | null; output: string };

let tmp: TmpDir;
let projectRoot: string;
let sousHome: string;

/** Runs `sous <args...>` through the real published bin, against this test's store. */
function sous(args: string[]): RunResult {
  const env: NodeJS.ProcessEnv = { ...process.env, SOUS_HOME: sousHome };
  delete env.SOUS_CONFIG;
  delete env.SOUS_DIR;
  delete env.SOUS_CONFD;
  for (const key of Object.keys(env)) {
    if (key.startsWith("SOUS_VAR_")) delete env[key];
  }
  const result = spawnSync(process.execPath, [binPath, ...args], { cwd: projectRoot, encoding: "utf8", env, input: "" });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

/** Writes the project's shared env file, which holds the stored answers. */
function writeAnswers(text: string): void {
  writeFixtureFile(path.join(projectRoot, ".sous", ".env"), text);
}

/** Whether a compiled skill exists under `.claude/skills/`. */
function hasSkill(name: string): boolean {
  return fs.existsSync(path.join(projectRoot, ".claude", "skills", name, "SKILL.md"));
}

/** A JSON file under the project: `settings.json` (the manifest's gated edit) or `handler.json` (the configure handler's). */
function json(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, name), "utf8")) as Record<string, unknown>;
}

/**
 * A recipe manifest condition reads the recipe's own answer (#266).
 *
 * The recipe gates a skill in `contents` and an edit in `edits` on a yes-or-no variable whose
 * default is `false`, and its `configure` handler writes the answer it reads into `handler.json`.
 * The build must read the default when nothing answers it, and the stored answer when one is
 * stored, in all three places.
 */
describe("manifest conditions that read a recipe answer", () => {
  beforeAll(async () => {
    tmp = makeTmpDir("sous-manifest-answers-");
    sousHome = path.join(tmp.path, "sous-home");
    projectRoot = path.join(tmp.path, "project");
    const fixtures = path.join(tmp.path, "fixtures");

    await buildFixtureRepo(fixtures, "fixtures", [
      {
        namespace: "fw",
        name: "harness",
        version: "1.0.0",
        description: "Gated capability",
        variables: [
          {
            name: "jiraEnabled",
            type: "boolean",
            prompt: "Jira?",
            description: "Installs the Jira skill and turns Jira on in settings.json.",
            example: true,
            default: false,
          },
        ],
        contents: [
          {
            kind: "skills",
            include: ["skills/**/*"],
            exclude: [{ $if: { expr: "jiraEnabled != true", then: "skills/jira-*/**/*" } }],
          },
        ],
        edits: [
          {
            $if: {
              expr: "jiraEnabled == true",
              then: { file: "settings.json", set: { path: "jira", value: true } },
            },
          },
        ],
        handlers: { configure: [{ file: "handlers/jira.js", handler: "declareJira" }] },
        files: {
          "skills/core/SKILL.md": "# core\n",
          "skills/jira-x/SKILL.md": "# jira\n",
          "handlers/jira.js": [
            "export function declareJira(sous, { config }) {",
            '  config.atPath("editor.edits").append({ file: "handler.json", set: { path: "jira", value: sous.vars.get("jiraEnabled") ?? "unset" } });',
            "}",
            "",
          ].join("\n"),
        },
      },
    ]);

    writeFixtureFile(
      path.join(projectRoot, ".sous", "sous.config.jsonc"),
      '{\n  "name": "Manifest Answers Test Project",\n  "repos": { "sous-recipes": { "enabled": false } }\n}\n'
    );
    writeFixtureFile(path.join(projectRoot, "settings.json"), '{ "keep": 1 }\n');
    writeFixtureFile(path.join(projectRoot, "handler.json"), "{}\n");
    writeAnswers("");

    const added = sous(["repo", "add", fixtures, "--trust"]);
    expect(added.status, added.output).toBe(0);
    const subscribed = sous(["subscribe", "fw/harness", "--yes", "--no-build"]);
    expect(subscribed.status, subscribed.output).toBe(0);
  }, CLI_TIMEOUT);

  afterAll(() => {
    tmp.cleanup();
  });

  /**
   * With nothing stored, the default `false` decides both conditions.
   *
   * sous build   // -> core only; settings.json untouched; handler.json jira "false"
   */
  it(
    "should read the variable's default in contents, edits and a configure handler",
    () => {
      writeAnswers("");
      const built = sous(["build"]);
      expect(built.status, built.output).toBe(0);
      expect(hasSkill("core")).toBe(true);
      expect(hasSkill("jira-x")).toBe(false);
      expect(json("settings.json")).toEqual({ keep: 1 });
      expect(json("handler.json")).toEqual({ jira: "false" });
    },
    CLI_TIMEOUT
  );

  /**
   * A stored answer decides both conditions.
   *
   * SOUS_VAR_JIRA_ENABLED=true in .sous/.env; sous build   // -> both skills; jira set in both files
   */
  it(
    "should read a stored answer in contents, edits and a configure handler",
    () => {
      writeAnswers("SOUS_VAR_JIRA_ENABLED=true\n");
      const built = sous(["build"]);
      expect(built.status, built.output).toBe(0);
      expect(hasSkill("core")).toBe(true);
      expect(hasSkill("jira-x")).toBe(true);
      expect(json("settings.json")).toEqual({ keep: 1, jira: true });
      expect(json("handler.json")).toEqual({ jira: "true" });
    },
    CLI_TIMEOUT
  );

  /**
   * Listing the variables builds the same config, so it must not stop on the conditions either.
   *
   * sous vars list   // -> exit 0, names jiraEnabled
   */
  it(
    "should list the variables",
    () => {
      writeAnswers("SOUS_VAR_JIRA_ENABLED=true\n");
      const listed = sous(["vars", "list"]);
      expect(listed.status, listed.output).toBe(0);
      expect(listed.output).toContain("jiraEnabled");
    },
    CLI_TIMEOUT
  );
});
