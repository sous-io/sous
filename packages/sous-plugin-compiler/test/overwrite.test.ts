/**
 * Files the compiler did not write: overwritten and taken over by default; left alone, with
 * a warning, when `compilation.overwriteUntracked` is `false`.
 */

import { afterEach, describe, expect, it } from "vitest";
import { compileOnce, makeProject, type TestProject } from "./helpers.js";

let project: TestProject;

afterEach(() => {
    project?.remove();
});

describe("compilation.overwriteUntracked", () => {
    /** By default the user's file is overwritten, and from then on sous owns it. */
    it("should overwrite a file sous did not write and take it over", async () => {
        project = makeProject();
        const src = project.write("src.md", "COMPILED");
        const dest = project.write("CLAUDE.md", "the user's own");
        const { result, compiler } = await compileOnce(project, { targets: [{ entryPoint: src, outputs: [{ destinationFile: dest }] }] });

        expect(result.ok).toBe(true);
        expect(result.outputs[0]?.action).toBe("updated");
        expect(project.read("CLAUDE.md")).toBe("COMPILED");
        expect(compiler.engine.handle.config.services.get("compiler.state").isTracked(dest)).toBe(true);
    });

    /** With `false`, the file stays as it is, the compile warns, and strict mode fails. */
    it("should leave a file sous did not write alone when overwriteUntracked is false", async () => {
        project = makeProject();
        const src = project.write("src.md", "COMPILED");
        const dest = project.write("CLAUDE.md", "the user's own");
        const compilation = { overwriteUntracked: false, targets: [{ entryPoint: src, outputs: [{ destinationFile: dest }] }] };
        const { result, compiler } = await compileOnce(project, compilation);

        expect(result.ok).toBe(true);
        expect(result.outputs[0]?.action).toBe("skipped-untracked");
        expect(result.problems).toEqual([expect.objectContaining({ level: "warning", file: dest })]);
        expect(compiler.output()).toContain("compilation.overwriteUntracked is false");
        expect(project.read("CLAUDE.md")).toBe("the user's own");
        expect(compiler.engine.handle.config.services.get("compiler.state").isTracked(dest)).toBe(false);

        const strict = await compileOnce(project, compilation, { strict: true });

        expect(strict.result.ok).toBe(false);
    });

    /**
     * An output with `backupExisting` backs up and overwrites a file sous did not write even when
     * overwriteUntracked is false, and says so as a warning.
     *
     * CLAUDE.md "the user's own", overwriteUntracked false, backupExisting true
     * // -> CLAUDE.md "COMPILED"; .sous/backups/<date>/<time>/CLAUDE.md "the user's own"; one warning
     */
    it("should back up, warn and overwrite for an output with backupExisting", async () => {
        project = makeProject();
        const src = project.write("src.md", "COMPILED");
        const dest = project.write("CLAUDE.md", "the user's own");
        const compilation = { overwriteUntracked: false, targets: [{ entryPoint: src, outputs: [{ destinationFile: dest, backupExisting: true }] }] };
        const { result } = await compileOnce(project, compilation);

        expect(result.ok).toBe(true);
        expect(result.outputs[0]?.action).toBe("updated");
        expect(result.outputs[0]?.backup).toContain(`${project.sousDir}/backups/`);
        expect(result.problems).toEqual([expect.objectContaining({ level: "warning", file: dest, message: expect.stringContaining("was not written by sous") })]);
        expect(project.read("CLAUDE.md")).toBe("COMPILED");
    });
});
