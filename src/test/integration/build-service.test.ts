import path from "node:path";
import fs from "node:fs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { makeSettings } from "../utils/settings.js";
import type { ConfigContext, Settings } from "../../lib/settings.js";
import { BuildService, resolveStateFilePath, type BuildOptions } from "../../lib/build-service.js";
import { StateService } from "../../lib/state.js";

describe("BuildService", () => {
  let tmp: TmpDir;
  let srcFile: string;
  let destFile: string;
  let stateFilePath: string;
  let configContext: ConfigContext;

  /**
   * Builds a Settings object for the "proj" project. No path vars are needed:
   * the state file location comes from the ConfigContext (the discovered `.sous/`
   * directory), which the tmp dir stands in for.
   */
  function makeProjectSettings(
    projectOverrides: Parameters<typeof makeSettings>[1]
  ): Settings {
    return makeSettings("proj", projectOverrides);
  }

  /**
   * Runs BuildService.build() with the test's ConfigContext attached, mirroring
   * how the commands call it.
   */
  function build(
    service: BuildService,
    settings: Settings,
    options: BuildOptions = {}
  ): Promise<boolean> {
    return service.build("proj", settings, { ...options, configContext });
  }

  beforeEach(() => {
    tmp = makeTmpDir();
    srcFile = path.join(tmp.path, "source.md");
    destFile = path.join(tmp.path, "output.md");
    configContext = {
      sousDir: tmp.path,
      configPath: path.join(tmp.path, "sous.config.js"),
    };
    // Single-project config → the state file sits directly in the .sous/ dir.
    stateFilePath = path.join(tmp.path, "sous.state.json");

    fs.writeFileSync(srcFile, "# Hello\n\nThis is test content.\n", "utf8");

    // Suppress compiler output during tests
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    tmp.cleanup();
    vi.restoreAllMocks();
  });

  describe("build()", () => {
    /**
     * build() should compile the entry point and write the output file to the
     * destination path specified in the settings.
     *
     * Given a settings object with entryPoint=source.md and destinationFile=output.md,
     * after build() completes, output.md should exist on disk with the same content
     * as source.md.
     */
    it("should compile and write the output file", async () => {
      const settings = makeProjectSettings({
        name: "Test Project",
        compilation: {
          targets: [
            {
              entryPoint: srcFile,
              outputs: [{ destinationFile: destFile }],
            },
          ],
        },
      });

      const service = new BuildService();
      const ok = await build(service, settings);

      expect(ok).toBe(true);
      expect(fs.existsSync(destFile)).toBe(true);
      expect(fs.readFileSync(destFile, "utf8")).toBe(
        "# Hello\n\nThis is test content.\n"
      );
    });

    /**
     * build() should create a sous.state.json file recording the output file.
     * For a single-project config the state file goes in the discovered `.sous/`
     * directory: <sousDir>/sous.state.json.
     *
     * Given sousDir=tmp.path, the state file should be at tmp/sous.state.json and
     * contain an entry for the output file.
     */
    it("should write a state file containing the output file entry", async () => {
      const settings = makeProjectSettings({
        name: "Test Project",
        compilation: {
          targets: [
            {
              entryPoint: srcFile,
              outputs: [{ destinationFile: destFile }],
            },
          ],
        },
      });

      const service = new BuildService();
      await build(service, settings);

      expect(fs.existsSync(stateFilePath)).toBe(true);

      const stateService = new StateService();
      const state = await stateService.load(stateFilePath);

      expect(state).not.toBeNull();
      expect(state!.files.length).toBeGreaterThan(0);

      const entry = state!.files.find((f) => f.dest === destFile);
      expect(entry).toBeDefined();
      expect(entry!.dest).toBe(destFile);
    });

    /**
     * build() with noCompile: true should skip the compilation step entirely,
     * so the destination file is not created.
     *
     * Given noCompile=true, the output file should not exist after build().
     * The prune step still runs (with no state to prune, it is a no-op).
     */
    it("should skip compilation when noCompile is true", async () => {
      const settings = makeProjectSettings({
        name: "Test Project",
        compilation: {
          targets: [
            {
              entryPoint: srcFile,
              outputs: [{ destinationFile: destFile }],
            },
          ],
        },
      });

      const service = new BuildService();
      const ok = await build(service, settings, { noCompile: true });

      expect(ok).toBe(true);
      expect(fs.existsSync(destFile)).toBe(false);
    });

    /**
     * build() with noPrune: true should run compilation but skip the prune step.
     * A stale file that was previously written and is no longer in config should remain.
     *
     * Step 1: build() writes staleFile to disk and records it in state.
     * Step 2: build() with new config (no staleFile) and noPrune=true — staleFile survives.
     */
    it("should skip pruning when noPrune is true", async () => {
      const staleFile = path.join(tmp.path, "stale.md");

      // First build: write staleFile
      const settingsV1 = makeProjectSettings({
        name: "Test Project",
        compilation: {
          targets: [
            {
              entryPoint: srcFile,
              outputs: [{ destinationFile: staleFile }],
            },
          ],
        },
      });

      const service = new BuildService();
      await build(service, settingsV1);
      expect(fs.existsSync(staleFile)).toBe(true);

      // Second build: new config points to destFile, noPrune=true — staleFile must survive
      const settingsV2 = makeProjectSettings({
        name: "Test Project",
        compilation: {
          targets: [
            {
              entryPoint: srcFile,
              outputs: [{ destinationFile: destFile }],
            },
          ],
        },
      });

      await build(service, settingsV2, { noPrune: true });

      expect(fs.existsSync(staleFile)).toBe(true);
    });
  });

  describe("prune()", () => {
    /**
     * prune() removes a file that was written in a previous build but is no longer in config.
     *
     * The intended workflow is:
     *   1. build() compiles and writes outputs, recording them in state.
     *   2. Config changes — an output is removed.
     *   3. build({ noCompile: true }) runs prune-only: the old state still lists staleFile,
     *      the new config does not, so prune deletes staleFile and updates state.
     *
     * Example: V1 writes stale.md → state = [stale.md]. V2 config has destFile only.
     * build(V2, noCompile) → stale.md deleted; state = [].
     */
    it("should remove a file that is no longer in the config", async () => {
      const staleFile = path.join(tmp.path, "stale.md");

      // V1: compile and record staleFile in state
      const settingsV1 = makeProjectSettings({
        name: "Test Project",
        compilation: {
          targets: [
            {
              entryPoint: srcFile,
              outputs: [{ destinationFile: staleFile }],
            },
          ],
        },
      });

      const service = new BuildService();
      await build(service, settingsV1);
      expect(fs.existsSync(staleFile)).toBe(true);

      // V2: config no longer references staleFile; run prune-only so the old state is visible
      const settingsV2 = makeProjectSettings({
        name: "Test Project",
        compilation: {
          targets: [
            {
              entryPoint: srcFile,
              outputs: [{ destinationFile: destFile }],
            },
          ],
        },
      });

      await build(service, settingsV2, { noCompile: true });

      expect(fs.existsSync(staleFile)).toBe(false);

      const stateService = new StateService();
      const state = await stateService.load(stateFilePath);
      const staleEntry = state?.files.find((f) => f.dest === staleFile);
      expect(staleEntry).toBeUndefined();
    });

    /**
     * A PLAIN build (compile + prune, no flags) removes a file dropped from the config.
     *
     * This is the everyday workflow — edit the config, run `xcv build` — with no
     * noCompile workaround. It regresses the orphaning bug where compile replaced
     * state.files wholesale with only the current pass's outputs, so by the time
     * prune ran the dropped file was already gone from state and survived on disk
     * forever (no later prune, build, or clear could ever find it).
     *
     * Example: V1 writes stale.md and keep.md → state = [stale.md, keep.md].
     * V2 config drops stale.md. Plain build(V2) → stale.md deleted from disk and
     * state; keep.md untouched.
     */
    it("should remove a file dropped from the config on a plain build", async () => {
      const staleFile = path.join(tmp.path, "stale.md");

      // V1: two outputs from the same source
      const settingsV1 = makeProjectSettings({
        name: "Test Project",
        compilation: {
          targets: [
            {
              entryPoint: srcFile,
              outputs: [
                { destinationFile: destFile },
                { destinationFile: staleFile },
              ],
            },
          ],
        },
      });

      const service = new BuildService();
      await build(service, settingsV1);
      expect(fs.existsSync(staleFile)).toBe(true);

      // V2: staleFile is dropped; run a PLAIN build — no noCompile, no rebuild
      const settingsV2 = makeProjectSettings({
        name: "Test Project",
        compilation: {
          targets: [
            {
              entryPoint: srcFile,
              outputs: [{ destinationFile: destFile }],
            },
          ],
        },
      });

      await build(service, settingsV2);

      expect(fs.existsSync(staleFile)).toBe(false);
      expect(fs.existsSync(destFile)).toBe(true);

      const stateService = new StateService();
      const state = await stateService.load(stateFilePath);
      expect(state?.files.find((f) => f.dest === staleFile)).toBeUndefined();
      expect(state?.files.find((f) => f.dest === destFile)).toBeDefined();
    });

    /**
     * prune() removes an empty Sous-created directory after its last output file is pruned.
     *
     * Step 1: build() writes output into a new subdirectory and records the dir in state.dirs.
     * Step 2: build({ noCompile: true }) with new config omits that output.
     * Expected: the file is deleted, the now-empty directory is removed, state.dirs is updated.
     */
    it("should remove an empty Sous-created directory after its file is pruned", async () => {
      const subDir = path.join(tmp.path, "sous-created-dir");
      const staleFile = path.join(subDir, "output.md");

      const settingsV1 = makeProjectSettings({
        name: "Test Project",
        compilation: {
          targets: [
            {
              entryPoint: srcFile,
              outputs: [{ destinationFile: staleFile }],
            },
          ],
        },
      });

      const service = new BuildService();
      await build(service, settingsV1);
      expect(fs.existsSync(staleFile)).toBe(true);
      expect(fs.existsSync(subDir)).toBe(true);

      // Verify the dir was tracked in state
      const stateService = new StateService();
      const stateBefore = await stateService.load(stateFilePath);
      expect(stateBefore).not.toBeNull();
      expect(stateBefore!.dirs).toContain(subDir);

      // V2: prune-only — new config has destFile instead of staleFile
      const settingsV2 = makeProjectSettings({
        name: "Test Project",
        compilation: {
          targets: [
            {
              entryPoint: srcFile,
              outputs: [{ destinationFile: destFile }],
            },
          ],
        },
      });

      await build(service, settingsV2, { noCompile: true });

      expect(fs.existsSync(staleFile)).toBe(false);
      expect(fs.existsSync(subDir)).toBe(false);

      const stateAfter = await stateService.load(stateFilePath);
      expect(stateAfter!.dirs).not.toContain(subDir);
    });

    /**
     * prune() leaves a Sous-created directory that still contains non-stale files.
     *
     * Step 1: build() writes two outputs into the same subDir (kept.md and stale.md).
     * Step 2: build({ noCompile: true }) with config that only lists kept.md — stale.md pruned.
     * Expected: subDir and kept.md survive; stale.md is deleted.
     */
    it("should leave a directory that still contains non-stale files", async () => {
      const subDir = path.join(tmp.path, "shared-dir");
      const keptFile = path.join(subDir, "kept.md");
      const staleFile = path.join(subDir, "stale.md");

      // Two source files, one per output
      const srcFile2 = path.join(tmp.path, "source2.md");
      fs.writeFileSync(srcFile2, "# Source 2\n", "utf8");

      const settingsV1 = makeProjectSettings({
        name: "Test Project",
        compilation: {
          targets: [
            {
              entryPoint: srcFile,
              outputs: [{ destinationFile: keptFile }],
            },
            {
              entryPoint: srcFile2,
              outputs: [{ destinationFile: staleFile }],
            },
          ],
        },
      });

      const service = new BuildService();
      await build(service, settingsV1);
      expect(fs.existsSync(keptFile)).toBe(true);
      expect(fs.existsSync(staleFile)).toBe(true);

      // V2: prune-only — only keptFile is in the new config
      const settingsV2 = makeProjectSettings({
        name: "Test Project",
        compilation: {
          targets: [
            {
              entryPoint: srcFile,
              outputs: [{ destinationFile: keptFile }],
            },
          ],
        },
      });

      await build(service, settingsV2, { noCompile: true });

      expect(fs.existsSync(staleFile)).toBe(false);
      expect(fs.existsSync(keptFile)).toBe(true);
      expect(fs.existsSync(subDir)).toBe(true);
    });

    /**
     * When dryRun is true, prune() logs "would prune" for each stale file but does not
     * delete anything from disk, and the state file remains unchanged.
     *
     * Step 1: build() writes staleFile and saves state = [staleFile].
     * Step 2: build({ noCompile: true, dryRun: true }) with new config (no staleFile).
     * Expected: staleFile still on disk; state still references staleFile; log says "would prune".
     */
    it("should log 'would prune' but not delete files when dryRun is true", async () => {
      const staleFile = path.join(tmp.path, "stale.md");

      const settingsV1 = makeProjectSettings({
        name: "Test Project",
        compilation: {
          targets: [
            {
              entryPoint: srcFile,
              outputs: [{ destinationFile: staleFile }],
            },
          ],
        },
      });

      const service = new BuildService();
      await build(service, settingsV1);
      expect(fs.existsSync(staleFile)).toBe(true);

      // Capture log calls for the dry-run prune
      const logCalls: string[] = [];
      vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logCalls.push(args.map(String).join(" "));
      });

      const settingsV2 = makeProjectSettings({
        name: "Test Project",
        compilation: {
          targets: [
            {
              entryPoint: srcFile,
              outputs: [{ destinationFile: destFile }],
            },
          ],
        },
      });

      // noCompile so the old state (with staleFile) is still on disk when prune runs
      await build(service, settingsV2, { noCompile: true, dryRun: true });

      // staleFile must NOT have been deleted
      expect(fs.existsSync(staleFile)).toBe(true);

      // A "would prune" message must have been logged
      const wouldPruneLog = logCalls.some((msg) => msg.includes("would prune"));
      expect(wouldPruneLog).toBe(true);

      // State must still reference staleFile (dry-run must not mutate state)
      const stateService = new StateService();
      const state = await stateService.load(stateFilePath);
      const staleEntry = state?.files.find((f) => f.dest === staleFile);
      expect(staleEntry).toBeDefined();
    });
  });

  describe("resolveStateFilePath()", () => {
    /**
     * resolveStateFilePath() should default to <sousDir>/sous.state.json for a
     * config that defines one project.
     *
     * resolveStateFilePath("proj", oneProjectSettings, { sousDir: "<tmp>", ... });
     * // -> "<tmp>/sous.state.json"
     */
    it("should default to <sousDir>/sous.state.json for a single-project config", () => {
      const settings = makeProjectSettings({ name: "Test Project" });
      expect(resolveStateFilePath("proj", settings, configContext)).toBe(
        path.join(tmp.path, "sous.state.json")
      );
    });

    /**
     * resolveStateFilePath() should qualify the file name with the project key
     * when the config defines several projects, so they cannot share one state file.
     *
     * // settings.projects has "a" and "b"
     * resolveStateFilePath("a", settings, ctx); // -> "<tmp>/a.sous.state.json"
     */
    it("should include the project key when the config has several projects", () => {
      const settings: Settings = {
        projects: { a: { name: "A" }, b: { name: "B" } },
      };
      expect(resolveStateFilePath("a", settings, configContext)).toBe(
        path.join(tmp.path, "a.sous.state.json")
      );
      expect(resolveStateFilePath("b", settings, configContext)).toBe(
        path.join(tmp.path, "b.sous.state.json")
      );
    });

    /**
     * resolveStateFilePath() should honour a `stateFilePath` var defined at the
     * PROJECT level. Resolving from the root scope alone was a bug: a project-level
     * override was ignored and state silently landed in cwd.
     *
     * // project _vars: { stateFilePath: "<tmp>/custom.json" }
     * resolveStateFilePath("proj", settings, ctx); // -> "<tmp>/custom.json"
     */
    it("should honour a stateFilePath var defined at the project level", () => {
      const custom = path.join(tmp.path, "custom-state.json");
      const settings = makeProjectSettings({
        name: "Test Project",
        _vars: { stateFilePath: custom },
      });
      expect(resolveStateFilePath("proj", settings, configContext)).toBe(custom);
    });

    /**
     * resolveStateFilePath() should honour a root-level `stateFilePath` var too,
     * since project scope inherits from root scope.
     *
     * // settings._vars: { stateFilePath: "<tmp>/root-state.json" }
     * resolveStateFilePath("proj", settings, ctx); // -> "<tmp>/root-state.json"
     */
    it("should honour a stateFilePath var defined at the root level", () => {
      const custom = path.join(tmp.path, "root-state.json");
      const settings: Settings = {
        _vars: { stateFilePath: custom },
        projects: { proj: { name: "Test Project" } },
      };
      expect(resolveStateFilePath("proj", settings, configContext)).toBe(custom);
    });

    /**
     * resolveStateFilePath() should let a project-level `stateFilePath` override a
     * root-level one, and should resolve `${sousDir}` inside it.
     *
     * // root _vars sets one path; project _vars sets "${sousDir}/proj-state.json"
     * resolveStateFilePath("proj", settings, ctx); // -> "<tmp>/proj-state.json"
     */
    it("should let the project level override the root level and resolve ${sousDir}", () => {
      const settings: Settings = {
        _vars: { stateFilePath: path.join(tmp.path, "root-state.json") },
        projects: {
          proj: {
            name: "Test Project",
            _vars: { stateFilePath: "${sousDir}/proj-state.json" },
          },
        },
      };
      expect(resolveStateFilePath("proj", settings, configContext)).toBe(
        path.join(tmp.path, "proj-state.json")
      );
    });
  });
});
