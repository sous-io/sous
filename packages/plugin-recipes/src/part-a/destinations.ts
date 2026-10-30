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
 * A `${var}` in a path is filled in the way the build fills it in (`variables.resolver`: the
 * root scope, then `normalizePath`), so a directory named by a variable and the same directory
 * named by a skill target show once, as the resolved path. A variable that cannot be resolved
 * (no resolver, or a name nothing sets) is left as written.
 */

import path from "node:path";
import type { Context } from "@sous-io/plugin-api";
import type {} from "@sous-io/plugin-variables/types";
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

/** Fills in the `${var}` of a path the way the build does, or returns it as written when that cannot be done. */
function resolveVariables(ctx: Partial<Pick<Context, "services">>, value: string): string {
    if (!value.includes("${") || ctx.services === undefined || !ctx.services.has("variables.resolver")) {
        return value;
    }

    try {
        const resolver = ctx.services.get("variables.resolver");

        return resolver.normalizePath(resolver.substituteStrict(value, resolver.scope({ level: "root" }), "recipes.skills.outputs"));
    } catch {
        return value;
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
export function destinationsFor(ctx: Pick<Context, "entities" | "config" | "project"> & Partial<Pick<Context, "services">>, kind: string): string[] {
    const root = ctx.project?.root;

    if (kind === "skills") {
        const targets = listOf<SkillTargetShape>(ctx, "skill-target")
            .map((target) => target.directory)
            .filter((directory): directory is string => typeof directory === "string" && directory.length > 0);
        const outputs = ctx.config.get<unknown>(["recipes", "skills", "outputs"]);
        const extra = Array.isArray(outputs) ? outputs.filter((output): output is string => typeof output === "string" && output.length > 0) : [];

        return distinct([...targets, ...extra].map((target) => underRoot(root, resolveVariables(ctx, target))));
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
