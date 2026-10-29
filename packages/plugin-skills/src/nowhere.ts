/**
 * Saying why skills went nowhere. Core has no default destination (ruled 2026-10-25, G8), so with
 * no `skill-target` and no `recipes.skills.outputs`, skills are skipped and the compile says so.
 *
 * It is said when the compile starts, from the finished config, never from the contributor: an
 * early pass may lack a skill target that a plugin loaded later adds.
 */

import type { Context } from "@sous-io/plugin-api";
import { skillDestinations } from "./destinations.js";
import { stringsOf } from "./settings.js";
import type { SkillSource, SkillsSources } from "./types.js";

/** The message for skills that go nowhere, or `undefined` when there are none. */
export function describeNowhere(sources: readonly SkillSource[]): string | undefined {
    const recipes = new Set(sources.flatMap((source) => (source.recipe === undefined ? [] : [source.recipe]))).size;
    const own = sources.filter((source) => source.origin === "project").length;
    const parts: string[] = [];

    if (recipes > 0) {
        parts.push(`the skills of ${recipes} ${recipes === 1 ? "recipe" : "recipes"}`);
    }

    if (own > 0) {
        parts.push(`${own} ${own === 1 ? "skill" : "skills"} of your own`);
    }

    if (parts.length === 0) {
        return undefined;
    }

    return (
        `Skipped ${parts.join(" and ")}: nothing says where skills go.\n` +
        `  Set recipes.skills.outputs in the config, or enable an agent plugin (such as @sous-io/plugin-claude-code).`
    );
}

/** Every warning about skills for the config a compile runs with. */
export function skillWarnings(ctx: Pick<Context, "config" | "entities" | "services">): string[] {
    if (!ctx.services.has("skills.sources")) {
        return [];
    }

    const sources = ctx.services.get("skills.sources") as SkillsSources & { problems?(): string[] };
    const warnings = sources.problems?.() ?? [];
    const destinations = skillDestinations(stringsOf(ctx.config.get("recipes.skills.outputs")), ctx.entities.list("skill-target"));

    if (destinations.length === 0) {
        const nowhere = describeNowhere(sources.list());

        if (nowhere) {
            warnings.push(nowhere);
        }
    }

    return warnings;
}
