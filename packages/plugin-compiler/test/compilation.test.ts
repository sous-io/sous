/**
 * Compiling targets through `compiler.compile`, ported from today's
 * `src/test/integration/compilation.test.ts`. Targets come from the config now
 * (`compilation.targets`), and an output's variables are its `_vars`.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileOnce, copyFixture, errorsOf, makeCompiler, makeProject, type TestProject } from "./helpers.js";

let project: TestProject;

afterEach(() => {
    project?.remove();
});

/** One target with one destination file. */
function single(entryPoint: string, destinationFile: string, extra: Record<string, unknown> = {}) {
    return { targets: [{ entryPoint, outputs: [{ destinationFile }], ...extra }] };
}

describe("compiler.compile", () => {
    /** A plain entry point is copied verbatim. */
    it("should write output file whose content matches the source for a simple entry point", async () => {
        project = makeProject();
        const dir = copyFixture(project, "simple");
        const entry = path.join(dir, "entry.md");
        const dest = project.at("out", "entry.md");

        const { result } = await compileOnce(project, single(entry, dest));

        expect(result.ok).toBe(true);
        expect(fs.readFileSync(dest, "utf8")).toBe(fs.readFileSync(entry, "utf8"));
        expect(result.outputs).toEqual([expect.objectContaining({ file: dest, action: "created", source: entry, target: "0" })]);
    });

    /** Included files are inlined where the include line was. */
    it("should inline included file content at the @include directive", async () => {
        project = makeProject();
        const dir = copyFixture(project, "with-includes");
        const dest = project.at("out", "result.md");

        const { result } = await compileOnce(project, single(path.join(dir, "entry.md"), dest));

        expect(result.ok).toBe(true);
        const output = fs.readFileSync(dest, "utf8");

        expect(output).toContain("# Shared");
        expect(output).toContain("# Child");
        expect(output).not.toContain("@shared.md");
    });

    /** `@./x.md` and `@../x.md` resolve against the including file's directory. */
    it("should resolve @includes that start with ./ and ../", async () => {
        project = makeProject();
        project.write("shared.md", "# Parent Shared\n");
        project.write("sub/sibling.md", "# Dot Sibling\n");
        const entry = project.write("sub/entry.md", "# Entry\n\n@./sibling.md\n\n@../shared.md\n");
        const dest = project.at("out", "dot-relative.md");

        const { result } = await compileOnce(project, single(entry, dest));

        expect(result.ok).toBe(true);
        const output = fs.readFileSync(dest, "utf8");

        expect(output).toContain("# Dot Sibling");
        expect(output).toContain("# Parent Shared");
        expect(output).not.toContain("@./sibling.md");
    });

    /** `@shared.md` finds `shared.tpl.md` and the other way round; the literal spelling wins. */
    it("should fall back to the .tpl. twin of an @include, literal spelling first", async () => {
        project = makeProject();
        project.write("shared.tpl.md", "# Shared Template\n");
        project.write("notes.md", "# Plain Notes\n");
        project.write("both.md", "# Both Plain\n");
        project.write("both.tpl.md", "# Both Template\n");
        const entry = project.write("entry.md", "# Entry\n\n@shared.md\n\n@notes.tpl.md\n\n@both.md\n");
        const dest = project.at("out", "twins.md");

        const { result } = await compileOnce(project, single(entry, dest));

        expect(result.ok).toBe(true);
        const output = fs.readFileSync(dest, "utf8");

        expect(output).toContain("# Shared Template");
        expect(output).toContain("# Plain Notes");
        expect(output).toContain("# Both Plain");
        expect(output).not.toContain("# Both Template");
    });

    /** Includes resolve transitively: entry -> child -> shared. */
    it("should resolve nested @includes transitively (A includes B includes C)", async () => {
        project = makeProject();
        const dir = copyFixture(project, "with-includes");
        const dest = project.at("out", "nested.md");

        await compileOnce(project, single(path.join(dir, "entry.md"), dest));

        const output = fs.readFileSync(dest, "utf8");

        expect(output).toContain("This content is shared across multiple entry points.");
        expect(output).toContain("This is a nested child file.");
    });

    /** A cycle is an error, never a hang or a throw. */
    it("should not hang or throw on a circular @include; should complete and report error", async () => {
        project = makeProject();
        const dir = copyFixture(project, "with-circular");

        const { result } = await compileOnce(project, single(path.join(dir, "a.md"), project.at("out", "circular.md")));

        expect(result.ok).toBe(false);
        expect(errorsOf(result)).toContain("Circular dependency detected");
    });

    /** A `.tpl.` entry renders with its output's variables. */
    it("should substitute LiquidJS vars and strip .tpl. from the output filename", async () => {
        project = makeProject();
        const dir = copyFixture(project, "with-templates");
        const dest = project.at("out", "entry.md");

        const { result } = await compileOnce(project, {
            targets: [{ entryPoint: path.join(dir, "entry.tpl.md"), outputs: [{ destinationFile: dest, _vars: { projectName: "TestProj" } }] }],
        });

        expect(result.ok).toBe(true);
        const output = fs.readFileSync(dest, "utf8");

        expect(output).toContain("TestProj");
        expect(output).toContain("Project: TestProj");
        expect(output).not.toContain("{{ projectName }}");
    });

    /** With `destinationDir`, `.tpl.` is taken out of the file name. */
    it("should strip .tpl. from the output filename when using destinationDir", async () => {
        project = makeProject();
        const dir = copyFixture(project, "with-templates");
        const outDir = project.at("outdir");

        await compileOnce(project, {
            targets: [{ entryPoint: path.join(dir, "entry.tpl.md"), outputs: [{ destinationDir: outDir, _vars: { projectName: "TestProj" } }] }],
        });

        expect(fs.existsSync(path.join(outDir, "entry.md"))).toBe(true);
        expect(fs.existsSync(path.join(outDir, "entry.tpl.md"))).toBe(false);
    });

    /** A file without `.tpl.` in its name is never rendered. */
    it("should copy non-.tpl. files verbatim without processing LiquidJS tags", async () => {
        project = makeProject();
        const src = project.write("verbatim.md", "# Verbatim\n\n{{ do_not_render_me }}\n");
        const dest = project.at("out", "verbatim.md");

        const { result } = await compileOnce(project, {
            targets: [{ entryPoint: src, outputs: [{ destinationFile: dest, _vars: { do_not_render_me: "SUBSTITUTED" } }] }],
        });

        expect(result.ok).toBe(true);
        expect(fs.readFileSync(dest, "utf8")).toContain("{{ do_not_render_me }}");
    });

    /** A second compile with the same source does not rewrite the output. */
    it("should skip writing an output file when srcHash is unchanged and file exists", async () => {
        project = makeProject();
        const dir = copyFixture(project, "simple");
        const dest = project.at("out", "entry.md");
        const config = single(path.join(dir, "entry.md"), dest);

        await compileOnce(project, config);
        const first = fs.statSync(dest).mtimeMs;

        await new Promise((resolve) => setTimeout(resolve, 20));

        const { result } = await compileOnce(project, config);

        expect(fs.statSync(dest).mtimeMs).toBe(first);
        expect(result.outputs[0]?.action).toBe("unchanged");
    });

    /** `rebuild` rewrites every output. */
    it("should rewrite the output file when rebuild: true even if srcHash is unchanged", async () => {
        project = makeProject();
        const dir = copyFixture(project, "simple");
        const dest = project.at("out", "entry.md");
        const config = single(path.join(dir, "entry.md"), dest);

        await compileOnce(project, config);
        const first = fs.statSync(dest).mtimeMs;

        await new Promise((resolve) => setTimeout(resolve, 20));
        await compileOnce(project, config, { rebuild: true });

        expect(fs.statSync(dest).mtimeMs).toBeGreaterThan(first);
    });

    /** A dry run writes nothing, the state file included. */
    it("should not create any output files when dryRun: true", async () => {
        project = makeProject();
        const dir = copyFixture(project, "simple");
        const dest = project.at("out", "entry.md");

        const { result } = await compileOnce(project, single(path.join(dir, "entry.md"), dest), { dryRun: true });

        expect(result.ok).toBe(true);
        expect(fs.existsSync(dest)).toBe(false);
        expect(fs.existsSync(path.join(project.sousDir, "sous.state.json"))).toBe(false);
        expect(result.outputs[0]?.action).toBe("would-create");
    });

    /** `includeSourceComments` writes `<!-- from: -->` before each included file. */
    it("should insert <!-- from: ... --> comments before included content when includeSourceComments is true", async () => {
        project = makeProject();
        const dir = copyFixture(project, "with-source-comments");
        const dest = project.at("out", "result.md");

        const { result } = await compileOnce(project, single(path.join(dir, "entry.md"), dest, { includeSourceComments: true }));

        expect(result.ok).toBe(true);
        expect(fs.readFileSync(dest, "utf8")).toContain("<!-- from: with-source-comments/section.md -->");
    });

    /** The compilation-wide `includeSourceComments` applies to every target that does not set its own. */
    it("should use the compilation-wide includeSourceComments when a target sets none", async () => {
        project = makeProject();
        const dir = copyFixture(project, "with-source-comments");
        const dest = project.at("out", "result.md");

        await compileOnce(project, { includeSourceComments: true, ...single(path.join(dir, "entry.md"), dest) });

        expect(fs.readFileSync(dest, "utf8")).toContain("<!-- from:");
    });

    /** A non-boolean `includeSourceComments` is a config error now, caught when the config is checked. */
    it("should refuse a non-boolean includeSourceComments when the config is built", async () => {
        project = makeProject();
        const dir = copyFixture(project, "simple");

        await expect(
            makeCompiler(project, { config: { compilation: { includeSourceComments: "yes", ...single(path.join(dir, "entry.md"), project.at("out.md")) } } }),
        ).rejects.toMatchObject({ details: [expect.stringContaining("compilation.includeSourceComments")] });
    });

    /** One target may write to many destinations. */
    it("should write the compiled content to every destination in a multi-output target", async () => {
        project = makeProject();
        const dir = copyFixture(project, "simple");
        const entry = path.join(dir, "entry.md");
        const one = project.at("out1", "entry.md");
        const two = project.at("out2", "entry.md");

        const { result } = await compileOnce(project, { targets: [{ entryPoint: entry, outputs: [{ destinationFile: one }, { destinationFile: two }] }] });

        expect(result.ok).toBe(true);
        expect(fs.readFileSync(one, "utf8")).toBe(fs.readFileSync(entry, "utf8"));
        expect(fs.readFileSync(two, "utf8")).toBe(fs.readFileSync(entry, "utf8"));
    });

    /** The state file records every output, with its hashes, size and time, and where it came from. */
    it("should write a state file with correct entries after compilation", async () => {
        project = makeProject();
        const dir = copyFixture(project, "simple");
        const dest = project.at("out", "entry.md");

        await compileOnce(project, {
            targets: [{ id: "docs", entryPoint: path.join(dir, "entry.md"), origin: { plugin: "p", recipe: "ns/r", repository: "repo" }, outputs: [{ destinationFile: dest }] }],
        });

        const state = JSON.parse(fs.readFileSync(path.join(project.sousDir, "sous.state.json"), "utf8"));
        const entry = state.files.find((file: { dest: string }) => file.dest === dest);

        expect(entry.srcHash).toMatch(/^[0-9a-f]{64}$/);
        expect(entry.destHash).toMatch(/^[0-9a-f]{64}$/);
        expect(entry.size).toBeGreaterThan(0);
        expect(entry.builtAt).not.toBe("");
        expect(entry.target).toBe("docs");
        expect(entry.origin).toEqual({ plugin: "p", recipe: "ns/r", repository: "repo" });
    });

    /** Missing directories are made, and recorded so prune can remove them. */
    it("should create intermediate output directories and record them in the state file", async () => {
        project = makeProject();
        const dir = copyFixture(project, "simple");
        const dest = project.at("brand", "new", "dir", "entry.md");

        const { result } = await compileOnce(project, single(path.join(dir, "entry.md"), dest));

        expect(result.ok).toBe(true);
        expect(fs.existsSync(dest)).toBe(true);
        const state = JSON.parse(fs.readFileSync(path.join(project.sousDir, "sous.state.json"), "utf8"));

        expect(state.dirs).toEqual([project.at("brand"), project.at("brand", "new"), project.at("brand", "new", "dir")]);
    });

    /** Include lines inside a fenced block are text. */
    it("should leave @include lines inside a fenced code block verbatim", async () => {
        project = makeProject();
        project.write("real.md", "REAL CONTENT\n");
        const entry = project.write("entry.md", "# Doc\n\n@real.md\n\n```markdown\n@does/not/exist.md\n```\n");
        const dest = project.at("out", "entry.md");

        const { result } = await compileOnce(project, single(entry, dest));
        const output = fs.readFileSync(dest, "utf8");

        expect(result.ok).toBe(true);
        expect(output).toContain("REAL CONTENT");
        expect(output).toContain("@does/not/exist.md");
    });

    /** `~~~` fences count as fences too. */
    it("should treat ~~~ fences the same as backtick fences", async () => {
        project = makeProject();
        project.write("real.md", "REAL CONTENT\n");
        const entry = project.write("entry.md", "~~~text\n@real.md\n~~~\n");
        const dest = project.at("out", "entry.md");

        await compileOnce(project, single(entry, dest));

        expect(fs.readFileSync(dest, "utf8")).toContain("@real.md");
        expect(fs.readFileSync(dest, "utf8")).not.toContain("REAL CONTENT");
    });

    /** Includes resolve again after the closing fence; a fence of the other character does not close it. */
    it("should resume resolving @includes after the closing fence", async () => {
        project = makeProject();
        project.write("real.md", "REAL CONTENT\n");
        project.write("fenced.md", "FENCED CONTENT\n");
        const entry = project.write("entry.md", "```\n~~~\n@fenced.md\n```\n\n@real.md\n");
        const dest = project.at("out", "entry.md");

        await compileOnce(project, single(entry, dest));
        const output = fs.readFileSync(dest, "utf8");

        expect(output).toContain("@fenced.md");
        expect(output).not.toContain("FENCED CONTENT");
        expect(output).toContain("REAL CONTENT");
    });

    /** A line that looks like an include but is not well formed is an error naming the line. */
    it("should report a malformed include line with its file and line", async () => {
        project = makeProject();
        const entry = project.write("entry.md", "# Doc\n@docs/notes.txt\n@alice thanks\n");

        const { result } = await compileOnce(project, single(entry, project.at("out.md")));

        expect(result.ok).toBe(false);
        expect(errorsOf(result)).toContain(`Malformed include line: @docs/notes.txt\n  in file: ${entry}, line 2`);
        expect(errorsOf(result)).not.toContain("@alice");
    });

    describe("compile errors", () => {
        /** gh-127: a missing include keeps the previous output and its state entry. */
        it("should keep the previous output and state entry when an include is missing", async () => {
            project = makeProject();
            const entry = project.write("entry.md", "first build\n");
            const dest = project.at("AGENTS.md");
            const statePath = path.join(project.sousDir, "sous.state.json");
            const config = single(entry, dest);

            expect((await compileOnce(project, config)).result.ok).toBe(true);
            const before = JSON.parse(fs.readFileSync(statePath, "utf8"));

            project.write("entry.md", "Before\n@missing.md\nAfter\n");
            const { result, compiler } = await compileOnce(project, config);

            expect(result.ok).toBe(false);
            expect(fs.readFileSync(dest, "utf8")).toBe("first build\n");
            const after = JSON.parse(fs.readFileSync(statePath, "utf8"));

            expect(after.files.find((file: { dest: string }) => file.dest === dest)).toEqual(before.files.find((file: { dest: string }) => file.dest === dest));
            expect(compiler.output()).toContain("(not written because of an error; the previous copy stays)");
        });

        /** Every target compiles even after one fails, and every error is listed. */
        it("should compile every target and list every error", async () => {
            project = makeProject();
            const good = project.write("good.md", "GOOD\n");
            const bad = project.write("bad.md", "@missing.md\n");
            const loop = project.write("loop.md", "@loop.md\n");
            const out = (name: string) => project.at("out", name);

            const { result, compiler } = await compileOnce(project, {
                targets: [
                    { entryPoint: bad, outputs: [{ destinationFile: out("bad.md") }] },
                    { entryPoint: loop, outputs: [{ destinationFile: out("loop.md") }] },
                    { entryPoint: good, outputs: [{ destinationFile: out("good.md") }] },
                ],
            });

            expect(result.ok).toBe(false);
            expect(fs.readFileSync(out("good.md"), "utf8")).toBe("GOOD\n");
            expect(fs.existsSync(out("bad.md"))).toBe(false);
            expect(fs.existsSync(out("loop.md"))).toBe(false);
            expect(errorsOf(result)).toContain("Include not found: @missing.md");
            expect(errorsOf(result)).toContain("Circular dependency detected");
            expect(compiler.output()).toContain("Done with 2 error(s).");
            expect(result.problems.map((problem) => problem.target)).toEqual(["0", "1"]);
        });

        /** A template that fails to render is not written. */
        it("should not write an output whose template fails to render", async () => {
            project = makeProject();
            const entry = project.write("entry.tpl.md", "Hello {% if %}\n");
            const dest = project.at("out", "entry.md");

            const { result } = await compileOnce(project, single(entry, dest));

            expect(result.ok).toBe(false);
            expect(errorsOf(result)).toContain("Template rendering error");
            expect(fs.existsSync(dest)).toBe(false);
        });

        /** Strict mode turns a warning into an error and carries on with the next target. */
        it("should treat a warning as an error in strict mode and carry on", async () => {
            project = makeProject();
            const plain = project.write("plain.md", "PLAIN\n");
            const out = project.at("out", "plain.md");
            const config = {
                targets: [
                    { entryGlob: "nothing/**/*.md", outputs: [{ destinationDir: project.at("out") }] },
                    { entryPoint: plain, outputs: [{ destinationFile: out }] },
                ],
            };

            const { result } = await compileOnce(project, config, { strict: true });

            expect(result.ok).toBe(false);
            expect(errorsOf(result)).toContain("Glob pattern matched no files");
            expect(fs.readFileSync(out, "utf8")).toBe("PLAIN\n");
        });

        /** Without strict mode a warning stays a warning. */
        it("should leave a warning a warning without strict mode", async () => {
            project = makeProject();
            const { result } = await compileOnce(project, { targets: [{ entryGlob: "nothing/**/*.md", outputs: [{ destinationDir: project.at("out") }] }] });

            expect(result.ok).toBe(true);
            expect(result.problems).toEqual([expect.objectContaining({ level: "warning", message: expect.stringContaining("Glob pattern matched no files") })]);
        });
    });
});

