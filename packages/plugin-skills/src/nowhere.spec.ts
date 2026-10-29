import { describe, expect, it } from "vitest";
import { describeNowhere } from "./nowhere.js";
import type { SkillSource } from "./types.js";

function source(name: string, recipe?: string): SkillSource {
    return recipe === undefined
        ? { name, origin: "project", dir: `/p/${name}`, files: ["SKILL.md"] }
        : { name, origin: "recipe", recipe, dir: `/r/${name}`, files: ["SKILL.md"] };
}

describe("describeNowhere()", () => {
    /**
     * describeNowhere should count the recipes whose skills were skipped and say how to fix it.
     *
     * describeNowhere([a/x skill, a/x skill, b/y skill]);
     * // -> "Skipped the skills of 2 recipes: nothing says where skills go.\n  Set recipes.skills.outputs ..."
     */
    it("should count the recipes and say how to fix it", () => {
        const message = describeNowhere([source("one", "a/x"), source("two", "a/x"), source("three", "b/y")]);

        expect(message).toBe(
            "Skipped the skills of 2 recipes: nothing says where skills go.\n" +
                "  Set recipes.skills.outputs in the config, or enable an agent plugin (such as @sous-io/plugin-claude-code).",
        );
    });

    /**
     * describeNowhere should name the user's own skills too, in the singular when there is one.
     *
     * describeNowhere([a/x skill, own skill]); // -> "Skipped the skills of 1 recipe and 1 skill of your own: ..."
     */
    it("should count the user's own skills", () => {
        expect(describeNowhere([source("one", "a/x"), source("mine")])).toMatch(/^Skipped the skills of 1 recipe and 1 skill of your own: /);
    });

    /**
     * describeNowhere should say nothing when there are no skills.
     *
     * describeNowhere([]); // -> undefined
     */
    it("should say nothing without skills", () => {
        expect(describeNowhere([])).toBeUndefined();
    });
});
