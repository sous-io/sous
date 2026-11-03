/**
 * What the web editor reads from the compiler: dry-run content and token counts from
 * `compiler.compile`, the `compiler.targets` and `compiler.render` services, and `compiler.tokens`.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CompilerTokensResult } from "../src/types.js";
import { compileOnce, makeCompiler, makeProject, type TestCompiler, type TestProject } from "./helpers.js";

let project: TestProject;

afterEach(() => {
    project?.remove();
});

/** A project with one `.tpl.` entry point that includes a partial, and two outputs with their own `_vars`. */
function twoOutputs() {
    project.write("src/part.md", "Part\n");
    const entry = project.write("src/entry.tpl.md", "Hello {{ who }}\n@part.md\n");

    return {
        entry,
        compilation: {
            targets: [
                {
                    id: "greeting",
                    entryPoint: entry,
                    outputs: [
                        { destinationFile: project.at("out", "a.md"), _vars: { who: "Ann" } },
                        { destinationFile: project.at("out", "b.md"), _vars: { who: "Bob" } },
                    ],
                },
            ],
        },
    };
}

function services(compiler: TestCompiler) {
    return compiler.engine.handle.config.services;
}

describe("compiler.compile includeContent and countTokens", () => {
    /** A dry run writes nothing but carries each output's text and tokens when asked. */
    it("should give content and tokens on a dry run when asked", async () => {
        project = makeProject();
        const { compilation } = twoOutputs();
        const { result } = await compileOnce(project, compilation, { dryRun: true, includeContent: true, countTokens: true });

        expect(project.exists("out/a.md")).toBe(false);
        expect(result.outputs.map((output) => output.content)).toEqual(["Hello Ann\nPart\n\n", "Hello Bob\nPart\n\n"]);
        expect(result.outputs.every((output) => typeof output.tokens === "number" && output.tokens > 0)).toBe(true);
    });

    /** By default a dry run carries neither. */
    it("should leave content and tokens out by default", async () => {
        project = makeProject();
        const { compilation } = twoOutputs();
        const { result } = await compileOnce(project, compilation, { dryRun: true });

        expect(result.outputs.some((output) => "content" in output || "tokens" in output)).toBe(false);
    });

    /** An unchanged output is counted and carries its text too. */
    it("should give content and tokens for unchanged outputs", async () => {
        project = makeProject();
        const { compilation } = twoOutputs();
        const { compiler } = await compileOnce(project, compilation);
        const again = await compiler.compile({ includeContent: true, countTokens: true });

        expect(again.outputs.map((output) => output.action)).toEqual(["unchanged", "unchanged"]);
        expect(again.outputs[0]!.content).toBe("Hello Ann\nPart\n\n");
        expect(again.outputs[0]!.tokens).toBeGreaterThan(0);
    });
});

describe("compiler.targets", () => {
    /** One entry per output, with absolute paths. */
    it("should expand every output of every target", async () => {
        project = makeProject();
        const { entry, compilation } = twoOutputs();
        const compiler = await makeCompiler(project, { config: { compilation } });
        const { entries, problems } = services(compiler).get("compiler.targets").expand();

        expect(problems).toEqual([]);
        expect(entries).toEqual([
            expect.objectContaining({ target: "greeting", targetIndex: 0, source: entry, output: project.at("out", "a.md"), outputIndex: 0 }),
            expect.objectContaining({ target: "greeting", targetIndex: 0, source: entry, output: project.at("out", "b.md"), outputIndex: 1 }),
        ]);
    });

    /** A glob target gives one entry per matched file. */
    it("should expand a glob target into its files", async () => {
        project = makeProject();
        project.write("docs/a.md", "A\n");
        project.write("docs/sub/b.md", "B\n");
        const compiler = await makeCompiler(project, {
            config: { compilation: { targets: [{ entryGlob: project.at("docs/**/*.md"), outputs: [{ destinationDir: project.at("out") }] }] } },
        });
        const { entries } = services(compiler).get("compiler.targets").expand();

        expect(entries.map((entry) => entry.output).sort()).toEqual([project.at("out", "a.md"), project.at("out", "sub", "b.md")]);
    });
});