/**
 * Ported from `src/test/integration/per-file-rendering.test.ts`: every `.tpl.` file renders as Liquid
 * by its own name, and no other file ever does, whichever file includes it. These run with the real
 * Liquid, variables and host plugins.
 */
describe("per-file Liquid rendering", () => {
    /** Compiles one entry to `out/OUT.md` with the given output variables; returns the result and the output. */
    async function render(entry: string, vars: Record<string, string> = { who: "world" }, input: { rebuild?: boolean } = { rebuild: true }) {
        const dest = project.at("out", "OUT.md");
        const { result, compiler } = await compileOnce(
            project,
            { targets: [{ entryPoint: entry, outputs: [{ destinationFile: dest, _vars: vars }] }] },
            input,
            { real: true },
        );

        return { result, compiler, output: fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : "" };
    }

    /**
     * A `.tpl.` child renders even though its host is a plain file; the host's own text is copied verbatim.
     *
     * ENTRY.md "plain {{ who }}" + @child.tpl.md "hi {{ who }}" // -> "plain {{ who }}" and "hi world"
     */
    it("should render a .tpl. child in a plain host and leave the host literal", async () => {
        project = makeProject();
        const entry = project.write("ENTRY.md", "plain {{ who }}\n\n@child.tpl.md\n");
        project.write("child.tpl.md", "hi {{ who }}");

        const { result, output } = await render(entry);

        expect(result.ok, errorsOf(result)).toBe(true);
        expect(output).toContain("plain {{ who }}");
        expect(output).toContain("hi world");
    });

    /**
     * A plain child of a `.tpl.` host stays literal; the host renders.
     *
     * ENTRY.tpl.md "host {{ who }}" + @child.md "kid {{ who }}" // -> "host world" and "kid {{ who }}"
     */
    it("should leave a plain child literal inside a .tpl. host", async () => {
        project = makeProject();
        const entry = project.write("ENTRY.tpl.md", "host {{ who }}\n\n@child.md\n");
        project.write("child.md", "kid {{ who }}");

        const { result, output } = await render(entry);

        expect(result.ok, errorsOf(result)).toBe(true);
        expect(output).toContain("host world");
        expect(output).toContain("kid {{ who }}");
    });

    /**
     * The name of the file found decides, not the spelling of the include.
     *
     * @x.md (only x.tpl.md exists) -> rendered; @y.tpl.md (only y.md exists) -> literal
     */
    it("should decide by the resolved file name, including through a .tpl. twin", async () => {
        project = makeProject();
        const entry = project.write("ENTRY.md", "@x.md\n\n@y.tpl.md\n");
        project.write("x.tpl.md", "x {{ who }}");
        project.write("y.md", "y {{ who }}");

        const { result, output } = await render(entry);

        expect(result.ok, errorsOf(result)).toBe(true);
        expect(output).toContain("x world");
        expect(output).toContain("y {{ who }}");
    });

    /**
     * An include line inside a condition of a `.tpl.` host appears only when the condition holds.
     *
     * {% if who == "world" %}@a.md{% endif %} and {% if who == "nobody" %}@b.md{% endif %} // -> A only
     */
    it("should honor a condition around an include line", async () => {
        project = makeProject();
        const entry = project.write("ENTRY.tpl.md", '{% if who == "world" %}\n@a.md\n{% endif %}\n{% if who == "nobody" %}\n@b.md\n{% endif %}\n');
        project.write("a.md", "AAA");
        project.write("b.md", "BBB");

        const { result, output } = await render(entry);

        expect(result.ok, errorsOf(result)).toBe(true);
        expect(output).toContain("AAA");
        expect(output).not.toContain("BBB");
    });

    /**
     * Nothing renders twice: a value holding Liquid syntax comes out as that text.
     *
     * who = "{{ again }}"; child.tpl.md "{{ who }}" included by ENTRY.tpl.md // -> "{{ again }}"
     */
    it("should not render a rendered child again", async () => {
        project = makeProject();
        const entry = project.write("ENTRY.tpl.md", "@child.tpl.md\n");
        project.write("child.tpl.md", "{{ who }}");

        const { result, output } = await render(entry, { who: "{{ again }}" });

        expect(result.ok, errorsOf(result)).toBe(true);
        expect(output.trim()).toBe("{{ again }}");
    });

    /**
     * A child's own includes expand inside it, and each renders by its own name.
     *
     * ENTRY.md -> mid.tpl.md -> leaf.md, with Liquid in all three // -> mid rendered, leaf literal
     */
    it("should expand a child's includes before putting it in place", async () => {
        project = makeProject();
        const entry = project.write("ENTRY.md", "@mid.tpl.md\n");
        project.write("mid.tpl.md", "mid {{ who }}\n@leaf.md\n");
        project.write("leaf.md", "leaf {{ who }}");

        const { output } = await render(entry);

        expect(output).toContain("mid world");
        expect(output).toContain("leaf {{ who }}");
    });

    /**
     * A file may be included twice and renders each time.
     *
     * @c.tpl.md twice -> "c world" twice
     */
    it("should render a file included more than once each time", async () => {
        project = makeProject();
        const entry = project.write("ENTRY.md", "@c.tpl.md\n\n@c.tpl.md\n");
        project.write("c.tpl.md", "c {{ who }}");

        const { output } = await render(entry);

        expect(output.match(/c world/g)).toHaveLength(2);
    });

    /**
     * The source hash covers every included file and the variables: changing a `.tpl.` child of a
     * plain host, or a variable, renders again; changing nothing leaves the output alone.
     *
     * first build, unchanged build -> "unchanged"; edit child -> rewritten; new value -> rewritten
     */
    it("should render again when an included child or a variable changes", async () => {
        project = makeProject();
        const entry = project.write("ENTRY.md", "@child.tpl.md\n");
        const child = project.write("child.tpl.md", "v1 {{ who }}");

        expect((await render(entry, { who: "world" }, {})).output).toContain("v1 world");
        expect((await render(entry, { who: "world" }, {})).result.outputs[0]?.action).toBe("unchanged");

        fs.writeFileSync(child, "v2 {{ who }}");
        expect((await render(entry, { who: "world" }, {})).output).toContain("v2 world");
        expect((await render(entry, { who: "moon" }, {})).output).toContain("v2 moon");
    });

    /**
     * An output that sets no variables still renders a `.tpl.` child: every output has the
     * project's variables now, so the old "written without being rendered" warning is gone.
     *
     * output without _vars, child.tpl.md "[{{ who }}]" in a plain host -> "[]", no warning
     */
    it("should render a .tpl. child for an output that sets no variables", async () => {
        project = makeProject();
        const entry = project.write("ENTRY.md", "@child.tpl.md\n");
        project.write("child.tpl.md", "[{{ who }}]");
        const dest = project.at("out", "OUT.md");

        const { result, compiler } = await compileOnce(project, { targets: [{ entryPoint: entry, outputs: [{ destinationFile: dest }] }] }, {}, { real: true });

        expect(result.ok, errorsOf(result)).toBe(true);
        expect(fs.readFileSync(dest, "utf8")).toContain("[]");
        expect(compiler.output()).not.toContain("WITHOUT BEING RENDERED");
    });

    /**
     * The compile reports every file it read, for the unincluded-memory check.
     *
     * compile ENTRY.md that includes a.md -> included has both
     */
    it("should report every file the compile read", async () => {
        project = makeProject();
        const entry = project.write("ENTRY.md", "@a.md\n");
        const a = project.write("a.md", "A");

        const { result } = await render(entry, {});

        expect(result.included).toEqual(expect.arrayContaining([fs.realpathSync(a), fs.realpathSync(entry)]));
    });
});
