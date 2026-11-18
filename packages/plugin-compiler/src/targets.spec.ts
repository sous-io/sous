import { describe, expect, it } from "vitest";
import type { CompilationFile, CompilationSettings, CompilationTarget, CompileProblem } from "./types.js";
import { unitsOf, yieldToConfigTargets, type CompileUnit } from "./targets.js";

/** A unit writing the given files, with the given origin. */
function unit(name: string, destinations: string[], origin?: CompileUnit["origin"]): CompileUnit {
    return {
        targetIndex: 0,
        targetName: name,
        source: `/project/${name}`,
        label: name,
        includeSourceComments: false,
        scope: {},
        transforms: [],
        ...(origin === undefined ? {} : { origin }),
        outputs: destinations.map((destination, index) => ({ index, destination, vars: {}, transforms: [] })),
    };
}

describe("yieldToConfigTargets", () => {
    it("drops a plugin's target that writes a file the config's own target writes", () => {
        const mine = unit("CLAUDE.md", ["/project/CLAUDE.md"]);
        const memories = unit("memories/claude-code", ["/project/CLAUDE.md"], { plugin: "@sous-io/plugin-memories" });

        expect(yieldToConfigTargets([memories, mine])).toEqual([mine]);
    });

    it("keeps a plugin's outputs that no config target writes", () => {
        const mine = unit("CLAUDE.md", ["/project/CLAUDE.md"]);
        const plugin = unit("p", ["/project/CLAUDE.md", "/project/OTHER.md"], { plugin: "p" });

        const [kept] = yieldToConfigTargets([plugin, mine]);

        expect(kept!.outputs.map((output) => output.destination)).toEqual(["/project/OTHER.md"]);
    });

    it("leaves targets with no clash alone", () => {
        const mine = unit("OUT.md", ["/project/OUT.md"]);
        const recipe = unit("r", ["/project/OTHER.md"], { plugin: "@sous-io/plugin-skills", recipe: "a/b" });
        const memories = unit("memories/claude-code", ["/project/CLAUDE.md"], { plugin: "@sous-io/plugin-memories" });

        expect(yieldToConfigTargets([mine, recipe, memories])).toEqual([mine, recipe, memories]);
    });

    /**
     * A recipe's output that a config target also writes (a project skill with a recipe skill's
     * name) should yield to the project's target, with a warning naming the file and the recipe.
     */
    it("should drop a recipe's clashing output with a warning", () => {
        const mine = unit("deploy", ["/project/.claude/skills/deploy/SKILL.md"]);
        const recipe = unit("r", ["/project/.claude/skills/deploy/SKILL.md"], { plugin: "@sous-io/plugin-skills", recipe: "workflow/deploy" });
        const problems: CompileProblem[] = [];

        expect(yieldToConfigTargets([recipe, mine], problems)).toEqual([mine]);
        expect(problems).toEqual([
            {
                level: "warning",
                message: "/project/.claude/skills/deploy/SKILL.md is written by this project's own target, so the copy from the recipe workflow/deploy is not written.",
                target: "r",
                file: "/project/r",
            },
        ]);
    });
});

describe("unitsOf", () => {
    const env = { resolver: { scope: (request: { extra?: Record<string, string> }) => ({ base: "1", ...(request.extra ?? {}) }) }, projectRoot: "/project" };
    const target = (outputs: CompilationTarget["outputs"]): CompilationTarget => ({ id: "skills", entryPoint: "/project/a.md", outputs }) as CompilationTarget;
    /** Two outputs of one source that resolved to one file (written `/project/.claude/skills` and `${claudeSkillsDir}`). */
    const settings = (outputs: CompilationTarget["outputs"], extra: Partial<CompilationFile> = {}): CompilationSettings => ({
        includeSourceComments: false,
        overwriteUntracked: true,
        targets: [target(outputs)],
        files: [0, 1].map((output) => ({ target: "skills", targetIndex: 0, source: "/project/a.md", output, destination: "/project/.claude/skills/a.md", ...extra })),
        listing: { targets: 1, problems: [] },
    });

    /** One unit per source; of two outputs that write the same file, the first is kept. */
    it("should keep the first of two outputs that write the same file", () => {
        const { units, problems } = unitsOf(settings([{ destinationDir: "/project/.claude/skills" }, { destinationDir: "${claudeSkillsDir}" }]), env);

        expect(units).toHaveLength(1);
        expect(units[0]!.outputs.map((output) => [output.index, output.destination])).toEqual([[0, "/project/.claude/skills/a.md"]]);
        expect(problems).toEqual([]);
    });

    /** A dropped output with different transforms is reported, never lost silently. */
    it("should warn when the dropped output has different transforms", () => {
        const { units, problems } = unitsOf(settings([{ destinationDir: "/project/.claude/skills" }, { destinationDir: "${claudeSkillsDir}", transforms: ["strip"] }]), env);

        expect(units[0]!.outputs).toHaveLength(1);
        expect(problems).toEqual([
            expect.objectContaining({ level: "warning", target: "skills", file: "/project/.claude/skills/a.md", message: expect.stringContaining("Outputs 0 and 1") }),
        ]);
    });

    /** An entry's `_vars` (from `compilation.varOverrides`) are laid over the output's scope, so they win. */
    it("should lay an entry's _vars over the output's variables", () => {
        const { units } = unitsOf(settings([{ destinationDir: "/project/.claude/skills" }, { destinationDir: "/x" }], { _vars: { base: "2", tool: "claude" } }), env);

        expect(units[0]!.outputs[0]!.vars).toEqual({ base: "2", tool: "claude" });
    });

    /** The listing's problems are returned; a target added after the listing is an error, not silence. */
    it("should return the listing's problems and report a target the listing never saw", () => {
        const late: CompilationSettings = {
            ...settings([{ destinationDir: "/x" }]),
            targets: [target([{ destinationDir: "/x" }]), { id: "late", entryPoint: "/project/b.md", outputs: [] }],
            listing: { targets: 1, problems: [{ level: "warning", message: "Glob pattern matched no files", target: "skills", targetIndex: 0 }] },
        };
        const { problems } = unitsOf(late, env);

        expect(problems).toEqual([
            { level: "warning", message: "Glob pattern matched no files", target: "skills" },
            expect.objectContaining({ level: "error", target: "late", message: expect.stringContaining("were never listed") }),
        ]);
    });
});
