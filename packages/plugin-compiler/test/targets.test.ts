/**
 * Compilation targets as the config holds them: entry globs and aliases (ported from today's
 * `entry-glob-aliases.test.ts`), `_if` and `${var}` in outputs (from `resolveCompilation()` in
 * today's `settings.spec.ts`), `content` targets a plugin adds, transforms, choosing
 * targets, and watch mode's partial rebuild.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { definePlugin } from "@sous-io/plugin-api";
import type { CompilationTarget, CompilationTransformEntity } from "../src/types.js";
import { compileOnce, errorsOf, makeCompiler, makeProject, type TestProject } from "./helpers.js";

let project: TestProject;

afterEach(() => {
    project?.remove();
});

/** A skill tree under a directory: `<root>/skills/demo/SKILL.md`. */
function makeSkillTree(root: string): string {
    project.write(path.join(root, "skills", "demo", "SKILL.md"), "# Demo skill\n");

    return project.at(root);
}

describe("entryGlob targets", () => {
    /** A user alias at the start of an entry glob. */
    it("should expand a user-alias entryGlob and compile the matched files", async () => {
        project = makeProject();
        const teamRoot = makeSkillTree("team-prompts");
        const { result } = await compileOnce(project, { targets: [{ entryGlob: "team/skills/**/*", outputs: [{ destinationDir: project.at("out") }] }] }, {}, {
            config: { _aliases: { team: teamRoot } },
        });

        expect(result.ok).toBe(true);
        expect(project.exists("out/demo/SKILL.md")).toBe(true);
    });

    /** `#project` at the start of an entry glob is the project root. */
    it("should expand the built-in #project alias", async () => {
        project = makeProject();
        makeSkillTree(".");
        const { result } = await compileOnce(project, { targets: [{ entryGlob: "#project/skills/**/*", outputs: [{ destinationDir: project.at("out") }] }] });

        expect(result.ok).toBe(true);
        expect(project.exists("out/demo/SKILL.md")).toBe(true);
    });

    /** When an alias's first base matches nothing, the next is tried. */
    it("should fall through to the next alias base when the first matches nothing", async () => {
        project = makeProject();
        fs.mkdirSync(project.at("empty-prompts"));
        const fullRoot = makeSkillTree("full-prompts");
        const { result } = await compileOnce(project, { targets: [{ entryGlob: "layered/skills/**/*", outputs: [{ destinationDir: project.at("out") }] }] }, {}, {
            config: { _aliases: { layered: [project.at("empty-prompts"), fullRoot] } },
        });

        expect(result.ok).toBe(true);
        expect(project.exists("out/demo/SKILL.md")).toBe(true);
    });

    /** A relative glob is relative to the project root; outputs mirror the glob's static base; `.tpl.` goes. */
    it("should mirror paths under the glob's base and strip .tpl.", async () => {
        project = makeProject();
        project.write("docs/a.md", "A");
        project.write("docs/deep/b.tpl.md", "{{ who }}");
        project.write("docs/.hidden.md", "H");
        const { result } = await compileOnce(project, { targets: [{ entryGlob: "docs/**/*.md", outputs: [{ destinationDir: "${projectRoot}/out", _vars: { who: "B" } }] }] });

        expect(result.ok).toBe(true);
        expect(project.read("out/a.md")).toBe("A");
        expect(project.read("out/deep/b.md")).toBe("B");
        expect(project.exists("out/.hidden.md")).toBe(false);
    });

    /** An explicit `globBase` decides what is mirrored. */
    it("should honour an explicit globBase", async () => {
        project = makeProject();
        project.write("src/sub/x.md", "X");
        const { result } = await compileOnce(project, { targets: [{ entryGlob: "src/sub/*.md", globBase: "src", outputs: [{ destinationDir: project.at("out") }] }] });

        expect(result.ok).toBe(true);
        expect(project.exists("out/sub/x.md")).toBe(true);
    });
});

