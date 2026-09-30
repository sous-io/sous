/**
 * One build, everywhere: every command that builds prepares the project's
 * recipes first (gh-125), a project template may include from anything the
 * lockfile pins (gh-126), and any compile error fails the build while the last
 * good output stays in place (gh-127).
 *
 * Everything runs through the real CLI against local fixture repositories read
 * through the `local` provider, with `SOUS_HOME` inside the test's temporary
 * directory and a `fetch` that throws, so nothing here reaches the network or
 * the user's home directory.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { buildFixtureRepo, gitIn, writeFixtureFile } from "../utils/fixture-repo.js";
import { hashDirectory } from "../../lib/repos/store/hash.js";
import { repoIdentity } from "../../lib/repos/identity.js";
import { requireProvider } from "../../lib/repos/providers/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const binPath = path.join(repoRoot, "bin", "run.js");

/** Per-test budget: each one boots the real CLI, some of them several times. */
const CLI_TIMEOUT = 120_000;

type RunResult = { status: number | null; output: string };

let tmp: TmpDir;
let sousHome: string;
let offlineHook: string;
let fixturesRepo: string;
let extrasRepo: string;
let projectRoot: string;

/**
 * Runs `sous <args...>` through the real published bin, from `cwd`, with the
 * store in the test's temporary directory, no terminal and no network.
 */
function sous(cwd: string, ...args: string[]): RunResult {
  const env = {
    ...process.env,
    SOUS_HOME: sousHome,
    GITHUB_TOKEN: "offline-test-token",
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
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** Runs `sous <args...>` and fails the test, showing its output, unless it succeeded. */
function sousOk(cwd: string, ...args: string[]): RunResult {
  const result = sous(cwd, ...args);
  expect(result.status, result.output).toBe(0);
  return result;
}

/** Where the store keeps one version of one recipe from a local repository. */
function storeEntry(repo: string, key: string, version: string): string {
  const identity = repoIdentity(requireProvider(repo).canonicalize(repo));
  return path.join(sousHome, "cache", ...identity.split("/"), ...key.split("/"), version);
}

/** The versions the project's lockfile pins, keyed by recipe. */
function lockedVersions(root: string): Record<string, string> {
  const lock = JSON.parse(
    fs.readFileSync(path.join(root, ".sous", "sous.lock.json"), "utf8")
  ) as { recipes: Record<string, { version: string }> };
  return Object.fromEntries(
    Object.entries(lock.recipes).map(([key, entry]) => [key, entry.version])
  );
}

/**
 * Publishes a new version of a recipe into a fixture repository the way a
 * release would: the manifest changes, the index gains the version with the
 * folder's real hash and the dependencies it was released against, and the
 * commit is tagged.
 */
async function publishVersion(
  repo: string,
  key: string,
  version: string,
  change: { subscribes?: string[]; dependencies?: Record<string, { version: string }> } = {}
): Promise<void> {
  const recipeDir = path.join(repo, "recipes", key);
  const manifestPath = path.join(recipeDir, "sous.recipe.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  manifest["version"] = version;
  if (change.subscribes !== undefined) manifest["subscribes"] = change.subscribes;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const indexPath = path.join(repo, "sous.index.json");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8")) as {
    recipes: Record<string, { versions: Record<string, unknown> }>;
  };
  index.recipes[key]!.versions[version] = {
    hash: await hashDirectory(recipeDir),
    tag: `${key}@${version}`,
    prerelease: false,
    releasedAt: "2026-02-01T00:00:00.000Z",
    ...(change.dependencies === undefined ? {} : { dependencies: change.dependencies }),
  };
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));

  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "--quiet", "-m", `Release ${key}@${version}`);
  gitIn(repo, "tag", `${key}@${version}`);
}

/** The compiled skill a recipe contributes, in the project's skills directory. */
function skillOf(root: string, name: string): string {
  return path.join(root, ".claude", "skills", name, "SKILL.md");
}

