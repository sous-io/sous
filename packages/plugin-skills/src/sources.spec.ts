import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activeRecipe, makeTmpDir, projectIn, type TmpDir, write } from "../test/helpers.js";
import { findSkills, staticBase } from "./sources.js";

let tmp: TmpDir;
let recipeDir: string;
let projectRoot: string;

beforeEach(() => {
    tmp = makeTmpDir();
    recipeDir = path.join(tmp.path, "store", "fixtures", "workflow", "task-files", "1.0.0");
    projectRoot = path.join(tmp.path, "project");
    write(path.join(projectRoot, ".sous", "sous.config.json"), "{}");
});

afterEach(() => {
    tmp.cleanup();
});

describe("staticBase()", () => {
    /**
     * staticBase should return the directories before the first glob character, which is the base a
     * recipe's output tree mirrors.
     *
     * staticBase("skills/**\/*.md"); // -> "skills"
     */
    it("should return the directories before the first glob character", () => {
        expect(staticBase("skills/**/*.md")).toBe("skills");
        expect(staticBase("a/b/*.md")).toBe("a/b");
        expect(staticBase("**/*.md")).toBe(".");
    });

    /**
     * staticBase should return a literal file's directory, so the file keeps its name.
     *
     * staticBase("skills/greeting/SKILL.md"); // -> "skills/greeting"
     */
    it("should return a literal file's directory", () => {
        expect(staticBase("skills/greeting/SKILL.md")).toBe("skills/greeting");
    });
});

