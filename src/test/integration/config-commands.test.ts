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

/** ESC[ — the start of any ANSI escape sequence. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[/;

type RunResult = { stdout: string; stderr: string; status: number | null };

/**
 * Runs `xcv <args...>` through the real published bin, from `cwd`. SOUS_* env
 * vars are stripped so the child resolves its config purely by walk-up discovery
 * from `cwd` (an ambient SOUS_CONFIG in the runner's env must not leak in).
 */
function runXcv(cwd: string, ...args: string[]): RunResult {
  const env = { ...process.env };
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

/** Writes `content` to `<sousDir>/<rel>`, creating parent dirs. Returns the full path. */
function writeSous(sousDir: string, rel: string, content: string): string {
  const full = path.join(sousDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
  return full;
}

/**
 * These tests exercise the `xcv config *` inspection commands (show / get /
 * validate) end to end through the real CLI, against temp configs that use
 * conf.d layers: a primary config plus two drop-in layers, one overriding a
 * scalar and one appending a compilation target.
 *
 * `${...}` refs in fixtures are ordinary quoted strings (never template
 * literals) so they reach the child verbatim instead of interpolating here.
 */
describe("xcv config commands", () => {
  let tmp: TmpDir;
  let root: string;
  let sousDir: string;

  beforeAll(() => {
    tmp = makeTmpDir("sous-config-cmd-");
    root = tmp.path;
    sousDir = path.join(root, ".sous");

    // Primary config: name + one target + one tool.
    writeSous(
      sousDir,
      "sous.config.json",
      JSON.stringify({
        name: "primary-name",
        _vars: { projectRoot: "${sousDir}/.." },
        compilation: {
          targets: [
            {
              entryPoint: "${projectRoot}/a.md",
              outputs: [{ destinationFile: "${projectRoot}/out/a.md" }],
            },
          ],
        },
        tools: { claude: { command: "claude" } },
      })
    );

    // conf.d layer 1: override the scalar `name` (later layer wins).
    writeSous(sousDir, "conf.d/10-override.json", JSON.stringify({ name: "overridden-name" }));

    // conf.d layer 2: append a second compilation target (arrays concatenate).
    writeSous(
      sousDir,
      "conf.d/20-append.json",
      JSON.stringify({
        compilation: {
          targets: [
            {
              entryPoint: "${projectRoot}/b.md",
              outputs: [{ destinationFile: "${projectRoot}/out/b.md" }],
            },
          ],
        },
      })
    );
  });

  afterAll(() => {
    tmp.cleanup();
  });

  // --- config show -----------------------------------------------------------

  it(
    "config show pipes plain, valid JSON of the merged (pre-resolution) config",
    () => {
      const { stdout, status } = runXcv(root, "config", "show");
      expect(status).toBe(0);

      // Piped (not a TTY): output must be plain JSON with no ANSI color codes.
      expect(ANSI_RE.test(stdout)).toBe(false);

      const merged = JSON.parse(stdout) as {
        name: string;
        compilation: { targets: { entryPoint: string }[] };
      };
      // conf.d layer 1 overrode the scalar.
      expect(merged.name).toBe("overridden-name");
      // conf.d layer 2 appended a target, so both survive in order.
      expect(merged.compilation.targets).toHaveLength(2);
      expect(merged.compilation.targets.map((t) => t.entryPoint)).toEqual([
        "${projectRoot}/a.md",
        "${projectRoot}/b.md",
      ]);
      // Pre-resolution: the ${var} refs are printed as written, not expanded.
      expect(stdout).toContain("${projectRoot}/a.md");
    },
    CLI_TIMEOUT
  );

  // --- config get ------------------------------------------------------------

  it(
    "config get of a scalar prints it raw (no quotes)",
    () => {
      const { stdout, status } = runXcv(root, "config", "get", "name");
      expect(status).toBe(0);
      expect(stdout.trim()).toBe("overridden-name");
    },
    CLI_TIMEOUT
  );

  it(
    "config get of an object prints pretty JSON",
    () => {
      const { stdout, status } = runXcv(root, "config", "get", "tools");
      expect(status).toBe(0);
      expect(ANSI_RE.test(stdout)).toBe(false);
      const tools = JSON.parse(stdout) as Record<string, { command: string }>;
      expect(tools.claude.command).toBe("claude");
    },
    CLI_TIMEOUT
  );

  it(
    "config get with an array index reaches into the merged targets",
    () => {
      const { stdout, status } = runXcv(
        root,
        "config",
        "get",
        "compilation.targets[1].entryPoint"
      );
      expect(status).toBe(0);
      // Scalar, printed raw; the [1] target came from conf.d layer 2.
      expect(stdout.trim()).toBe("${projectRoot}/b.md");
    },
    CLI_TIMEOUT
  );

  it(
    "config get of a missing path exits non-zero with a helpful message",
    () => {
      const { stdout, stderr, status } = runXcv(root, "config", "get", "does.not.exist");
      expect(status).not.toBe(0);
      const out = `${stdout}\n${stderr}`;
      expect(out).toMatch(/does\.not\.exist/);
      expect(out).toMatch(/config show/);
    },
    CLI_TIMEOUT
  );

  it(
    "config get --layers lists each layer that changed the value, incl. the (unset) first change",
    () => {
      const { stdout, status } = runXcv(root, "config", "get", "name", "--layers");
      expect(status).toBe(0);

      // First layer (the primary) counts as a change from (unset).
      expect(stdout).toContain("(unset)");
      // Primary layer path shown relative to sousDir.
      expect(stdout).toMatch(/sous\.config\.json/);
      expect(stdout).toContain("primary-name");

      // The overriding conf.d layer is listed with old -> new.
      expect(stdout).toMatch(/10-override\.json/);
      expect(stdout).toContain("overridden-name");
      expect(stdout).toContain("->");

      // The non-changing layer (20-append) must NOT appear.
      expect(stdout).not.toMatch(/20-append\.json/);
    },
    CLI_TIMEOUT
  );

  // --- config validate (success) ---------------------------------------------

  it(
    "config validate exits 0 with a summary on the good config",
    () => {
      const { stdout, stderr, status } = runXcv(root, "config", "validate");
      expect(status).toBe(0);
      const out = `${stdout}\n${stderr}`;
      expect(out).toMatch(/valid/i);
      // Summary: config file, layer count (primary + 2 conf.d = 3), 2 targets, tool name.
      expect(out).toContain("sous.config.json");
      expect(out).toContain("3"); // Layers
      expect(out).toContain("2"); // Targets
      expect(out).toContain("claude"); // Tools
    },
    CLI_TIMEOUT
  );
});

// --- config validate (failures) ----------------------------------------------

/**
 * Each failure case gets its own temp `.sous/` so a broken config in one does
 * not affect the others. `config validate` must exit non-zero and name the
 * specific problem.
 */
describe("xcv config validate failures", () => {
  const tmps: TmpDir[] = [];

  /** Makes a fresh temp project whose `.sous/sous.config.json` is `config`. */
  function makeProject(config: unknown): string {
    const t = makeTmpDir("sous-config-fail-");
    tmps.push(t);
    writeSous(path.join(t.path, ".sous"), "sous.config.json", JSON.stringify(config));
    return t.path;
  }

  afterAll(() => {
    for (const t of tmps) t.cleanup();
  });

  it(
    "fails (non-zero) naming an unknown/typo top-level key",
    () => {
      const root = makeProject({ name: "x", notARealKey: true });
      const { stdout, stderr, status } = runXcv(root, "config", "validate");
      expect(status).not.toBe(0);
      const out = `${stdout}\n${stderr}`;
      expect(out).toContain("notARealKey");
      expect(out).toMatch(/typo/i);
    },
    CLI_TIMEOUT
  );

  it(
    "fails (non-zero) naming an undefined ${var} in _vars (fixpoint error)",
    () => {
      // "${bogus}" is a plain quoted string, so it reaches the child verbatim.
      const root = makeProject({ name: "x", _vars: { thing: "${bogus}" } });
      const { stdout, stderr, status } = runXcv(root, "config", "validate");
      expect(status).not.toBe(0);
      const out = `${stdout}\n${stderr}`;
      expect(out).toContain("bogus");
      expect(out).toMatch(/unresolved|undefined/i);
    },
    CLI_TIMEOUT
  );

  it(
    "fails (non-zero) on a duplicate conf.d layer baseName",
    () => {
      const t = makeTmpDir("sous-config-fail-");
      tmps.push(t);
      const sd = path.join(t.path, ".sous");
      writeSous(sd, "sous.config.json", JSON.stringify({ name: "x" }));
      // Same baseName, different extensions: an ambiguous merge order, rejected.
      writeSous(sd, "conf.d/500-repos.json", JSON.stringify({ _vars: { a: "1" } }));
      writeSous(sd, "conf.d/500-repos.yaml", "_vars:\n  b: '2'\n");

      const { stdout, stderr, status } = runXcv(t.path, "config", "validate");
      expect(status).not.toBe(0);
      const out = `${stdout}\n${stderr}`;
      expect(out).toMatch(/duplicate config layer basename/i);
      expect(out).toContain("500-repos");
    },
    CLI_TIMEOUT
  );
});
