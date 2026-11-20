/**
 * A lockfile is never written while a recipe's dependencies are unknown (#291).
 *
 * The fixture index records no `depends` for any version, the way an index
 * released before sous recorded them looks, so what a recipe depends on is read
 * from its manifest, which needs its files on this machine. Each command runs on
 * a copy of one project with an empty recipe store (a fresh clone, a new machine,
 * CI): `sous doctor`, `sous lock rebuild` and `sous build` download what they
 * need to read, and write nothing while a recipe still cannot be read.
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
import { binPath } from "../utils/sous-bin.js";

/** Per-test budget: every one of these boots the real CLI several times. */
const CLI_TIMEOUT = 120_000;

type RunResult = { stdout: string; stderr: string; status: number | null; output: string };

let tmp: TmpDir;
let repo: string;
let template: string;
let copies = 0;

/** Runs `sous <args...>` through the real bin, from `cwd`, with the given store, and no terminal. */
function sous(cwd: string, home: string, ...args: string[]): RunResult {
  const env: NodeJS.ProcessEnv = { ...process.env, SOUS_HOME: home };
  delete env.SOUS_CONFIG;
  delete env.SOUS_DIR;
  delete env.SOUS_CONFD;
  const result = spawnSync(process.execPath, [binPath, ...args], { cwd, encoding: "utf8", env, input: "" });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** Text with every run of whitespace as one space, so a sentence a list wrapped still matches. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** A fresh copy of the template project and an empty recipe store for it. */
function freshClone(): { project: string; home: string } {
  copies += 1;
  const project = path.join(tmp.path, `clone-${copies}`);
  const home = path.join(tmp.path, `home-${copies}`);
  fs.cpSync(template, project, { recursive: true });
  fs.mkdirSync(home);
  return { project, home };
}

/** The project's lockfile, as text. */
function lockText(project: string): string {
  return fs.readFileSync(path.join(project, ".sous", "sous.lock.json"), "utf8");
}

/** The project's lockfile, parsed. */
function readLock(project: string): { recipes: Record<string, { version: string; kind: string; requestedBy: string[] }> } {
  return JSON.parse(lockText(project));
}

/** Adds subscriptions to the project's managed subscriptions file by hand, as a colleague's commit would. */
function subscribeByHand(project: string, ...keys: string[]): void {
  const sousDir = path.join(project, ".sous");
  const parsed = readManagedLayer(sousDir, SUBSCRIPTIONS_LAYER_FILENAME) as { subscriptions: Record<string, unknown> };
  for (const key of keys) {
    parsed.subscriptions[key] = {};
  }
  fs.writeFileSync(path.join(sousDir, "conf.d", SUBSCRIPTIONS_LAYER_FILENAME), JSON.stringify(parsed, null, 2));
}

beforeAll(async () => {
  tmp = makeTmpDir("sous-unread-recipes-");
  repo = path.join(tmp.path, "fixtures");
  template = path.join(tmp.path, "template");

  await buildFixtureRepo(repo, "fixtures", [
    { namespace: "support", name: "base", version: "1.0.0", files: { "partials/base.md": "BASE\n" }, contents: [] },
    { namespace: "lib", name: "one", version: "1.0.0", depends: ["support/base@^1.0.0"], files: { "skills/one/SKILL.md": "# one\n" } },
    { namespace: "lib", name: "two", version: "1.0.0", depends: ["support/base@^1.0.0"], files: { "skills/two/SKILL.md": "# two\n" } },
    { namespace: "lib", name: "broken", version: "1.0.0", depends: ["support/base@^1.0.0"], files: { "skills/broken/SKILL.md": "# broken\n" } },
  ]);
  // The index still offers lib/broken 1.0.0, but its tag and its folder are gone, so it cannot be downloaded.
  gitIn(repo, "tag", "-d", "lib/broken@1.0.0");
  fs.rmSync(path.join(repo, "recipes", "lib", "broken"), { recursive: true });

  writeFixtureFile(
    path.join(template, ".sous", "sous.config.js"),
    ["export const config = {", '  name: "Unread Recipes Project",', '  repos: { "sous-recipes": { enabled: false } },', "};", ""].join("\n")
  );
  const setupHome = path.join(tmp.path, "setup-home");
  for (const args of [["repo", "add", repo, "--name", "fixtures", "--trust"], ["subscription", "add", "lib/one", "--yes", "--no-build"]]) {
    const result = sous(template, setupHome, ...args);
    expect(result.status, result.output).toBe(0);
  }

  // The starting point every test copies: lib/one, and support/base, which only lib/one's manifest names.
  expect(readLock(template).recipes["support/base"]).toMatchObject({ version: "1.0.0", kind: "depends", requestedBy: ["lib/one"] });
}, CLI_TIMEOUT);

afterAll(() => {
  tmp.cleanup();
});

describe("sous doctor with an empty recipe store", () => {
  /**
   * The pins of what an unread recipe depends on stay: the doctor downloads
   * the pinned recipes to read them, finds the lockfile right, and writes nothing.
   *
   * SOUS_HOME=<empty> sous doctor --yes
   * // -> exit 0, the lockfile unchanged
   */
  it(
    "should leave a correct lockfile alone",
    () => {
      const { project, home } = freshClone();
      const before = lockText(project);
      const result = sous(project, home, "doctor", "--yes");

      expect(result.status, result.output).toBe(0);
      expect(lockText(project)).toBe(before);
      expect(result.output).not.toContain("The lockfile was written again");
    },
    CLI_TIMEOUT
  );

  /**
   * A dry run may fill the machine's recipe store, and says it did (the
   * user's ruling on #291).
   *
   * SOUS_HOME=<empty> sous doctor --dry-run
   * // -> "Sous downloaded these recipes into this machine's recipe store to read them: ..."
   */
  it(
    "should say which recipes a dry run downloaded",
    () => {
      const { project, home } = freshClone();
      const before = lockText(project);
      const result = sous(project, home, "doctor", "--dry-run");

      expect(result.status, result.output).toBe(0);
      expect(flat(result.output)).toContain("into this machine's recipe store to read them");
      expect(flat(result.output)).toMatch(/to read them: lib\/one, support\/base\./);
      expect(lockText(project)).toBe(before);
    },
    CLI_TIMEOUT
  );

  /**
   * A subscription whose recipe cannot be downloaded leaves its dependencies
   * unknown: the doctor reports that, offers no fix, and writes nothing.
   *
   * SOUS_HOME=<empty> sous doctor --yes   (lib/broken subscribed, its tag and folder gone)
   * // -> exit 1, "Sous cannot tell whether the lockfile matches the subscriptions", the lockfile unchanged
   */
  it(
    "should report a recipe it cannot read, and write no lockfile",
    () => {
      const { project, home } = freshClone();
      subscribeByHand(project, "lib/broken");
      const before = lockText(project);
      const result = sous(project, home, "doctor", "--yes");

      expect(result.status, result.output).toBe(1);
      expect(flat(result.output)).toContain("Sous cannot tell whether the lockfile matches the subscriptions");
      expect(flat(result.output)).toContain("lib/broken");
      expect(lockText(project)).toBe(before);
    },
    CLI_TIMEOUT
  );
});

describe("sous lock rebuild with an empty recipe store", () => {
  /**
   * The rebuild downloads lib/one to read what it depends on, so support/base
   * keeps its pin.
   *
   * SOUS_HOME=<empty> sous lock rebuild
   * // -> the lockfile pins support/base for lib/one, as before
   */
  it(
    "should keep what an unread recipe depends on",
    () => {
      const { project, home } = freshClone();
      const result = sous(project, home, "lock", "rebuild");

      expect(result.status, result.output).toBe(0);
      expect(readLock(project).recipes["support/base"]).toMatchObject({ version: "1.0.0", kind: "depends", requestedBy: ["lib/one"] });
    },
    CLI_TIMEOUT
  );

  /**
   * SOUS_HOME=<empty> sous lock rebuild   (lib/broken subscribed, its tag and folder gone)
   * // -> exit 1, "The lockfile was not written", the lockfile unchanged
   */
  it(
    "should not write the lockfile while a recipe cannot be read",
    () => {
      const { project, home } = freshClone();
      subscribeByHand(project, "lib/broken");
      const before = lockText(project);
      const result = sous(project, home, "lock", "rebuild");

      expect(result.status, result.output).toBe(1);
      expect(flat(result.output)).toContain("The lockfile was not written");
      expect(flat(result.output)).toContain("lib/broken");
      expect(lockText(project)).toBe(before);
    },
    CLI_TIMEOUT
  );
});

describe("sous build with an empty recipe store", () => {
  /**
   * A subscription a colleague added is locked with what it depends on: the
   * build downloads lib/two to read its manifest.
   *
   * SOUS_HOME=<empty> sous build   (lib/two subscribed by hand)
   * // -> support/base held by lib/one and lib/two
   */
  it(
    "should lock a new subscription with what it depends on",
    () => {
      const { project, home } = freshClone();
      subscribeByHand(project, "lib/two");
      const result = sous(project, home, "build");

      expect(result.status, result.output).toBe(0);
      expect(readLock(project).recipes["lib/two"]).toMatchObject({ version: "1.0.0" });
      expect(readLock(project).recipes["support/base"]?.requestedBy).toEqual(["lib/one", "lib/two"]);
    },
    CLI_TIMEOUT
  );

  /**
   * SOUS_HOME=<empty> sous build   (lib/broken subscribed by hand, its tag and folder gone)
   * // -> "The lockfile was not written, because sous could not read what lib/broken depends on."
   */
  it(
    "should not write the lockfile while a new subscription cannot be read",
    () => {
      const { project, home } = freshClone();
      subscribeByHand(project, "lib/broken");
      const before = readLock(project).recipes;
      const result = sous(project, home, "build");

      expect(flat(result.output)).toContain("The lockfile was not written, because sous could not read what lib/broken depends on.");
      // No pin changes; the build may still record the repository's index hash, which pins nothing.
      expect(readLock(project).recipes).toEqual(before);
    },
    CLI_TIMEOUT
  );
});
