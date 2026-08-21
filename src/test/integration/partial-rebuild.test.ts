import path from "node:path";
import fs from "node:fs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { makeSettings } from "../utils/settings.js";
import type { ConfigContext, Settings } from "../../lib/settings.js";
import { BuildService, type BuildOptions } from "../../lib/build-service.js";
import { StateService } from "../../lib/state.js";

describe("BuildService", () => {
  describe("build() with changedFile", () => {
    let tmp: TmpDir;
    let configContext: ConfigContext;

    /**
     * Builds a Settings object for the "proj" project. The state file location
     * comes from the ConfigContext (the tmp dir stands in for `.sous/`), which
     * keeps state out of the repo working directory.
     *
     * Mirrors the same helper pattern used in build-service.test.ts.
     */
    function makeProjectSettings(
      projectOverrides: Parameters<typeof makeSettings>[1]
    ): Settings {
      return makeSettings("proj", projectOverrides);
    }

    /** Runs build() with the test's ConfigContext attached. */
    function build(
      service: BuildService,
      settings: Settings,
      options: BuildOptions = {}
    ): Promise<boolean> {
      return service.build("proj", settings, { ...options, configContext });
    }

    beforeEach(() => {
      tmp = makeTmpDir();
      configContext = {
        sousDir: tmp.path,
        configPath: path.join(tmp.path, "sous.config.js"),
      };
      vi.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
      tmp.cleanup();
      vi.restoreAllMocks();
    });

    /**
     * When changedFile points to source A, only target A's output is compiled.
     * Target B's output is NOT written because target B does not include source A.
     *
     * Example:
     *   - a.md  → output-a.md  (target A)
     *   - b.md  → output-b.md  (target B)
     *   changedFile = a.md
     *   Result: output-a.md exists; output-b.md does NOT exist.
     */
    it("should compile only the target whose entry point matches changedFile", async () => {
      const srcA = path.join(tmp.path, "a.md");
      const srcB = path.join(tmp.path, "b.md");
      const destA = path.join(tmp.path, "output-a.md");
      const destB = path.join(tmp.path, "output-b.md");

      fs.writeFileSync(srcA, "# File A\n", "utf8");
      fs.writeFileSync(srcB, "# File B\n", "utf8");

      const settings = makeProjectSettings({
        name: "Test Project",
        compilation: {
          targets: [
            { entryPoint: srcA, outputs: [{ destinationFile: destA }] },
            { entryPoint: srcB, outputs: [{ destinationFile: destB }] },
          ],
        },
      });

      const service = new BuildService();
      const ok = await build(service, settings, { changedFile: srcA });

      expect(ok).toBe(true);
      expect(fs.existsSync(destA)).toBe(true);
      expect(fs.existsSync(destB)).toBe(false);
    });

    /**
     * When changedFile is a file included via @include in an entry point,
     * the target that owns that entry point IS compiled, because changedFile
     * is transitively reachable from the target's rootInputPath.
     *
     * Example:
     *   - entry.md contains `@included.md`
     *   - target: entryPoint=entry.md → output.md
     *   changedFile = included.md
     *   Result: output.md exists (entry.md was recompiled due to the include chain).
     */
    it("should compile a target when changedFile is transitively included by its entry point", async () => {
      const includedFile = path.join(tmp.path, "included.md");
      const entryFile = path.join(tmp.path, "entry.md");
      const destFile = path.join(tmp.path, "output.md");

      fs.writeFileSync(includedFile, "## Included Section\n\nSome shared content.\n", "utf8");
      fs.writeFileSync(entryFile, "# Entry\n\n@included.md\n", "utf8");

      const settings = makeProjectSettings({
        name: "Test Project",
        compilation: {
          targets: [
            { entryPoint: entryFile, outputs: [{ destinationFile: destFile }] },
          ],
        },
      });

      const service = new BuildService();
      const ok = await build(service, settings, { changedFile: includedFile });

      expect(ok).toBe(true);
      expect(fs.existsSync(destFile)).toBe(true);
    });

    /**
     * When changedFile is not referenced by any compilation target (neither as
     * an entry point nor via any @include chain), no output files are written.
     * The build should still return true — this is a clean no-op, not an error.
     *
     * Example:
     *   - a.md  → output-a.md  (target A, no includes)
     *   changedFile = /tmp/unrelated.md  (not in any target's include graph)
     *   Result: output-a.md does NOT exist; build returns true.
     */
    it("should write no output and return true when changedFile is not in any target's include graph", async () => {
      const srcA = path.join(tmp.path, "a.md");
      const destA = path.join(tmp.path, "output-a.md");
      const unrelated = path.join(tmp.path, "unrelated.md");

      fs.writeFileSync(srcA, "# File A\n", "utf8");
      fs.writeFileSync(unrelated, "# Unrelated\n", "utf8");

      const settings = makeProjectSettings({
        name: "Test Project",
        compilation: {
          targets: [
            { entryPoint: srcA, outputs: [{ destinationFile: destA }] },
          ],
        },
      });

      const service = new BuildService();
      const ok = await build(service, settings, { changedFile: unrelated });

      expect(ok).toBe(true);
      expect(fs.existsSync(destA)).toBe(false);
    });

    /**
     * When changedFile is omitted entirely, all compilation targets are compiled
     * regardless of which file changed (full rebuild).
     *
     * Example:
     *   - a.md  → output-a.md  (target A)
     *   - b.md  → output-b.md  (target B)
     *   No changedFile supplied.
     *   Result: both output-a.md and output-b.md exist.
     */
    it("should compile all targets when changedFile is not provided", async () => {
      const srcA = path.join(tmp.path, "a.md");
      const srcB = path.join(tmp.path, "b.md");
      const destA = path.join(tmp.path, "output-a.md");
      const destB = path.join(tmp.path, "output-b.md");

      fs.writeFileSync(srcA, "# File A\n", "utf8");
      fs.writeFileSync(srcB, "# File B\n", "utf8");

      const settings = makeProjectSettings({
        name: "Test Project",
        compilation: {
          targets: [
            { entryPoint: srcA, outputs: [{ destinationFile: destA }] },
            { entryPoint: srcB, outputs: [{ destinationFile: destB }] },
          ],
        },
      });

      const service = new BuildService();
      const ok = await build(service, settings);

      expect(ok).toBe(true);
      expect(fs.existsSync(destA)).toBe(true);
      expect(fs.existsSync(destB)).toBe(true);
    });

    /**
     * A partial rebuild must not truncate the state file to the changed target.
     *
     * During `build --watch`, a change to source A narrows compilation to target A.
     * The compiler writes state from what it compiled this pass, so without the
     * carry-forward merge, target B's entry vanished from state on every watch
     * event — leaving clear/prune blind to output-b.md for the rest of the session.
     *
     * Example: full build writes output-a.md and output-b.md → state = [A, B].
     * build({changedFile: a.md}) compiles only target A.
     * Expected: state still contains BOTH entries.
     */
    it("should keep other targets' state entries after a partial rebuild", async () => {
      const srcA = path.join(tmp.path, "a.md");
      const srcB = path.join(tmp.path, "b.md");
      const destA = path.join(tmp.path, "output-a.md");
      const destB = path.join(tmp.path, "output-b.md");

      fs.writeFileSync(srcA, "# File A\n", "utf8");
      fs.writeFileSync(srcB, "# File B\n", "utf8");

      const settings = makeProjectSettings({
        name: "Test Project",
        compilation: {
          targets: [
            { entryPoint: srcA, outputs: [{ destinationFile: destA }] },
            { entryPoint: srcB, outputs: [{ destinationFile: destB }] },
          ],
        },
      });

      const service = new BuildService();
      await build(service, settings);

      // Touch source A and rebuild only its target, as the watcher would
      fs.writeFileSync(srcA, "# File A (edited)\n", "utf8");
      const ok = await build(service, settings, { changedFile: srcA });
      expect(ok).toBe(true);

      const stateService = new StateService();
      const state = await stateService.load(path.join(tmp.path, "sous.state.json"));
      expect(state?.files.find((f) => f.dest === destA)).toBeDefined();
      expect(state?.files.find((f) => f.dest === destB)).toBeDefined();
    });
  });
});
