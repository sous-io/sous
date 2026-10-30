/**
 * The contract of plugin-skills: places a harness reads skills from
 * (`skill-target`), where skills come from, and the `skills.targets` contributor that turns skill
 * targets into compilation targets. It writes nothing itself; the compiler does.
 *
 * With no `skill-target` and no configured destination, skills go nowhere, and the build says why
 * and how to fix it; core has no default destination.
 *
 * Other plugins import this file type-only.
 */

import type { ServiceContext } from "@sous-io/plugin-api";
import type { TransformFile } from "@sous-io/plugin-compiler/types";

/** One skill file on its way to a skill target, as a transform sees it. */
export interface SkillFile extends TransformFile {
    /** The skill's name: its directory under the recipe's skills. */
    readonly skill: string;
    /** The recipe it came from, `namespace/recipe`, or `undefined` for the user's own. */
    readonly recipe?: string;
}

/** A skill target's optional change to each file's name or contents. */
export type SkillTransform = (file: SkillFile, ctx: ServiceContext) => SkillFile | undefined | Promise<SkillFile | undefined>;

/** A `skill-target` entity: a place a harness reads skills from. */
export interface SkillTargetEntity {
    /** `claude-code`. */
    id: string;
    /** The `harness` entity that reads it, when there is one. */
    harness?: string;
    /** The directory skills go into; relative paths are under the project root. `${var}` allowed. */
    directory: string;
    /** Changes each file's name or contents before it is written; `undefined` drops the file. */
    transform?: SkillTransform;
    description?: string;
}

/** Where a skill comes from. */
export type SkillOrigin = "recipe" | "project";

/** One skill and its files. */
export interface SkillSource {
    /** The skill's name. */
    readonly name: string;
    readonly origin: SkillOrigin;
    /** The recipe, `namespace/recipe`, for a recipe's skill. */
    readonly recipe?: string;
    /** The recipe's repository short name. */
    readonly repository?: string;
    /** The skill's directory. */
    readonly dir: string;
    /** Every file of the skill, relative to `dir`, bytewise. */
    readonly files: readonly string[];
}

/** Where skills come from: the active recipes, and the user's own. */
export interface SkillsSources {
    list(): SkillSource[];
    /** The active recipes that publish skills. */
    recipes(): string[];
}

/** The `recipes.skills` config key. */
export interface SkillsSettings {
    /** Directories skills are also written to, `${var}` allowed (`recipes.skills.outputs`). Default `[]`. */
    outputs: string[];
    /** Directories of the user's own skills, compiled like a recipe's. Default `[]`. */
    include: string[];
}

declare module "@sous-io/plugin-api" {
    interface SousServices {
        "skills.sources": SkillsSources;
    }

    interface SousEntities {
        /** A place a harness reads skills from. */
        "skill-target": SkillTargetEntity;
    }

    interface SousConfig {
        "recipes.skills": SkillsSettings;
    }
}
