/**
 * Where a recipe's files land in this project, for `recipe show`. Skills go to every place a
 * harness reads skills from (the `skill-target` entities plugin-skills reads) and to the
 * directories in `recipes.skills.outputs`; memories go to every file a harness reads into each
 * session (the `memory-target` entities). Other kinds are not written into the project.
 *
 * ```ts
 * destinationsFor(ctx, "skills");   // ["/project/.claude/skills"]
 * destinationsFor(ctx, "memories"); // ["/project/CLAUDE.md"]
 * ```
 *
 * Paths are shown as configured: a `${var}` in one is left for the build to fill in.
 */

import path from "node:path";
import type { Context } from "@sous-io/plugin-api";
import { compareBytewise } from "./util.js";

/** What a `skill-target` entity says, read loosely: plugin-recipes does not depend on plugin-skills. */
interface SkillTargetShape {
    readonly directory?: unknown;
}

/** What a `memory-target` entity says, read loosely: plugin-recipes does not depend on plugin-memories. */
interface MemoryTargetShape {
    readonly fileName?: unknown;
    readonly directory?: unknown;
}

/** The entities of a kind another plugin defines; none when no plugin defines it. */
function listOf<T>(ctx: Pick<Context, "entities">, kind: string): T[] {
    try {
        return (ctx.entities.list as (kind: string) => T[])(kind);
    } catch {
        return [];
    }
}

/** A path under the project root, unless it is absolute or holds a variable. */
function underRoot(root: string | undefined, target: string): string {
    if (root === undefined || path.isAbsolute(target) || target.startsWith("${")) {
        return target;
    }

    return path.join(root, target);
}

/** Each destination once, in bytewise order. */
function distinct(paths: readonly string[]): string[] {
    return [...new Set(paths)].sort(compareBytewise);
}

/** Where one content kind's files land in this project. */
export function destinationsFor(ctx: Pick<Context, "entities" | "config" | "project">, kind: string): string[] {
    const root = ctx.project?.root;

    if (kind === "skills") {
        const targets = listOf<SkillTargetShape>(ctx, "skill-target")
            .map((target) => target.directory)
            .filter((directory): directory is string => typeof directory === "string" && directory.length > 0);
        const outputs = ctx.config.get<unknown>(["recipes", "skills", "outputs"]);
        const extra = Array.isArray(outputs) ? outputs.filter((output): output is string => typeof output === "string" && output.length > 0) : [];

        return distinct([...targets, ...extra].map((target) => underRoot(root, target)));
    }

    if (kind === "memories") {
        return distinct(
            listOf<MemoryTargetShape>(ctx, "memory-target")
                .filter((target): target is { fileName: string; directory?: unknown } => typeof target.fileName === "string" && target.fileName.length > 0)
                .map((target) => underRoot(root, path.join(typeof target.directory === "string" ? target.directory : "", target.fileName))),
        );
    }

    return [];
}
