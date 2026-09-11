import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { parse as parseJsonc } from "jsonc-parser";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { buildFixtureRepo } from "../utils/fixture-repo.js";
import { discoverConfig } from "../../lib/config-discovery.js";
import { loadSettings } from "../../lib/settings.js";
import { SubscriptionService } from "../../lib/repos/subscription-service.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const binPath = path.join(repoRoot, "bin", "run.js");

/** Per-test budget: every one of these boots the real CLI several times. */
const CLI_TIMEOUT = 90_000;

type RunResult = { stdout: string; stderr: string; status: number | null };

let tmp: TmpDir;
/** The project the commands run in. */
let projectRoot: string;
let sousDir: string;
/** The user-level sous directory, which holds the store. */
let sousHome: string;
let storeRoot: string;
/** The two local fixture repositories. */
let mainRepo: string;
let extrasRepo: string;

/**
 * Runs `sous <args...>` through the real published bin, from `cwd`, with the
 * store pointed at this test's temporary directory. The `SOUS_*` project
 * variables are stripped so the child discovers its config by walking up from
 * `cwd`, and nothing this test does can reach the developer's own store.
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
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

/**
 * Runs `sous <args...>` exactly as `sous` does, with extra environment
 * variables layered on top. Used for the cases that are about the environment
 * itself, such as `CI`.
 */
