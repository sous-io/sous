/**
 * The `recipes.skills` config key (C57): where the user's skills go, and where their own skills come
 * from.
 */

import { type ConfigKeyEntity, jsonSchema } from "@sous-io/plugin-api";
import type { SkillsSettings } from "./types.js";

/** The key's path. */
export const SKILLS_KEY = "recipes.skills";

const stringList = { type: "array", items: { type: "string" }, default: [] } as const;

/** The `config-key` entity for `recipes.skills`. */
export const skillsConfigKey: ConfigKeyEntity = {
    id: SKILLS_KEY,
    description: "Where skills go (outputs, `${var}` allowed) and directories of your own skills (include).",
    schema: jsonSchema<SkillsSettings>({
        type: "object",
        properties: {
            outputs: { ...stringList, description: "Directories skills are also written to." },
            include: { ...stringList, description: "Directories of your own skills, compiled like a recipe's." },
        },
        additionalProperties: false,
        default: {},
    }),
};

/**
 * Keeps the strings of a list setting and drops anything else. The config is checked only after it
 * is built, so a contributor may see a value of the wrong type; checking reports it then.
 */
export function stringsOf(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
}
