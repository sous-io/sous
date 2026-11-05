/**
 * What the subscription commands say about the built-in `core` subscription,
 * end to end through the real CLI, with no network at all (#204, #229).
 *
 * The built-in `core` subscription follows the installed sous: its range is
 * exactly the running version. A project whose lockfile still pins an older
 * core moves it on the next build or update. These tests check that the
 * commands say so before and after, that removing core switches it off and
 * keeps its pin, and that each section heading is printed once.
 *
 * The child process is made offline the way `core-namespace.test.ts` does it:
 * `fetch` throws, git may use only `file`, and `GITHUB_TOKEN` is a dummy.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { SOUS_VERSION } from "../utils/package-info.js";
import { readManagedLayer, SUBSCRIPTIONS_LAYER_FILENAME } from "../utils/managed-layer.js";

import { binPath } from "../utils/sous-bin.js";

/** Per-test budget: each one boots the real CLI several times. */
const CLI_TIMEOUT = 120_000;

/** The older core version a project's lockfile is made to pin. */
const OLD_CORE = "0.0.1";

type RunResult = { stdout: string; stderr: string; status: number | null; output: string };

let tmp: TmpDir;
let sousHome: string;
let offlineHook: string;

/** Writes a file, creating its parent directories. Returns the full path. */
function write(filePath: string, contents: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
  return filePath;
}

/** Runs `sous <args...>` through the real bin, from `cwd`, on a machine with no network. */
function sous(cwd: string, ...args: string[]): RunResult {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SOUS_HOME: sousHome,
    GITHUB_TOKEN: "offline-test-token",
    GIT_ALLOW_PROTOCOL: "file",
    NODE_OPTIONS: `--import=${pathToFileURL(offlineHook).href}`,
  };
  delete env.SOUS_CONFIG;
  delete env.SOUS_DIR;
  delete env.SOUS_CONFD;
  const result = spawnSync(process.execPath, [binPath, ...args], { cwd, encoding: "utf8", env });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** Runs `sous <args...>` and fails the test, showing what it printed, unless it succeeded. */
function sousOk(cwd: string, ...args: string[]): RunResult {
  const result = sous(cwd, ...args);
  expect(result.status, result.output).toBe(0);
  return result;
}

/** A new project that says nothing about repositories, built once so core is pinned. */
function builtProject(name: string): string {
  const project = path.join(tmp.path, name);
  write(path.join(project, ".sous", "sous.config.json"), `${JSON.stringify({ name }, null, 2)}\n`);
  sousOk(project, "build");
  return project;
}

/** The project's lockfile. */
function readLock(project: string): { recipes: Record<string, { version: string; hash: string }> } {
  return JSON.parse(fs.readFileSync(path.join(project, ".sous", "sous.lock.json"), "utf8"));
}

/** The subscriptions in the project's `conf.d/510-subscriptions.jsonc`. */
function managedSubscriptions(project: string): Record<string, Record<string, unknown>> {
  const layer = readManagedLayer(path.join(project, ".sous"), SUBSCRIPTIONS_LAYER_FILENAME) as {
    subscriptions?: Record<string, Record<string, unknown>>;
  };
  return layer.subscriptions ?? {};
}

/**
 * Makes the project's lockfile pin core at {@link OLD_CORE}, as a project last
 * built by an older sous does. The store gets a copy of the current entry under
 * the old version, and the cached index lists it, so nothing needs the network.
 */
function pinOldCore(project: string): void {
  const entries = path.join(sousHome, "cache", "github.com", "sous-io", "sous-recipes", "core", "sous-skills");
  const oldEntry = path.join(entries, OLD_CORE);
  if (!fs.existsSync(oldEntry)) {
    fs.cpSync(path.join(entries, SOUS_VERSION), oldEntry, { recursive: true });
    const markerPath = path.join(oldEntry, ".sous.entry.json");
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(markerPath, JSON.stringify({ ...marker, version: OLD_CORE }, null, 2));

    const indexPath = path.join(sousHome, "cache", "_indexes", "github.com", "sous-io", "sous-recipes.json");
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8")) as {
      recipes: Record<string, { versions: Record<string, Record<string, unknown>> }>;
    };
    const versions = index.recipes["core/sous-skills"]!.versions;
    versions[OLD_CORE] = { ...Object.values(versions)[0]!, tag: `core/sous-skills@${OLD_CORE}` };
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  }

  const lockPath = path.join(project, ".sous", "sous.lock.json");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { recipes: Record<string, { version: string }> };
  lock.recipes["core/sous-skills"]!.version = OLD_CORE;
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

/** The output with every run of whitespace made one space, so a wrapped line reads whole. */
function flat(output: string): string {
  return output.replace(/\s+/g, " ");
}

/** How many times `text` appears in `output`. */
function count(output: string, text: string): number {
  return output.split(text).length - 1;
}