beforeAll(async () => {
  tmp = makeTmpDir("sous-whole-build-");
  sousHome = path.join(tmp.path, "sous-home");
  fixturesRepo = path.join(tmp.path, "fixtures");
  extrasRepo = path.join(tmp.path, "extras");
  projectRoot = path.join(tmp.path, "project");

  offlineHook = writeFixtureFile(
    path.join(tmp.path, "offline.mjs"),
    [
      "globalThis.fetch = async (url) => {",
      "  throw new Error(`offline: this test machine cannot reach ${url}`);",
      "};",
      "",
    ].join("\n")
  );

  // A set (omakase/house) with no files of its own, a member it subscribes
  // the project to, a library only the member depends on, and one ordinary
  // recipe the project subscribes to directly.
  await buildFixtureRepo(fixturesRepo, "fixtures", [
    {
      namespace: "workflow",
      name: "alpha",
      version: "1.0.0",
      files: { "skills/alpha/SKILL.md": "# alpha\n" },
    },
    {
      namespace: "support",
      name: "lib",
      version: "1.0.0",
      files: { "partials/lib.md": "LIB PARTIAL\n" },
      contents: [],
    },
    {
      namespace: "workflow",
      name: "member",
      version: "1.0.0",
      depends: ["support/lib"],
      dependencies: { "support/lib": { version: "1.0.0" } },
      files: {
        "skills/member/SKILL.md": "# member\n",
        "memories/member.md": "MEMBER MEMORY\n",
      },
    },
    {
      namespace: "omakase",
      name: "house",
      version: "1.0.0",
      subscribes: ["workflow/member"],
      dependencies: { "workflow/member": { version: "1.0.0" } },
      files: { "README.md": "The house set.\n" },
      contents: [],
    },
  ]);
  await buildFixtureRepo(extrasRepo, "extras", [
    {
      namespace: "extras",
      name: "thing",
      version: "1.0.0",
      files: { "skills/thing/SKILL.md": "# thing\n" },
    },
  ]);

  writeFixtureFile(
    path.join(projectRoot, ".sous", "sous.config.js"),
    [
      "export const config = {",
      '  name: "Whole Build Project",',
      '  repos: { "sous-recipes": { enabled: false } },',
      "  _vars: { projectRoot: \"${sousDir}/..\" },",
      "  compilation: {",
      "    targets: [",
      "      {",
      '        entryPoint: "${sousDir}/prompts/AGENTS.md",',
      '        outputs: [{ destinationFile: "${projectRoot}/AGENTS.md" }],',
      "      },",
      "    ],",
      "  },",
      "  tools: {",
      `    noop: { command: ${JSON.stringify(process.execPath)}, args: ["-e", ""] },`,
      "  },",
      "};",
      "",
    ].join("\n")
  );
  // The member arrives through the set's `subscribes`, and the library only
  // through the member's `depends`: the project subscribes to neither.
  writeFixtureFile(
    path.join(projectRoot, ".sous", "prompts", "AGENTS.md"),
    "# Project\n\n@~workflow/member/memories/member.md\n\n@~support/lib/partials/lib.md\n"
  );

  sousOk(projectRoot, "repo", "add", fixturesRepo, "--name", "fixtures", "--trust");
  sousOk(projectRoot, "repo", "add", extrasRepo, "--name", "extras", "--trust");
  sousOk(projectRoot, "subscription", "add", "omakase/house", "--yes", "--no-build");
  sousOk(projectRoot, "subscription", "add", "workflow/alpha", "--yes", "--no-build");
  sousOk(projectRoot, "subscription", "add", "extras/thing", "--yes", "--no-build");
}, CLI_TIMEOUT);

afterAll(() => {
  tmp.cleanup();
});

describe("a project template includes from any recipe the lockfile pins", () => {
  /**
   * A set's member (held through `subscribes`) and a library held only through
   * the member's `depends` are both addressable from the project's own
   * template, and the build succeeds.
   *
   * sous build
   * // -> exit 0; AGENTS.md holds "MEMBER MEMORY" and "LIB PARTIAL"
   */
  it(
    "should build a template that includes from a set member and a depends-only library",
    () => {
      const result = sousOk(projectRoot, "build");

      expect(result.output).not.toContain("Error:");
      const agents = fs.readFileSync(path.join(projectRoot, "AGENTS.md"), "utf8");
      expect(agents).toContain("MEMBER MEMORY");
      expect(agents).toContain("LIB PARTIAL");
    },
    CLI_TIMEOUT
  );
});