describe("compiler.render", () => {
    /** The real scope of the file's target, its first output by default, includes expanded. */
    it("should render an entry point with its output's variables", async () => {
        project = makeProject();
        const { entry, compilation } = twoOutputs();
        const compiler = await makeCompiler(project, { config: { compilation } });
        const render = services(compiler).get("compiler.render");

        expect(await render.render({ file: entry })).toMatchObject({ text: "Hello Ann\nPart\n\n", target: "greeting", outputIndex: 0, problems: [] });
        expect((await render.render({ file: entry, output: 1 })).text).toBe("Hello Bob\nPart\n\n");
        expect(project.exists("out/a.md")).toBe(false);
    });

    /** Unsaved source and scope overrides, with unusual Unicode kept as given. */
    it("should render given source with overrides, keeping invisible characters", async () => {
        project = makeProject();
        const { entry, compilation } = twoOutputs();
        const compiler = await makeCompiler(project, { config: { compilation } });
        const result = await services(compiler)
            .get("compiler.render")
            .render({ file: entry, source: "⁣S1⁣Hi {{ who }}⁣E1⁣", scope: { who: "Zed" } });

        expect(result.text).toBe("⁣S1⁣Hi Zed⁣E1⁣");
        expect(fs.readFileSync(entry, "utf8")).toBe("Hello {{ who }}\n@part.md\n");
    });

    /** A Liquid error is a problem with its line and column. */
    it("should report a Liquid error with where it is", async () => {
        project = makeProject();
        const { entry, compilation } = twoOutputs();
        const compiler = await makeCompiler(project, { config: { compilation } });
        const result = await services(compiler).get("compiler.render").render({ file: entry, source: "ok\n{% if %}\n" });

        expect(result.problems).toEqual([expect.objectContaining({ level: "error", file: entry, line: 2 })]);
        expect(result.problems[0]!.column).toBeGreaterThan(0);
    });

    /** A partial renders with the scope of the target that includes it. */
    it("should render a partial with the scope of a target that includes it", async () => {
        project = makeProject();
        const partial = project.write("src/part.tpl.md", "Part for {{ who }}\n");
        const entry = project.write("src/entry.md", "@part.tpl.md\n");
        const compiler = await makeCompiler(project, {
            config: { compilation: { targets: [{ entryPoint: entry, outputs: [{ destinationFile: project.at("out.md"), _vars: { who: "Ann" } }] }] } },
        });
        const result = await services(compiler).get("compiler.render").render({ file: partial });

        expect(result).toMatchObject({ text: "Part for Ann\n", target: "0" });
        expect(path.isAbsolute(result.included[0] ?? partial)).toBe(true);
    });

    /** Text that is no output is counted as compile counts an output: the same text, the same count. */
    it("should count a render's tokens as compile counts an output's", async () => {
        project = makeProject();
        const { entry, compilation } = twoOutputs();
        const compiler = await makeCompiler(project, { config: { compilation } });
        const render = services(compiler).get("compiler.render");
        const rendered = await render.render({ file: entry });
        const compiled = await compiler.compile({ dryRun: true, countTokens: true });

        expect(await render.countTokens(rendered.text)).toBe(compiled.outputs[0]!.tokens);
        expect(await render.countTokens("")).toBe(0);
    });
});

describe("compiler.tokens", () => {
    /** Every output's tokens and bytes, writing nothing. */
    it("should count every output's tokens without writing", async () => {
        project = makeProject();
        const { compilation } = twoOutputs();
        const compiler = await makeCompiler(project, { config: { compilation } });
        const result = (await compiler.engine.handle.submit({ intent: "compiler.tokens", input: {} }, { reporter: compiler.reporter })).toPlain() as unknown as CompilerTokensResult;

        expect(project.exists("out/a.md")).toBe(false);
        expect(result.outputs).toHaveLength(2);
        expect(result.totalTokens).toBe(result.outputs.reduce((sum, output) => sum + output.tokens, 0));
        expect(result.totalBytes).toBe(Buffer.byteLength("Hello Ann\nPart\n\n") + Buffer.byteLength("Hello Bob\nPart\n\n"));
    });
});