beforeAll(() => {
  tmp = makeTmpDir("sous-subscription-messages-");
  sousHome = path.join(tmp.path, "sous-home");
  offlineHook = write(
    path.join(tmp.path, "offline.mjs"),
    ["globalThis.fetch = async (url) => {", "  throw new Error(`offline: this test machine cannot reach ${url}`);", "};", ""].join("\n")
  );
}, CLI_TIMEOUT);

afterAll(() => {
  tmp.cleanup();
});

describe("the built-in core subscription when the lockfile pins an older core", () => {
  /**
   * The dry run lists the core move as a change, from the pinned version to
   * the installed one, and does not claim core "stays" (#229 defect 6).
   *
   * sous subscription update --dry-run
   * // -> Updating core/sous-skills from version 0.0.1 to version <installed>
   */
  it(
    "should list the core move in the update plan",
    () => {
      const project = builtProject("update-plan");
      pinOldCore(project);

      const result = sousOk(project, "subscription", "update", "--dry-run");

      expect(flat(result.output)).toContain(`Updating core/sous-skills from version ${OLD_CORE} to version ${SOUS_VERSION}`);
      expect(flat(result.output)).not.toContain("stays at");
      expect(flat(result.output)).toContain("follows the installed sous");
    },
    CLI_TIMEOUT
  );

  /**
   * The closing lockfile summary of a real update lists the core move too.
   *
   * sous subscription update --yes --no-build
   * // -> ▶ Lockfile: Updating core/sous-skills from version 0.0.1 to version <installed>
   */
  it(
    "should list the core move in the lockfile summary",
    () => {
      const project = builtProject("update-summary");
      pinOldCore(project);

      const result = sousOk(project, "subscription", "update", "--yes", "--no-build");
      const summary = result.stdout.slice(result.stdout.lastIndexOf("Lockfile"));

      expect(flat(summary)).toContain(`Updating core/sous-skills from version ${OLD_CORE} to version ${SOUS_VERSION}`);
      expect(readLock(project).recipes["core/sous-skills"]!.version).toBe(SOUS_VERSION);
    },
    CLI_TIMEOUT
  );

  /**
   * A plain build that moves core says why.
   *
   * sous build
   * // -> core/sous-skills moved from version 0.0.1 to version <installed>, because ... follows the installed sous ...
   */
  it(
    "should say why a build moves core",
    () => {
      const project = builtProject("build-moves-core");
      pinOldCore(project);

      const result = sousOk(project, "build");

      expect(flat(result.output)).toContain(
        `core/sous-skills moved from version ${OLD_CORE} to version ${SOUS_VERSION}, because the subscription to 'core' follows the installed sous, version ${SOUS_VERSION}.`
      );
    },
    CLI_TIMEOUT
  );
});

describe("subscription commands on the built-in core subscription", () => {
  /**
   * Removing core switches it off and keeps its pin, exactly like disabling
   * it; adding it back clears the opt-out instead of writing a new entry (#204
   * bug 26).
   *
   * sous subscription remove core --yes --no-build  // 510: core: { enabled: false }, pin kept
   * sous subscription add core --yes --no-build     // 510: no core entry
   */
  it(
    "should keep core's pin when core is removed, and clear the opt-out when it is added back",
    () => {
      const project = builtProject("remove-core");
      const pinned = readLock(project).recipes["core/sous-skills"];

      const removed = sousOk(project, "subscription", "remove", "core", "--yes", "--no-build");

      expect(flat(removed.output)).toContain("switched off rather than deleted");
      expect(managedSubscriptions(project)["core"]).toEqual({ enabled: false });
      expect(readLock(project).recipes["core/sous-skills"]).toEqual(pinned);

      sousOk(project, "subscription", "add", "core", "--yes", "--no-build");

      expect(managedSubscriptions(project)["core"]).toBeUndefined();
    },
    CLI_TIMEOUT
  );

  /**
   * Each section heading is printed once, though the command runs a build
   * (#204 bug 44, #229).
   *
   * sous subscription disable core
   * // -> one "▶ Building the project:", one "▶ Disabling a subscription:"
   */
  it(
    "should print each heading once when disabling, enabling and removing",
    () => {
      const project = builtProject("headings");

      const disabled = sousOk(project, "subscription", "disable", "core");
      expect(count(disabled.output, "▶ Building the project:"), disabled.output).toBe(1);
      expect(count(disabled.output, "▶ Disabling a subscription:"), disabled.output).toBe(1);

      const enabled = sousOk(project, "subscription", "enable", "core");
      expect(count(enabled.output, "▶ Building the project:"), enabled.output).toBe(1);
      expect(count(enabled.output, "▶ Enabling a subscription:"), enabled.output).toBe(1);

      const removed = sousOk(project, "subscription", "remove", "core");
      expect(count(removed.output, "▶ Building the project:"), removed.output).toBe(1);
      expect(count(removed.output, "▶ Unsubscribing:"), removed.output).toBe(1);
    },
    CLI_TIMEOUT
  );
});
