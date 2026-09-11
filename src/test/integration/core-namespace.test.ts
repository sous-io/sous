/**
 * The core namespace, end to end, with no network at all.
 *
 * This is the promise Phase 7 makes: install sous, run `sous build` in a project
 * that has never used a repository, on a machine that cannot reach GitHub, and
 * the skills that teach an agent about sous are compiled into `.claude/skills`
 * anyway. Nothing is typed, nothing is asked, and the lockfile records exactly
 * what was used.
 *
 * The child process is made genuinely offline three ways, so a passing run here
 * can never be a run that quietly reached the network:
 *
 *   - `fetch` is replaced, before any sous code loads, with one that throws.
 *     That is the call the GitHub provider makes to read a repository's index.
 *   - `GIT_ALLOW_PROTOCOL` is narrowed to `file`, so any `git clone` over HTTPS
 *     is refused by git itself.
 *   - `GITHUB_TOKEN` is set to a dummy value, so sous never shells out to `gh`
 *     looking for a real one.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { SOUS_VERSION } from "../../lib/package-info.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const binPath = path.join(repoRoot, "bin", "run.js");

/** Per-test budget: each one boots the real CLI. */
const CLI_TIMEOUT = 90_000;

type RunResult = { stdout: string; stderr: string; status: number | null };

let tmp: TmpDir;
let projectRoot: string;
let sousDir: string;
let sousHome: string;
let offlineHook: string;

/** Writes a file, creating its parent directories. Returns the full path. */
function write(filePath: string, contents: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
  return filePath;
}

/**
 * Runs `sous <args...>` through the real published bin, from `cwd`, on a machine
 * that has no network.
 */