describe("targets a plugin adds for a file of a recipe (what plugin-skills does)", () => {
    /**
     * An entryPoint target with a `globBase` mirrors the file's path under the base into a
     * destinationDir, and its `origin.recipe` selects that recipe's own variables for the output
     * path and for the template.
     *
     * entryPoint skills/demo/SKILL.tpl.md, globBase skills, recipe ns/r (who = R)
     *     // -> out/R/demo/SKILL.md, containing "by R"
     */
    it("should honour globBase on an entryPoint and pass the recipe's variables through origin.recipe", async () => {
        project = makeProject();
        project.write("skills/demo/SKILL.tpl.md", "by {{ who }}");
        const { result } = await compileOnce(project, {
            targets: [
                {
                    id: "skills/ns/r/demo/SKILL.tpl.md",
                    entryPoint: project.at("skills/demo/SKILL.tpl.md"),
                    globBase: project.at("skills"),
                    origin: { plugin: "p", recipe: "ns/r" },
                    outputs: [{ destinationDir: "${projectRoot}/out/${who}" }],
                },
            ],
        }, {}, { config: { _recipeVars: { "ns/r": { who: "R" } } } });

        expect(errorsOf(result)).toBe("");
        expect(project.read("out/R/demo/SKILL.md")).toBe("by R");
        // `included` lists every file read, as real paths: plugin-build checks memories against it.
        expect(result.included).toContain(project.at("skills/demo/SKILL.tpl.md"));
    });
});

describe("outputs", () => {
    /** `${var}` in an entry point and a destination comes from the target's and the output's variables. */
    it("should substitute variables in entryPoint, destinationFile and destinationDir", async () => {
        project = makeProject();
        project.write("prompts/main.md", "MAIN");
        const { result } = await compileOnce(project, {
            _vars: { outRoot: "${projectRoot}/out" },
            targets: [
                {
                    _vars: { promptDir: "prompts" },
                    entryPoint: "${promptDir}/main.md",
                    outputs: [{ destinationFile: "${outRoot}/file/${name}.md", _vars: { name: "one" } }, { destinationDir: "${outRoot}/dir" }],
                },
            ],
        });

        expect(result.ok).toBe(true);
        expect(project.read("out/file/one.md")).toBe("MAIN");
        expect(project.read("out/dir/main.md")).toBe("MAIN");
    });

    /** An unknown variable in a path is an error naming where it was written; other targets still compile. */
    it("should report an unknown variable in a destination, naming its path", async () => {
        project = makeProject();
        const entry = project.write("a.md", "A");
        const { result } = await compileOnce(project, {
            targets: [
                { entryPoint: entry, outputs: [{ destinationFile: "${nowhere}/a.md" }] },
                { entryPoint: entry, outputs: [{ destinationFile: project.at("ok.md") }] },
            ],
        });

        expect(result.ok).toBe(false);
        expect(errorsOf(result)).toContain("compilation.targets[0].outputs[0].destinationFile");
        expect(errorsOf(result)).toContain("${nowhere}");
        expect(project.exists("ok.md")).toBe(true);
    });

    /** `_if` keeps an output only when every named variable equals its value. */
    it("should include an output whose _if matches and leave out one that does not", async () => {
        project = makeProject();
        const entry = project.write("a.md", "A");
        const { result } = await compileOnce(
            project,
            {
                targets: [
                    {
                        entryPoint: entry,
                        outputs: [
                            { _if: { env: { eq: "prod" } }, destinationFile: project.at("prod.md") },
                            { _if: { env: { eq: "dev" } }, destinationFile: project.at("dev.md") },
                            { _if: { env: { eq: "dev" } }, _vars: { env: "dev" }, destinationFile: project.at("local.md") },
                            { destinationFile: project.at("always.md") },
                        ],
                    },
                ],
            },
            {},
            { config: { _vars: { env: "prod" } } },
        );

        expect(result.ok).toBe(true);
        expect(project.exists("prod.md")).toBe(true);
        expect(project.exists("dev.md")).toBe(false);
        expect(project.exists("local.md")).toBe(true);
        expect(project.exists("always.md")).toBe(true);
    });

    /** A target with both or neither of its sources is refused when the config is checked. */
    it("should refuse a target with both entryPoint and entryGlob, or neither", async () => {
        project = makeProject();

        await expect(makeCompiler(project, { config: { compilation: { targets: [{ entryPoint: "a.md", entryGlob: "*.md", outputs: [] }] } } })).rejects.toMatchObject({
            details: [expect.stringContaining("exactly one of 'entryPoint', 'entryGlob' or 'content'")],
        });
        await expect(makeCompiler(project, { config: { compilation: { targets: [{ outputs: [] }] } } })).rejects.toMatchObject({
            details: [expect.stringContaining("exactly one of")],
        });
        await expect(makeCompiler(project, { config: { compilation: { targets: [{ entryPoint: "a.md", outputs: [{ destinationFiles: "x" }] }] } } })).rejects.toMatchObject({
            details: [expect.stringContaining("compilation.targets[0].outputs[0]")],
        });
    });

    /** The schema fills in the defaults. */
    it("should fill in the compilation defaults", async () => {
        project = makeProject();
        const compiler = await makeCompiler(project);

        expect(compiler.engine.handle.config.get("compilation")).toEqual({
            includeSourceComments: false,
            overwriteUntracked: true,
            stateFile: "${sousDir}/sous.state.json",
            targets: [],
        });
    });
});

