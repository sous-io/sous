/**
 * The `skills.targets` contributor: turns every skill into compilation targets, one
 * per file, writing into every skill target and every `recipes.skills.outputs` directory. A skill
 * target's `transform` becomes a `compilation-transform` entity its outputs name.
 *
 * It reads everything through the builder, so a skill target, an active recipe or a setting added
 * later in the build re-runs it. It writes nothing; the compiler does.
 */

import path from "node:path";
import type { ConfigBuilder, ServiceContext } from "@sous-io/plugin-api";
import type { CompilationOutput, CompilationTarget, CompilationTransformEntity, TransformFile } from "@sous-io/plugin-compiler/types";
import { skillDestinations, transformIdFor, type SkillDestination } from "./destinations.js";
import { stringsOf } from "./settings.js";
import type { RecipesContents } from "@sous-io/plugin-recipes/types";
import { findSkills, type FindSkillsInput, type FoundSkill } from "./sources.js";
import type { SkillFile, SkillTargetEntity } from "./types.js";

/** The contributor's id. */
export const TARGETS_CONTRIBUTOR = "skills.targets";

/** Where a target's file came from, for the transform. */
interface FileOrigin {
    readonly skill: string;
    readonly recipe?: string;
}

/** Adds the compilation targets for every skill. */
export function contributeSkillTargets(config: ConfigBuilder, plugin: string, contents: Pick<RecipesContents, "of">): void {
    const outputs = stringsOf(config.atPath("recipes.skills.outputs").get());
    const include = stringsOf(config.atPath("recipes.skills.include").get());
    const targets = config.entities("skill-target");
    const destinations = skillDestinations(outputs, targets);

    // With nowhere to write, nothing is added; the compile says why (see ./nowhere.ts).
    if (destinations.length === 0) {
        return;
    }

    // The `skills` entries of `recipes.contents` (law L8), read through the builder.
    const input: FindSkillsInput = {
        contents: contents.of(config, "skills"),
        recipes: config.entities("active-recipe"),
        include,
        project: config.project,
    };
    const { skills } = findSkills(input);

    if (skills.length === 0) {
        return;
    }

    const origins = new Map<string, FileOrigin>();
    const list = config.atPath("compilation.targets");

    for (const skill of skills) {
        for (const file of skill.files) {
            const entryPoint = path.join(skill.dir, file);

            origins.set(entryPoint, skill.recipe === undefined ? { skill: skill.name } : { skill: skill.name, recipe: skill.recipe });
            list.append(compilationTarget(skill, entryPoint, destinations, plugin, config.project?.root));
        }
    }

    for (const target of targets) {
        if (typeof target.transform === "function" && destinations.some((d) => d.target === target.id)) {
            config.addEntity("compilation-transform", transformEntity(target, origins));
        }
    }
}

/** One file's compilation target. */
function compilationTarget(
    skill: FoundSkill,
    entryPoint: string,
    destinations: readonly SkillDestination[],
    plugin: string,
    projectRoot: string | undefined,
): CompilationTarget {
    const fromBase = path.relative(skill.base, entryPoint).split(path.sep).join("/");
    const where =
        skill.recipe ?? `project:${projectRoot ? path.relative(projectRoot, skill.base).split(path.sep).join("/") || "." : skill.base}`;
    const inline = skill.inline?.get(entryPoint);

    if (inline !== undefined) {
        // Inline content has no file: a `content` target writing each destination's file.
        return {
            id: `skills/${where}/${fromBase}`,
            content: inlineTemplate(inline, fromBase),
            origin: {
                plugin,
                ...(skill.recipe === undefined ? {} : { recipe: skill.recipe }),
                ...(skill.repository === undefined ? {} : { repository: skill.repository }),
            },
            outputs: destinations.map((destination) => outputFor(destination, { destinationFile: `${destination.dir.replace(/\/+$/, "")}/${fromBase}` })),
        };
    }

    return {
        id: `skills/${where}/${fromBase}`,
        entryPoint,
        globBase: skill.base,
        origin: {
            plugin,
            ...(skill.recipe === undefined ? {} : { recipe: skill.recipe }),
            ...(skill.repository === undefined ? {} : { repository: skill.repository }),
        },
        outputs: destinations.map((destination) => outputFor(destination, { destinationDir: destination.dir })),
    };
}

/**
 * One output for one destination: the destination's transform, and its harness, so the merge of
 * the per-harness config builds takes the output from that harness's build (S8, "The Merge").
 *
 * ```ts
 * outputFor({ dir: "${projectRoot}/.claude/skills", target: "claude-code", harness: "claude-code" }, { destinationDir: "${projectRoot}/.claude/skills" });
 * // -> { destinationDir: "${projectRoot}/.claude/skills", harness: "claude-code" }
 * ```
 */
export function outputFor(destination: SkillDestination, where: Pick<CompilationOutput, "destinationDir" | "destinationFile">): CompilationOutput {
    return {
        ...where,
        ...(destination.transform === undefined ? {} : { transforms: [destination.transform] }),
        ...(destination.harness === undefined ? {} : { harness: destination.harness }),
    };
}

/**
 * The template a `content` target compiles for inline content. The compiler renders every
 * `content` source as Liquid, but only a `.tpl.` path is a template, so any other inline content is
 * wrapped in `{% raw %}` and written as it is.
 */
export function inlineTemplate(content: string, virtualPath: string): string {
    return path.posix.basename(virtualPath).includes(".tpl.") ? content : `{% raw %}${content}{% endraw %}`;
}

/** A skill target's transform, as the compiler calls it: each file told its skill and recipe. */
function transformEntity(target: SkillTargetEntity, origins: ReadonlyMap<string, FileOrigin>): CompilationTransformEntity {
    const transform = target.transform!;

    return {
        id: transformIdFor(target.id),
        description: `The transform of the skill target "${target.id}".`,
        async transform(file: TransformFile, ctx: ServiceContext): Promise<TransformFile | undefined> {
            const origin = origins.get(file.source) ?? { skill: path.basename(path.dirname(file.source)) };
            const skillFile: SkillFile = { ...file, ...origin };

            return transform(skillFile, ctx);
        },
    };
}