function sousWithEnv(
  cwd: string,
  extra: NodeJS.ProcessEnv,
  ...args: string[]
): RunResult {
  const env = { ...process.env, ...extra, SOUS_HOME: sousHome };
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

/** Writes a file, creating its parent directories. Returns the full path. */
function write(filePath: string, contents: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
  return filePath;
}

/** Reads a JSON file that the CLI wrote. */
function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

/**
 * Reads one of the managed `conf.d/` layers, which are JSON with comments.
 */
function readJsonc(filePath: string): Record<string, unknown> {
  return parseJsonc(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}


/**
 * Drives the whole consumer surface end to end through the real CLI: adding a
 * local repository, subscribing to a recipe, compiling what it contributes,
 * addressing it from a project template, listing its variables, unsubscribing,
 * restoring a fresh clone and collecting the store.
 *
 * Everything runs against local fixture repositories read through the `local`
 * provider, so no test here touches the network.
 */
describe("the repositories consumer surface", () => {
  beforeAll(async () => {
    tmp = makeTmpDir("sous-repositories-");
    sousHome = path.join(tmp.path, "sous-home");
    storeRoot = path.join(sousHome, "cache");
    projectRoot = path.join(tmp.path, "project");
    sousDir = path.join(projectRoot, ".sous");
    mainRepo = path.join(tmp.path, "fixtures");
    extrasRepo = path.join(tmp.path, "extras");

    await buildFixtureRepo(mainRepo, "fixtures", [
      {
        namespace: "workflow",
        name: "task-files",
        version: "1.0.0",
        description: "Keeps one task file per branch",
        files: {
          "skills/task-files/SKILL.md": "# Task files\n\nA skill from the fixture repo.\n",
          "partials/shared.md": "A shared partial from the fixture repo.\n",
        },
        variables: [
          {
            name: "apiUrl",
            type: "url",
            prompt: "Where does the API live?",
            description: "The service every request this recipe generates is sent to.",
            example: "https://api.example.com",
            required: true,
          },
          {
            name: "taskFileRoot",
            type: "path",
            prompt: "Where do task files live?",
            description: "The directory holding one task file per git branch.",
            example: ".sous/tasks",
            required: false,
          },
        ],
      },
      {
        namespace: "workflow",
        name: "needs-extras",
        version: "1.0.0",
        description: "Depends on a recipe from another repository",
        depends: ["extras:tooling/formatter"],
        files: { "skills/needs-extras/SKILL.md": "# Needs extras\n" },
      },
      // The namespace 'formatter' shares its name with the recipe
      // 'tooling/formatter' in the other repository, which is what makes the
      // one-word ref 'formatter' ambiguous. Its recipe, 'daily', has a name
      // nothing else uses, so 'daily' on its own is not.
      {
        namespace: "formatter",
        name: "daily",
        version: "1.0.0",
        description: "Formats something once a day",
        files: { "skills/daily/SKILL.md": "# Daily\n" },
      },
    ]);

    await buildFixtureRepo(extrasRepo, "extras", [
      {
        namespace: "tooling",
        name: "formatter",
        version: "1.0.0",
        description: "A formatter recipe",
        files: { "skills/formatter/SKILL.md": "# Formatter\n" },
      },
    ]);

    // The project: one template of its own, which also includes a file from the
    // recipe through the reserved `~namespace` sigil.
    write(
      path.join(sousDir, "sous.config.js"),
      [
        "export const config = {",
        '  name: "Repositories Test Project",',
        '  _vars: { projectRoot: "${sousDir}/.." },',
        // Every project is given the official repository and the core namespace
        // unless it says otherwise. This one says otherwise, so the whole file
        // runs against its two local fixture repositories and nothing else:
        // no network, and no chance of a fixture recipe name colliding with a
        // real published one. The offline defaults are covered on their own in
        // core-namespace.test.ts.
        '  repos: { "sous-recipes": { enabled: false } },',
        "  compilation: {",
        "    targets: [",
        "      {",
        '        entryPoint: "${sousDir}/prompts/AGENTS.md",',
        '        outputs: [{ destinationFile: "${projectRoot}/AGENTS.md" }],',
        "      },",
        "    ],",
        "  },",
        "};",
        "",
      ].join("\n")
    );
    write(
      path.join(sousDir, "prompts", "AGENTS.md"),
      "# The project\n\n@~workflow/task-files/partials/shared.md\n"
    );
    // An answer already in scope, so the required variable is inherited rather
    // than asked for; a run with no terminal cannot answer a question.
    write(path.join(sousDir, ".env"), "SOUS_VAR_API_URL=https://api.example.invalid\n");
  }, CLI_TIMEOUT);

  afterAll(() => {
    tmp.cleanup();
  });

  /**
   * `sous repo add` must not add anything without an answer to the trust
   * question, and a run with no terminal cannot answer one. It should fail
   * naming the repository and the flag that acknowledges the trust.
   *
   * sous repo add /path/to/fixtures   // -> exits non-zero, names --trust
   */
  it(
    "should refuse to add a repository with no terminal and no --trust",
    () => {
      const result = sous(projectRoot, "repo", "add", mainRepo);

      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("fixtures");
      expect(result.stdout + result.stderr).toContain("--trust");
      expect(fs.existsSync(path.join(sousDir, "conf.d", "500-repos.jsonc"))).toBe(false);
    },
    CLI_TIMEOUT
  );

  /**
   * With `--trust`, the repository is written into the managed 500-repos layer
   * and exactly one file is fetched from it: its index. Nothing is installed.
   *
   * sous repo add /path/to/fixtures --trust
   */
  it(
    "should add a repository with --trust and fetch only its index",
    () => {
      const result = sous(projectRoot, "repo", "add", mainRepo, "--trust");

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("workflow");

      const layer = readJsonc(path.join(sousDir, "conf.d", "500-repos.jsonc"));
      const repos = layer.repos as Record<string, { url: string; addedBy: string }>;
      expect(repos.fixtures!.url).toBe(mainRepo);
      expect(repos.fixtures!.addedBy).toBe("user");

      // The index is cached, and nothing else has been downloaded.
      expect(fs.existsSync(path.join(storeRoot, "_indexes", "fixtures.json"))).toBe(true);
      expect(fs.existsSync(path.join(storeRoot, "fixtures"))).toBe(false);
    },
    CLI_TIMEOUT
  );

  /**
   * `sous repo list` shows the trusted repository and where it came from, and
   * `--verbose` adds the namespaces its cached index says it publishes.
   * `sous repo search` finds a recipe by its description. All of it reads only
   * what is already on disk.
   */
  it(
    "should list and search the trusted repositories",
    () => {
      const list = sous(projectRoot, "repo", "list");
      expect(list.status).toBe(0);
      expect(list.stdout).toContain("fixtures");

      const verbose = sous(projectRoot, "repo", "list", "--verbose");
      expect(verbose.status).toBe(0);
      expect(verbose.stdout).toMatch(/Namespaces: .*workflow/);

      const search = sous(projectRoot, "repo", "search", "task file per branch");
      expect(search.status).toBe(0);
      expect(search.stdout).toContain("workflow/task-files");
      expect(search.stdout).toContain("1.0.0");

      const nothing = sous(projectRoot, "repo", "search", "nothing-matches-this");
      expect(nothing.status).toBe(0);
      expect(nothing.stdout).toContain("Nothing in the repositories");
    },
    CLI_TIMEOUT
  );

  /**
   * A dependency on a recipe in a repository the project has not added stops the
   * install and names the repository, rather than fetching from somewhere the
   * project never agreed to trust.
   *
   * sous subscribe workflow/needs-extras --yes   // -> exits non-zero, names 'extras'
   */
  it(
    "should refuse a dependency on an untrusted repository",
    () => {
      // '--yes' answers both questions this command can ask; '--trust' is only
      // another spelling of it, so passing one of them is passing both.
      const result = sous(projectRoot, "subscribe", "workflow/needs-extras", "--yes");

      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("extras");
      expect(fs.existsSync(path.join(sousDir, "sous.lock.json"))).toBe(false);
    },
    CLI_TIMEOUT
  );

  /**
   * Once the second repository is added, the same subscription resolves the
   * whole closure: the recipe the project asked for, plus the build dependency
   * it declares, each pinned at an exact version.
   */
  it(
    "should install a dependency closure once its repository is trusted",
    () => {
      expect(sous(projectRoot, "repo", "add", extrasRepo, "--trust").status).toBe(0);

      const result = sous(projectRoot, "subscribe", "workflow/needs-extras", "--yes");
      expect(result.status).toBe(0);

      const lock = readJson(path.join(sousDir, "sous.lock.json"));
      const recipes = lock.recipes as Record<string, { repo: string; kind: string }>;
      expect(Object.keys(recipes).sort()).toEqual([
        "tooling/formatter",
        "workflow/needs-extras",
      ]);
      expect(recipes["tooling/formatter"]!.kind).toBe("depends");
      expect(recipes["workflow/needs-extras"]!.kind).toBe("subscribes");
    },
    CLI_TIMEOUT
  );

  /**
   * Subscribing writes the lockfile, fills the store, records the subscription
   * in the managed 510 layer, and reports the answers it inherited rather than
   * asking for them again.
   *
   * sous subscribe workflow/task-files
   */
  it(
    "should subscribe to a recipe and record it everywhere",
    () => {
      const result = sous(projectRoot, "subscribe", "workflow/task-files", "--yes");

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("workflow/task-files");

      const lock = readJson(path.join(sousDir, "sous.lock.json"));
      const recipes = lock.recipes as Record<string, { version: string; repo: string }>;
      expect(recipes["workflow/task-files"]!.version).toBe("1.0.0");
      expect(recipes["workflow/task-files"]!.repo).toBe("fixtures");

      const subscriptions = readJsonc(
        path.join(sousDir, "conf.d", "510-subscriptions.jsonc")
      ).subscriptions as Record<string, { addedBy: string }>;
      expect(subscriptions["workflow/task-files"]!.addedBy).toBe("user");

      const entryDir = path.join(
        storeRoot,
        "fixtures",
        "workflow",
        "task-files",
        "1.0.0"
      );
      expect(fs.existsSync(path.join(entryDir, "skills", "task-files", "SKILL.md"))).toBe(
        true
      );
      expect(fs.existsSync(path.join(entryDir, ".sous.entry.json"))).toBe(true);

      // The required variable already had an answer in scope, so it was
      // inherited and reported rather than asked for.
      expect(result.stdout).toContain("apiUrl");
    },
    CLI_TIMEOUT
  );

  /**
   * `sous vars` lists the variables the subscribed recipes publish, with the
   * environment variable that answered each one.
   */
  it(
    "should list the subscribed recipe's variables",
    () => {
      const result = sous(projectRoot, "vars");

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("apiUrl");
      expect(result.stdout).toContain("workflow/task-files");
      expect(result.stdout).toContain("SOUS_VAR_API_URL");
    },
    CLI_TIMEOUT
  );

  /**
   * The canonical spellings of the same two reports, and the singular spelling
   * of the topic. Bare `sous vars` above is the shorthand for the first of them.
   *
   * sous vars list
   * sous vars show apiUrl
   * sous var list
   */
  it(
    "should list and show variables under their canonical commands",
    () => {
      const listed = sous(projectRoot, "vars", "list");
      expect(listed.status).toBe(0);
      expect(listed.stdout).toContain("apiUrl");
      expect(listed.stdout).toContain("SOUS_VAR_API_URL");

      const shown = sous(projectRoot, "vars", "show", "apiUrl");
      expect(shown.status).toBe(0);
      expect(shown.stdout).toContain("Where does the API live?");
      expect(shown.stdout).toContain("SOUS_VAR_WORKFLOW_TASK_FILES_API_URL");

      // The singular spelling of the topic reaches the same command.
      const singular = sous(projectRoot, "var", "list");
      expect(singular.status).toBe(0);
      expect(singular.stdout).toContain("apiUrl");
    },
    CLI_TIMEOUT
  );

  /**
   * The listing reports what the project subscribes to, the range it resolves
   * within, and the version the lockfile pins for it.
   *
   * sous subscription list
   * sous subscriptions list
   */
  it(
    "should list the project's subscriptions",
    () => {
      const result = sous(projectRoot, "subscription", "list");

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("workflow/task-files");
      expect(result.stdout).toContain("workflow/task-files 1.0.0");
      expect(result.stdout).toContain("user");

      // The plural spelling of the topic reaches the same command.
      const plural = sous(projectRoot, "subscriptions", "list");
      expect(plural.status).toBe(0);
      expect(plural.stdout).toContain("workflow/task-files");
    },
    CLI_TIMEOUT
  );

  /**
   * Searching is reachable both under its topic and as a top-level command,
   * because it is how a person finds anything to subscribe to.
   *
   * sous search task
   */
  it(
    "should search from the top level",
    () => {
      const result = sous(projectRoot, "search", "task");

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("workflow/task-files");
    },
    CLI_TIMEOUT
  );

  /**
   * A build compiles what the subscribed recipes contribute into the project's
   * skills directory, alongside the project's own targets, and resolves a
   * `@~namespace/recipe/file.md` include against the pinned recipe.
   */
  it(
    "should compile recipe skills and resolve a namespace include",
    () => {
      const result = sous(projectRoot, "build");
      expect(result.status).toBe(0);

      const skill = path.join(
        projectRoot,
        ".claude",
        "skills",
        "task-files",
        "SKILL.md"
      );
      expect(fs.readFileSync(skill, "utf8")).toContain("A skill from the fixture repo.");

      const agents = fs.readFileSync(path.join(projectRoot, "AGENTS.md"), "utf8");
      expect(agents).toContain("A shared partial from the fixture repo.");

      // The build dependency's files never enter the project's output; that is
      // the whole difference between `depends` and `subscribes`.
      expect(
        fs.existsSync(path.join(projectRoot, ".claude", "skills", "formatter"))
      ).toBe(false);
    },
    CLI_TIMEOUT
  );

  /**
   * Neither prune nor clear may ever reach into a linked checkout or the shared
   * recipe store, whatever a stale state entry claims, because both hold work
   * that is not this project's to delete.
   */
  it(
    "should never prune or clear anything under .sous/repos or the store",
    () => {
      const checkoutFile = write(
        path.join(sousDir, "repos", "someone", "checkout", "WORK.md"),
        "unpushed work"
      );
      const storeFile = path.join(
        storeRoot,
        "fixtures",
        "workflow",
        "task-files",
        "1.0.0",
        "skills",
        "task-files",
        "SKILL.md"
      );

      // Poison the state file with entries pointing at both, the way a bug or a
      // hand edit could.
      const statePath = path.join(sousDir, "sous.state.json");
      const state = readJson(statePath) as {
        files: Array<Record<string, unknown>>;
        dirs: string[];
      };
      const poison = (dest: string) => ({
        dest,
        srcHash: "",
        destHash: "",
        size: 0,
        builtAt: "2026-01-01T00:00:00.000Z",
      });
      state.files.push(poison(checkoutFile), poison(storeFile));
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");

      expect(sous(projectRoot, "build").status).toBe(0);
      expect(fs.existsSync(checkoutFile)).toBe(true);
      expect(fs.existsSync(storeFile)).toBe(true);

      expect(sous(projectRoot, "clear", "--force").status).toBe(0);
      expect(fs.existsSync(checkoutFile)).toBe(true);
      expect(fs.existsSync(storeFile)).toBe(true);
    },
    CLI_TIMEOUT
  );

  /**
   * A fresh clone has a lockfile and no store. A build restores exactly what the
   * lockfile pins, asking nothing, and produces the same output as before.
   */
  it(
    "should restore a fresh clone with no prompts",
    () => {
      fs.rmSync(storeRoot, { recursive: true, force: true });
      fs.rmSync(path.join(projectRoot, ".claude"), { recursive: true, force: true });

      const result = sous(projectRoot, "build");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Restoring recipes");

      const skill = path.join(projectRoot, ".claude", "skills", "task-files", "SKILL.md");
      expect(fs.readFileSync(skill, "utf8")).toContain("A skill from the fixture repo.");
      expect(
        fs.existsSync(
          path.join(storeRoot, "fixtures", "workflow", "task-files", "1.0.0")
        )
      ).toBe(true);
    },
    CLI_TIMEOUT
  );

  /**
   * Unsubscribing is refcounted: the recipe the project asked for goes, and so
   * does the build dependency nothing else holds, while a recipe another
   * subscription still holds stays and is reported as having stayed.
   */
  it(
    "should unsubscribe with refcounting",
    () => {
      const result = sous(projectRoot, "unsubscribe", "workflow/needs-extras");
      expect(result.status).toBe(0);

      const lock = readJson(path.join(sousDir, "sous.lock.json"));
      const recipes = lock.recipes as Record<string, unknown>;
      expect(Object.keys(recipes).sort()).toEqual(["workflow/task-files"]);

      const subscriptions = readJsonc(
        path.join(sousDir, "conf.d", "510-subscriptions.jsonc")
      ).subscriptions as Record<string, unknown>;
      expect(Object.keys(subscriptions)).toEqual(["workflow/task-files"]);

      // What it used to write is pruned on the next build.
      expect(sous(projectRoot, "build").status).toBe(0);
      expect(
        fs.existsSync(path.join(projectRoot, ".claude", "skills", "needs-extras"))
      ).toBe(false);
      expect(
        fs.existsSync(path.join(projectRoot, ".claude", "skills", "task-files"))
      ).toBe(true);
    },
    CLI_TIMEOUT
  );

  /**
   * The canonical spellings of the same two commands, there and back again, so
   * the project ends exactly where the alias-driven test above left it. The
   * subscribe confirmation is answered with '--yes', because these runs have no
   * terminal to be asked on.
   *
   * sous subscription add workflow/needs-extras --yes
   * sous subscription remove workflow/needs-extras
   */
  it(
    "should add and remove a subscription under its canonical commands",
    () => {
      const added = sous(
        projectRoot,
        "subscription",
        "add",
        "workflow/needs-extras",
        "--yes"
      );
      expect(added.status, added.stdout + added.stderr).toBe(0);

      const withIt = readJson(path.join(sousDir, "sous.lock.json"));
      expect(Object.keys(withIt.recipes as Record<string, unknown>).sort()).toEqual([
        "tooling/formatter",
        "workflow/needs-extras",
        "workflow/task-files",
      ]);

      const listed = sous(projectRoot, "subscription", "list");
      expect(listed.status).toBe(0);
      expect(listed.stdout).toContain("workflow/needs-extras");

      const removed = sous(projectRoot, "subscription", "remove", "workflow/needs-extras");
      expect(removed.status).toBe(0);

      const without = readJson(path.join(sousDir, "sous.lock.json"));
      expect(Object.keys(without.recipes as Record<string, unknown>).sort()).toEqual([
        "workflow/task-files",
      ]);
    },
    CLI_TIMEOUT
  );

  /**
   * `sous repo gc` collects the store back to its cap, protecting everything the
   * lockfile still pins. A dry run removes nothing at all.
   */
  it(
    "should collect the store while protecting what the lockfile pins",
    () => {
      const dry = sous(projectRoot, "repo", "gc", "--max-bytes", "1", "--dry-run");
      expect(dry.status).toBe(0);
      expect(
        fs.existsSync(
          path.join(storeRoot, "fixtures", "workflow", "task-files", "1.0.0")
        )
      ).toBe(true);

      const real = sous(projectRoot, "repo", "gc", "--max-bytes", "1");
      expect(real.status).toBe(0);

      // Still pinned, so still there, however small the cap.
      expect(
        fs.existsSync(
          path.join(storeRoot, "fixtures", "workflow", "task-files", "1.0.0")
        )
      ).toBe(true);
      // No longer pinned by anything, so collected.
      expect(
        fs.existsSync(path.join(storeRoot, "extras", "tooling", "formatter", "1.0.0"))
      ).toBe(false);
    },
    CLI_TIMEOUT
  );

  /**
   * A ref with one segment is a guess at a name. A name only one thing carries
   * resolves on its own, and the run says what it resolved to.
   *
   * sous subscribe daily --yes   // -> fixtures:formatter/daily
   */
  it(
    "should subscribe to a recipe named by a bare name",
    () => {
      const result = sous(projectRoot, "subscribe", "daily", "--yes");

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("fixtures:formatter/daily");

      const lock = readJson(path.join(sousDir, "sous.lock.json"));
      const recipes = lock.recipes as Record<string, { repo: string }>;
      expect(recipes["formatter/daily"]!.repo).toBe("fixtures");
    },
    CLI_TIMEOUT
  );

  /**
   * A name that is both a namespace in one repository and a recipe in another
   * cannot be resolved without asking, and a run with no terminal cannot ask.
   * It fails naming the flag that decides, and prints the command's own help so
   * every other flag is visible too.
   *
   * sous subscribe formatter --yes   // -> exits non-zero, names --accept-first
   */
  it(
    "should fail on an ambiguous bare name with no terminal, naming --accept-first",
    () => {
      const result = sous(projectRoot, "subscribe", "formatter", "--yes");
      const output = result.stdout + result.stderr;

      expect(result.status).not.toBe(0);
      expect(output).toContain("--accept-first");
      expect(output).toContain("fixtures:formatter");
      expect(output).toContain("extras:tooling/formatter");
      // The command's own help, printed underneath the error.
      expect(result.stderr).toContain("USAGE");
      expect(result.stderr).toContain("--non-interactive");

      const lock = readJson(path.join(sousDir, "sous.lock.json"));
      expect(Object.keys(lock.recipes as Record<string, unknown>)).not.toContain(
        "tooling/formatter"
      );
    },
    CLI_TIMEOUT
  );

  /**
   * `--accept-first` takes the first candidate in the documented order:
   * repositories in the order the project added them, so the namespace in
   * 'fixtures' beats the recipe of the same name in 'extras'.
   *
   * sous subscribe formatter --accept-first --yes
   */
  it(
    "should take the first candidate with --accept-first",
    () => {
      const result = sous(
        projectRoot,
        "subscribe",
        "formatter",
        "--accept-first",
        "--yes"
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("fixtures:formatter");

      const subscriptions = readJsonc(
        path.join(sousDir, "conf.d", "510-subscriptions.jsonc")
      ).subscriptions as Record<string, unknown>;
      expect(Object.keys(subscriptions)).toContain("formatter");
    },
    CLI_TIMEOUT
  );

  /**
   * The confirmation is a real gate: without an answer, and without `--yes`,
   * nothing is written at all. A run with no terminal cannot answer it, so it
   * fails naming the flag that would have.
   *
   * sous subscribe workflow/task-files   // -> exits non-zero, names --yes
   */
  it(
    "should refuse to subscribe with no terminal and no --yes",
    () => {
      const result = sous(projectRoot, "unsubscribe", "formatter");
      expect(result.status).toBe(0);

      const attempt = sous(projectRoot, "subscribe", "formatter", "--accept-first");
      const output = attempt.stdout + attempt.stderr;

      expect(attempt.status).not.toBe(0);
      expect(output).toContain("--yes");
      // The plan is printed before the question, so the reader knows what they
      // are being asked about.
      expect(output).toContain("compiled into this project");

      const subscriptions = readJsonc(
        path.join(sousDir, "conf.d", "510-subscriptions.jsonc")
      ).subscriptions as Record<string, unknown>;
      expect(Object.keys(subscriptions)).not.toContain("formatter");
    },
    CLI_TIMEOUT
  );

  /**
   * Declining the confirmation writes nothing at all: no lockfile entry, no
   * subscription record, nothing downloaded.
   *
   * The question needs a terminal, which a spawned process does not have, so
   * this one drives the service in process with the answer injected. The plan
   * it printed and the question it asked are the same ones the command shows.
   */
  it(
    "should write nothing when the confirmation is declined",
    async () => {
      const discovered = discoverConfig(projectRoot);
      expect(discovered).not.toBeNull();
      const settings = await loadSettings(discovered!);

      const asked: string[] = [];
      const printed: string[] = [];
      const service = new SubscriptionService({
        sousDir,
        settings,
        env: { ...process.env, SOUS_HOME: sousHome },
        interactive: true,
        write: (line) => printed.push(line),
        ask: async (message) => {
          asked.push(message);
          return false;
        },
      });

      const lockPath = path.join(sousDir, "sous.lock.json");
      const lockBefore = fs.readFileSync(lockPath, "utf8");
      const subscriptionsPath = path.join(
        sousDir,
        "conf.d",
        "510-subscriptions.jsonc"
      );
      const subscriptionsBefore = fs.readFileSync(subscriptionsPath, "utf8");

      await expect(
        service.subscribe({ ref: "workflow/needs-extras" })
      ).rejects.toThrow(/declined/);

      expect(asked).toEqual(["Proceed?"]);
      expect(printed.join("\n")).toContain("compiled into this project");
      expect(fs.readFileSync(lockPath, "utf8")).toBe(lockBefore);
      expect(fs.readFileSync(subscriptionsPath, "utf8")).toBe(subscriptionsBefore);
    },
    CLI_TIMEOUT
  );

  /**
   * `CI` alone makes a run non-interactive, even where stdin and stdout are
   * terminals: a continuous integration job has nobody to answer a question.
   */
  it(
    "should treat a truthy CI variable as non-interactive",
    () => {
      const result = sousWithEnv(projectRoot, { CI: "true" }, "subscribe", "daily");

      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("CI");
      expect(result.stdout + result.stderr).toContain("--yes");
    },
    CLI_TIMEOUT
  );
});