describe("content targets", () => {
    /** A plugin adds a target whose source is a template string; it renders and its includes resolve. */
    it("should compile a content target a plugin adds", async () => {
        project = makeProject();
        project.write("memories/one.md", "MEMORY ONE");
        const memories = definePlugin({
            name: "sous-plugin-notes",
            version: "1.0.0",
            register(sous) {
                sous.config.contribute({
                    id: "notes/targets",
                    contribute(config) {
                        const target: CompilationTarget = {
                            id: "memories/claude-code",
                            content: `# {{ title }}\n\n@${project.at("memories/one.md")}\n\n@#project/memories/one.md\n`,
                            origin: { plugin: "sous-plugin-notes" },
                            outputs: [{ destinationFile: "${projectRoot}/CLAUDE.md", _vars: { title: "Memories" } }],
                        };

                        config.atPath("compilation.targets").appendValue(target as never);
                    },
                });
            },
        });
        const compiler = await makeCompiler(project, { plugins: [memories] });
        const result = await compiler.compile();

        expect(result.ok).toBe(true);
        expect(project.read("CLAUDE.md")).toBe("# Memories\n\nMEMORY ONE\n\nMEMORY ONE\n");
        expect(result.outputs[0]).toMatchObject({ source: "memories/claude-code", target: "memories/claude-code", origin: { plugin: "sous-plugin-notes" } });
        expect(compiler.engine.handle.config.services.get("compiler.state").filesFrom({ plugin: "sous-plugin-notes" }).map((entry) => entry.dest)).toEqual([
            project.at("CLAUDE.md"),
        ]);
    });

    /** A `content` target's errors name it by its id. */
    it("should name a content target by its id in errors", async () => {
        project = makeProject();
        const { result } = await compileOnce(project, { targets: [{ id: "generated/x", content: "@missing.md\n", outputs: [{ destinationFile: project.at("x.md") }] }] });

        expect(result.ok).toBe(false);
        expect(errorsOf(result)).toContain("in file: generated/x");
        expect(result.problems[0]?.target).toBe("generated/x");
    });

    /** A `content` target without an id is refused. */
    it("should refuse a content target without an id", async () => {
        project = makeProject();

        await expect(makeCompiler(project, { config: { compilation: { targets: [{ content: "x", outputs: [] }] } } })).rejects.toMatchObject({
            details: [expect.stringContaining("compilation.targets[0].id")],
        });
    });

    /** With a destination directory, a content target is written under its id. */
    it("should write a content target under its id in a destination directory", async () => {
        project = makeProject();
        const { result } = await compileOnce(project, { targets: [{ id: "notes/today.tpl.md", content: "{{ 1 | plus: 1 }}", outputs: [{ destinationDir: project.at("out") }] }] });

        expect(result.ok).toBe(true);
        expect(project.read("out/notes/today.md")).toBe("2");
    });
});

