/**
 * The `skills.targets` contributor (C6, C42, C57): turns every skill into compilation targets, one
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
import { findSkills, type FoundSkill } from "./sources.js";
import type { SkillFile, SkillTargetEntity } from "./types.js";

/** The contributor's id. */
export const TARGETS_CONTRIBUTOR = "skills.targets";

/** Where a target's file came from, for the transform. */
interface FileOrigin {
    readonly skill: string;
    readonly recipe?: string;
}

/** Adds the compilation targets for every skill. */
export function contributeSkillTargets(config: ConfigBuilder, plugin: string): void {
    const outputs = stringsOf(config.atPath("recipes.skills.outputs").get());
    const include = stringsOf(config.atPath("recipes.skills.include").get());
    const targets = config.entities("skill-target");
    const recipes = config.entities("active-recipe");
    const destinations = skillDestinations(outputs, targets);

    // With nowhere to write, nothing is added; the compile says why (see ./nowhere.ts).
    if (destinations.length === 0) {
        return;
    }

    const { skills } = findSkills({ recipes, include, project: config.project });

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

    return {
        id: `skills/${where}/${fromBase}`,
        entryPoint,
        globBase: skill.base,
        origin: {
            plugin,
            ...(skill.recipe === undefined ? {} : { recipe: skill.recipe }),
            ...(skill.repository === undefined ? {} : { repository: skill.repository }),
        },
        outputs: destinations.map((destination): CompilationOutput =>
            destination.transform ? { destinationDir: destination.dir, transforms: [destination.transform] } : { destinationDir: destination.dir },
        ),
    };
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
