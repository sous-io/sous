import path from "node:path";
import fs from "node:fs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { makeSettings } from "../utils/settings.js";
import type { Settings } from "../../lib/settings.js";
import { BuildService } from "../../lib/build-service.js";
import { StateService } from "../../lib/state.js";

describe("BuildService", () => {
  let tmp: TmpDir;
  let srcFile: string;
  let destFile: string;
  let stateFilePath: string;

  /**
   * Builds a Settings object with configsRoot set at the root _vars level so
   * that StateService.getFilePath (which receives the resolved root scope) can
   * derive the state file path correctly.
   *
   * BuildService calls resolveRootScope(settings) and passes the result to
   * StateService.getFilePath — so configsRoot must live in settings._vars, not
   * in a project-level _vars block.
   */
  function makeProjectSettings(
    projectOverrides: Parameters<typeof makeSettings>[1]
  ): Settings {
    const base = makeSettings("proj", projectOverrides);
    return { ...base, _vars: { configsRoot: tmp.path } };
  }

  beforeEach(() => {
    tmp = makeTmpDir();
    srcFile = path.join(tmp.path, "source.md");
    destFile = path.join(tmp.path, "output.md");
    stateFilePath = path.join(tmp.path, "projects", "proj", "sous.state.json");

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
      const ok = await service.build("proj", settings);

      expect(ok).toBe(true);
      expect(fs.existsSync(destFile)).toBe(true);
      expect(fs.readFileSync(destFile, "utf8")).toBe(
        "# Hello\n\nThis is test content.\n"
      );
    });

    /**
     * build() should create a sous.state.json file recording the output file.
     * The state file is derived from configsRoot: <configsRoot>/projects/<key>/sous.state.json.
     *
     * Given configsRoot=tmp.path and projectKey="proj", the state file should be at
     * tmp/projects/proj/sous.state.json and contain an entry for the output file.
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
      await service.build("proj", settings);

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
      const ok = await service.build("proj", settings, { noCompile: true });

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
      await service.build("proj", settingsV1);
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

      await service.build("proj", settingsV2, { noPrune: true });

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
      await service.build("proj", settingsV1);
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

      await service.build("proj", settingsV2, { noCompile: true });

      expect(fs.existsSync(staleFile)).toBe(false);

      const stateService = new StateService();
      const state = await stateService.load(stateFilePath);
      const staleEntry = state?.files.find((f) => f.dest === staleFile);
      expect(staleEntry).toBeUndefined();
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
      await service.build("proj", settingsV1);
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

      await service.build("proj", settingsV2, { noCompile: true });

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
      await service.build("proj", settingsV1);
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

      await service.build("proj", settingsV2, { noCompile: true });

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
      await service.build("proj", settingsV1);
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
      await service.build("proj", settingsV2, { noCompile: true, dryRun: true });

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
});
