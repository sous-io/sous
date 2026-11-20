/**
 * `sous subscription add` checks everything before it writes anything (#230
 * item 1), and says the version range it records (#230 item 3).
 *
 * A subscription whose recipe cannot be downloaded, or whose required question
 * cannot be answered without a terminal, fails with the project exactly as it
 * was: no subscription in `conf.d/510-subscriptions.jsonc`, no pin in the
 * lockfile, no `sous.state.json` change.
 *
 * Everything runs against a local fixture repository read through the `local`
 * provider, so nothing here touches the network.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { buildFixtureRepo, gitIn, writeFixtureFile } from "../utils/fixture-repo.js";
import { readManagedLayer, SUBSCRIPTIONS_LAYER_FILENAME } from "../utils/managed-layer.js";
import { runInProcess } from "../utils/in-process.js";
import { binPath } from "../utils/sous-bin.js";

/** Per-test budget: every one of these boots the real CLI several times. */
const CLI_TIMEOUT = 120_000;

type RunResult = { stdout: string; stderr: string; status: number | null; output: string };

let tmp: TmpDir;
let sousHome: string;
let repo: string;
let project: string;

/** Runs `sous <args...>` through the real bin, from the project, with no terminal. */
function sous(...args: string[]): RunResult {
  const env: NodeJS.ProcessEnv = { ...process.env, SOUS_HOME: sousHome };
  delete env.SOUS_CONFIG;
  delete env.SOUS_DIR;
  delete env.SOUS_CONFD;
  const result = spawnSync(process.execPath, [binPath, ...args], { cwd: project, encoding: "utf8", env, input: "" });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** Text with every run of whitespace as one space, so a sentence a table or a list wrapped still matches. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** Every file under the project's `.sous` directory, by relative path, with its content. */
function snapshot(): Record<string, string> {
  const root = path.join(project, ".sous");
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        files[path.relative(root, full)] = fs.readFileSync(full, "utf8");
      }
    }
  };
  walk(root);
  return files;
}

/** The subscriptions recorded in the project's managed layer. */
function subscriptions(): Record<string, { range?: string }> {
  return ((readManagedLayer(path.join(project, ".sous"), SUBSCRIPTIONS_LAYER_FILENAME) as { subscriptions?: Record<string, { range?: string }> }).subscriptions ?? {});
}

/** A required variable with no default, in the manifest's form. */
const REGION = {
  name: "region",
  type: "string",
  prompt: "Which region does the agent deploy to?",
  description: "The region the agent deploys to. It has no default; any region name is accepted.",
  example: "eu-west-1",
  required: true,
};

beforeAll(async () => {
  tmp = makeTmpDir("sous-add-checks-first-");
  sousHome = path.join(tmp.path, "sous-home");
  repo = path.join(tmp.path, "fixtures");
  project = path.join(tmp.path, "project");

  await buildFixtureRepo(repo, "fixtures", [
    { namespace: "acme", name: "widget", version: "1.0.0", files: { "skills/widget/SKILL.md": "# widget\n" } },
    { namespace: "acme", name: "fancy", version: "1.0.0", files: { "skills/fancy/SKILL.md": "# fancy\n" }, variables: [REGION] },
    { namespace: "acme", name: "gadget", version: "1.0.0", files: { "skills/gadget/SKILL.md": "# gadget\n" }, variables: [REGION] },
    { namespace: "acme", name: "plain", version: "1.4.0", files: { "skills/plain/SKILL.md": "# plain\n" } },
    { namespace: "acme", name: "asker", version: "1.0.0", files: { "skills/asker/SKILL.md": "# asker\n" }, variables: [REGION] },
  ]);
  // The index still offers these versions, but their tags and folders are gone, so they cannot be downloaded.
  gitIn(repo, "tag", "-d", "acme/widget@1.0.0");
  fs.rmSync(path.join(repo, "recipes", "acme", "widget"), { recursive: true });
  gitIn(repo, "tag", "-d", "acme/fancy@1.0.0");
  fs.rmSync(path.join(repo, "recipes", "acme", "fancy"), { recursive: true });

  writeFixtureFile(
    path.join(project, ".sous", "sous.config.js"),
    ["export const config = {", '  name: "Checks First Project",', '  repos: { "sous-recipes": { enabled: false } },', "};", ""].join("\n")
  );
  const added = sous("repo", "add", repo, "--name", "fixtures", "--trust");
  expect(added.status, added.output).toBe(0);
}, CLI_TIMEOUT);

afterAll(() => {
  tmp.cleanup();
});

