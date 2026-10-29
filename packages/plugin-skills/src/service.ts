/**
 * The `skills.sources` service (config lifetime): where skills come from, for the built config.
 */

import type { ConfigReader, ServiceContext } from "@sous-io/plugin-api";
import { stringsOf } from "./settings.js";
import { findSkills, type FoundSkills } from "./sources.js";
import type { SkillSource, SkillsSources } from "./types.js";

/** Finds the skills of a built config, once, on first use. */
export class ConfigSkillsSources implements SkillsSources {
    private found: FoundSkills | undefined;

    constructor(
        private readonly config: ConfigReader,
        private readonly ctx: Pick<ServiceContext, "entities" | "project">,
    ) {}

    list(): SkillSource[] {
        return this.find().skills.map(({ base: _base, ...source }) => source);
    }

    recipes(): string[] {
        return [...new Set(this.find().skills.flatMap((skill) => (skill.recipe === undefined ? [] : [skill.recipe])))];
    }

    /** What is wrong with `recipes.skills.include`, one sentence each. */
    problems(): string[] {
        return this.find().problems.map((problem) => problem.message);
    }

    private find(): FoundSkills {
        this.found ??= findSkills({
            recipes: this.ctx.entities.list("active-recipe"),
            include: stringsOf(this.config.get("recipes.skills.include")),
            project: this.ctx.project,
        });

        return this.found;
    }
}
