/**
 * Where skills come from: the `skills` content of the active recipes, and the user's own skill
 * directories (`recipes.skills.include`). Ported from `buildRecipeTargets` in today's
 * `src/lib/repos/recipe-targets.ts`, with the destinations taken out (see `./destinations.ts`).
 *
 * Two rules decide what counts:
 *
 * - Only recipes held through `subscribes` contribute skills. A recipe held only through `depends`
 *   is fetched and addressable from the recipe that declared it, but its files never enter the
 *   project's output.
 * - A skill is the first directory under the static part of a content block's include pattern:
 *   `skills/**` in a recipe makes `skills/greeting/SKILL.md` part of the skill `greeting`.
 */

import fs from "node:fs";
import path from "node:path";
import { globSync } from "glob";
import type { ProjectInfo } from "@sous-io/sous-plugin-api";
import type { ActiveRecipeContent, ActiveRecipeEntity } from "@sous-io/sous-plugin-recipes/types";
import type { SkillSource } from "./types.js";

/** One skill, with the directory its output paths mirror under. */
export interface FoundSkill extends SkillSource {
    /** The directory above the skill: the static part of the include pattern, absolute. */
    readonly base: string;
    /** The skill's inline files (`{ $inline, path }` in a manifest), by absolute path: no file exists there. */
    readonly inline?: ReadonlyMap<string, string>;
}

/** Something wrong with the user's own skill directories. */
export interface SkillProblem {
    readonly setting: string;
    /** One plain sentence. */
    readonly message: string;
}

/** What {@link findSkills} looks at. */
export interface FindSkillsInput {
    /** The `skills` entries of `recipes.contents`, their files listed (`recipes.contents`' `of`). */
    readonly contents: readonly ActiveRecipeContent[];
    /** The active recipes, for each one's repository. */
    readonly recipes: readonly Pick<ActiveRecipeEntity, "id" | "repo">[];
    /** `recipes.skills.include`. */
    readonly include: readonly string[];
    readonly project: ProjectInfo | undefined;
}

/** What {@link findSkills} found. */
export interface FoundSkills {
    readonly skills: FoundSkill[];
    readonly problems: SkillProblem[];
}

/** Compares strings by code unit, the order sous lists files in. */
export function bytewise(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Every skill of the active recipes, then the user's own. Recipes keep lockfile order; skills within
 * one recipe or directory, and each skill's files, are sorted bytewise.
 */
export function findSkills(input: FindSkillsInput): FoundSkills {
    const skills: FoundSkill[] = [];
    const problems: SkillProblem[] = [];

    const repositories = new Map(input.recipes.map((recipe) => [recipe.id, recipe.repo]));

    for (const content of input.contents) {
        skills.push(...recipeSkills(content, repositories.get(content.recipe)));
    }

    input.include.forEach((entry, index) => {
        const setting = `recipes.skills.include[${index}]`;
        const dir = resolveProjectDir(entry, input.project);

        if (typeof dir !== "string") {
            problems.push({ setting, message: `${setting} is "${entry}": ${dir.reason}` });

            return;
        }

        if (!isDirectory(dir)) {
            problems.push({ setting, message: `${setting} is "${entry}", which is not a directory, so it was skipped.` });

            return;
        }

        skills.push(...groupSkills({ origin: "project" }, [{ base: dir, files: listFiles(dir, "**/*", []) }]));
    });

    return { skills, problems };
}

/** The skills of one `recipes.contents` entry. */
function recipeSkills(content: ActiveRecipeContent, repository: string | undefined): FoundSkill[] {
    const byBase = new Map<string, string[]>();
    const inline = new Map<string, string>();

    for (const { base, file, content: text } of content.files) {
        byBase.set(base, [...(byBase.get(base) ?? []), file]);

        if (text !== undefined) {
            inline.set(file, text);
        }
    }

    const skills = groupSkills(
        { origin: "recipe", recipe: content.recipe, ...(repository === undefined ? {} : { repository }) },
        [...byBase].map(([base, files]) => ({ base, files })),
    );

    if (inline.size === 0) {
        return skills;
    }

    return skills.map((skill) => {
        const own = new Map([...inline].filter(([file]) => skill.files.some((relative) => path.join(skill.dir, relative) === file)));

        return own.size === 0 ? skill : { ...skill, inline: own };
    });
}

/** Splits files into skills by the first directory under their base. */
function groupSkills(
    from: Pick<SkillSource, "origin" | "recipe" | "repository">,
    groups: ReadonlyArray<{ base: string; files: readonly string[] }>,
): FoundSkill[] {
    const byDir = new Map<string, { name: string; base: string; files: Set<string> }>();

    for (const group of groups) {
        for (const file of group.files) {
            const relative = path.relative(group.base, file);

            if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
                continue;
            }

            const [first] = relative.split(path.sep) as [string, ...string[]];
            const nested = relative !== first;
            const dir = nested ? path.join(group.base, first) : group.base;
            const name = nested ? first : withoutExtensions(first);
            const key = `${dir}\u0000${nested ? "" : name}`;
            let skill = byDir.get(key);

            if (!skill) {
                skill = { name, base: group.base, files: new Set() };
                byDir.set(key, skill);
            }

            skill.files.add(path.relative(dir, file).split(path.sep).join("/"));
        }
    }

    return [...byDir.entries()]
        .map(([key, skill]) => ({
            name: skill.name,
            ...from,
            dir: key.slice(0, key.indexOf("\u0000")),
            base: skill.base,
            files: [...skill.files].sort(bytewise),
        }))
        .sort((a, b) => bytewise(a.name, b.name) || bytewise(a.dir, b.dir));
}

/** Every regular file a pattern matches under a directory, absolute. */
function listFiles(cwd: string, pattern: string, exclude: readonly string[]): string[] {
    if (!isDirectory(cwd)) {
        return [];
    }

    return globSync(pattern, { cwd, absolute: true, nodir: true, ignore: [...exclude] })
        .filter(isFile)
        .sort(bytewise);
}

/**
 * Resolves one of the user's skill directories: absolute, or relative to the project root.
 * `${projectRoot}` and `${sousDir}` are the project's own directories; any other variable cannot be
 * known while the config is built, so the directory is reported and skipped.
 */
function resolveProjectDir(entry: string, project: ProjectInfo | undefined): string | { reason: string } {
    const substituted = entry.replace(/\$\{(projectRoot|sousDir)\}/g, (_match, name: string) => {
        if (!project) {
            return _match;
        }

        return name === "projectRoot" ? project.root : project.sousDir;
    });

    if (/\$\{[^}]*\}/.test(substituted)) {
        return {
            reason: project
                ? "only ${projectRoot} and ${sousDir} can be used here, so it was skipped."
                : "there is no project to resolve it in, so it was skipped.",
        };
    }

    if (path.isAbsolute(substituted)) {
        return path.normalize(substituted);
    }

    if (!project) {
        return { reason: "a relative directory needs a project, and there is none, so it was skipped." };
    }

    return path.resolve(project.root, substituted);
}

/** A file name without its extensions: `notes.tpl.md` is `notes`. */
function withoutExtensions(name: string): string {
    const dot = name.indexOf(".", 1);

    return dot === -1 ? name : name.slice(0, dot);
}

function isDirectory(candidate: string): boolean {
    try {
        return fs.statSync(candidate).isDirectory();
    } catch {
        return false;
    }
}

function isFile(candidate: string): boolean {
    try {
        return fs.statSync(candidate).isFile();
    } catch {
        return false;
    }
}
