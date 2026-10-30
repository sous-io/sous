import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompilationTarget, CompilationTransformEntity } from "@sous-io/plugin-compiler/types";
import skillsPlugin, { PLUGIN_NAME } from "../src/index.js";
import type { SkillFile } from "../src/types.js";
import {
    activeRecipe,
    type CompileLog,
    compilerStandIn,
    makeEngine,
    makeTmpDir,
    plugin,
    projectIn,
    recipesStandIn,
    type TmpDir,
    userConfig,
    write,
} from "./helpers.js";

let tmp: TmpDir;
let recipeDir: string;
let projectRoot: string;

beforeEach(() => {
    tmp = makeTmpDir();
    recipeDir = path.join(tmp.path, "store", "workflow", "task-files");
    projectRoot = path.join(tmp.path, "project");
    write(path.join(recipeDir, "skills", "greeting", "SKILL.md"), "# hello");
    write(path.join(projectRoot, ".sous", "sous.config.json"), "{}");
});

afterEach(() => {
    tmp.cleanup();
});

/** A plugin adding a skill target in `register()`. */
function targetPlugin(name: string, id: string, directory: string, transform?: (file: SkillFile) => SkillFile | undefined) {
    return plugin(name, (sous) => {
        sous.entities.add("skill-target", transform ? { id, directory, transform } : { id, directory });
    });
}

function targetsOf(value: unknown): CompilationTarget[] {
    return (value as CompilationTarget[] | undefined) ?? [];
}

