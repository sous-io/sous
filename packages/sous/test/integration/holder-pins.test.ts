/**
 * A recipe pinned once per holder (ADR 0023, decisions 4 and 5), end to end
 * through the real CLI.
 *
 * Two subscribed libraries each need an exact, different version of a recipe
 * they reach only through `depends`. No version fits both, so the lockfile pins
 * the recipe once for the project and once more for one library; the store
 * holds both versions, each library's include reads its own version, and the
 * questions the two versions ask are combined the same way by the dry-run
 * preview and by `vars ask`.
 *
 * Everything runs against a local fixture repository read through the `local`
 * provider, so nothing here touches the network.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hashDirectory } from "@sous-io/plugin-formats";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { buildFixtureRepo, gitIn, writeFixtureFile } from "../utils/fixture-repo.js";
import { binPath } from "../utils/sous-bin.js";

/** Per-test budget: every one of these boots the real CLI several times. */
const CLI_TIMEOUT = 120_000;

type RunResult = { stdout: string; stderr: string; status: number | null; output: string };

let tmp: TmpDir;
let sousHome: string;
let repo: string;
let projectRoot: string;

/** Runs `sous <args...>` through the real bin, from `cwd`, with the store in this test's directory. */
function sous(cwd: string, ...args: string[]): RunResult {
  const env: NodeJS.ProcessEnv = { ...process.env, SOUS_HOME: sousHome };
  delete env.SOUS_CONFIG;
  delete env.SOUS_DIR;
  delete env.SOUS_CONFD;
  const result = spawnSync(process.execPath, [binPath, ...args], { cwd, encoding: "utf8", env });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** The same, failing the test with everything printed unless it succeeded. */
function sousOk(cwd: string, ...args: string[]): RunResult {
  const result = sous(cwd, ...args);
  expect(result.status, result.output).toBe(0);
  return result;
}

/** The project's lockfile. */
function readLock(): { recipes: Record<string, { version: string; requestedBy: string[]; pins?: Record<string, { version: string }> }> } {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, ".sous", "sous.lock.json"), "utf8"));
}

/** The store directory of one version of a fixture recipe, under the `local` provider's identity. */
function storeEntryDir(key: string, version: string): string {
  const segments = repo
    .split(path.sep)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase().replace(/^([a-z]):$/, "$1"));
  return path.join(sousHome, "cache", "localhost", ...segments, ...key.split("/"), version);
}

/** A variable definition, in the manifest's form. */
function tone(local: boolean): unknown {
  return {
    name: "tone",
    type: "string",
    prompt: "Which tone should the agent write in?",
    description: "The tone the agent writes in. It has no default; any short word is accepted.",
    example: "plain",
    required: false,
    scope: local ? "local" : "shared",
  };
}

/**
 * Publishes version 2.0.0 of `support/base` into the fixture repository the way
 * a release would: new files, a new index entry with the folder's real hash,
 * and a tag.
 */
async function publishBaseTwo(): Promise<void> {
  const recipeDir = path.join(repo, "recipes", "support", "base");
  const manifestPath = path.join(recipeDir, "sous.recipe.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  manifest["version"] = "2.0.0";
  manifest["variables"] = [tone(true)];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  writeFixtureFile(path.join(recipeDir, "partials", "base.md"), "BASE TWO\n");

  const indexPath = path.join(repo, "sous.index.json");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8")) as { recipes: Record<string, { versions: Record<string, unknown> }> };
  index.recipes["support/base"]!.versions["2.0.0"] = {
    hash: await hashDirectory(recipeDir),
    tag: "support/base@2.0.0",
    prerelease: false,
    releasedAt: "2026-02-01T00:00:00.000Z",
  };
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));

  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "--quiet", "-m", "Release support/base@2.0.0");
  gitIn(repo, "tag", "support/base@2.0.0");
}

/**
 * Records in the fixture index what each version declares, the way a release
 * does, so a dry run knows a recipe's dependencies and questions without
 * downloading it.
 */
function recordInIndex(entries: Record<string, Record<string, unknown>>): void {
  const indexPath = path.join(repo, "sous.index.json");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8")) as { recipes: Record<string, { versions: Record<string, Record<string, unknown>> }> };
  for (const [keyAt, fields] of Object.entries(entries)) {
    const [key, version] = keyAt.split("@") as [string, string];
    Object.assign(index.recipes[key]!.versions[version]!, fields);
  }
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "--quiet", "-m", "Record what each version declares");
}

