/**
 * The `compiler.files` contributor: every file a build writes is its own entry in the config,
 * listed while the config is built, and the compiler compiles those entries.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { CompilationFile } from "../src/types.js";
import { makeCompiler, makeProject, type TestProject } from "./helpers.js";

let project: TestProject;

afterEach(() => {
    project?.remove();
});

describe("compilation.files", () => {
    /** A glob target becomes one entry per matched file and output, with its source and destination. */
    it("should list one entry per matched file and output", async () => {
        project = makeProject();
        project.write("docs/a.md", "A");
        project.write("docs/deep/b.tpl.md", "B");

        const compiler = await makeCompiler(project, {
            config: { compilation: { targets: [{ id: "docs", entryGlob: "docs/**/*.md", outputs: [{ destinationDir: "${projectRoot}/out" }, { destinationDir: "${projectRoot}/copy", harness: "codex" }] }] } },
        });
        const files = compiler.engine.handle.config.get<CompilationFile[]>("compilation.files");

        expect(files).toEqual([
            { target: "docs", targetIndex: 0, source: project.at("docs", "a.md"), output: 0, destination: project.at("out", "a.md") },
            { target: "docs", targetIndex: 0, source: project.at("docs", "a.md"), output: 1, destination: project.at("copy", "a.md"), harness: "codex" },
            { target: "docs", targetIndex: 0, source: project.at("docs", "deep", "b.tpl.md"), output: 0, destination: project.at("out", "deep", "b.md") },
            { target: "docs", targetIndex: 0, source: project.at("docs", "deep", "b.tpl.md"), output: 1, destination: project.at("copy", "deep", "b.md"), harness: "codex" },
        ]);
    });

    /** `--layers` names the compiler's contributor as the one that set the entries. */
    it("should record the compiler's contributor as the author of the entries", async () => {
        project = makeProject();
        project.write("a.md", "A");

        const compiler = await makeCompiler(project, { config: { compilation: { targets: [{ entryPoint: "a.md", outputs: [{ destinationFile: "${projectRoot}/out.md" }] }] } } });
        const layers = compiler.engine.handle.config.layers("compilation.files");

        expect(layers.map((layer) => layer.contributor)).toEqual(["compiler.files"]);
    });

    /**
     * The compiler compiles the listed files and no longer matches the glob itself: a file added
     * after the config was built is compiled only once the config is built again.
     */
    it("should compile what the config lists, and a new file once the config is rebuilt", async () => {
        project = makeProject();
        project.write("docs/a.md", "A");

        const compiler = await makeCompiler(project, { config: { compilation: { targets: [{ entryGlob: "docs/*.md", outputs: [{ destinationDir: "${projectRoot}/out" }] }] } } });

        project.write("docs/b.md", "B");
        await compiler.compile();

        expect(project.exists("out/a.md")).toBe(true);
        expect(project.exists("out/b.md")).toBe(false);

        await compiler.rebuild();
        await compiler.compile();

        expect(project.read("out/b.md")).toBe("B");
    });

    /** A target that cannot be listed (a variable no one sets) is reported when a build runs; the others compile. */
    it("should report a target it could not list when a build runs", async () => {
        project = makeProject();
        project.write("a.md", "A");

        const compiler = await makeCompiler(project, {
            config: {
                compilation: {
                    targets: [
                        { id: "bad", entryPoint: "${nowhere}/a.md", outputs: [{ destinationFile: "${projectRoot}/bad.md" }] },
                        { id: "good", entryPoint: "a.md", outputs: [{ destinationFile: "${projectRoot}/good.md" }] },
                    ],
                },
            },
        });

        expect(compiler.engine.handle.config.get("compilation.listing")).toEqual({
            targets: 2,
            problems: [expect.objectContaining({ level: "error", target: "bad", targetIndex: 0, message: expect.stringContaining("${nowhere}") })],
        });

        const result = await compiler.compile();

        expect(result.ok).toBe(false);
        expect(result.problems).toContainEqual(expect.objectContaining({ level: "error", target: "bad" }));
        expect(project.read("good.md")).toBe("A");
    });
});
