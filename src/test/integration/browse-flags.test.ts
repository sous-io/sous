import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { buildFixtureRepo } from "../utils/fixture-repo.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const binPath = path.join(repoRoot, "bin", "run.js");

/** Per-test budget: every one of these boots the real CLI in a subprocess. */
const CLI_TIMEOUT = 90_000;

type RunResult = { stdout: string; stderr: string; status: number | null };

let tmp: TmpDir;
/** The local recipe repository the project trusts. */
let recipeRepo: string;
/** The project that subscribes to one of its recipes. */
let projectRoot: string;
let sousDir: string;
/** The machine-wide sous home, which holds the store and the index cache. */
let sousHome: string;

/**
 * Runs `sous <args...>` through the real published bin, from `cwd`, with the
 * store pointed at this test's temporary directory and the `SOUS_*` project
 * variables stripped, so nothing here can reach the developer's own store.
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
    input: "",
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

/** Everything a run printed, without the color codes that make matching brittle. */
function output(result: RunResult): string {
  // eslint-disable-next-line no-control-regex
  return `${result.stdout}${result.stderr}`.replace(/\u001B\[[0-9;]*m/g, "");
}

/** Writes a file, creating its parent directories. */
function write(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

/** Every file under the index cache, with its contents, so a test can prove nothing changed. */
function snapshotIndexCache(): Record<string, string> {
  const root = path.join(sousHome, "cache", "_indexes");
  const files: Record<string, string> = {};
  if (!fs.existsSync(root)) return files;
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    files[path.relative(root, full)] = fs.readFileSync(full, "utf8");
  }
  return files;
}

/** The version the project's lockfile pins for one recipe. */
function pinnedVersion(key: string): string | undefined {
  const lock = JSON.parse(fs.readFileSync(path.join(sousDir, "sous.lock.json"), "utf8")) as {
    recipes: Record<string, { version: string }>;
  };
  return lock.recipes[key]?.version;
}

/**
 * Publishes a newer version of `workflow/alpha` in the repository's working
 * tree index, which is what the `local` provider serves as upstream. Nothing
 * fetches the new version's files, so its hash is borrowed from the old one.
 */
function publishNewerAlpha(): void {
  const indexPath = path.join(recipeRepo, "sous.index.json");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8")) as {
    recipes: Record<string, { versions: Record<string, Record<string, unknown>> }>;
  };
  const alpha = index.recipes["workflow/alpha"]!;
  alpha.versions["1.1.0"] = { ...alpha.versions["1.0.0"]!, tag: "workflow/alpha@1.1.0" };
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf8");
}

/**
 * The browsing flags and the newer-version notice, end to end through the real
 * CLI: `--latest` reads upstream without writing to the cache, `--installed`
 * narrows every browsing command to what the lockfile pins, and a build states
 * a newer in-range version without moving the pin.
 *
 * Everything runs against a local fixture repository read through the `local`
 * provider, so nothing here touches the network.
 */
