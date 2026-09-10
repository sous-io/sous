import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import YAML from "yaml";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { parseIndexFile } from "../../lib/repos/formats/index-file.js";
import { parseRecipeManifest } from "../../lib/repos/formats/recipe-manifest.js";
import { parseRepoManifest } from "../../lib/repos/formats/repo-manifest.js";
import { parseLinksMap, type LinksMap } from "../../lib/repos/formats/links-map.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const binPath = path.join(repoRoot, "bin", "run.js");

/** Per-test timeout: each test boots the real CLI (tsx + oclif) in a subprocess. */
const CLI_TIMEOUT = 30_000;

type RunResult = { stdout: string; stderr: string; status: number | null };

/**
 * Runs `sous <args...>` through the real published bin, from `cwd`. Ambient
 * SOUS_* variables are stripped so a value in the runner's own environment can
 * never decide where the child writes; SOUS_HOME is then set per test, to a
 * temp directory, so no test touches the real `~/.sous`.
 */
function runSous(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): RunResult {
  const childEnv = { ...process.env, ...env };
  delete childEnv.SOUS_CONFIG;
  delete childEnv.SOUS_DIR;
  delete childEnv.SOUS_CONFD;
  const result = spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: "utf8",
    env: childEnv,
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

/** Runs a git command in `cwd`, failing loudly when it does not succeed. */
function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${result.stderr || result.stdout}`
    );
  }
}

/**
 * These tests exercise `sous repo init`, `sous repo link` and `sous repo unlink`
 * end to end through the real CLI. Everything they touch is inside a temp
 * directory: the project, the machine-wide sous home, and the repository that
 * gets cloned, which is a local bare repository created with `git init --bare`.
 * Nothing here reaches the network.
 */
describe("sous repo init / link / unlink", () => {
  let tmp: TmpDir;
  let root: string;
  let sourceRepo: string;
  let bareRepo: string;
  let bareRepoUrl: string;
  let projectRoot: string;
  let sousDir: string;
  let sousHome: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(() => {
    tmp = makeTmpDir("sous-repo-cmd-");
    root = tmp.path;
    sourceRepo = path.join(root, "source-repo");
    bareRepo = path.join(root, "origin.git");
    // A file:// URL, because the config schema's `url` field is a real URL and a
    // bare filesystem path is not one. git clones it exactly like any remote.
    bareRepoUrl = `file://${bareRepo}`;
    projectRoot = path.join(root, "project");
    sousDir = path.join(projectRoot, ".sous");
    sousHome = path.join(root, "sous-home");
    env = { SOUS_HOME: sousHome };

    fs.mkdirSync(sourceRepo, { recursive: true });
    fs.mkdirSync(sousDir, { recursive: true });

    // A repository to clone from, scaffolded by the command under test and then
    // pushed into a local bare repository. No network is involved.
    const init = runSous(root, env, "repo", "init", sourceRepo, "--name", "demo-recipes");
    if (init.status !== 0) {
      throw new Error(`repo init failed: ${init.stdout}${init.stderr}`);
    }

    git(sourceRepo, "init", "-q", "-b", "main");
    git(sourceRepo, "config", "user.email", "tests@example.com");
    git(sourceRepo, "config", "user.name", "Sous Tests");
    git(sourceRepo, "add", "-A");
    git(sourceRepo, "commit", "-qm", "the scaffold");
    git(root, "init", "-q", "--bare", "-b", "main", bareRepo);
    git(sourceRepo, "push", "-q", bareRepo, "main");

    // The project links the repository by the short name its config records.
    fs.writeFileSync(
      path.join(sousDir, "sous.config.json"),
      JSON.stringify(
        {
          name: "link-test-project",
          repos: { "demo-recipes": { url: bareRepoUrl } },
        },
        null,
        2
      ),
      "utf8"
    );
  });

  afterAll(() => {
    tmp.cleanup();
  });

  /** Reads the project's links map through the real parser. */
  function readProjectLinksMap(): LinksMap {
    const file = path.join(sousDir, "sous.links.json");
    return parseLinksMap(JSON.parse(fs.readFileSync(file, "utf8")), file);
  }

  /**
   * `sous repo init` should write a repository whose every file parses through
   * the schemas sous uses to read a published repository.
   *
   * sous repo init ./my-recipes
   * // -> sous.repo.yaml, sous.index.json, one recipe, a README, a workflow
   */
  it(
    "should scaffold a repository whose files all parse",
    () => {
      const manifestPath = path.join(sourceRepo, "sous.repo.yaml");
      const manifest = parseRepoManifest(
        YAML.parse(fs.readFileSync(manifestPath, "utf8")),
        manifestPath
      );
      expect(manifest.name).toBe("demo-recipes");
      expect(manifest.recipes).toHaveLength(1);

      const recipePath = path.join(sourceRepo, manifest.recipes[0]!, "sous.recipe.yaml");
      const recipe = parseRecipeManifest(
        YAML.parse(fs.readFileSync(recipePath, "utf8")),
        recipePath
      );
      expect(recipe.name).toBe("example");

      const indexPath = path.join(sourceRepo, "sous.index.json");
      parseIndexFile(JSON.parse(fs.readFileSync(indexPath, "utf8")), indexPath);

      expect(
        fs.existsSync(path.join(sourceRepo, ".github/workflows/sous-release.yml"))
      ).toBe(true);
      expect(fs.existsSync(path.join(sourceRepo, "README.md"))).toBe(true);
      expect(fs.existsSync(path.join(sourceRepo, ".gitignore"))).toBe(true);
    },
    CLI_TIMEOUT
  );

  /**
   * `sous repo init` should refuse to write over an existing repository, and
   * should say which flag would let it.
   */
  it(
    "should refuse to re-initialize an existing repository",
    () => {
      const result = runSous(root, env, "repo", "init", sourceRepo);
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("--force");
    },
    CLI_TIMEOUT
  );

  /**
   * `sous repo link <repo> <path>` should link a checkout that already exists,
   * recording it with the origin "path" and cloning nothing.
   */
  it(
    "should link an existing checkout by path",
    () => {
      const result = runSous(
        projectRoot,
        env,
        "repo",
        "link",
        "demo-recipes",
        sourceRepo
      );
      expect(result.status).toBe(0);

      const links = readProjectLinksMap();
      expect(links.links["demo-recipes"]).toMatchObject({
        path: sourceRepo,
        origin: "path",
      });

      // Nothing was cloned, so the repos directory holds only its ignore file.
      const reposDir = path.join(sousDir, "repos");
      expect(fs.readdirSync(reposDir)).toEqual([".gitignore"]);
      expect(fs.readFileSync(path.join(reposDir, ".gitignore"), "utf8")).toBe("*\n");
    },
    CLI_TIMEOUT
  );

  /**
   * Linking should maintain the managed block in `.sous/.gitignore`, covering
   * every machine-local file sous writes there.
   */
  it(
    "should maintain the managed block in .sous/.gitignore",
    () => {
      const gitignore = fs.readFileSync(path.join(sousDir, ".gitignore"), "utf8");
      expect(gitignore).toContain("# >>> sous managed");
      expect(gitignore).toContain("# <<< sous managed");
      expect(gitignore).toContain("sous.links.json");
      expect(gitignore).toContain("sous.state.json");
      expect(gitignore).toContain("sous.pid");
      expect(gitignore).toContain("repos/");
    },
    CLI_TIMEOUT
  );

  /**
   * `sous repo link <repo>` with no path should clone the repository into
   * `.sous/repos/<owner>/<name>` and record the link with the origin "clone".
   * The remote here is a local bare repository, so no network is involved.
   */
  it(
    "should clone the repository when no path is given",
    () => {
      const result = runSous(projectRoot, env, "repo", "link", "demo-recipes");
      expect(result.status).toBe(0);

      const links = readProjectLinksMap();
      const entry = links.links["demo-recipes"]!;
      expect(entry.origin).toBe("clone");
      expect(entry.path.startsWith(path.join(sousDir, "repos"))).toBe(true);
      expect(fs.existsSync(path.join(entry.path, "sous.repo.yaml"))).toBe(true);
    },
    CLI_TIMEOUT
  );

  /**
   * Running the same link twice should reuse the checkout rather than failing
   * or cloning a second time, so the command is safe to repeat.
   */
  it(
    "should reuse a checkout of the same repository on a second link",
    () => {
      const result = runSous(projectRoot, env, "repo", "link", "demo-recipes");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Reused the checkout");
    },
    CLI_TIMEOUT
  );

  /**
   * A path that is not a sous repository should be refused, naming the manifest
   * file that was expected, rather than being linked and failing later.
   */
  it(
    "should refuse a path that holds no repo manifest",
    () => {
      const notARepo = path.join(root, "not-a-repo");
      fs.mkdirSync(notARepo, { recursive: true });

      const result = runSous(projectRoot, env, "repo", "link", "demo-recipes", notARepo);
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("sous.repo.yaml");
    },
    CLI_TIMEOUT
  );

  /**
   * A short name that is neither configured nor a URL should be refused, and
   * the message should point at the command that adds a repository.
   */
  it(
    "should refuse a name that is neither configured nor a URL",
    () => {
      const result = runSous(projectRoot, env, "repo", "link", "unknown-repo");
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("sous repo add");
    },
    CLI_TIMEOUT
  );

  /**
   * `sous repo unlink` should remove the entry and leave the checkout on disk,
   * printing where it is.
   */
  it(
    "should unlink and leave the checkout in place",
    () => {
      const before = readProjectLinksMap().links["demo-recipes"]!;

      const result = runSous(projectRoot, env, "repo", "unlink", "demo-recipes");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(before.path);

      expect(readProjectLinksMap().links["demo-recipes"]).toBeUndefined();
      expect(fs.existsSync(before.path)).toBe(true);
    },
    CLI_TIMEOUT
  );

  /**
   * Unlinking something that is not linked should fail with a message naming
   * the command that would link it, rather than doing nothing quietly.
   */
  it(
    "should refuse to unlink a repository that is not linked",
    () => {
      const result = runSous(projectRoot, env, "repo", "unlink", "demo-recipes");
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("sous repo link demo-recipes");
    },
    CLI_TIMEOUT
  );

  /**
   * A global link should be recorded under SOUS_HOME rather than in the
   * project, so two projects on one machine can share a checkout.
   */
  it(
    "should record a global link under SOUS_HOME",
    () => {
      const result = runSous(
        projectRoot,
        env,
        "repo",
        "link",
        "demo-recipes",
        sourceRepo,
        "--global"
      );
      expect(result.status).toBe(0);

      const globalFile = path.join(sousHome, "sous.links.json");
      const links = parseLinksMap(
        JSON.parse(fs.readFileSync(globalFile, "utf8")),
        globalFile
      );
      expect(links.links["demo-recipes"]!.path).toBe(sourceRepo);

      // The project map stays empty; the link was recorded machine-wide.
      expect(readProjectLinksMap().links["demo-recipes"]).toBeUndefined();
    },
    CLI_TIMEOUT
  );

  /**
   * Unlinking without --global when the link is machine-wide should say where
   * the link actually is and which flag removes it; getting the scope wrong is
   * the easiest mistake to make here.
   */
  it(
    "should point at the other scope when the link is elsewhere",
    () => {
      const result = runSous(projectRoot, env, "repo", "unlink", "demo-recipes");
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("--global");
    },
    CLI_TIMEOUT
  );

  /**
   * A dry run should report what it would do and change nothing on disk.
   */
  it(
    "should change nothing on a dry run",
    () => {
      const result = runSous(
        projectRoot,
        env,
        "repo",
        "unlink",
        "demo-recipes",
        "--global",
        "--dry-run"
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Dry Run");

      const globalFile = path.join(sousHome, "sous.links.json");
      const links = parseLinksMap(
        JSON.parse(fs.readFileSync(globalFile, "utf8")),
        globalFile
      );
      expect(links.links["demo-recipes"]).toBeDefined();
    },
    CLI_TIMEOUT
  );
});
