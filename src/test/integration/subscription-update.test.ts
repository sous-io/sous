/**
 * `sous subscription update` and `sous repo unlink`, end to end through the real
 * CLI.
 *
 * Everything runs against a local fixture repository read through the `local`
 * provider, and newer versions are published into it by the test itself (a
 * commit, a tag and a regenerated index entry), so nothing here touches the
 * network and every run starts from the same state.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { buildFixtureRepo, gitIn, writeFixtureFile } from "../utils/fixture-repo.js";
import { hashDirectory } from "../../lib/repos/store/hash.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const binPath = path.join(repoRoot, "bin", "run.js");

/** Per-test budget: every one of these boots the real CLI several times. */
const CLI_TIMEOUT = 120_000;

type RunResult = { stdout: string; stderr: string; status: number | null; output: string };

let tmp: TmpDir;
let sousHome: string;

/**
 * Runs `sous <args...>` through the real published bin, from `cwd`, with the
 * store pointed at this test's temporary directory and no terminal.
 */
function sous(cwd: string, ...args: string[]): RunResult {
  const env = { ...process.env, SOUS_HOME: sousHome };
  delete env.SOUS_CONFIG;
  delete env.SOUS_DIR;
  delete env.SOUS_CONFD;
  const result = spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: "utf8",
    env,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
}

/**
 * Runs `sous <args...>` as `sous` does and fails the test, showing everything
 * the command printed, unless it succeeded. For setup steps.
 */
function sousOk(cwd: string, ...args: string[]): RunResult {
  const result = sous(cwd, ...args);
  expect(result.status, result.output).toBe(0);
  return result;
}

/** The versions a project's lockfile pins, keyed by recipe. */
function lockedVersions(projectRoot: string): Record<string, string> {
  const lock = JSON.parse(
    fs.readFileSync(path.join(projectRoot, ".sous", "sous.lock.json"), "utf8")
  ) as { recipes: Record<string, { version: string }> };
  return Object.fromEntries(
    Object.entries(lock.recipes).map(([key, entry]) => [key, entry.version])
  );
}

/**
 * Publishes a new version of a recipe into a fixture repository, the way a
 * release would: the manifest and a file change, the index gains the version
 * with the folder's real hash, and the commit is tagged.
 */
async function publishVersion(
  repo: string,
  recipe: {
    namespace: string;
    name: string;
    version: string;
    depends?: string[];
    variables?: unknown[];
  }
): Promise<void> {
  const relative = `recipes/${recipe.namespace}/${recipe.name}`;
  const recipeDir = path.join(repo, relative);
  const manifestPath = path.join(recipeDir, "sous.recipe.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  manifest["version"] = recipe.version;
  if (recipe.depends !== undefined) manifest["depends"] = recipe.depends;
  if (recipe.variables !== undefined) manifest["variables"] = recipe.variables;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  writeFixtureFile(
    path.join(recipeDir, "skills", recipe.name, "SKILL.md"),
    `# ${recipe.name}\n\nVersion ${recipe.version}.\n`
  );

  const indexPath = path.join(repo, "sous.index.json");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8")) as {
    recipes: Record<string, { versions: Record<string, unknown> }>;
  };
  const key = `${recipe.namespace}/${recipe.name}`;
  index.recipes[key]!.versions[recipe.version] = {
    hash: await hashDirectory(recipeDir),
    tag: `${key}@${recipe.version}`,
    prerelease: false,
    releasedAt: "2026-02-01T00:00:00.000Z",
  };
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));

  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "--quiet", "-m", `Release ${key}@${recipe.version}`);
  gitIn(repo, "tag", `${key}@${recipe.version}`);
}

/**
 * Builds a project that trusts one fixture repository and subscribes to two
 * of its recipes, one with a range and one without.
 */
