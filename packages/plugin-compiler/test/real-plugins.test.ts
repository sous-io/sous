/**
 * The compiler with the real plugins it depends on (plugin-host, plugin-variables, plugin-liquid,
 * plugin-refs) instead of the stand-ins: the same paths the other tests take, end to end.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { JsonObject } from "@sous-io/plugin-api";
import { makeCompiler, makeProject, type TestProject } from "./helpers.js";

let project: TestProject;

afterEach(() => {
    project?.remove();
});

describe("with the real plugins", () => {
    /** Includes, `#project`, `_aliases`, `${var}`, a `.tpl.` render, `{% render %}` and the built-in tags. */
    it("should compile includes, aliases, variables, renders and tags", async () => {
        project = makeProject();
        project.write("docs/shared.md", "SHARED");
        project.write("lib/partial.md", "PARTIAL");
        project.write("notes/n.md", "NOTE");
        project.write("list/a.md", "");
        const entry = project.write(
            "prompts/AGENTS.tpl.md",
            "# {{ title }}\n\n@#project/docs/shared.md\n\n@lib:partial.md\n\n@${noteDir}/n.md\n\n{% render \"@lib/partial.md\" %}\n\n{% listFiles root=listDir %}\n",
        );
        const compiler = await makeCompiler(project, {
            real: true,
            config: {
                _vars: { noteDir: "${projectRoot}/notes" },
                _aliases: { lib: "${projectRoot}/lib" },
                compilation: {
                    targets: [{ entryPoint: entry, outputs: [{ destinationFile: "${projectRoot}/AGENTS.md", _vars: { title: "Agents", listDir: "${projectRoot}/list" } }] }],
                },
            },
        });
        const result = await compiler.compile();

        expect(result.problems).toEqual([]);
        expect(result.ok).toBe(true);
        expect(project.read("AGENTS.md")).toBe("# Agents\n\nSHARED\n\nPARTIAL\n\nNOTE\n\nPARTIAL\n\n- a.md\n");
    });

    /** A content target, a glob target, then a prune after the config drops one. */
    it("should compile content and glob targets and prune what is dropped", async () => {
        project = makeProject();
        project.write("skills/a/SKILL.md", "A");
        project.write("skills/b/SKILL.md", "B");
        let withGlob = true;
        const compiler = await makeCompiler(project, {
            real: true,
            config: () => ({
                compilation: <JsonObject>{
                    targets: [
                        { id: "memo", content: "{{ 2 | plus: 3 }}", outputs: [{ destinationFile: "${projectRoot}/MEMO.md" }] },
                        ...(withGlob ? [{ entryGlob: "skills/**/*.md", outputs: [{ destinationDir: "${projectRoot}/.claude/skills" }] }] : []),
                    ],
                },
            }),
        });

        expect((await compiler.compile()).ok).toBe(true);
        expect(project.read("MEMO.md")).toBe("5");
        expect(project.read(".claude/skills/b/SKILL.md")).toBe("B");

        withGlob = false;
        await compiler.rebuild();

        const pruned = await compiler.prune();

        expect(pruned.removed.sort()).toEqual([project.at(".claude/skills/a/SKILL.md"), project.at(".claude/skills/b/SKILL.md")]);
        expect(project.exists(".claude")).toBe(false);
        expect(project.exists("MEMO.md")).toBe(true);
    });
});
