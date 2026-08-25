import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const binPath = path.join(repoRoot, "bin", "run.js");

/** Per-test timeout: each test boots the real CLI (tsx + oclif + config kernel) in a subprocess. */
const CLI_TIMEOUT = 30_000;

/**
 * Phase 2 end-to-end smoke test for composable config loading.
 *
 * A temp `.sous/` holds THREE layers of three different kinds:
 *   1. sous.config.yaml            — the YAML PRIMARY config (name, _vars, one target)
 *   2. conf.d/10-json.json         — a JSON drop-in layer contributing a second target
 *   3. conf.d/20-configure.js      — a JS `configure(config)` layer that mutates the live
 *                                    cumulative config to push a third target
 *
 * `xcv build --dry-run` runs the whole real pipeline: discovery enumerates the
 * conf.d layers, the config kernel subprocess parses/imports and deep-merges all
 * three (arrays concatenate, so every layer's target survives), then the build
 * reports each destination it WOULD write. Seeing all three destinations proves
 * the layers merged from three different file formats through the real binary.
 */
describe("multi-source config (YAML primary + conf.d JSON + conf.d configure JS)", () => {
  let tmp: TmpDir;
  let sousDir: string;

  /** Runs `xcv build --dry-run --config <sousDir>` and returns combined output. */
  function build(...extraArgs: string[]): { status: number | null; output: string } {
    const result = spawnSync(
      process.execPath,
      [binPath, "build", "--dry-run", "--config", sousDir, ...extraArgs],
      { cwd: tmp.path, encoding: "utf8" }
    );
    return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
  }

  beforeAll(() => {
    tmp = makeTmpDir("sous-multi-source-");
    sousDir = path.join(tmp.path, ".sous");
    const confDir = path.join(sousDir, "conf.d");
    fs.mkdirSync(confDir, { recursive: true });

    // Entry-point source files (one per layer's target) live inside .sous/.
    fs.writeFileSync(path.join(sousDir, "src-primary.md"), "PRIMARY SOURCE\n");
    fs.writeFileSync(path.join(sousDir, "src-json.md"), "JSON SOURCE\n");
    fs.writeFileSync(path.join(sousDir, "src-configure.md"), "CONFIGURE SOURCE\n");

    // 1. YAML PRIMARY. `${sousDir}` / `${projectRoot}` are literal var references
    //    resolved by sous at build time (written literally here on purpose).
    fs.writeFileSync(
      path.join(sousDir, "sous.config.yaml"),
      [
        "name: Demo Multi Source",
        "_vars:",
        "  projectRoot: ${sousDir}/..",
        "compilation:",
        "  targets:",
        "    - entryPoint: ${sousDir}/src-primary.md",
        "      outputs:",
        "        - destinationFile: ${projectRoot}/out-primary.md",
        "",
      ].join("\n")
    );

    // 2. JSON conf.d layer — a second compilation target. Arrays concatenate on
    //    merge, so this target is ADDED to the primary's, not replaced.
    fs.writeFileSync(
      path.join(confDir, "10-json.json"),
      JSON.stringify({
        compilation: {
          targets: [
            {
              entryPoint: "${sousDir}/src-json.md",
              outputs: [{ destinationFile: "${projectRoot}/out-json.md" }],
            },
          ],
        },
      })
    );

    // 3. JS configure() conf.d layer — mutates the live cumulative config by
    //    reference to push a third target. Exercises the configure() seam.
    fs.writeFileSync(
      path.join(confDir, "20-configure.js"),
      [
        "export function configure(config) {",
        "  config.compilation.targets.push({",
        '    entryPoint: "${sousDir}/src-configure.md",',
        '    outputs: [{ destinationFile: "${projectRoot}/out-configure.md" }],',
        "  });",
        "}",
        "",
      ].join("\n")
    );
  });

  afterAll(() => {
    tmp.cleanup();
  });

  /**
   * The dry-run must report a "(would write)" line for the destination from EACH
   * of the three layers, proving the YAML primary, the JSON conf.d layer, and the
   * JS configure conf.d layer were all discovered, loaded, and deep-merged into
   * one config by the real binary.
   */
  it(
    "should merge targets contributed by the primary and both conf.d layers",
    () => {
      const { status, output } = build();

      expect(status).toBe(0);

      // Primary (YAML) target.
      expect(output).toContain(path.join(tmp.path, "out-primary.md"));
      // conf.d JSON layer target.
      expect(output).toContain(path.join(tmp.path, "out-json.md"));
      // conf.d configure() JS layer target.
      expect(output).toContain(path.join(tmp.path, "out-configure.md"));

      // Each destination is a dry-run "would write", not an actual write.
      expect(output).toContain("(would write)");

      // The project name comes from the YAML primary — confirms YAML parsed.
      expect(output).toContain("Demo Multi Source");
    },
    CLI_TIMEOUT
  );

  /**
   * A layer's baseName is its filename minus the final extension, and must be
   * unique across every loaded config file. Two layers named `10-json.json` and
   * `10-json.yaml` collide; discovery must reject the build naming both files.
   */
  it(
    "should reject duplicate layer baseNames across conf.d",
    () => {
      const confDir = path.join(sousDir, "conf.d");
      const dupe = path.join(confDir, "10-json.yaml");
      fs.writeFileSync(dupe, "name: Dupe\n");
      try {
        const { status, output } = build();
        expect(status).not.toBe(0);
        expect(output).toContain("10-json");
        expect(output.toLowerCase()).toContain("basename");
      } finally {
        fs.rmSync(dupe, { force: true });
      }
    },
    CLI_TIMEOUT
  );
});