describe("a failed sous subscription add", () => {
  /**
   * sous subscription add acme/widget --yes   (no variables; its tag and folder are gone)
   * // -> exit 1, "Sous could not download a recipe the subscription to 'acme/widget' installs, so nothing was written."
   */
  it(
    "should write nothing when a recipe without variables cannot be downloaded",
    () => {
      const before = snapshot();
      const result = sous("subscription", "add", "acme/widget", "--yes");

      expect(result.status, result.output).toBe(1);
      expect(flat(result.output)).toContain("so nothing was written");
      expect(result.output).not.toContain("What was installed");
      expect(snapshot()).toEqual(before);
    },
    CLI_TIMEOUT
  );

  /**
   * sous subscription add acme/fancy --yes   (a required variable; its tag and folder are gone)
   * // -> exit 1, nothing written
   */
  it(
    "should write nothing when a recipe with variables cannot be downloaded",
    () => {
      const before = snapshot();
      const result = sous("subscription", "add", "acme/fancy", "--yes");

      expect(result.status, result.output).toBe(1);
      expect(flat(result.output)).toContain("so nothing was written");
      expect(snapshot()).toEqual(before);
    },
    CLI_TIMEOUT
  );

  /**
   * sous subscription add acme/gadget --yes </dev/null
   * // -> exit 1, "One variable still needs an answer, and there is no terminal to ask on.", nothing written
   */
  it(
    "should write nothing when a required variable cannot be answered without a terminal",
    () => {
      const before = snapshot();
      const result = sous("subscription", "add", "acme/gadget", "--yes");

      expect(result.status, result.output).toBe(1);
      expect(result.stderr).toContain("One variable still needs an answer, and there is no terminal to ask on.");
      expect(result.stderr).toContain("region (acme/gadget)");
      expect(snapshot()).toEqual(before);
    },
    CLI_TIMEOUT
  );

  /**
   * In a terminal, the recipe's questions are asked before anything is
   * written, so interrupting one (Ctrl-C) leaves the project exactly as it was.
   *
   * sous subscription add acme/asker   (a terminal; Ctrl-C at "Which region does the agent deploy to?")
   * // -> fails; no 510 entry, no lockfile change, no state change, no answer
   */
  it(
    "should write nothing when a question is interrupted",
    async () => {
      const before = snapshot();
      const run = await runInProcess(
        project,
        { SOUS_HOME: sousHome },
        "subscription.add",
        { ref: "acme/asker" },
        () => true,
        () => {
          throw new Error("Interrupted (Ctrl-C).");
        }
      );

      expect(run.error?.message).toBe("Interrupted (Ctrl-C).");
      expect(run.asked).toContain(REGION.prompt);
      expect(snapshot()).toEqual(before);
    },
    CLI_TIMEOUT
  );

  /**
   * The question comes before every write, and its answer is written with
   * the subscription.
   *
   * sous subscription add acme/asker --no-build   (a terminal; answers "eu-west-1")
   * // -> when asked: no 510 entry yet; afterwards: subscribed, SOUS_VAR_REGION=eu-west-1 stored
   */
  it(
    "should ask before writing, then write the answer with the subscription",
    async () => {
      const seenWhenAsked: string[] = [];
      const run = await runInProcess(
        project,
        { SOUS_HOME: sousHome },
        "subscription.add",
        { ref: "acme/asker", noBuild: true },
        () => true,
        () => {
          seenWhenAsked.push(...Object.keys(subscriptions()));

          return "eu-west-1";
        }
      );

      expect(run.error).toBeUndefined();
      expect(seenWhenAsked).not.toContain("acme/asker");
      expect(subscriptions()["acme/asker"]).toBeDefined();
      expect(Object.values(snapshot()).join("\n")).toContain("=eu-west-1");
    },
    CLI_TIMEOUT
  );

  /**
   * The same subscription with the answer given up front goes through.
   *
   * sous subscription add acme/gadget --yes --answer region=eu-west-1 --no-build
   * // -> exit 0, subscribed
   */
  it(
    "should subscribe once the required variable is answered up front",
    () => {
      const result = sous("subscription", "add", "acme/gadget", "--yes", "--answer", "region=eu-west-1", "--no-build");

      expect(result.status, result.output).toBe(0);
      expect(subscriptions()["acme/gadget"]).toBeDefined();
    },
    CLI_TIMEOUT
  );
});

describe("the version range a subscription records", () => {
  /**
   * Without '@range' the subscription accepts any version, and the plan and
   * the result both say so.
   *
   * sous subscription add acme/plain --yes --no-build
   * // -> "It is recorded with the version range 'any version', ..." (before the question)
   * // -> "... recorded in this project's config with the version range 'any version', ..."
   */
  it(
    "should say a subscription without a range accepts any version",
    () => {
      const result = sous("subscription", "add", "acme/plain", "--yes", "--no-build");

      expect(result.status, result.output).toBe(0);
      expect(flat(result.stderr)).toContain("It is recorded with the version range 'any version'");
      expect(flat(result.stdout)).toContain("with the version range 'any version'");
      expect(subscriptions()["acme/plain"]?.range).toBeUndefined();
    },
    CLI_TIMEOUT
  );

  /**
   * sous subscription add acme/plain@^1.4.0 --dry-run
   * // -> "It is recorded with the version range '^1.4.0', ..." and "would be recorded with the version range '^1.4.0'"
   */
  it(
    "should say the range a subscription is written with",
    () => {
      const result = sous("subscription", "add", "acme/plain@^1.4.0", "--dry-run");

      expect(result.status, result.output).toBe(0);
      expect(flat(result.stderr)).toContain("It is recorded with the version range '^1.4.0'");
      expect(flat(result.stdout)).toContain("would be recorded with the version range '^1.4.0'");
    },
    CLI_TIMEOUT
  );
});
