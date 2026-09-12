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
import {
  readManagedLayer,
  REPOS_LAYER_FILENAME,
  SUBSCRIPTIONS_LAYER_FILENAME,
} from "../../lib/repos/managed-layer.js";
import { buildFixtureRepo } from "../utils/fixture-repo.js";

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
  let localRepo: string;
  let untrustedRepo: string;
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
    // Two more repositories on disk, neither of them in the project's config:
    // one for the in-place link, one for the trust gate that guards it.
    localRepo = path.join(root, "local-recipes");
    untrustedRepo = path.join(root, "untrusted-recipes");
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

    for (const [directory, name] of [
      [localRepo, "local-recipes"],
      [untrustedRepo, "untrusted-recipes"],
    ] as const) {
      const scaffold = runSous(root, env, "repo", "init", directory, "--name", name);
      if (scaffold.status !== 0) {
        throw new Error(`repo init failed: ${scaffold.stdout}${scaffold.stderr}`);
      }
    }

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

      // Nothing was cloned, so the repos directory holds only its ignore file
      // and the three files every sous-created directory explains itself with.
      const reposDir = path.join(sousDir, "repos");
      expect(fs.readdirSync(reposDir).sort()).toEqual([
        ".gitignore",
        "AGENTS.md",
        "CLAUDE.md",
        "README.md",
      ]);
      expect(fs.readFileSync(path.join(reposDir, ".gitignore"), "utf8")).toBe("*\n");
      expect(fs.readFileSync(path.join(reposDir, "README.md"), "utf8")).toContain(
        "linked repository checkouts"
      );
      expect(fs.readFileSync(path.join(reposDir, "AGENTS.md"), "utf8")).toContain(
        "README.md"
      );
      expect(fs.readFileSync(path.join(reposDir, "CLAUDE.md"), "utf8")).toContain(
        "README.md"
      );
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
   * A linked repository's recipes are read straight from a checkout, with no
   * version, no lockfile and no hash check. Linking a repository the project
   * never added would therefore read an untrusted repository, which is the one
   * thing adding a repository exists to gate. With no terminal to ask on and no
   * confirmation flag it must be refused, nothing may be linked, and the message
   * must not offer a way around the gate.
   *
   * sous repo link /path/to/some-repo   // -> exits non-zero, names 'sous repo add'
   */
  it(
    "should refuse to link a repository this project has not trusted",
    () => {
      const result = runSous(projectRoot, env, "repo", "link", untrustedRepo);

      expect(result.status).not.toBe(0);
      const output = result.stdout + result.stderr;
      expect(output).toContain("sous repo add");
      expect(output).not.toContain("without adding it");
      expect(readProjectLinksMap().links["untrusted-recipes"]).toBeUndefined();
    },
    CLI_TIMEOUT
  );

  /**
   * `sous repo link <path>` with nothing else means "link the checkout that is
   * already here". The repository is added and trusted first, because linking
   * one is at least as consequential as adding one, and then the checkout is
   * linked exactly where it is: the short name comes from its own manifest, the
   * link records the absolute path with the origin "path", and nothing is
   * cloned into `.sous/repos`.
   *
   * sous repo link ../local-recipes --trust   // -> links /tmp/.../local-recipes
   */
  it(
    "should link a local checkout in place, without cloning it",
    () => {
      const reposDir = path.join(sousDir, "repos");
      const before = fs.readdirSync(reposDir).sort();

      const result = runSous(
        projectRoot,
        env,
        "repo",
        "link",
        "../local-recipes",
        "--trust"
      );
      expect(result.status).toBe(0);

      // The short name is the one the checkout's own manifest suggests, not the
      // slug a clone would have been filed under.
      expect(readProjectLinksMap().links["local-recipes"]).toMatchObject({
        path: localRepo,
        origin: "path",
      });

      // Nothing was cloned: the repository entry points at the checkout, and the
      // directory clones land in is exactly as it was.
      const layer = readManagedLayer(sousDir, REPOS_LAYER_FILENAME) as {
        repos?: Record<string, { url: string }>;
      };
      expect(layer.repos?.["local-recipes"]?.url).toBe(localRepo);
      expect(fs.readdirSync(reposDir).sort()).toEqual(before);
    },
    CLI_TIMEOUT
  );

  /**
   * A path in both slots contradicts itself: the first already says which
   * checkout to link. The message should name the two written forms rather than
   * picking one of them.
   *
   * sous repo link ../local-recipes ../local-recipes   // -> exits non-zero
   */
  it(
    "should refuse a path in both argument slots",
    () => {
      const result = runSous(
        projectRoot,
        env,
        "repo",
        "link",
        "../local-recipes",
        localRepo
      );
      expect(result.status).not.toBe(0);

      const output = result.stdout + result.stderr;
      expect(output).toContain("sous repo link ../local-recipes");
      expect(output).toContain("sous repo link <name-or-url>");
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

/**
 * `sous repo add` with a repository on this machine. A path is what people
 * actually type, and they type it relative to where they are standing, so the
 * relative form has to work; what gets stored is the absolute form, because a
 * repository on this machine is machine-specific either way.
 *
 * Everything here stays inside a temp directory and no network is involved:
 * the repository is scaffolded by `sous repo init` and read straight off disk.
 */
describe("sous repo add with a local path", () => {
  let tmp: TmpDir;
  let root: string;
  let recipesRepo: string;
  let projectRoot: string;
  let sousDir: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(() => {
    tmp = makeTmpDir("sous-repo-add-local-");
    root = fs.realpathSync(tmp.path);
    recipesRepo = path.join(root, "my-recipes");
    projectRoot = path.join(root, "project");
    sousDir = path.join(projectRoot, ".sous");
    env = { SOUS_HOME: path.join(root, "sous-home") };

    fs.mkdirSync(sousDir, { recursive: true });
    fs.writeFileSync(
      path.join(sousDir, "sous.config.json"),
      JSON.stringify({ name: "local-path-project" }, null, 2),
      "utf8"
    );

    const init = runSous(root, env, "repo", "init", recipesRepo, "--name", "my-recipes");
    if (init.status !== 0) {
      throw new Error(`repo init failed: ${init.stdout}${init.stderr}`);
    }
  });

  afterAll(() => {
    tmp.cleanup();
  });

  /**
   * Reads the managed repositories layer sous writes when a repository is
   * added. The layer is JSON with comments, so it is read through the same
   * reader the CLI uses rather than through `JSON.parse`.
   */
  function readReposLayer(): Record<string, { url: string; provider?: string }> {
    const layer = readManagedLayer(sousDir, REPOS_LAYER_FILENAME) as {
      repos?: Record<string, { url: string; provider?: string }>;
    };
    return layer.repos ?? {};
  }

  /**
   * A relative path should be accepted and stored absolute, so the entry means
   * the same thing from any working directory the project is built from.
   *
   * sous repo add ../my-recipes --trust   // -> url: "/tmp/.../my-recipes"
   */
  it(
    "should accept a relative path and store the absolute one",
    () => {
      const result = runSous(projectRoot, env, "repo", "add", "../my-recipes", "--trust");
      expect(result.stdout + result.stderr).toContain("my-recipes");
      expect(result.status).toBe(0);

      const repos = readReposLayer();
      expect(repos["my-recipes"]?.url).toBe(recipesRepo);
    },
    CLI_TIMEOUT
  );

  /**
   * A path that is not there is a path mistake, so the message should name the
   * path as typed, the absolute path sous tried, and what it expected to find.
   * Suggesting a provider would send the reader somewhere irrelevant.
   *
   * sous repo add ../not-there   // -> exits non-zero, no mention of --provider
   */
  it(
    "should explain a path that is not there without mentioning providers",
    () => {
      const result = runSous(projectRoot, env, "repo", "add", "../not-there", "--trust");
      expect(result.status).not.toBe(0);

      const output = result.stdout + result.stderr;
      expect(output).toContain("../not-there");
      expect(output).toContain(path.join(root, "not-there"));
      expect(output).toContain("sous.repo.yaml");
      expect(output).not.toContain("--provider");
    },
    CLI_TIMEOUT
  );

  /**
   * Naming a provider that plainly does not own the argument is a
   * contradiction, not a hint, so it should be refused and the provider that
   * does own it named.
   *
   * sous repo add ../my-recipes --provider github   // -> exits non-zero
   */
  it(
    "should refuse a provider that contradicts a path",
    () => {
      const result = runSous(
        projectRoot,
        env,
        "repo",
        "add",
        "../my-recipes",
        "--provider",
        "github",
        "--trust"
      );
      expect(result.status).not.toBe(0);

      const output = result.stdout + result.stderr;
      expect(output).toContain("The github provider does not handle");
      expect(output).toContain("the local provider handles");
    },
    CLI_TIMEOUT
  );
});

/**
 * `sous repo remove`: withdrawing trust from a repository, and everything that
 * goes with it.
 *
 * The repository is a local fixture read through the `local` provider, so
 * nothing here touches the network. The project subscribes to one of its
 * recipes first, so the removal has a subscription, a lockfile entry and a
 * compiled skill to take away.
 */
describe("sous repo remove", () => {
  let tmp: TmpDir;
  let root: string;
  let recipesRepo: string;
  let projectRoot: string;
  let sousDir: string;
  /** A second project, used for the built-in repository sous provides itself. */
  let defaultsProject: string;
  let defaultsSousDir: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    tmp = makeTmpDir("sous-repo-remove-");
    root = fs.realpathSync(tmp.path);
    recipesRepo = path.join(root, "fixtures");
    projectRoot = path.join(root, "project");
    sousDir = path.join(projectRoot, ".sous");
    defaultsProject = path.join(root, "defaults-project");
    defaultsSousDir = path.join(defaultsProject, ".sous");
    env = { SOUS_HOME: path.join(root, "sous-home") };

    await buildFixtureRepo(recipesRepo, "fixtures", [
      {
        namespace: "workflow",
        name: "task-files",
        version: "1.0.0",
        description: "Keeps one task file per branch",
        files: { "skills/task-files/SKILL.md": "# Task files\n\nFrom the fixture repo.\n" },
      },
    ]);

    // The project runs against the fixture repository and nothing else: the
    // repository sous provides itself is switched off, so no test here needs a
    // network and no fixture name can collide with a published one.
    fs.mkdirSync(sousDir, { recursive: true });
    fs.writeFileSync(
      path.join(sousDir, "sous.config.json"),
      JSON.stringify(
        { name: "repo-remove-project", repos: { "sous-recipes": { enabled: false } } },
        null,
        2
      ),
      "utf8"
    );

    // The second project takes the defaults exactly as sous provides them.
    fs.mkdirSync(defaultsSousDir, { recursive: true });
    fs.writeFileSync(
      path.join(defaultsSousDir, "sous.config.json"),
      JSON.stringify({ name: "defaults-project" }, null, 2),
      "utf8"
    );

    const added = runSous(projectRoot, env, "repo", "add", recipesRepo, "--trust");
    if (added.status !== 0) {
      throw new Error(`repo add failed: ${added.stdout}${added.stderr}`);
    }

    const subscribed = runSous(
      projectRoot,
      env,
      "subscribe",
      "workflow/task-files",
      "--yes"
    );
    if (subscribed.status !== 0) {
      throw new Error(`subscribe failed: ${subscribed.stdout}${subscribed.stderr}`);
    }
  }, 120_000);

  afterAll(() => {
    tmp.cleanup();
  });

  /** The repositories the managed layer records, keyed by short name. */
  function reposLayer(dir = sousDir): Record<string, { enabled?: boolean }> {
    const layer = readManagedLayer(dir, REPOS_LAYER_FILENAME) as {
      repos?: Record<string, { enabled?: boolean }>;
    };
    return layer.repos ?? {};
  }

  /** The subscriptions the managed layer records, keyed by ref. */
  function subscriptionsLayer(dir = sousDir): Record<string, unknown> {
    const layer = readManagedLayer(dir, SUBSCRIPTIONS_LAYER_FILENAME) as {
      subscriptions?: Record<string, unknown>;
    };
    return layer.subscriptions ?? {};
  }

  /** The lockfile as it stands right now. */
  function lockfile(): { repos: Record<string, unknown>; recipes: Record<string, unknown> } {
    const file = path.join(sousDir, "sous.lock.json");
    return JSON.parse(fs.readFileSync(file, "utf8")) as {
      repos: Record<string, unknown>;
      recipes: Record<string, unknown>;
    };
  }

  /** The skill file the subscribed recipe compiles into the project. */
  function compiledSkill(): string {
    return path.join(projectRoot, ".claude", "skills", "task-files", "SKILL.md");
  }

  /**
   * The setup itself is the first assertion: the repository is trusted, the
   * subscription is locked, and the recipe's skill is on disk. Everything below
   * is about taking those three things away.
   */
  it(
    "should start from a trusted repository with a compiled subscription",
    () => {
      expect(reposLayer()["fixtures"]).toBeDefined();
      expect(Object.keys(subscriptionsLayer())).toEqual(["workflow/task-files"]);
      expect(Object.keys(lockfile().recipes)).toEqual(["workflow/task-files"]);
      expect(fs.existsSync(compiledSkill())).toBe(true);
    },
    CLI_TIMEOUT
  );

  /**
   * A dry run says what would go, in full, and writes nothing at all.
   *
   * sous repo remove fixtures --dry-run
   */
  it(
    "should report what would go and write nothing on a dry run",
    () => {
      const result = runSous(projectRoot, env, "repo", "remove", "fixtures", "--dry-run");
      expect(result.status, result.stdout + result.stderr).toBe(0);

      // The plan names the subscription that goes, the recipe that leaves the
      // lockfile, and the file the next build would prune.
      expect(result.stdout).toContain("workflow/task-files");
      expect(result.stdout).toContain(compiledSkill());

      expect(reposLayer()["fixtures"]).toBeDefined();
      expect(Object.keys(subscriptionsLayer())).toEqual(["workflow/task-files"]);
      expect(Object.keys(lockfile().recipes)).toEqual(["workflow/task-files"]);
      expect(fs.existsSync(compiledSkill())).toBe(true);
    },
    CLI_TIMEOUT
  );

  /**
   * A name the project does not trust is a mistake worth naming: the message
   * says so and lists the repositories it does trust.
   *
   * sous repo remove nowhere-recipes   // -> exits non-zero, names 'fixtures'
   */
  it(
    "should refuse a name this project does not trust",
    () => {
      const result = runSous(projectRoot, env, "repo", "remove", "nowhere-recipes");
      expect(result.status).not.toBe(0);

      const output = result.stdout + result.stderr;
      expect(output).toContain("nowhere-recipes");
      expect(output).toContain("fixtures");
      expect(reposLayer()["fixtures"]).toBeDefined();
    },
    CLI_TIMEOUT
  );

  /**
   * The removal itself: the entry leaves the repositories layer, the
   * subscription that resolved into it goes, the lockfile lets the recipe go,
   * and the build that follows prunes what it used to write.
   *
   * sous repo remove fixtures --yes
   */
  it(
    "should remove the repository, its subscription and its outputs",
    () => {
      const result = runSous(projectRoot, env, "repo", "remove", "fixtures", "--yes");
      expect(result.status, result.stdout + result.stderr).toBe(0);

      expect(reposLayer()["fixtures"]).toBeUndefined();
      expect(subscriptionsLayer()["workflow/task-files"]).toBeUndefined();

      const lock = lockfile();
      expect(Object.keys(lock.recipes)).toEqual([]);
      expect(Object.keys(lock.repos)).toEqual([]);

      // The build the command ends with prunes the skill the recipe wrote.
      expect(fs.existsSync(compiledSkill())).toBe(false);
    },
    CLI_TIMEOUT
  );

  /**
   * Removing the repository sous provides itself cannot delete an entry,
   * because the entry comes back from the installed package on every run. It
   * records the opt-out instead, in the shape a person writes by hand, and says
   * so.
   *
   * sous repo remove sous-recipes --yes --no-build
   */
  it(
    "should switch the built-in repository off rather than delete it",
    () => {
      const result = runSous(
        defaultsProject,
        env,
        "repo",
        "remove",
        "sous-recipes",
        "--yes",
        "--no-build"
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("enabled: false");

      expect(reposLayer(defaultsSousDir)["sous-recipes"]).toEqual({ enabled: false });
    },
    CLI_TIMEOUT
  );
});