describe("every command that builds prepares the project first", () => {
  const alpha = () => storeEntry(fixturesRepo, "workflow/alpha", "1.0.0");

  /**
   * Removes workflow/alpha from the store and the compiled skill, runs the
   * command, and checks that the build restored the recipe before compiling:
   * the store holds it again, the output said so, and its skill is compiled.
   */
  function expectRestored(run: () => RunResult): RunResult {
    fs.rmSync(alpha(), { recursive: true, force: true });
    fs.rmSync(path.dirname(skillOf(projectRoot, "alpha")), { recursive: true, force: true });

    const result = run();

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("Restoring recipes");
    expect(result.output).toContain("restored: workflow/alpha");
    expect(fs.existsSync(alpha())).toBe(true);
    expect(fs.existsSync(skillOf(projectRoot, "alpha")), result.output).toBe(true);
    return result;
  }

  /** sous build */
  it("should restore a missing recipe in sous build", () => {
    expectRestored(() => sous(projectRoot, "build"));
  }, CLI_TIMEOUT);

  /** sous launch noop */
  it("should restore a missing recipe in sous launch", () => {
    expectRestored(() => sous(projectRoot, "launch", "noop"));
  }, CLI_TIMEOUT);

  /**
   * sous prune compiles nothing, so the skill is not written back; what it
   * proves is that the recipe is restored and its compiled files are NOT
   * pruned as if the recipe were gone.
   */
  it("should restore a missing recipe in sous prune, and prune none of its files", () => {
    fs.rmSync(alpha(), { recursive: true, force: true });

    const result = sous(projectRoot, "prune");

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("restored: workflow/alpha");
    expect(fs.existsSync(alpha())).toBe(true);
    expect(fs.existsSync(skillOf(projectRoot, "alpha"))).toBe(true);
    expect(result.output).not.toContain("pruned:");
  }, CLI_TIMEOUT);

  /** sous subscription remove extras/thing */
  it("should restore a missing recipe in sous subscription remove", () => {
    expectRestored(() => sous(projectRoot, "subscription", "remove", "extras/thing"));
    expect(fs.existsSync(skillOf(projectRoot, "thing"))).toBe(false);
  }, CLI_TIMEOUT);

  /** sous subscription add extras/thing --yes */
  it("should restore a missing recipe in sous subscription add", () => {
    expectRestored(() => sous(projectRoot, "subscription", "add", "extras/thing", "--yes"));
    expect(fs.existsSync(skillOf(projectRoot, "thing"))).toBe(true);
  }, CLI_TIMEOUT);

  /** sous repo unlink extras, after linking it to its own checkout */
  it("should restore a missing recipe in sous repo unlink", () => {
    sousOk(projectRoot, "repo", "link", "extras", extrasRepo, "--yes");
    expectRestored(() => sous(projectRoot, "repo", "unlink", "extras"));
  }, CLI_TIMEOUT);

  /** sous subscription update extras/thing --yes, once a newer version is published */
  it("should restore a missing recipe in sous subscription update", async () => {
    await publishVersion(extrasRepo, "extras/thing", "1.1.0");
    expectRestored(() => sous(projectRoot, "subscription", "update", "extras/thing", "--yes"));
    expect(lockedVersions(projectRoot)["extras/thing"]).toBe("1.1.0");
  }, CLI_TIMEOUT);

  /** sous repo remove extras --yes */
  it("should restore a missing recipe in sous repo remove", () => {
    expectRestored(() => sous(projectRoot, "repo", "remove", "extras", "--yes"));
    expect(lockedVersions(projectRoot)["extras/thing"]).toBeUndefined();
  }, CLI_TIMEOUT);

  /**
   * sous init, in a directory whose `.sous/` already holds a lockfile pinning a
   * recipe the store does not have and the layer trusting its repository: the
   * first build restores it.
   */
  it("should restore a missing recipe in sous init", () => {
    const initRoot = path.join(tmp.path, "init-project");
    const lock = {
      formatVersion: 1,
      repos: JSON.parse(
        fs.readFileSync(path.join(projectRoot, ".sous", "sous.lock.json"), "utf8")
      ).repos,
      recipes: {
        "workflow/alpha": JSON.parse(
          fs.readFileSync(path.join(projectRoot, ".sous", "sous.lock.json"), "utf8")
        ).recipes["workflow/alpha"],
      },
    };
    writeFixtureFile(
      path.join(initRoot, ".sous", "sous.lock.json"),
      `${JSON.stringify(lock, null, 2)}\n`
    );
    fs.cpSync(
      path.join(projectRoot, ".sous", "conf.d", "500-repos.jsonc"),
      path.join(initRoot, ".sous", "conf.d", "500-repos.jsonc")
    );
    fs.rmSync(alpha(), { recursive: true, force: true });

    const result = sous(initRoot, "init", "--yes");

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("restored: workflow/alpha");
    expect(fs.existsSync(alpha())).toBe(true);
    expect(fs.existsSync(skillOf(initRoot, "alpha")), result.output).toBe(true);
  }, CLI_TIMEOUT);
});

