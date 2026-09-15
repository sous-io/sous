import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const binPath = path.join(repoRoot, "bin", "run.js");
const ownVersion = (JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
  version: string;
}).version;

/** The version the project copy is relabelled with, so the two are told apart. */
const PROJECT_VERSION = "0.0.0-project";

/** Per-test timeout: each test boots the real CLI (tsx + oclif) in a subprocess. */
const CLI_TIMEOUT = 30_000;

/**
 * End-to-end coverage for the hand-off from an invoked sous to the sous a
 * project installs (gh-10), exercised through the real entry point
 * (bin/run.js) the way a global install would be.
 *
 * The "project copy" is the package as npm would publish it: `npm pack` builds
 * the tarball from the repository's own files allowlist (no network; pack only
 * reads local files), and it is extracted under a temporary project's
 * node_modules. The copy's node_modules is a symlink to the repository's, so
 * its dependencies resolve without an install, and its package.json version is
 * relabelled so `sous --version` says which copy ran.
 */
describe("hand-off to the project's own install", () => {
  let tmp: TmpDir;
  let projectRoot: string;
  let projectCopy: string;
  let nestedDir: string;
  let outsideDir: string;

  function runCli(
    args: string[],
    opts: { cwd: string; env?: Record<string, string | undefined>; bin?: string }
  ): { stdout: string; stderr: string; status: number | null } {
    const env: Record<string, string | undefined> = {
      ...process.env,
      SOUS_HOME: path.join(tmp.path, "sous-home"),
    };
    delete env.SOUS_CONFIG;
    delete env.SOUS_DIR;
    delete env.SOUS_CONFD;
    delete env.SOUS_NO_DELEGATE;
    delete env.SOUS_DEBUG;
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    const result = spawnSync(process.execPath, [opts.bin ?? binPath, ...args], {
      cwd: opts.cwd,
      encoding: "utf8",
      env,
    });
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
  }

  beforeAll(() => {
    tmp = makeTmpDir("sous-project-install-e2e-");

    // Pack the repository as npm would publish it.
    const packDir = path.join(tmp.path, "pack");
    fs.mkdirSync(packDir);
    const pack = spawnSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["pack", "--json", "--pack-destination", packDir],
      { cwd: repoRoot, encoding: "utf8" }
    );
    if (pack.status !== 0) {
      throw new Error(`npm pack failed:\n${pack.stderr}`);
    }
    const [{ filename }] = JSON.parse(pack.stdout) as { filename: string }[];

    // Extract it where a devDependency install would put it.
    projectRoot = path.join(tmp.path, "project");
    projectCopy = path.join(projectRoot, "node_modules", "@sous-io", "sous");
    fs.mkdirSync(projectCopy, { recursive: true });
    const untar = spawnSync(
      "tar",
      ["-xzf", path.join(packDir, filename), "--strip-components=1", "-C", projectCopy],
      { encoding: "utf8" }
    );
    if (untar.status !== 0) {
      throw new Error(`tar failed:\n${untar.stderr}`);
    }

    // Its dependencies are the repository's; relabel its version.
    fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(projectCopy, "node_modules"), "dir");
    const pkgFile = path.join(projectCopy, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8")) as Record<string, unknown>;
    pkg.version = PROJECT_VERSION;
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));

    // A sous project with a config, some way beneath the root, and a
    // directory outside any project.
    nestedDir = path.join(projectRoot, "packages", "app");
    fs.mkdirSync(path.join(nestedDir, ".sous"), { recursive: true });
    fs.writeFileSync(
      path.join(nestedDir, ".sous", "sous.config.json"),
      JSON.stringify({ name: "Nested App" })
    );
    outsideDir = path.join(tmp.path, "outside");
    fs.mkdirSync(outsideDir);
  }, 120_000);

  afterAll(() => {
    tmp.cleanup();
  });

  /**
   * The repository's own bin, standing in for a global install, hands off to
   * the project copy from anywhere inside the project, and says so on stderr
   * because the versions differ.
   * Example: `sous --version` in <project>/packages/app reports 0.0.0-project.
   */
  it(
    "should run the project's copy from inside the project and say so on stderr",
    () => {
      const result = runCli(["--version"], { cwd: nestedDir });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`@sous-io/sous/${PROJECT_VERSION}`);
      expect(result.stderr).toContain(`sous ${PROJECT_VERSION}`);
      expect(result.stderr).toContain(`sous ${ownVersion} you invoked`);
      expect(result.stderr).toContain("SOUS_NO_DELEGATE=1");
    },
    CLI_TIMEOUT
  );

  /**
   * The notice never touches stdout, so a command whose output is consumed by
   * a pipe prints exactly what it always did.
   * Example: `sous config get name` prints only `Nested App` on stdout.
   */
  it(
    "should keep stdout clean when it hands off",
    () => {
      const result = runCli(["config", "get", "name"], { cwd: nestedDir });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("Nested App");
      expect(result.stderr).toContain(`sous ${PROJECT_VERSION}`);
    },
    CLI_TIMEOUT
  );

  /**
   * Outside any project the invoked copy runs, with nothing on stderr.
   * Example: `sous --version` in an unrelated directory reports the repository's version.
   */
  it(
    "should run the invoked copy outside a project",
    () => {
      const result = runCli(["--version"], { cwd: outsideDir });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`@sous-io/sous/${ownVersion}`);
      expect(result.stderr).toBe("");
    },
    CLI_TIMEOUT
  );

  /**
   * SOUS_NO_DELEGATE keeps the invoked copy running inside the project.
   * Example: `SOUS_NO_DELEGATE=1 sous --version` in the project reports the repository's version.
   */
  it(
    "should run the invoked copy when SOUS_NO_DELEGATE is set",
    () => {
      const result = runCli(["--version"], { cwd: nestedDir, env: { SOUS_NO_DELEGATE: "1" } });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`@sous-io/sous/${ownVersion}`);
      expect(result.stderr).toBe("");
    },
    CLI_TIMEOUT
  );

  /**
   * The project copy invoked directly (what `npx sous` does) finds itself and
   * never hands off, so there is no loop and no notice.
   * Example: `node <project copy>/bin/run.js --version` reports 0.0.0-project silently.
   */
  it(
    "should not hand off from the project copy to itself",
    () => {
      const result = runCli(["--version"], {
        cwd: nestedDir,
        bin: path.join(projectCopy, "bin", "run.js"),
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`@sous-io/sous/${PROJECT_VERSION}`);
      expect(result.stderr).toBe("");
    },
    CLI_TIMEOUT
  );
});