describe("findSkills()", () => {
    /**
     * findSkills should list every file a recipe's skills content matches, grouped by the first
     * directory under the include's static base, so `skills/greeting/SKILL.md` belongs to the skill
     * `greeting` and mirrors under `skills/`. (Ported from buildRecipeTargets' "one target per file".)
     *
     * findSkills({ recipes: [recipe], include: [], project });
     * // -> [{ name: "greeting", dir: ".../skills/greeting", base: ".../skills", files: ["SKILL.md"] }]
     */
    it("should group a recipe's files into skills under the include's base", () => {
        write(path.join(recipeDir, "skills", "greeting", "SKILL.md"), "# hello");
        write(path.join(recipeDir, "skills", "greeting", "refs", "b.md"));

        const { skills, problems } = findSkills({ recipes: [activeRecipe(recipeDir)], include: [], project: projectIn(projectRoot) });

        expect(problems).toEqual([]);
        expect(skills).toEqual([
            {
                name: "greeting",
                origin: "recipe",
                recipe: "workflow/task-files",
                repository: "fixtures",
                dir: path.join(recipeDir, "skills", "greeting"),
                base: path.join(recipeDir, "skills"),
                files: ["SKILL.md", "refs/b.md"],
            },
        ]);
    });

    /**
     * findSkills should honour a content block's exclude patterns, so a recipe can publish a
     * directory without publishing everything in it.
     *
     * // include skills/**\/*.md, exclude skills/private/**
     * findSkills(...).skills.map((s) => s.name); // -> ["greeting"]
     */
    it("should honour exclude patterns", () => {
        write(path.join(recipeDir, "skills", "greeting", "SKILL.md"), "# hello");
        write(path.join(recipeDir, "skills", "private", "SKILL.md"), "# secret");

        const recipe = activeRecipe(recipeDir);

        recipe.manifest.contents = [{ kind: "skills", include: ["skills/**/*.md"], exclude: ["skills/private/**"] }];

        const { skills } = findSkills({ recipes: [recipe], include: [], project: undefined });

        expect(skills.map((skill) => skill.name)).toEqual(["greeting"]);
    });

    /**
     * findSkills should find nothing in a recipe held only as a build dependency: it is fetched and
     * addressable, but its files never enter the project's output.
     *
     * findSkills({ recipes: [{ kind: "depends", ... }] }).skills; // -> []
     */
    it("should find nothing in a build dependency", () => {
        write(path.join(recipeDir, "skills", "greeting", "SKILL.md"), "# hello");

        const { skills } = findSkills({ recipes: [activeRecipe(recipeDir, { kind: "depends" })], include: [], project: undefined });

        expect(skills).toEqual([]);
    });

    /**
     * findSkills should ignore content of other kinds: memories and prompts are not copied as skills.
     *
     * // contents: skills, memories, prompts
     * findSkills(...).skills.length; // -> 1
     */
    it("should ignore memories and prompts", () => {
        write(path.join(recipeDir, "skills", "greeting", "SKILL.md"));
        write(path.join(recipeDir, "memories", "notes.md"));
        write(path.join(recipeDir, "prompts", "p.md"));

        const recipe = activeRecipe(recipeDir);

        recipe.manifest.contents = [
            { kind: "skills", include: ["skills/**/*.md"] },
            { kind: "memories", include: ["memories/**/*.md"] },
            { kind: "prompts", include: ["prompts/**/*.md"] },
        ];

        expect(findSkills({ recipes: [recipe], include: [], project: undefined }).skills).toHaveLength(1);
    });

    /**
     * findSkills should return nothing when no recipe is active and no directory is included, so a
     * project using no repositories pays nothing.
     *
     * findSkills({ recipes: [], include: [], project }); // -> { skills: [], problems: [] }
     */
    it("should return nothing when nothing is active", () => {
        expect(findSkills({ recipes: [], include: [], project: projectIn(projectRoot) })).toEqual({ skills: [], problems: [] });
    });

    /**
     * findSkills should list the user's own skill directories after the recipes' skills, resolving
     * relative directories and `${projectRoot}` against the project.
     *
     * findSkills({ include: ["skills", "${projectRoot}/more"], project });
     * // -> [{ name: "mine", origin: "project", ... }, { name: "other", ... }]
     */
    it("should list the user's own skills, relative to the project root", () => {
        write(path.join(projectRoot, "skills", "mine", "SKILL.md"));
        write(path.join(projectRoot, "more", "other", "SKILL.md"));

        const { skills, problems } = findSkills({
            recipes: [],
            include: ["skills", "${projectRoot}/more"],
            project: projectIn(projectRoot),
        });

        expect(problems).toEqual([]);
        expect(skills.map((skill) => [skill.name, skill.origin, skill.base, skill.files])).toEqual([
            ["mine", "project", path.join(projectRoot, "skills"), ["SKILL.md"]],
            ["other", "project", path.join(projectRoot, "more"), ["SKILL.md"]],
        ]);
        expect(skills[0]!.recipe).toBeUndefined();
    });

    /**
     * findSkills should report, and skip, an included directory that does not exist or uses a
     * variable it cannot know while the config is built.
     *
     * findSkills({ include: ["missing", "${home}/x"], project }).problems;
     * // -> [{ setting: "recipes.skills.include[0]", ... }, { setting: "recipes.skills.include[1]", ... }]
     */
    it("should report included directories it cannot use", () => {
        const { skills, problems } = findSkills({ recipes: [], include: ["missing", "${home}/x"], project: projectIn(projectRoot) });

        expect(skills).toEqual([]);
        expect(problems.map((problem) => problem.setting)).toEqual(["recipes.skills.include[0]", "recipes.skills.include[1]"]);
        expect(problems[0]!.message).toContain("not a directory");
        expect(problems[1]!.message).toContain("${projectRoot}");
    });

    /**
     * findSkills should treat a file directly under the base as a skill named after the file, with
     * its extensions removed.
     *
     * // skills/notes.tpl.md
     * findSkills(...).skills[0].name; // -> "notes"
     */
    it("should name a file directly under the base after the file", () => {
        write(path.join(recipeDir, "skills", "notes.tpl.md"));

        const [skill] = findSkills({ recipes: [activeRecipe(recipeDir)], include: [], project: undefined }).skills;

        expect(skill).toMatchObject({ name: "notes", dir: path.join(recipeDir, "skills"), files: ["notes.tpl.md"] });
    });
});
