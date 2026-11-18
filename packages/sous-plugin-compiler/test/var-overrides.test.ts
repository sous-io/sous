/**
 * `compilation.varOverrides`: variables for every output whose path matches a pattern, outputs a
 * plugin added included, set on the listed files by the `compiler.var-overrides` contributor.
 */

import { afterEach, describe, expect, it } from "vitest";
import { definePlugin, type JsonObject } from "@sous-io/sous-plugin-api";
import type { CompilationFile } from "../src/types.js";
import { makeCompiler, makeProject, type TestProject } from "./helpers.js";

let project: TestProject;

afterEach(() => {
    project?.remove();
});

/** One source rendered into `.claude/` and `.codex/`, reading `{{ tool }}`. */
function twoTools(varOverrides: unknown[], outputVars: Record<string, string> = {}): JsonObject {
    return {
        compilation: {
            targets: [
                {
                    id: "prompts",
                    entryGlob: "prompts/*",
                    outputs: [
                        { destinationDir: "${projectRoot}/.claude", _vars: outputVars },
                        { destinationDir: "${projectRoot}/.codex" },
                    ],
                },
            ],
            varOverrides: varOverrides as JsonObject[],
        },
    };
}

describe("compilation.varOverrides", () => {
    /** Each rule sets its variables on the outputs whose path matches it. */
    it("should set variables by output path", async () => {
        project = makeProject();
        project.write("prompts/tool.tpl.md", "{{ tool }}");

        const compiler = await makeCompiler(project, {
            config: twoTools([
                { match: "${projectRoot}/.claude/**", _vars: { tool: "claude" } },
                { match: "${projectRoot}/.codex/**", _vars: { tool: "codex" } },
            ]),
        });
        const result = await compiler.compile();

        expect(result.ok).toBe(true);
        expect(project.read(".claude/tool.md")).toBe("claude");
        expect(project.read(".codex/tool.md")).toBe("codex");
    });

    /** A rule wins over the output's own `_vars`. */
    it("should win over the output's own variables", async () => {
        project = makeProject();
        project.write("prompts/tool.tpl.md", "{{ tool }}");

        const compiler = await makeCompiler(project, { config: twoTools([{ match: "${projectRoot}/.claude/**", _vars: { tool: "from-rule" } }], { tool: "from-output" }) });

        await compiler.compile();

        expect(project.read(".claude/tool.md")).toBe("from-rule");
    });

    /** When several rules match, the later one wins for a name both set; a name only one sets is kept. */
    it("should let a later rule win and keep what only one rule sets", async () => {
        project = makeProject();
        project.write("prompts/tool.tpl.md", "{{ tool }}/{{ tone }}");

        const compiler = await makeCompiler(project, {
            config: twoTools([
                { match: "${projectRoot}/**", _vars: { tool: "any", tone: "plain" } },
                { match: ["${projectRoot}/.claude/**"], _vars: { tool: "claude" } },
            ]),
        });

        await compiler.compile();

        expect(project.read(".claude/tool.md")).toBe("claude/plain");
        expect(project.read(".codex/tool.md")).toBe("any/plain");
    });

    /** `exclude` takes globs and `/.../` regular expressions, one or a list. */
    it("should leave out what exclude matches, globs and regular expressions alike", async () => {
        project = makeProject();
        project.write("prompts/a.tpl.md", "{{ tool }}");
        project.write("prompts/b.local.tpl.md", "{{ tool }}");
        project.write("prompts/c.tpl.md", "{{ tool }}");

        const compiler = await makeCompiler(project, {
            config: twoTools([{ match: "/\\/\\.claude\\//", exclude: ["/\\.local\\./", "${projectRoot}/.claude/c.md"], _vars: { tool: "claude" } }]),
        });

        await compiler.compile();

        expect(project.read(".claude/a.md")).toBe("claude");
        expect(project.read(".claude/b.local.md")).toBe("");
        expect(project.read(".claude/c.md")).toBe("");
    });

    /** Outputs a plugin added are matched too, and the rule's variables show on the listed file. */
    it("should apply to outputs a plugin added, and show on the listed file", async () => {
        project = makeProject();
        project.write("skills/x/SKILL.tpl.md", "{{ tool }}");

        const skills = definePlugin({
            name: "test-skills",
            version: "1.0.0",
            register(sous) {
                sous.config.contribute({
                    id: "test-skills.targets",
                    contribute(config) {
                        config.atPath("compilation.targets").append({
                            id: "skills/x",
                            entryPoint: "${projectRoot}/skills/x/SKILL.tpl.md",
                            globBase: "${projectRoot}/skills",
                            origin: { plugin: "test-skills" },
                            outputs: [{ destinationDir: "${projectRoot}/.claude/skills" }],
                        });
                    },
                });
            },
        });
        const compiler = await makeCompiler(project, {
            plugins: [skills],
            config: { compilation: { varOverrides: [{ match: "${projectRoot}/.claude/**", _vars: { tool: "claude" } }] } },
        });
        const files = compiler.engine.handle.config.get<CompilationFile[]>("compilation.files");

        expect(files).toEqual([expect.objectContaining({ destination: project.at(".claude", "skills", "x", "SKILL.md"), _vars: { tool: "claude" } })]);
        expect(compiler.engine.handle.config.layers("compilation.files[0]._vars").map((layer) => layer.contributor)).toContain("compiler.var-overrides");

        await compiler.compile();

        expect(project.read(".claude/skills/x/SKILL.md")).toBe("claude");
    });

    /** A rule is matched against the path Sous planned to write, before a transform renames it. */
    it("should match the path from before a transform", async () => {
        project = makeProject();
        project.write("prompts/a.tpl.md", "{{ tool }}");

        const compiler = await makeCompiler(project, {
            config: {
                compilation: {
                    targets: [{ entryGlob: "prompts/*", outputs: [{ destinationDir: "${projectRoot}/out", transforms: ["rename"] }] }],
                    varOverrides: [{ match: "${projectRoot}/out/a.md", _vars: { tool: "planned" } }],
                },
            },
            register: (sous) =>
                sous.entities.add("compilation-transform", {
                    id: "rename",
                    transform: (file) => ({ ...file, destination: file.destination.replace("a.md", "renamed.md") }),
                }),
        });

        await compiler.compile();

        expect(project.read("out/renamed.md")).toBe("planned");
    });

    /** A regular expression that does not compile is refused when the config is checked, naming the rule. */
    it("should refuse an invalid regular expression", async () => {
        project = makeProject();

        await expect(makeCompiler(project, { config: { compilation: { varOverrides: [{ match: "/([/", _vars: { a: "b" } }] } } })).rejects.toMatchObject({
            details: [expect.stringContaining("compilation.varOverrides[0].match")],
        });
    });
});