beforeAll(async () => {
  tmp = makeTmpDir("sous-holder-pins-");
  sousHome = path.join(tmp.path, "sous-home");
  repo = path.join(tmp.path, "fixtures");
  projectRoot = path.join(tmp.path, "project");

  await buildFixtureRepo(repo, "fixtures", [
    {
      namespace: "support",
      name: "base",
      version: "1.0.0",
      files: { "partials/base.md": "BASE ONE\n" },
      contents: [],
      variables: [tone(false)],
    },
    {
      namespace: "lib",
      name: "one",
      version: "1.0.0",
      depends: ["support/base@1.0.0"],
      files: { "skills/one/SKILL.md": "# one\n\n@~support/base/partials/base.md\n" },
    },
    {
      namespace: "lib",
      name: "two",
      version: "1.0.0",
      depends: ["support/base@2.0.0"],
      files: { "skills/two/SKILL.md": "# two\n\n@~support/base/partials/base.md\n" },
    },
  ]);
  await publishBaseTwo();
  recordInIndex({
    "support/base@1.0.0": { depends: [], subscribes: [], variables: [tone(false)] },
    "support/base@2.0.0": { depends: [], subscribes: [], variables: [tone(true)] },
    "lib/one@1.0.0": { depends: ["support/base@1.0.0"], subscribes: [] },
    "lib/two@1.0.0": { depends: ["support/base@2.0.0"], subscribes: [] },
  });

  writeFixtureFile(
    path.join(projectRoot, ".sous", "sous.config.js"),
    ["export const config = {", '  name: "Holder Pins Project",', '  repos: { "sous-recipes": { enabled: false } },', "};", ""].join("\n")
  );
  sousOk(projectRoot, "repo", "add", repo, "--name", "fixtures", "--trust");
  sousOk(projectRoot, "subscription", "add", "lib/one", "--yes", "--no-build");
}, CLI_TIMEOUT);

afterAll(() => {
  tmp.cleanup();
});

describe("a depends-only recipe pinned once per holder", () => {
  /**
   * The dry-run preview combines the two versions' definitions of `tone`
   * (one of them stored in the gitignored env file) the way `vars ask` does, so it names the gitignored
   * env file; the real run then stores the answer there.
   *
   * sous subscription add lib/two --dry-run --non-interactive
   * // -> the question is stored in .sous/.env.local
   * sous subscription add lib/two --yes --no-build --answer tone=warm
   * // -> SOUS_VAR_TONE=warm in .sous/.env.local
   */
  it(
    "should preview a combined question where vars ask stores it",
    () => {
      const preview = sousOk(projectRoot, "subscription", "add", "lib/two", "--dry-run", "--non-interactive");
      const localFile = path.join(projectRoot, ".sous", ".env.local");

      expect(preview.stdout).toContain("SOUS_VAR_TONE");
      expect(preview.stdout).toContain(localFile);
      expect(preview.stdout).not.toContain(`${path.join(projectRoot, ".sous", ".env")}\n`);

      sousOk(projectRoot, "subscription", "add", "lib/two", "--yes", "--no-build", "--answer", "tone=warm");

      expect(fs.readFileSync(localFile, "utf8")).toContain("SOUS_VAR_TONE=warm");
    },
    CLI_TIMEOUT
  );

  /**
   * The locked version stays for the library it fits, and the other library
   * gets a pin of its own.
   *
   * // -> support/base 1.0.0, pinned at 2.0.0 for lib/two
   */
  it(
    "should pin the recipe once more for the library the shared version does not fit",
    () => {
      const base = readLock().recipes["support/base"];

      expect(base).toMatchObject({ version: "1.0.0", requestedBy: ["lib/one", "lib/two"] });
      expect(base?.pins).toEqual({ "lib/two": expect.objectContaining({ version: "2.0.0" }) });
    },
    CLI_TIMEOUT
  );

  /**
   * A build fetches both versions into the store, and each library's include
   * reads its own version of the partial.
   *
   * sous build
   * // -> skills/one holds "BASE ONE", skills/two holds "BASE TWO"
   */
  it(
    "should keep both versions in the store and resolve each library's include to its own",
    () => {
      sousOk(projectRoot, "build");

      expect(fs.existsSync(path.join(storeEntryDir("support/base", "1.0.0"), "partials", "base.md"))).toBe(true);
      expect(fs.existsSync(path.join(storeEntryDir("support/base", "2.0.0"), "partials", "base.md"))).toBe(true);
      expect(fs.readFileSync(path.join(projectRoot, ".claude", "skills", "one", "SKILL.md"), "utf8")).toContain("BASE ONE");
      expect(fs.readFileSync(path.join(projectRoot, ".claude", "skills", "two", "SKILL.md"), "utf8")).toContain("BASE TWO");
    },
    CLI_TIMEOUT
  );

  /**
   * Removing the library that held the pin removes the pin with it.
   *
   * sous subscription remove lib/two --no-build
   * // -> support/base 1.0.0, no pins
   */
  it(
    "should drop the pin when its holder goes",
    () => {
      sousOk(projectRoot, "subscription", "remove", "lib/two", "--no-build");

      const base = readLock().recipes["support/base"];

      expect(base).toMatchObject({ version: "1.0.0", requestedBy: ["lib/one"] });
      expect(base).not.toHaveProperty("pins");
    },
    CLI_TIMEOUT
  );
});
