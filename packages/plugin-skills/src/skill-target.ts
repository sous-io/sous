/**
 * The `skill-target` entity kind (C42): a place a harness reads skills from.
 */

import { jsonSchema } from "@sous-io/plugin-api";
import type { SkillTargetEntity } from "./types.js";

/** The kind's name. */
export const SKILL_TARGET = "skill-target";

/**
 * The schema every `skill-target` is checked against. `transform` is a function, which JSON Schema
 * cannot describe; it passes through, and the contributor uses it only when it is one.
 */
export const skillTargetSchema = jsonSchema<SkillTargetEntity>({
    type: "object",
    properties: {
        id: { type: "string", description: "The target's name: `claude-code`." },
        harness: { type: "string", description: "The `harness` entity that reads it." },
        directory: { type: "string", description: "The directory skills go into; relative paths are under the project root." },
        description: { type: "string" },
    },
    required: ["id", "directory"],
});

/** What the kind is, for `plugins show`. */
export const SKILL_TARGET_DESCRIPTION = "A place a harness reads skills from, with an optional transform of each file.";