function makeProject(projectRoot: string, repo: string): void {
  writeFixtureFile(
    path.join(projectRoot, ".sous", "sous.config.js"),
    [
      "export const config = {",
      '  name: "Update Test Project",',
      // The official repository is switched off, so the whole file runs against
      // the local fixture and nothing else.
      '  repos: { "sous-recipes": { enabled: false } },',
      "};",
      "",
    ].join("\n")
  );
  sousOk(projectRoot, "repo", "add", repo, "--name", "fixtures", "--trust");
  expect(
    sous(projectRoot, "subscription", "add", "workflow/alpha@^1.0.0", "--yes", "--no-build")
      .status
  ).toBe(0);
  expect(
    sous(projectRoot, "subscription", "add", "workflow/beta", "--yes", "--no-build").status
  ).toBe(0);
}

beforeAll(() => {
  tmp = makeTmpDir("sous-subscription-update-");
  sousHome = path.join(tmp.path, "sous-home");
});

afterAll(() => {
  tmp.cleanup();
});

describe("sous subscription update", () => {
  let repo: string;
  let projectRoot: string;
  let subscriptionsLayer: string;

  beforeAll(async () => {
    repo = path.join(tmp.path, "update-fixtures");
    projectRoot = path.join(tmp.path, "update-project");

    await buildFixtureRepo(repo, "fixtures", [
      { namespace: "workflow", name: "alpha", version: "1.0.0", files: { "skills/alpha/SKILL.md": "# alpha\n" } },
      { namespace: "workflow", name: "beta", version: "1.0.0", files: { "skills/beta/SKILL.md": "# beta\n" } },
      { namespace: "support", name: "base", version: "1.0.0", files: { "partials/base.md": "Base.\n" } },
    ]);
    makeProject(projectRoot, repo);
    subscriptionsLayer = fs.readFileSync(
      path.join(projectRoot, ".sous", "conf.d", "510-subscriptions.jsonc"),
      "utf8"
    );

    // Newer versions arrive after the project locked 1.0.0 of everything. The
    // newest alpha is outside its subscription's range, and the in-range one
    // brings a dependency along.
    await publishVersion(repo, {
      namespace: "workflow",
      name: "alpha",
      version: "1.1.0",
      depends: ["support/base@^1.0.0"],
    });
    await publishVersion(repo, { namespace: "workflow", name: "alpha", version: "2.0.0" });
    await publishVersion(repo, { namespace: "workflow", name: "beta", version: "1.1.0" });
  }, CLI_TIMEOUT);

  /**
   * A dry run fetches the indexes and prints the plan, and writes nothing.
   *
   * sous subscription update --dry-run
   * // -> "Updating workflow/alpha from version 1.0.0 to version 1.1.0", lock unchanged
   */
  it(
    "should print the plan and write nothing on a dry run",
    () => {
      const result = sous(projectRoot, "subscription", "update", "--dry-run");

      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain("Updating workflow/alpha from version 1.0.0 to version 1.1.0");
      expect(result.output).toContain("Updating workflow/beta from version 1.0.0 to version 1.1.0");
      expect(result.output).toContain("dependencies of the versions not on this machine yet");
      expect(lockedVersions(projectRoot)).toEqual({
        "workflow/alpha": "1.0.0",
        "workflow/beta": "1.0.0",
      });
    },
    CLI_TIMEOUT
  );

  /**
   * With no terminal and no `--yes`, the one question cannot be asked, so the
   * run fails naming the flag and changes nothing.
   *
   * sous subscription update
   * // -> exits non-zero, names --yes
   */
  it(
    "should fail naming --yes when it cannot ask",
    () => {
      const result = sous(projectRoot, "subscription", "update");

      expect(result.status).not.toBe(0);
      expect(result.output).toContain("--yes");
      expect(lockedVersions(projectRoot)["workflow/alpha"]).toBe("1.0.0");
    },
    CLI_TIMEOUT
  );

  /**
   * A reference narrows the update: only the named recipe moves, within its
   * range, and its new dependency arrives with it. The subscriptions are not
   * edited.
   *
   * sous subscription update workflow/alpha --yes --no-build
   * // -> alpha 1.1.0 (not 2.0.0), support/base added, beta still 1.0.0
   */
  it(
    "should move only the named recipe, within its range, with its dependencies",
    () => {
      const result = sous(
        projectRoot,
        "subscription",
        "update",
        "workflow/alpha",
        "--yes",
        "--no-build"
      );

      expect(result.status, result.output).toBe(0);
      expect(lockedVersions(projectRoot)).toEqual({
        "support/base": "1.0.0",
        "workflow/alpha": "1.1.0",
        "workflow/beta": "1.0.0",
      });
      expect(
        fs.readFileSync(
          path.join(projectRoot, ".sous", "conf.d", "510-subscriptions.jsonc"),
          "utf8"
        )
      ).toBe(subscriptionsLayer);
    },
    CLI_TIMEOUT
  );

  /**
   * With no reference everything moves, and the project is rebuilt so the new
   * versions' files are on disk.
   *
   * sous subscription update --yes
   * // -> beta 1.1.0, and the build writes its new SKILL.md
   */
  it(
    "should update everything and rebuild",
    () => {
      const result = sous(projectRoot, "subscription", "update", "--yes");

      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain("Building the project");
      expect(lockedVersions(projectRoot)["workflow/beta"]).toBe("1.1.0");
      expect(
        fs.readFileSync(
          path.join(projectRoot, ".claude", "skills", "beta", "SKILL.md"),
          "utf8"
        )
      ).toContain("Version 1.1.0");
    },
    CLI_TIMEOUT
  );

  /**
   * With nothing left to move, the run says so and asks nothing, so it
   * succeeds even with no terminal and no `--yes`.
   *
   * sous subscription update
   * // -> "Nothing to update"
   */
  it(
    "should ask nothing when there is nothing to update",
    () => {
      const result = sous(projectRoot, "subscription", "update");

      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain("Nothing to update");
    },
    CLI_TIMEOUT
  );

  /**
   * The plural spelling of the topic reaches the same command.
   *
   * sous subscriptions update workflow
   */
  it(
    "should accept the plural spelling of the topic",
    () => {
      const result = sous(projectRoot, "subscriptions", "update", "workflow");

      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain("Nothing to update");
    },
    CLI_TIMEOUT
  );

  /**
   * A reference that names nothing trusted is an error naming the reference.
   *
   * sous subscription update no-such-thing
   */
  it(
    "should refuse a reference that names nothing",
    () => {
      const result = sous(projectRoot, "subscription", "update", "no-such-thing");

      expect(result.status).not.toBe(0);
      expect(result.output).toContain("no-such-thing");
    },
    CLI_TIMEOUT
  );

  /**
   * A newer version that no longer depends on something releases it, and the
   * dependency leaves the lockfile because nothing else holds it.
   *
   * sous subscription update workflow/alpha --yes --no-build
   * // -> alpha 1.2.0, support/base removed
   */
  it(
    "should drop a dependency the newer version no longer declares",
    async () => {
      await publishVersion(repo, {
        namespace: "workflow",
        name: "alpha",
        version: "1.2.0",
        depends: [],
      });

      const result = sous(
        projectRoot,
        "subscription",
        "update",
        "workflow/alpha",
        "--yes",
        "--no-build"
      );

      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain("Removing support/base, which nothing needs any more");
      expect(lockedVersions(projectRoot)).toEqual({
        "workflow/alpha": "1.2.0",
        "workflow/beta": "1.1.0",
      });
    },
    CLI_TIMEOUT
  );

  /**
   * A variable a newer version introduces is listed in the plan and asked
   * like a subscription asks it; an answer supplied ahead of time stores it.
   *
   * sous subscription update workflow/beta --yes --no-build --answer releaseChannel=stable
   * // -> beta 1.2.0, SOUS_VAR_RELEASE_CHANNEL stored
   */
  it(
    "should ask the questions a newer version introduces",
    async () => {
      await publishVersion(repo, {
        namespace: "workflow",
        name: "beta",
        version: "1.2.0",
        variables: [
          {
            name: "releaseChannel",
            type: "string",
            prompt: "Which release channel?",
            description: "The channel this project follows. It has no default.",
            example: "stable",
            required: true,
          },
        ],
      });

      const result = sous(
        projectRoot,
        "subscription",
        "update",
        "workflow/beta",
        "--yes",
        "--no-build",
        "--answer",
        "releaseChannel=stable"
      );

      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain("releaseChannel");
      expect(lockedVersions(projectRoot)["workflow/beta"]).toBe("1.2.0");
      const envFiles = [".env", ".env.local"]
        .map((name) => path.join(projectRoot, ".sous", name))
        .filter((file) => fs.existsSync(file))
        .map((file) => fs.readFileSync(file, "utf8"))
        .join("\n");
      expect(envFiles).toContain("stable");
    },
    CLI_TIMEOUT
  );

  /**
   * A newer version that needs a repository the project does not trust puts
   * that repository in the plan; with no terminal and no `--yes` nothing moves.
   *
   * sous subscription update workflow/alpha
   * // -> names vendor-recipes, "does not trust yet", exits non-zero
   */
  it(
    "should name a repository a newer version needs before trusting it",
    async () => {
      await publishVersion(repo, {
        namespace: "workflow",
        name: "alpha",
        version: "1.3.0",
        depends: ["github://sous-io/vendor-recipes/tooling/formatter"],
      });

      const result = sous(projectRoot, "subscription", "update", "workflow/alpha");

      expect(result.status).not.toBe(0);
      expect(result.output).toContain("vendor-recipes");
      expect(result.output).toContain("does not trust yet");
      expect(lockedVersions(projectRoot)["workflow/alpha"]).toBe("1.2.0");
    },
    CLI_TIMEOUT
  );

  /**
   * A repository whose index cannot be fetched is skipped and reported, and
   * the run carries on with the rest.
   *
   * sous subscription update --dry-run   (with a second, vanished repository)
   * // -> "could not be fetched"
   */
  it(
    "should skip and report a repository that cannot be reached",
    async () => {
      const vanishing = path.join(tmp.path, "vanishing");
      await buildFixtureRepo(vanishing, "vanishing", [
        { namespace: "extra", name: "gamma", version: "1.0.0", files: { "skills/gamma/SKILL.md": "# gamma\n" } },
      ]);
      sousOk(projectRoot, "repo", "add", vanishing, "--trust");
      fs.rmSync(vanishing, { recursive: true, force: true });

      const result = sous(projectRoot, "subscription", "update", "--dry-run");

      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain("could not be fetched");
      expect(result.output).toContain("vanishing");
    },
    CLI_TIMEOUT
  );
});