describe("a compile error fails the build", () => {
  let brokenRoot: string;

  beforeAll(() => {
    brokenRoot = path.join(tmp.path, "broken-project");
    writeFixtureFile(
      path.join(brokenRoot, ".sous", "sous.config.js"),
      [
        "export const config = {",
        '  repos: { "sous-recipes": { enabled: false } },',
        "  _vars: { projectRoot: \"${sousDir}/..\" },",
        "  compilation: {",
        "    targets: [",
        '      { entryPoint: "${sousDir}/prompts/AGENTS.md", outputs: [{ destinationFile: "${projectRoot}/AGENTS.md" }] },',
        '      { entryPoint: "${sousDir}/prompts/OTHER.md", outputs: [{ destinationFile: "${projectRoot}/OTHER.md" }] },',
        "    ],",
        "  },",
        "};",
        "",
      ].join("\n")
    );
    writeFixtureFile(path.join(brokenRoot, ".sous", "prompts", "AGENTS.md"), "first build\n");
    writeFixtureFile(path.join(brokenRoot, ".sous", "prompts", "OTHER.md"), "other one\n");
  });

  /**
   * The gh-127 reproduction: a clean build, then an include of a missing
   * file. The build still compiles the other target, names the error, exits
   * 1, and AGENTS.md keeps the contents of the last good build.
   *
   * sous build  (AGENTS.md: "Before\n@missing.md\nAfter")
   * // -> exit 1; AGENTS.md still "first build"; OTHER.md updated
   */
  it("should exit non-zero and keep the last good output", () => {
    sousOk(brokenRoot, "build");
    expect(fs.readFileSync(path.join(brokenRoot, "AGENTS.md"), "utf8")).toBe("first build\n");

    writeFixtureFile(
      path.join(brokenRoot, ".sous", "prompts", "AGENTS.md"),
      "Before\n@missing.md\nAfter\n"
    );
    writeFixtureFile(path.join(brokenRoot, ".sous", "prompts", "OTHER.md"), "other two\n");

    const result = sous(brokenRoot, "build");

    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("Include not found: @missing.md");
    expect(result.output).toContain("Done with 1 error(s).");
    expect(fs.readFileSync(path.join(brokenRoot, "AGENTS.md"), "utf8")).toBe("first build\n");
    expect(fs.readFileSync(path.join(brokenRoot, "OTHER.md"), "utf8")).toBe("other two\n");
  }, CLI_TIMEOUT);

  /**
   * `sous compile` fails the same way, without `--strict`.
   *
   * sous compile
   * // -> exit 1
   */
  it("should exit non-zero from sous compile too", () => {
    const result = sous(brokenRoot, "compile");

    expect(result.status, result.output).toBe(1);
    expect(fs.readFileSync(path.join(brokenRoot, "AGENTS.md"), "utf8")).toBe("first build\n");
  }, CLI_TIMEOUT);

  /**
   * `sous launch` does not start the tool after a failed build, and exits 1.
   *
   * sous launch noop
   * // -> exit 1, "The build failed, so noop was not started."
   */
  it("should refuse to launch after a failed build", () => {
    fs.appendFileSync(
      path.join(brokenRoot, ".sous", "sous.config.js"),
      `config.tools = { noop: { command: ${JSON.stringify(process.execPath)}, args: ["-e", ""] } };\n`
    );

    const result = sous(brokenRoot, "launch", "noop");

    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("The build failed, so noop was not started.");
  }, CLI_TIMEOUT);
});

describe("an include of a recipe the lockfile no longer pins", () => {
  /**
   * A later version of the set drops its member. Updating to it drops the
   * member and its library from the lockfile, the rebuild fails on the
   * template's includes, and the errors name the set version that brought
   * each one in.
   *
   * sous subscription update omakase/house --yes
   * // -> exit 1; 'Version 1.0.0 of "omakase/house" brought "workflow/member" in'
   */
  it("should name the recipe that used to bring it in", async () => {
    await publishVersion(fixturesRepo, "omakase/house", "1.1.0", {
      subscribes: [],
      dependencies: {},
    });

    const result = sous(projectRoot, "subscription", "update", "omakase/house", "--yes");

    expect(result.status, result.output).toBe(1);
    expect(lockedVersions(projectRoot)["workflow/member"]).toBeUndefined();
    const output = result.output.replace(/\s+/g, " ");
    expect(output).toContain(
      'Version 1.0.0 of "omakase/house" brought "workflow/member" in, but the version this ' +
        "project pins, 1.1.0, does not, so the lockfile no longer pins it."
    );
    expect(output).toContain(
      'Version 1.0.0 of "omakase/house" brought "support/lib" in (through "workflow/member")'
    );
    // The last good AGENTS.md stays.
    expect(fs.readFileSync(path.join(projectRoot, "AGENTS.md"), "utf8")).toContain(
      "MEMBER MEMORY"
    );
  }, CLI_TIMEOUT);
});