describe("plugin-skills", () => {
    /**
     * The `recipes.skills` key should default to empty lists, so a config that never sets it still
     * reads `outputs` and `include`.
     *
     * built.get("recipes.skills"); // -> { outputs: [], include: [] }
     */
    it("should give recipes.skills its defaults", async () => {
        const { engine } = makeEngine([compilerStandIn(), recipesStandIn([]), skillsPlugin], projectIn(projectRoot));
        const built = await engine.buildConfig();

        expect(built.get("recipes.skills")).toEqual({ outputs: [], include: [] });
    });

    /**
     * A user can set where skills go: each file of each active recipe's skills becomes a
     * compilation target writing into every `recipes.skills.outputs` directory, mirroring under the
     * include's base, with the recipe as its origin.
     *
     * // recipes.skills.outputs: [".codex/skills"]
     * // -> { entryPoint: ".../skills/greeting/SKILL.md", globBase: ".../skills",
     * //      outputs: [{ destinationDir: "${projectRoot}/.codex/skills" }] }
     */
    it("should compile recipes' skills into recipes.skills.outputs", async () => {
        const { engine } = makeEngine(
            [compilerStandIn(), recipesStandIn([activeRecipe(recipeDir)]), skillsPlugin, userConfig({ recipes: { skills: { outputs: [".codex/skills"] } } })],
            projectIn(projectRoot),
        );
        const built = await engine.buildConfig();

        expect(targetsOf(built.get("compilation.targets"))).toEqual([
            {
                id: "skills/workflow/task-files/greeting/SKILL.md",
                entryPoint: path.join(recipeDir, "skills", "greeting", "SKILL.md"),
                globBase: path.join(recipeDir, "skills"),
                origin: { plugin: PLUGIN_NAME, recipe: "workflow/task-files", repository: "fixtures" },
                outputs: [{ destinationDir: "${projectRoot}/.codex/skills" }],
            },
        ]);
    });

    /**
     * A plugin can add a skill target with a transform: its directory becomes an output of
     * every skill file, naming a `compilation-transform` entity that hands the target's transform
     * each file with its skill and recipe.
     *
     * sous.entities.add("skill-target", { id: "claude-code", directory: ".claude/skills", transform });
     * // -> outputs: [{ destinationDir: "${projectRoot}/.claude/skills", transforms: ["skills/claude-code"] }]
     */
    it("should turn a skill target and its transform into outputs and a compilation-transform", async () => {
        const seen: SkillFile[] = [];
        const { engine } = makeEngine(
            [
                compilerStandIn(),
                recipesStandIn([activeRecipe(recipeDir)]),
                skillsPlugin,
                targetPlugin("test-harness", "claude-code", ".claude/skills", (file) => {
                    seen.push(file);

                    return { ...file, content: file.content.toUpperCase() };
                }),
            ],
            projectIn(projectRoot),
        );
        const built = await engine.buildConfig();
        const [target] = targetsOf(built.get("compilation.targets"));

        expect(target!.outputs).toEqual([{ destinationDir: "${projectRoot}/.claude/skills", transforms: ["skills/claude-code"] }]);

        const transform = built.entities.get("compilation-transform", "skills/claude-code") as CompilationTransformEntity;
        const source = path.join(recipeDir, "skills", "greeting", "SKILL.md");
        const out = await transform.transform({ source, destination: "/x/greeting/SKILL.md", content: "# hello" }, {} as never);

        expect(out?.content).toBe("# HELLO");
        expect(seen[0]).toMatchObject({ skill: "greeting", recipe: "workflow/task-files", source });
    });

    /**
     * Skill targets and `recipes.skills.outputs` should apply together, never one ignoring the other.
     *
     * // skill target .claude/skills, outputs [/abs/codex]
     * // -> outputs: [{ destinationDir: "${projectRoot}/.claude/skills" }, { destinationDir: "/abs/codex" }]
     */
    it("should write into skill targets and configured outputs together", async () => {
        const codex = path.join(tmp.path, "codex");
        const { engine } = makeEngine(
            [
                compilerStandIn(),
                recipesStandIn([activeRecipe(recipeDir)]),
                skillsPlugin,
                targetPlugin("test-harness", "claude-code", ".claude/skills"),
                userConfig({ recipes: { skills: { outputs: [codex] } } }),
            ],
            projectIn(projectRoot),
        );
        const built = await engine.buildConfig();

        expect(targetsOf(built.get("compilation.targets"))[0]!.outputs).toEqual([
            { destinationDir: "${projectRoot}/.claude/skills" },
            { destinationDir: codex },
        ]);
        expect(built.entities.list("compilation-transform")).toEqual([]);
    });

    /**
     * The contributor reads skill targets through the builder, so a skill target a contributor adds
     * in a later pass re-runs it.
     *
     * pass 1: skills.targets sees no skill target; codex adds one
     * pass 2: skills.targets re-runs; adds an output for .codex/skills
     */
    it("should re-run when a skill target is added later", async () => {
        const late = plugin("sous-plugin-codex", (sous) => {
            sous.config.contribute({
                id: "codex/targets",
                after: [PLUGIN_NAME],
                contribute(config) {
                    config.addEntity("skill-target", { id: "codex", directory: ".codex/skills" });
                },
            });
        });
        const { engine } = makeEngine([compilerStandIn(), recipesStandIn([activeRecipe(recipeDir)]), skillsPlugin, late], projectIn(projectRoot));
        const built = await engine.buildConfig();
        const skills = built.contributions().find((c) => c.contributor === "skills.targets");

        expect(skills?.runs).toBe(2);
        expect(targetsOf(built.get("compilation.targets"))[0]!.outputs).toEqual([{ destinationDir: "${projectRoot}/.codex/skills" }]);
    });

    /**
     * The user's own skill directories (`recipes.skills.include`) should be compiled like a recipe's,
     * with no recipe in their origin.
     *
     * // include: ["my-skills"], outputs: ["out"]
     * // -> { id: "skills/project:my-skills/mine/SKILL.md", origin: { plugin } }
     */
    it("should compile the user's own skills", async () => {
        write(path.join(projectRoot, "my-skills", "mine", "SKILL.md"));

        const { engine } = makeEngine(
            [compilerStandIn(), recipesStandIn([]), skillsPlugin, userConfig({ recipes: { skills: { outputs: ["out"], include: ["my-skills"] } } })],
            projectIn(projectRoot),
        );
        const [target] = targetsOf((await engine.buildConfig()).get("compilation.targets"));

        expect(target).toMatchObject({
            id: "skills/project:my-skills/mine/SKILL.md",
            entryPoint: path.join(projectRoot, "my-skills", "mine", "SKILL.md"),
            origin: { plugin: PLUGIN_NAME },
            outputs: [{ destinationDir: "${projectRoot}/out" }],
        });
    });

    /**
     * With no skill target and no setting, skills go nowhere: no target is added, and the compile
     * says why and how to fix it.
     *
     * await engine.submit({ intent: "compiler.compile" });
     * // warning: "Skipped the skills of 1 recipe: nothing says where skills go. ..."
     */
    it("should add no target and say why when skills go nowhere", async () => {
        const log: CompileLog = { runs: 0 };
        const { engine, reporter } = makeEngine([compilerStandIn(log), recipesStandIn([activeRecipe(recipeDir)]), skillsPlugin], projectIn(projectRoot));
        const built = await engine.buildConfig();

        expect(targetsOf(built.get("compilation.targets"))).toEqual([]);

        await engine.submit({ intent: "compiler.compile" });

        expect(log.runs).toBe(1);
        expect(reporter.at("warning")).toEqual([
            "Skipped the skills of 1 recipe: nothing says where skills go.\n" +
                "  Set recipes.skills.outputs in the config, or enable an agent plugin (such as @sous-io/plugin-claude-code).",
        ]);
    });

    /**
     * The compile should say nothing about skills once a skill target exists, and nothing when there
     * are no skills at all.
     *
     * await engine.submit({ intent: "compiler.compile" }); // no warning
     */
    it("should not warn when skills have somewhere to go, or there are none", async () => {
        const withTarget = makeEngine(
            [compilerStandIn(), recipesStandIn([activeRecipe(recipeDir)]), skillsPlugin, targetPlugin("test-harness", "claude-code", ".claude/skills")],
            projectIn(projectRoot),
        );

        await withTarget.engine.buildConfig();
        await withTarget.engine.submit({ intent: "compiler.compile" });
        expect(withTarget.reporter.at("warning")).toEqual([]);

        const noSkills = makeEngine([compilerStandIn(), recipesStandIn([]), skillsPlugin], projectIn(projectRoot));

        await noSkills.engine.buildConfig();
        await noSkills.engine.submit({ intent: "compiler.compile" });
        expect(noSkills.reporter.at("warning")).toEqual([]);
    });

    /**
     * The compile should report an included directory it cannot use.
     *
     * // include: ["missing"] -> warning naming recipes.skills.include[0]
     */
    it("should report an included directory it cannot use", async () => {
        const { engine, reporter } = makeEngine(
            [compilerStandIn(), recipesStandIn([]), skillsPlugin, userConfig({ recipes: { skills: { include: ["missing"] } } })],
            projectIn(projectRoot),
        );

        await engine.buildConfig();
        await engine.submit({ intent: "compiler.compile" });

        expect(reporter.at("warning")).toEqual([expect.stringContaining("recipes.skills.include[0]")]);
    });

    /**
     * The `skills.sources` service should list every skill and the recipes that publish them.
     *
     * services.get("skills.sources").recipes(); // -> ["workflow/task-files"]
     */
    it("should list skills through skills.sources", async () => {
        const { engine } = makeEngine([compilerStandIn(), recipesStandIn([activeRecipe(recipeDir)]), skillsPlugin], projectIn(projectRoot));
        const built = await engine.buildConfig();
        const sources = built.services.get("skills.sources");

        expect(sources.recipes()).toEqual(["workflow/task-files"]);
        expect(sources.list()).toEqual([
            {
                name: "greeting",
                origin: "recipe",
                recipe: "workflow/task-files",
                repository: "fixtures",
                dir: path.join(recipeDir, "skills", "greeting"),
                files: ["SKILL.md"],
            },
        ]);
    });

    /**
     * A skill target without a directory should be rejected when it is added.
     *
     * sous.entities.add("skill-target", { id: "broken" }); // -> a config error naming "directory"
     */
    it("should reject a skill target without a directory", async () => {
        const broken = plugin("test-broken", (sous) => {
            sous.entities.add("skill-target", { id: "broken" } as never);
        });
        const { engine } = makeEngine([compilerStandIn(), recipesStandIn([]), skillsPlugin, broken], projectIn(projectRoot));

        await expect(engine.buildConfig()).rejects.toMatchObject({ details: [expect.stringContaining("directory")] });
    });

    /**
     * A wrong type in `recipes.skills` should fail the config check, naming the key.
     *
     * recipes.skills.outputs: "nope" // -> error naming recipes.skills.outputs
     */
    it("should reject a recipes.skills.outputs that is not a list", async () => {
        const { engine } = makeEngine(
            [compilerStandIn(), recipesStandIn([]), skillsPlugin, userConfig({ recipes: { skills: { outputs: "nope" } } })],
            projectIn(projectRoot),
        );

        await expect(engine.buildConfig()).rejects.toMatchObject({ details: [expect.stringContaining("recipes.skills.outputs")] });
    });
});
