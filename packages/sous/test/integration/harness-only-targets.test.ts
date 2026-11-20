/**
 * Files a recipe gives to one harness only, through a manifest condition on `harness.id`, end to
 * end through the real CLI with Claude Code and Codex both on (#267, spec S8 "The Merge").
 *
 * The recipe excludes its `skplug` skill for every harness except Claude Code, and includes one
 * memory for Claude Code only. Neither is in the build with no harness, so each must come from
 * Claude Code's build, and reach Claude Code's files and no one else's.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { buildFixtureRepo, writeFixtureFile } from "../utils/fixture-repo.js";

import { binPath } from "../utils/sous-bin.js";

/** Per-test budget: every one of these boots the real CLI. */
const CLI_TIMEOUT = 90_000;

let tmp: TmpDir;
let projectRoot: string;
let sousHome: string;

/** Runs `sous <args...>` through the real published bin, against this test's store. */
function sous(...args: string[]): { status: number | null; output: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, SOUS_HOME: sousHome };
  delete env.SOUS_CONFIG;
  delete env.SOUS_DIR;
  delete env.SOUS_CONFD;
  const result = spawnSync(process.execPath, [binPath, ...args], { cwd: projectRoot, encoding: "utf8", env, input: "" });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

/** Whether a file exists under the project. */
const exists = (relative: string): boolean => fs.existsSync(path.join(projectRoot, relative));

/** A file under the project. */
const read = (relative: string): string => fs.readFileSync(path.join(projectRoot, relative), "utf8");

beforeAll(async () => {
  tmp = makeTmpDir("sous-harness-only-");
  sousHome = path.join(tmp.path, "sous-home");
  projectRoot = path.join(tmp.path, "project");
  const repo = path.join(tmp.path, "fixtures");

  await buildFixtureRepo(repo, "fixtures", [
    {
      namespace: "wf",
      name: "example",
      version: "1.0.0",
      description: "Gives Claude Code a skill and a memory of its own",
      contents: [
        {
          kind: "skills",
          include: ["skills/**/*"],
          exclude: [{ $if: { expr: "harness.id != 'claude-code'", then: "skills/skplug/**/*" } }],
        },
        {
          kind: "memories",
          include: ["memories/shared.md", { $if: { expr: "harness.id == 'claude-code'", then: "memories/claude.md" } }],
        },
      ],
      files: {
        "skills/example-skill/SKILL.md": "# example\n",
        "skills/skplug/SKILL.tpl.md": "# skplug\n",
        "skills/skplug/references/x.md": "reference\n",
        "skills/skplug/scripts/y.sh": "#!/bin/sh\necho y\n",
        "memories/shared.md": "SHARED MEMORY\n",
        "memories/claude.md": "CLAUDE ONLY MEMORY\n",
      },
    },
  ]);

  // Codex is turned on by writing its plugin's options, even as {}; Claude Code is on by default.
  // The target without an id is the project's own skills target that `sous init` writes; a merge
  // that matched it by place took one of skplug's files for it (#267).
  writeFixtureFile(
    path.join(projectRoot, ".sous", "sous.config.jsonc"),
    [
      "{",
      '  "name": "Harness Only Targets",',
      '  "plugins": { "options": { "@sous-io/sous-plugin-codex": {} } },',
      '  "repos": { "sous-recipes": { "enabled": false } },',
      '  "compilation": { "targets": [{ "entryGlob": "${sousDir}/skills/**/*", "globBase": "${sousDir}/skills", "outputs": [{ "destinationDir": "${projectRoot}/.claude/skills" }] }] }',
      "}",
      "",
    ].join("\n")
  );

  for (const args of [
    ["repo", "add", repo, "--name", "fixtures", "--trust"],
    ["subscription", "add", "wf/example", "--yes", "--no-build"],
  ]) {
    const result = sous(...args);
    expect(result.status, result.output).toBe(0);
  }

  const built = sous("build");
  expect(built.status, built.output).toBe(0);
}, CLI_TIMEOUT);

afterAll(() => {
  tmp.cleanup();
});

describe("files a recipe gives to one harness", () => {
  /**
   * sous build   // -> .claude/skills/skplug/SKILL.md; no .agents/skills/skplug (Codex reads skills there)
   */
  it("should write a skill excluded for every other harness into Claude Code's skills only", () => {
    expect(exists(".claude/skills/example-skill/SKILL.md")).toBe(true);
    expect(exists(".agents/skills/example-skill/SKILL.md")).toBe(true);
    expect(exists(".claude/skills/skplug/SKILL.md")).toBe(true);
    expect(exists(".claude/skills/skplug/references/x.md")).toBe(true);
    expect(exists(".claude/skills/skplug/scripts/y.sh")).toBe(true);
    expect(exists(".agents/skills/skplug")).toBe(false);
  });

  /**
   * sous build   // -> Claude Code's memories hold both; Codex's hold only the shared one
   */
  it("should write a memory included for Claude Code only into Claude Code's memories only", () => {
    const claude = read(".claude/rules/SOUS-MEMORIES.md");
    expect(claude).toContain("SHARED MEMORY");
    expect(claude).toContain("CLAUDE ONLY MEMORY");

    const codex = read("AGENTS.override.md");
    expect(codex).toContain("SHARED MEMORY");
    expect(codex).not.toContain("CLAUDE ONLY MEMORY");
  });

  /**
   * The next build counts the carried skill among the files it writes, so it neither removes it
   * nor reports a problem with it.
   *
   * sous build   // -> exit 0, .claude/skills/skplug/SKILL.md still there
   */
  it(
    "should keep the skill on the next build",
    () => {
      const built = sous("build");
      expect(built.status, built.output).toBe(0);
      expect(built.output).not.toContain("never listed");
      expect(exists(".claude/skills/skplug/SKILL.md")).toBe(true);
    },
    CLI_TIMEOUT
  );
});