describe("compilation transforms", () => {
    /** A target's and an output's transforms run in order, and may move or drop a file. */
    it("should apply the target's transforms, then the output's", async () => {
        project = makeProject();
        project.write("skills/a/SKILL.md", "alpha");
        project.write("skills/b/SKILL.md", "beta");
        project.write("skills/b/DROP.md", "dropped");
        const upper: CompilationTransformEntity = { id: "upper", transform: (file) => ({ ...file, content: file.content.toUpperCase() }) };
        const rename: CompilationTransformEntity = {
            id: "rename",
            transform: (file, ctx) => {
                if (file.source.endsWith("DROP.md")) {
                    return undefined;
                }

                return { ...file, destination: file.destination.replace(/SKILL\.md$/, `${ctx.plugin === "test-config" ? "T" : "X"}.md`), content: `${file.content}!` };
            },
        };
        const { result } = await compileOnce(
            project,
            { targets: [{ entryGlob: "skills/**/*.md", transforms: ["upper"], outputs: [{ destinationDir: project.at("out") }, { destinationDir: project.at("moved"), transforms: ["rename"] }] }] },
            {},
            { register: (sous) => [upper, rename].forEach((entity) => sous.entities.add("compilation-transform", entity)) },
        );

        expect(result.ok).toBe(true);
        expect(project.read("out/a/SKILL.md")).toBe("ALPHA");
        expect(project.read("out/b/DROP.md")).toBe("DROPPED");
        expect(project.read("moved/a/X.md")).toBe("ALPHA!");
        expect(project.exists("moved/b/DROP.md")).toBe(false);
        expect(project.exists("moved/a/SKILL.md")).toBe(false);
    });

    /** A transform nobody registered is an error, and the output is not written. */
    it("should report an unknown transform", async () => {
        project = makeProject();
        const entry = project.write("a.md", "A");
        const { result } = await compileOnce(project, { targets: [{ entryPoint: entry, transforms: ["nope"], outputs: [{ destinationFile: project.at("out.md") }] }] });

        expect(result.ok).toBe(false);
        expect(errorsOf(result)).toContain('The compilation transform "nope" is not registered.');
        expect(project.exists("out.md")).toBe(false);
    });
});

describe("choosing targets", () => {
    /** `targets` picks by id or index; a name that matches nothing is an error. */
    it("should compile only the targets named, by id or index", async () => {
        project = makeProject();
        const entry = project.write("a.md", "A");
        const compilation = {
            targets: [
                { id: "one", entryPoint: entry, outputs: [{ destinationFile: project.at("one.md") }] },
                { entryPoint: entry, outputs: [{ destinationFile: project.at("two.md") }] },
                { id: "three", entryPoint: entry, outputs: [{ destinationFile: project.at("three.md") }] },
            ],
        };
        const { result } = await compileOnce(project, compilation, { targets: ["three", 1, "missing"] });

        expect(project.exists("one.md")).toBe(false);
        expect(project.exists("two.md")).toBe(true);
        expect(project.exists("three.md")).toBe(true);
        expect(errorsOf(result)).toContain('There is no compilation target "missing".');
    });

    /** Watch mode's partial rebuild: only targets whose sources read a changed file, found or not. */
    it("should compile only the targets that read a changed file", async () => {
        project = makeProject();
        project.write("shared.md", "SHARED");
        const a = project.write("a.md", "@shared.md\n");
        const b = project.write("b.md", "B\n");
        const c = project.write("c.md", "@later.md\n");
        const compilation = {
            targets: [
                { entryPoint: a, outputs: [{ destinationFile: project.at("out/a.md") }] },
                { entryPoint: b, outputs: [{ destinationFile: project.at("out/b.md") }] },
                { entryPoint: c, outputs: [{ destinationFile: project.at("out/c.md") }] },
            ],
        };
        const { compiler } = await compileOnce(project, compilation, { changedFiles: [project.at("shared.md"), "later.md"] });

        expect(project.exists("out/a.md")).toBe(true);
        expect(project.exists("out/b.md")).toBe(false);
        expect(compiler.output()).toContain("Include not found: @later.md");

        const none = await compiler.compile({ changedFiles: ["unrelated.md"] });

        expect(none.outputs).toEqual([]);
        expect(compiler.output()).toContain("No targets affected by change to unrelated.md");
    });
});

describe("events and token counts", () => {
    /** `compiler.wrote` says what a compile wrote; each written output carries its token count. */
    it("should announce what it wrote and count tokens", async () => {
        project = makeProject();
        const entry = project.write("a.md", "hello world");
        const heard: unknown[] = [];
        const { result } = await compileOnce(project, { targets: [{ entryPoint: entry, outputs: [{ destinationFile: project.at("a-out.md") }] }] }, {}, {
            register: (sous) => sous.on("compiler.wrote", (event) => void heard.push(event.payload)),
        });

        expect(result.outputs[0]?.tokens).toBe(2);
        expect(heard).toEqual([{ files: result.outputs, dryRun: false }]);
    });
});