describe("the browsing flags and the newer-version notice", () => {
  beforeAll(async () => {
    tmp = makeTmpDir("sous-browse-flags-");
    sousHome = path.join(tmp.path, "sous-home");
    recipeRepo = path.join(tmp.path, "browse-recipes");
    projectRoot = path.join(tmp.path, "project");
    sousDir = path.join(projectRoot, ".sous");

    await buildFixtureRepo(recipeRepo, "browse-recipes", [
      {
        namespace: "workflow",
        name: "alpha",
        version: "1.0.0",
        description: "The recipe the project installs",
        files: { "skills/alpha/SKILL.md": "# Alpha\n" },
      },
      {
        namespace: "workflow",
        name: "beta",
        version: "1.0.0",
        description: "A sibling nothing installs",
        files: { "skills/beta/SKILL.md": "# Beta\n" },
      },
      {
        namespace: "tools",
        name: "gamma",
        version: "1.0.0",
        description: "A recipe in a namespace nothing installs from",
        files: { "skills/gamma/SKILL.md": "# Gamma\n" },
      },
    ]);

    write(
      path.join(sousDir, "sous.config.js"),
      [
        "// The project these tests browse from. The built-in repository is",
        "// switched off, so nothing here reaches the network.",
        "export const config = {",
        '  name: "browse",',
        '  _vars: { projectRoot: "${sousDir}/.." },',
        '  repos: { "sous-recipes": { enabled: false } },',
        "  compilation: {",
        "    targets: [",
        "      {",
        '        entryPoint: "${sousDir}/prompts/CLAUDE.md",',
        '        outputs: [{ destinationFile: "${projectRoot}/CLAUDE.md" }],',
        "      },",
        "    ],",
        "  },",
        "};",
        "",
      ].join("\n")
    );
    write(path.join(sousDir, "prompts", "CLAUDE.md"), "# browse\n");

    const added = sous(projectRoot, "repo", "add", recipeRepo, "--name", "browse", "--trust");
    if (added.status !== 0) throw new Error(`repo add failed: ${output(added)}`);

    const subscribed = sous(projectRoot, "subscription", "add", "workflow/alpha", "--yes");
    if (subscribed.status !== 0) throw new Error(`subscription add failed: ${output(subscribed)}`);

    // Upstream now publishes a newer version the cache has not seen.
    publishNewerAlpha();
  }, CLI_TIMEOUT);

  afterAll(() => {
    tmp.cleanup();
  });

  /**
   * By default a browsing command reads the cache, which still knows only
   * 1.0.0. With `--latest` it reads upstream and shows 1.1.0, and the cache is
   * left exactly as it was. `--remote` is the same flag.
   *
   * sous recipe list            // -> workflow/alpha latest 1.0.0
   * sous recipe list --latest   // -> workflow/alpha latest 1.1.0; cache unchanged
   */
  it(
    "should read upstream with --latest and never write to the cache",
    () => {
      const before = snapshotIndexCache();
      expect(Object.keys(before).length).toBeGreaterThan(0);

      const cached = output(sous(projectRoot, "recipe", "list"));
      expect(cached).toMatch(/workflow\/alpha\s+browse\s+1\.0\.0\s+1\.0\.0\s+yes/);
      expect(cached).toContain("the cached indexes");

      const latest = sous(projectRoot, "recipe", "list", "--latest");
      expect(latest.status).toBe(0);
      expect(output(latest)).toMatch(/workflow\/alpha\s+browse\s+1\.1\.0\s+1\.0\.0\s+yes/);
      expect(output(latest)).toContain("each repository, upstream");

      const remote = sous(projectRoot, "recipe", "list", "--remote");
      expect(output(remote)).toMatch(/workflow\/alpha\s+browse\s+1\.1\.0\s+1\.0\.0/);

      expect(snapshotIndexCache()).toEqual(before);
    },
    CLI_TIMEOUT
  );

  /**
   * `--installed` narrows the recipe listing to what the lockfile pins, and the
   * pinned column is headed as the installed version.
   *
   * sous recipe list --installed   // -> workflow/alpha only
   */
  it(
    "should narrow recipe list to what is installed",
    () => {
      const text = output(sous(projectRoot, "recipe", "list", "--installed"));

      expect(text).toContain("Recipes this project has installed");
      expect(text).toContain("Installed");
      expect(text).toContain("workflow/alpha");
      expect(text).not.toContain("workflow/beta");
      expect(text).not.toContain("tools/gamma");
    },
    CLI_TIMEOUT
  );

  /**
   * The namespace commands narrow the same way: a namespace nothing is
   * installed from is left out of the listing, and showing it with
   * `--installed` is an error saying why.
   *
   * sous namespace list --installed          // -> workflow, 1 installed
   * sous namespace show tools --installed    // -> exits non-zero
   */
  it(
    "should narrow the namespace commands to what is installed",
    () => {
      const list = output(sous(projectRoot, "namespace", "list", "--installed"));
      expect(list).toMatch(/workflow\s+browse\s+1\s+some recipes/);
      expect(list).not.toMatch(/^\s+tools\s/m);

      const show = sous(projectRoot, "namespace", "show", "workflow", "--installed");
      expect(show.status).toBe(0);
      expect(output(show)).toContain("workflow/alpha");
      expect(output(show)).not.toContain("workflow/beta");

      const refused = sous(projectRoot, "namespace", "show", "tools", "--installed");
      expect(refused.status).not.toBe(0);
      expect(output(refused)).toContain("installed no recipe from the namespace 'tools'");
    },
    CLI_TIMEOUT
  );

  /**
   * The flags combine: one installed recipe, with upstream's newest version
   * beside the installed one.
   *
   * sous recipe show alpha --installed --latest
   */
  it(
    "should show an installed recipe against upstream's latest version",
    () => {
      const result = sous(projectRoot, "recipe", "show", "alpha", "--installed", "--latest");
      const text = output(result);

      expect(result.status).toBe(0);
      expect(text).toMatch(/Latest version\s*:\s*1\.1\.0/);
      expect(text).toMatch(/Installed version\s*:\s*1\.0\.0/);

      const refused = sous(projectRoot, "recipe", "show", "beta", "--installed");
      expect(refused.status).not.toBe(0);
      expect(output(refused)).toContain("has not installed the recipe 'beta'");
    },
    CLI_TIMEOUT
  );

  /**
   * `sous subscription list` carries a latest column, read from the cache by
   * default and from upstream with `--latest`.
   *
   * sous subscription list --latest   // -> workflow/alpha 1.1.0 beside 1.0.0
   */
  it(
    "should show the latest version beside each subscription's pin",
    () => {
      const cached = output(sous(projectRoot, "subscription", "list"));
      expect(cached).toMatch(/workflow\/alpha 1\.0\.0\s+1\.0\.0\s/);

      const latest = output(sous(projectRoot, "subscription", "list", "--installed", "--latest"));
      expect(latest).toContain("Installed version");
      expect(latest).toMatch(/workflow\/alpha 1\.0\.0\s+1\.1\.0\s/);
    },
    CLI_TIMEOUT
  );

  /**
   * `sous repo list --installed` keeps the repositories something is installed
   * from and names the installed recipes under each row; `sous repo search
   * --installed` searches only installed recipes and shows the installed
   * version.
   */
  it(
    "should narrow repo list and repo search to what is installed",
    () => {
      const list = output(sous(projectRoot, "repo", "list", "--installed"));
      expect(list).toContain("Installed: workflow/alpha 1.0.0");

      const search = output(sous(projectRoot, "repo", "search", "a", "--installed", "--latest"));
      expect(search).toContain("workflow/alpha");
      expect(search).not.toContain("workflow/beta");
      expect(search).toContain("1.0.0, 1.1.0");
    },
    CLI_TIMEOUT
  );

  /**
   * A repository upstream cannot answer for is shown from the cache and named
   * as not checked, and the command still succeeds.
   *
   * sous recipe list --latest   // with the repository moved away
   */
  it(
    "should show an unreachable repository from the cache, marked not checked",
    () => {
      const moved = `${recipeRepo}-away`;
      fs.renameSync(recipeRepo, moved);
      try {
        const result = sous(projectRoot, "recipe", "list", "--latest");
        const text = output(result);

        expect(result.status).toBe(0);
        expect(text).toMatch(/workflow\/alpha\s+browse\s+1\.0\.0/);
        expect(text).toContain("could not be reached");
        expect(text).toMatch(/not checked:\s+browse/);
      } finally {
        fs.renameSync(moved, recipeRepo);
      }
    },
    CLI_TIMEOUT
  );

  /**
   * A build whose freshness window has lapsed looks upstream, states the newer
   * in-range version as a fact, and leaves the pin where it was.
   *
   * sous build   // -> "Newer versions published: workflow/alpha 1.1.0"
   */
  it(
    "should state a newer in-range version during a build without moving the pin",
    () => {
      write(
        path.join(sousDir, "conf.d", "300-freshness.json"),
        JSON.stringify({ store: { freshnessSeconds: 0 } }, null, 2)
      );

      const result = sous(projectRoot, "build");
      const text = output(result);

      expect(result.status, text).toBe(0);
      expect(text).toContain("Newer versions published");
      expect(text).toMatch(/workflow\/alpha\s*:\s*1\.1\.0 this project pins 1\.0\.0/);
      expect(text).toContain("No pin was changed");
      expect(pinnedVersion("workflow/alpha")).toBe("1.0.0");
    },
    CLI_TIMEOUT
  );

  /**
   * A build whose look upstream fails says nothing about the failure and still
   * succeeds; the cached index, which the previous build refreshed, still
   * answers for the newer version.
   *
   * sous build   // with the repository moved away
   */
  it(
    "should build quietly from the cache when the upstream check fails",
    () => {
      const moved = `${recipeRepo}-away`;
      fs.renameSync(recipeRepo, moved);
      try {
        const result = sous(projectRoot, "build");
        const text = output(result);

        expect(result.status, text).toBe(0);
        expect(text).not.toContain("could not check");
        expect(text).toMatch(/workflow\/alpha\s*:\s*1\.1\.0 this project pins 1\.0\.0/);
        expect(pinnedVersion("workflow/alpha")).toBe("1.0.0");
      } finally {
        fs.renameSync(moved, recipeRepo);
      }
    },
    CLI_TIMEOUT
  );

  /**
   * A recipe from a linked repository is marked linked wherever its pin is
   * shown, with a note saying builds read it from the checkout.
   *
   * sous repo link browse <path>; sous recipe list --installed
   */
  it(
    "should mark an installed recipe from a linked repository",
    () => {
      const linked = sous(projectRoot, "repo", "link", "browse", recipeRepo, "--yes");
      expect(linked.status, output(linked)).toBe(0);

      const text = output(sous(projectRoot, "recipe", "list", "--installed"));
      expect(text).toMatch(/workflow\/alpha\s+browse\s+\S+\s+1\.0\.0 linked/);
      expect(text).toContain("builds currently read it");

      const show = output(sous(projectRoot, "recipe", "show", "workflow/alpha"));
      expect(show).toContain("builds currently read this recipe from the checkout at");
    },
    CLI_TIMEOUT
  );
});
