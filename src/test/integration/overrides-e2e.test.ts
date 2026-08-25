import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const binPath = path.join(repoRoot, "bin", "run.js");

/** Per-test timeout: each test boots the real CLI (tsx + oclif) in a subprocess. */
const CLI_TIMEOUT = 30_000;

/**
 * End-to-end coverage for the Phase-5 config-locating overrides, exercised
 * through the real CLI entry point (bin/run.js) so the whole startup sequence
 * runs: raw-argv flag prescan, SOUS_* env reads from the REAL environment, then
 * discovery / resolveConfigFlag, conf.d layering and env-file loading.
 *
 * The observable is `xcv config get name`: it prints the merged config's `name`
 * scalar (post-merge, pre-variable-resolution) to stdout, so a conf.d layer that
 * overrides `name` tells us exactly which config + which layer directory won.
 *
 * Precedence under test (highest first):
 *   primary config: --sous-config/-c flag > SOUS_CONFIG > --sous-dir > SOUS_DIR > walk-up
 *   conf.d dir:     --sous-confd flag > SOUS_CONFD > <sousDir>/conf.d
 */
describe("config-locating overrides (env vars + flag aliases)", () => {
  let tmp: TmpDir;

  // Fixture paths, populated in beforeAll.
  let bareCwd: string;
  let primaryConfigFile: string;
  let primaryProjectRoot: string;
  let projBProjectRoot: string;
  let projBConfigFile: string;
  let projBSousDir: string;
  let primarySousDir: string;
  let altConfdDir: string;
  let altBConfdDir: string;
  let envLocalProjectRoot: string;

  // Launch fixture.
  let launchCwd: string;
  let launchConfigFile: string;
  let launchDumpFile: string;

  /**
   * Runs the CLI with a CLEAN copy of the environment: the three SOUS_* config
   * vars are stripped from the inherited env first, then only the requested
   * overrides are applied. This keeps a SOUS_* var leaking in from the test
   * runner's own shell from silently steering these tests.
   */
  function runCli(
    args: string[],
    opts: { cwd: string; env?: Record<string, string | undefined> } = { cwd: bareCwd }
  ): { stdout: string; stderr: string; status: number | null } {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.SOUS_CONFIG;
    delete env.SOUS_DIR;
    delete env.SOUS_CONFD;
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }

    const result = spawnSync(process.execPath, [binPath, ...args], {
      cwd: opts.cwd,
      encoding: "utf8",
      env,
    });
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
  }

  /** `xcv config get name`, returning the trimmed stdout scalar. */
  function getName(opts: { cwd: string; env?: Record<string, string | undefined>; flags?: string[] }): {
    name: string;
    status: number | null;
    stderr: string;
  } {
    const { stdout, stderr, status } = runCli(["config", "get", "name", ...(opts.flags ?? [])], {
      cwd: opts.cwd,
      env: opts.env,
    });
    return { name: stdout.trim(), status, stderr };
  }

  function writeConfig(dir: string, name: string): string {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "sous.config.json");
    fs.writeFileSync(file, JSON.stringify({ name }));
    return file;
  }

  /** A conf.d layer directory holding one layer that overrides `name`. */
  function writeConfdLayer(dir: string, name: string): string {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "500-layer.json"), JSON.stringify({ name }));
    return dir;
  }

  beforeAll(() => {
    tmp = makeTmpDir("sous-overrides-");
    const root = tmp.path;

    // A cwd with nothing to discover by walking up (it lives under os.tmpdir()).
    bareCwd = path.join(root, "bare");
    fs.mkdirSync(bareCwd, { recursive: true });

    // primary/.sous/sous.config.json (name PRIMARY), NO default conf.d layer, so
    // `name` stays PRIMARY unless a conf.d override is pointed in.
    primaryProjectRoot = path.join(root, "primary");
    primarySousDir = path.join(primaryProjectRoot, ".sous");
    primaryConfigFile = writeConfig(primarySousDir, "PRIMARY");

    // projB: a second, distinct config used to prove a flag/env WON.
    projBProjectRoot = path.join(root, "projB");
    projBSousDir = path.join(projBProjectRoot, ".sous");
    projBConfigFile = writeConfig(projBSousDir, "PROJB");

    // Two alternate conf.d layer dirs, each overriding `name` distinctly.
    altConfdDir = writeConfdLayer(path.join(root, "alt-confd"), "ALT_LAYER");
    altBConfdDir = writeConfdLayer(path.join(root, "altB-confd"), "ALTB_LAYER");

    // envlocal project: discoverable by walk-up from its own root, with a
    // .sous/.env.local that (wrongly, if honored) points SOUS_CONFD at alt-confd.
    envLocalProjectRoot = path.join(root, "envlocal");
    const envLocalSousDir = path.join(envLocalProjectRoot, ".sous");
    writeConfig(envLocalSousDir, "ENVLOCAL_PRIMARY");
    fs.writeFileSync(path.join(envLocalSousDir, ".env.local"), `SOUS_CONFD=${altConfdDir}\n`);

    // Launch fixture: a tool that dumps the argv it received to DUMP_FILE.
    launchCwd = path.join(root, "launch");
    const launchSousDir = path.join(launchCwd, ".sous");
    fs.mkdirSync(launchSousDir, { recursive: true });
    const dumpScript = path.join(launchCwd, "dump-args.js");
    fs.writeFileSync(
      dumpScript,
      'require("fs").writeFileSync(process.env.DUMP_FILE, JSON.stringify(process.argv.slice(2)));\n'
    );
    launchDumpFile = path.join(launchCwd, "dump.json");
    launchConfigFile = path.join(launchSousDir, "sous.config.json");
    fs.writeFileSync(
      launchConfigFile,
      JSON.stringify({
        name: "Launch",
        tools: { dump: { command: process.execPath, args: [dumpScript, "--defined"] } },
      })
    );
  });

  afterAll(() => {
    tmp.cleanup();
  });

  // --- SOUS_CONFIG -----------------------------------------------------------

  /**
   * SOUS_CONFIG (a config FILE) selects the config even from a cwd where walk-up
   * discovery would find nothing.
   */
  it(
    "SOUS_CONFIG (file) selects a config from a bare cwd",
    () => {
      const { name, status } = getName({ cwd: bareCwd, env: { SOUS_CONFIG: primaryConfigFile } });
      expect(status).toBe(0);
      expect(name).toBe("PRIMARY");
    },
    CLI_TIMEOUT
  );

  /**
   * SOUS_CONFIG resolves with the SAME rules as --config: a DIRECTORY (the
   * project root) has its `.sous/` child searched for the config.
   */
  it(
    "SOUS_CONFIG (directory) resolves like --config",
    () => {
      const { name, status } = getName({ cwd: bareCwd, env: { SOUS_CONFIG: projBProjectRoot } });
      expect(status).toBe(0);
      expect(name).toBe("PROJB");
    },
    CLI_TIMEOUT
  );

  // --- SOUS_DIR --------------------------------------------------------------

  /**
   * SOUS_DIR points directly at a `.sous` directory; its primary config is used.
   */
  it(
    "SOUS_DIR selects a .sous directory",
    () => {
      const { name, status } = getName({ cwd: bareCwd, env: { SOUS_DIR: primarySousDir } });
      expect(status).toBe(0);
      expect(name).toBe("PRIMARY");
    },
    CLI_TIMEOUT
  );

  /**
   * Env-pair precedence: SOUS_CONFIG outranks SOUS_DIR (primary-config chain).
   */
  it(
    "SOUS_CONFIG beats SOUS_DIR",
    () => {
      const { name, status } = getName({
        cwd: bareCwd,
        env: { SOUS_CONFIG: projBConfigFile, SOUS_DIR: primarySousDir },
      });
      expect(status).toBe(0);
      expect(name).toBe("PROJB");
    },
    CLI_TIMEOUT
  );

  // --- SOUS_CONFD ------------------------------------------------------------

  /**
   * SOUS_CONFD swaps in an alternate conf.d layer directory: its layer overrides
   * `name`, so the layer-contributed value (not the primary's) is what we see.
   */
  it(
    "SOUS_CONFD swaps in an alternate layer directory",
    () => {
      const { name, status } = getName({
        cwd: bareCwd,
        env: { SOUS_CONFIG: primaryConfigFile, SOUS_CONFD: altConfdDir },
      });
      expect(status).toBe(0);
      expect(name).toBe("ALT_LAYER");
      // Sanity: without the override the same config yields the primary's name.
      expect(getName({ cwd: bareCwd, env: { SOUS_CONFIG: primaryConfigFile } }).name).toBe(
        "PRIMARY"
      );
    },
    CLI_TIMEOUT
  );

  // --- flag beats env, per pair ---------------------------------------------

  /**
   * --sous-config beats SOUS_CONFIG.
   */
  it(
    "--sous-config beats SOUS_CONFIG",
    () => {
      const { name, status } = getName({
        cwd: bareCwd,
        env: { SOUS_CONFIG: primaryConfigFile },
        flags: ["--sous-config", projBConfigFile],
      });
      expect(status).toBe(0);
      expect(name).toBe("PROJB");
    },
    CLI_TIMEOUT
  );

  /**
   * -c (the --config short form) also beats SOUS_CONFIG.
   */
  it(
    "-c beats SOUS_CONFIG",
    () => {
      const { name, status } = getName({
        cwd: bareCwd,
        env: { SOUS_CONFIG: primaryConfigFile },
        flags: ["-c", projBConfigFile],
      });
      expect(status).toBe(0);
      expect(name).toBe("PROJB");
    },
    CLI_TIMEOUT
  );

  /**
   * --sous-dir beats SOUS_DIR.
   */
  it(
    "--sous-dir beats SOUS_DIR",
    () => {
      const { name, status } = getName({
        cwd: bareCwd,
        env: { SOUS_DIR: primarySousDir },
        flags: ["--sous-dir", projBSousDir],
      });
      expect(status).toBe(0);
      expect(name).toBe("PROJB");
    },
    CLI_TIMEOUT
  );

  /**
   * --sous-confd beats SOUS_CONFD (both point at layer dirs that override name).
   */
  it(
    "--sous-confd beats SOUS_CONFD",
    () => {
      const { name, status } = getName({
        cwd: bareCwd,
        env: { SOUS_CONFIG: primaryConfigFile, SOUS_CONFD: altConfdDir },
        flags: ["--sous-confd", altBConfdDir],
      });
      expect(status).toBe(0);
      expect(name).toBe("ALTB_LAYER");
    },
    CLI_TIMEOUT
  );

  // --- real environment only, never .env.local -------------------------------

  /**
   * A SOUS_* var set only in `.sous/.env.local` is IGNORED: env vars are read
   * from the real environment BEFORE env files load (they decide where
   * `.env.local` even lives). Here SOUS_CONFD lives only in .env.local, so the
   * default (empty) conf.d is used and `name` stays the primary's.
   */
  it(
    "ignores SOUS_CONFD when it is set only in .sous/.env.local",
    () => {
      const { name, status } = getName({ cwd: envLocalProjectRoot });
      expect(status).toBe(0);
      expect(name).toBe("ENVLOCAL_PRIMARY");
    },
    CLI_TIMEOUT
  );

  /**
   * The counterpart: the SAME override honored when set in the REAL environment
   * takes effect (the alt layer overrides `name`), proving the previous test's
   * result is the .env.local source being ignored, not the override being inert.
   */
  it(
    "honors SOUS_CONFD when it is set in the real environment",
    () => {
      const { name, status } = getName({
        cwd: envLocalProjectRoot,
        env: { SOUS_CONFD: altConfdDir },
      });
      expect(status).toBe(0);
      expect(name).toBe("ALT_LAYER");
    },
    CLI_TIMEOUT
  );

  // --- launch pass-through of the alias flags --------------------------------

  /** Runs `xcv launch dump ...` and returns the argv the tool received. */
  function launch(...argv: string[]): { toolArgv: string[] | null; status: number | null } {
    fs.rmSync(launchDumpFile, { force: true });
    const env: Record<string, string | undefined> = { ...process.env, DUMP_FILE: launchDumpFile };
    delete env.SOUS_CONFIG;
    delete env.SOUS_DIR;
    delete env.SOUS_CONFD;
    const result = spawnSync(process.execPath, [binPath, "launch", "dump", ...argv], {
      cwd: launchCwd,
      encoding: "utf8",
      env,
    });
    const toolArgv = fs.existsSync(launchDumpFile)
      ? (JSON.parse(fs.readFileSync(launchDumpFile, "utf8")) as string[])
      : null;
    return { toolArgv, status: result.status };
  }

  /**
   * launch CONSUMES --sous-config (a declared sous flag): it is not forwarded to
   * the tool. The tool receives only its config-defined args plus other
   * pass-through flags.
   */
  it(
    "launch consumes --sous-config (does not forward it)",
    () => {
      const { toolArgv, status } = launch(
        "--no-build",
        "--sous-config",
        launchConfigFile,
        "--resume"
      );
      expect(status).toBe(0);
      expect(toolArgv).toEqual(["--defined", "--resume"]);
    },
    CLI_TIMEOUT
  );

  /**
   * After a bare `--`, --sous-config is FORWARDED verbatim (it belongs to the
   * tool), not consumed by sous.
   */
  it(
    "launch forwards --sous-config after a bare --",
    () => {
      const { toolArgv, status } = launch("--no-build", "--", "--sous-config", "x");
      expect(status).toBe(0);
      expect(toolArgv).toEqual(["--defined", "--sous-config", "x"]);
    },
    CLI_TIMEOUT
  );
});