describe("sous repo unlink", () => {
  let repo: string;
  let projectRoot: string;
  let checkout: string;

  beforeAll(async () => {
    repo = path.join(tmp.path, "unlink-fixtures");
    projectRoot = path.join(tmp.path, "unlink-project");
    checkout = path.join(tmp.path, "my-checkout");

    await buildFixtureRepo(repo, "fixtures", [
      { namespace: "workflow", name: "alpha", version: "1.0.0", files: { "skills/alpha/SKILL.md": "# alpha\n" } },
      { namespace: "workflow", name: "beta", version: "1.0.0", files: { "skills/beta/SKILL.md": "# beta\n" } },
    ]);
    makeProject(projectRoot, repo);
    sousOk(projectRoot, "build");

    gitIn(tmp.path, "clone", "--quiet", repo, checkout);
    await publishVersion(repo, { namespace: "workflow", name: "alpha", version: "1.1.0" });
  }, CLI_TIMEOUT);

  /**
   * Plain unlink rebuilds, and reports the newer published version in range as
   * a fact without moving the pin.
   *
   * sous repo link fixtures <checkout>
   * sous repo unlink fixtures
   * // -> "1.1.0 is published", lock still 1.0.0, "Building the project"
   */
  it(
    "should rebuild and report newer published versions without moving anything",
    () => {
      sousOk(projectRoot, "repo", "link", "fixtures", checkout);

      const result = sous(projectRoot, "repo", "unlink", "fixtures");

      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain("1.0.0 pinned, 1.1.0 published");
      expect(result.output).toContain("Building the project");
      expect(lockedVersions(projectRoot)["workflow/alpha"]).toBe("1.0.0");
      expect(fs.existsSync(checkout)).toBe(true);
    },
    CLI_TIMEOUT
  );

  /**
   * A checkout linked by path was not created by sous, so `--remove` refuses
   * it and leaves the link in place.
   *
   * sous repo unlink fixtures --remove
   * // -> exits non-zero, "did not create"
   */
  it(
    "should refuse to delete a checkout that was linked by path",
    () => {
      sousOk(projectRoot, "repo", "link", "fixtures", checkout);

      const result = sous(projectRoot, "repo", "unlink", "fixtures", "--remove");

      expect(result.status).not.toBe(0);
      expect(result.output).toContain("did not create");
      expect(fs.existsSync(checkout)).toBe(true);
      const links = JSON.parse(
        fs.readFileSync(path.join(projectRoot, ".sous", "sous.links.json"), "utf8")
      ) as { links: Record<string, unknown> };
      expect(links.links["fixtures"]).toBeDefined();
    },
    CLI_TIMEOUT
  );

  /**
   * `--update` moves the repository's pins through the same code as
   * `sous subscription update <repository>`.
   *
   * sous repo unlink fixtures --update --yes --no-build
   * // -> alpha 1.1.0
   */
  it(
    "should move the pins with --update",
    () => {
      const result = sous(
        projectRoot,
        "repo",
        "unlink",
        "fixtures",
        "--update",
        "--yes",
        "--no-build"
      );

      expect(result.status, result.output).toBe(0);
      expect(lockedVersions(projectRoot)["workflow/alpha"]).toBe("1.1.0");
    },
    CLI_TIMEOUT
  );

  /**
   * A checkout sous cloned may be removed, but work that exists only in it is
   * listed and asked about first; with no terminal and no `--yes` the run
   * fails and deletes nothing. With `--yes` it is deleted.
   *
   * sous repo link fixtures --yes       (clones)
   * sous repo unlink fixtures --remove  (uncommitted work)
   * // -> exits non-zero, lists the file
   * sous repo unlink fixtures --remove --yes
   * // -> the checkout is gone
   */
  it(
    "should ask before deleting a cloned checkout that holds work",
    () => {
      const linked = sous(projectRoot, "repo", "link", "fixtures", "--yes");
      expect(linked.status, linked.output).toBe(0);
      const links = JSON.parse(
        fs.readFileSync(path.join(projectRoot, ".sous", "sous.links.json"), "utf8")
      ) as { links: Record<string, { path: string; origin: string }> };
      const cloned = links.links["fixtures"]!;
      expect(cloned.origin).toBe("clone");

      writeFixtureFile(path.join(cloned.path, "notes.md"), "Unsaved thoughts.\n");

      const refused = sous(projectRoot, "repo", "unlink", "fixtures", "--remove", "--no-build");
      expect(refused.status).not.toBe(0);
      expect(refused.output).toContain("notes.md");
      expect(refused.output).toContain("--yes");
      expect(fs.existsSync(cloned.path)).toBe(true);

      const removed = sous(
        projectRoot,
        "repo",
        "unlink",
        "fixtures",
        "--remove",
        "--yes",
        "--no-build"
      );
      expect(removed.status, removed.output).toBe(0);
      expect(fs.existsSync(cloned.path)).toBe(false);
    },
    CLI_TIMEOUT
  );
});
