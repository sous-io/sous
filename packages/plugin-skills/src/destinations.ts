/**
 * Where skills go: every `skill-target` entity, and every directory in `recipes.skills.outputs`,
 * both together. There is no default: with neither, skills go nowhere.
 */

import path from "node:path";
import type { SkillTargetEntity } from "./types.js";

/** One directory skills are written to. */
export interface SkillDestination {
    /** The directory, absolute or under `${projectRoot}`, any other `${var}` left for the compiler. */
    readonly dir: string;
    /** The skill target it came from; `undefined` for `recipes.skills.outputs`. */
    readonly target?: string;
    /** The `compilation-transform` id of the target's transform, when it has one. */
    readonly transform?: string;
}

/** The `compilation-transform` id a skill target's transform is registered under. */
export function transformIdFor(targetId: string): string {
    return `skills/${targetId}`;
}

/**
 * Turns a configured directory into an output directory. Absolute paths are normalized; a path
 * starting with a variable is left alone; anything else is under the project root, which
 * `plugin-variables` publishes as `${projectRoot}`.
 */
export function outputDir(directory: string): string {
    const trimmed = directory.trim();

    if (path.isAbsolute(trimmed)) {
        return stripTrailingSlash(path.normalize(trimmed));
    }

    if (trimmed.startsWith("${")) {
        return stripTrailingSlash(trimmed);
    }

    const relative = path.posix.normalize(trimmed.split(path.sep).join("/"));

    return relative === "." ? "${projectRoot}" : `\${projectRoot}/${stripTrailingSlash(relative.replace(/^\.\//, ""))}`;
}

/**
 * Every destination, skill targets first in entity order, then the user's outputs. A directory named
 * twice is written once: a skill target's entry wins, since it may carry a transform.
 */
export function skillDestinations(outputs: readonly string[], targets: readonly SkillTargetEntity[]): SkillDestination[] {
    const destinations: SkillDestination[] = [];
    const seen = new Set<string>();

    for (const target of targets) {
        if (typeof target.directory !== "string" || target.directory.trim() === "") {
            continue;
        }

        const dir = outputDir(target.directory);

        if (seen.has(dir)) {
            continue;
        }

        seen.add(dir);
        destinations.push(
            typeof target.transform === "function"
                ? { dir, target: target.id, transform: transformIdFor(target.id) }
                : { dir, target: target.id },
        );
    }

    for (const output of outputs) {
        const dir = outputDir(output);

        if (!seen.has(dir)) {
            seen.add(dir);
            destinations.push({ dir });
        }
    }

    return destinations;
}

function stripTrailingSlash(value: string): string {
    return value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
}