function sousOffline(cwd: string, ...args: string[]): RunResult {
  const env = {
    ...process.env,
    SOUS_HOME: sousHome,
    GITHUB_TOKEN: "offline-test-token",
    GIT_ALLOW_PROTOCOL: "file",
    NODE_OPTIONS: `--import=${pathToFileURL(offlineHook).href}`,
  };
  delete env.SOUS_CONFIG;
  delete env.SOUS_DIR;
  delete env.SOUS_CONFD;

  const result = spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: "utf8",
    env,
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

beforeAll(() => {
  tmp = makeTmpDir("sous-core-namespace-");
  projectRoot = path.join(tmp.path, "project");
  sousDir = path.join(projectRoot, ".sous");
  sousHome = path.join(tmp.path, "sous-home");

  // Installed before anything else loads, so the very first thing sous could
  // have fetched is already impossible.
  offlineHook = write(
    path.join(tmp.path, "offline.mjs"),
    [
      "globalThis.fetch = async (url) => {",
      "  throw new Error(`offline: this test machine cannot reach ${url}`);",
      "};",
      "",
    ].join("\n")
  );

  // A project that says nothing whatsoever about repositories: no `repos`, no
  // `subscriptions`, no `recipeOutputs`. Everything that follows comes from the
  // defaults sous provides.
  write(
    path.join(sousDir, "sous.config.json"),
    `${JSON.stringify({ name: "A Brand New Project" }, null, 2)}\n`
  );
}, CLI_TIMEOUT);

afterAll(() => {
  tmp.cleanup();
});

describe("the core namespace with no network", () => {
  /**
   * The whole promise in one command.
   *
   * sous build
   */
  it(
    "should build a brand new project offline",
    () => {
      const result = sousOffline(projectRoot, "build");

      expect(result.status).toBe(0);

      // Sous tried to reach the repository, could not, and said so before
      // carrying on with what it already had. That is the same last-good
      // behavior every repository gets, and it is what proves the network really
      // was unreachable rather than quietly succeeding.
      expect(result.stdout + result.stderr).toContain(
        "could not check the repository 'sous-recipes'"
      );
    },
    CLI_TIMEOUT
  );

  /**
   * The packaged recipe was copied into the machine-wide store, at the version
   * of the sous package that shipped it.
   */
  it(
    "should seed the store from the package",
    () => {
      const entry = path.join(
        sousHome,
        "cache",
        "sous-recipes",
        "core",
        "sous-skills",
        SOUS_VERSION
      );

      expect(fs.existsSync(path.join(entry, "sous.recipe.yaml"))).toBe(true);
      expect(fs.existsSync(path.join(entry, ".sous.entry.json"))).toBe(true);
    },
    CLI_TIMEOUT
  );

  /**
   * The stand-in index is what let the resolver see the seeded recipe. It says
   * in the file itself that sous wrote it.
   */
  it(
    "should write a stand-in index for the official repository",
    () => {
      const index = JSON.parse(
        fs.readFileSync(
          path.join(sousHome, "cache", "_indexes", "sous-recipes.json"),
          "utf8"
        )
      ) as { $comment?: string; recipes: Record<string, { versions: Record<string, unknown> }> };

      expect(index.$comment).toContain("inside the installed package");
      expect(Object.keys(index.recipes)).toEqual(["core/sous-skills"]);
      expect(Object.keys(index.recipes["core/sous-skills"]!.versions)).toEqual([
        SOUS_VERSION,
      ]);
    },
    CLI_TIMEOUT
  );

  /**
   * The lockfile is the point: it records what was used, so a colleague on a
   * different machine gets exactly the same thing.
   */
  it(
    "should write a lockfile pinning the core recipe",
    () => {
      const lock = JSON.parse(
        fs.readFileSync(path.join(sousDir, "sous.lock.json"), "utf8")
      ) as {
        repos: Record<string, { url: string }>;
        recipes: Record<
          string,
          { repo: string; version: string; kind: string; requestedBy: string[] }
        >;
      };

      expect(Object.keys(lock.recipes)).toEqual(["core/sous-skills"]);

      const locked = lock.recipes["core/sous-skills"]!;
      expect(locked.repo).toBe("sous-recipes");
      expect(locked.version).toBe(SOUS_VERSION);
      expect(locked.kind).toBe("subscribes");
      expect(locked.requestedBy).toEqual(["project"]);

      expect(lock.repos["sous-recipes"]!.url).toBe("https://github.com/sous-io/sous-recipes");
    },
    CLI_TIMEOUT
  );

  /**
   * And the skills actually land where an agent looks for them, rendered from
   * their `.tpl.` sources through the ordinary compiler.
   */
  it(
    "should compile the core skills into .claude/skills",
    () => {
      const skills = path.join(projectRoot, ".claude", "skills");

      for (const name of [
        "about-sous",
        "about-sous-configuration",
        "about-agent-skills",
        "about-liquid-templates",
        "create-skill",
      ]) {
        expect(fs.existsSync(path.join(skills, name, "SKILL.md"))).toBe(true);
      }

      // The `.tpl.` suffix is stripped on the way out, and nothing unrendered
      // is left behind.
      expect(fs.existsSync(path.join(skills, "about-sous", "SKILL.tpl.md"))).toBe(false);
      expect(fs.readFileSync(path.join(skills, "about-sous", "SKILL.md"), "utf8")).toContain(
        "sous",
      );
    },
    CLI_TIMEOUT
  );

  /**
   * A second build decides nothing again: the lockfile is already right, the
   * store already holds the entry, and nothing is refetched or rewritten.
   */
  it(
    "should be quiet and unchanged on a second build",
    () => {
      const before = fs.readFileSync(path.join(sousDir, "sous.lock.json"), "utf8");

      const result = sousOffline(projectRoot, "build");

      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("Locking subscribed recipes");
      expect(fs.readFileSync(path.join(sousDir, "sous.lock.json"), "utf8")).toBe(before);
    },
    CLI_TIMEOUT
  );

  /**
   * The way out is ordinary config. A project that switches the built-in
   * repository off gets no core skills and no lockfile entry, and still builds.
   *
   * repos: { "sous-recipes": { enabled: false } }
   */
  it(
    "should honour the opt-out",
    () => {
      const optedOut = path.join(tmp.path, "opted-out");
      write(
        path.join(optedOut, ".sous", "sous.config.json"),
        `${JSON.stringify(
          {
            name: "A Project That Opted Out",
            repos: { "sous-recipes": { enabled: false } },
          },
          null,
          2
        )}\n`
      );

      const result = sousOffline(optedOut, "build");

      expect(result.status).toBe(0);
      expect(fs.existsSync(path.join(optedOut, ".sous", "sous.lock.json"))).toBe(false);
      expect(fs.existsSync(path.join(optedOut, ".claude", "skills"))).toBe(false);
    },
    CLI_TIMEOUT
  );

  /**
   * Opting out of the subscription alone leaves the repository in place, which
   * is what a project wants when it means to subscribe to something else in the
   * official repository but not to core.
   *
   * subscriptions: { core: { enabled: false } }
   */
  it(
    "should honour opting out of the core subscription alone",
    () => {
      const noCore = path.join(tmp.path, "no-core");
      write(
        path.join(noCore, ".sous", "sous.config.json"),
        `${JSON.stringify(
          {
            name: "A Project With No Core",
            subscriptions: { core: { enabled: false } },
          },
          null,
          2
        )}\n`
      );

      const result = sousOffline(noCore, "build");

      expect(result.status).toBe(0);
      expect(fs.existsSync(path.join(noCore, ".sous", "sous.lock.json"))).toBe(false);
      expect(fs.existsSync(path.join(noCore, ".claude", "skills"))).toBe(false);

      // The repository itself is untouched, so anything else it publishes can
      // still be subscribed to.
      const listed = sousOffline(noCore, "repo", "list");
      expect(listed.status).toBe(0);
      expect(listed.stdout).toContain("sous-recipes");
      expect(listed.stdout).toContain("built in");
    },
    CLI_TIMEOUT
  );

  /**
   * The listing reports the built-in subscription as a subscription like any
   * other: the range sous pinned it to, the version the lockfile holds, and the
   * fact that sous provided it rather than a person.
   *
   * sous subscription list
   */
  it(
    "should list the built-in core subscription",
    () => {
      const result = sousOffline(projectRoot, "subscription", "list");

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("core");
      expect(result.stdout).toContain(SOUS_VERSION);
      expect(result.stdout).toContain(`core/sous-skills ${SOUS_VERSION}`);
      expect(result.stdout).toContain("built in");
    },
    CLI_TIMEOUT
  );

  /** The plural spelling of the topic reaches the same command. */
  it(
    "should accept the plural spelling of the subscription topic",
    () => {
      const result = sousOffline(projectRoot, "subscriptions", "list");

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("core");
    },
    CLI_TIMEOUT
  );

  /**
   * Removing a subscription sous provides itself cannot delete an entry, because
   * there is no entry to delete: the default comes back on the next run. So it
   * records the opt-out instead, in the same managed layer a hand-written one
   * would go in, and the repository stays trusted.
   *
   * sous subscription remove core
   * sous subscription add core
   */
  it(
    "should record an opt-out when the built-in core subscription is removed",
    () => {
      const dropped = path.join(tmp.path, "dropped-core");
      write(
        path.join(dropped, ".sous", "sous.config.json"),
        `${JSON.stringify({ name: "A Project That Drops Core" }, null, 2)}\n`
      );

      // A first build locks core, so there is something real to remove.
      expect(sousOffline(dropped, "build").status).toBe(0);

      const removed = sousOffline(dropped, "subscription", "remove", "core");
      expect(removed.status).toBe(0);
      expect(removed.stdout).toContain("enabled: false");

      const layerPath = path.join(dropped, ".sous", "conf.d", "510-subscriptions.json");
      const layer = JSON.parse(fs.readFileSync(layerPath, "utf8")) as {
        subscriptions: Record<string, { enabled?: boolean }>;
      };
      expect(layer.subscriptions["core"]).toEqual({ enabled: false });

      // The lockfile no longer pins the core recipe, and a build leaves it out.
      const lock = JSON.parse(
        fs.readFileSync(path.join(dropped, ".sous", "sous.lock.json"), "utf8")
      ) as { recipes: Record<string, unknown> };
      expect(Object.keys(lock.recipes)).toEqual([]);

      expect(sousOffline(dropped, "build").status).toBe(0);
      expect(
        fs.existsSync(path.join(dropped, ".claude", "skills", "about-sous", "SKILL.md"))
      ).toBe(false);

      // The repository sous provides is untouched by any of that.
      const repos = sousOffline(dropped, "repo", "list");
      expect(repos.status).toBe(0);
      expect(repos.stdout).toContain("sous-recipes");
      expect(repos.stdout).toContain("built in");

      // The listing reports the opt-out rather than hiding it.
      const listed = sousOffline(dropped, "subscription", "list");
      expect(listed.status).toBe(0);
      expect(listed.stdout).toMatch(/core\b[\s\S]*\bno\b/);

      // Adding it back clears the override, and the skills come back. The
      // answer to the one variable core publishes is put where sous looks for
      // it, because subscribing asks and this run has no terminal to ask on.
      write(
        path.join(dropped, ".sous", ".env"),
        "SOUS_VAR_SKILLS_ROOT=prompts/skills\n"
      );

      const addedBack = sousOffline(dropped, "subscription", "add", "core");
      expect(addedBack.status).toBe(0);
      const after = JSON.parse(fs.readFileSync(layerPath, "utf8")) as {
        subscriptions: Record<string, { enabled?: boolean }>;
      };
      expect(after.subscriptions["core"]!.enabled).toBeUndefined();

      expect(sousOffline(dropped, "build").status).toBe(0);
      expect(
        fs.existsSync(path.join(dropped, ".claude", "skills", "about-sous", "SKILL.md"))
      ).toBe(true);
    },
    CLI_TIMEOUT
  );
});
