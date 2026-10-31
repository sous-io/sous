import path from "node:path";
import type { BuiltConfig, ProjectInfo } from "@sous-io/plugin-api";
import type { HostGlobs } from "@sous-io/plugin-host/types";

/** What watch mode watches. */
export interface WatchSet {
    /** Exact source files: a change is a partial rebuild. */
    files: string[];
    /** Glob patterns of source files: a matching change is a partial rebuild. */
    globs: string[];
    /** Files and directories whose change is a full rebuild: the config, `conf.d`, links, `watch.paths`. */
    fullRebuildPaths: string[];
    /** Files whose change is never a rebuild: the state file, the PID file. */
    ignored: string[];
}

/** What a change is. */
export type ChangeKind = "full" | "partial" | "ignored";

/**
 * Works out what to watch from the latest config. Each compilation target's `entryPoint` is watched
 * as a file and its `entryGlob` as a pattern (alias prefixes expanded to every base, as compiling
 * does). Targets a recipe added are left out: a recipe's files only change in a linked checkout,
 * which is watched whole. `content` targets have no source file.
 *
 * ```ts
 * watchSet(ctx.config, ctx.project, globs, { cwd });
 * // { files: ["/p/prompts/AGENTS.md"], globs: ["/p/skills/**\/*.md"], fullRebuildPaths: ["/p/.sous/sous.config.ts", "/p/.sous/conf.d"], ignored: [...] }
 * ```
 */
export function watchSet(
    config: BuiltConfig,
    project: ProjectInfo | undefined,
    globs: HostGlobs,
    options: { cwd: string; ignored?: readonly string[] },
): WatchSet {
    const services = config.services;
    const resolver = services.get("variables.resolver");
    const aliases = services.has("compiler.aliases") ? services.get("compiler.aliases") : undefined;
    const targets = config.get("compilation")?.targets ?? [];
    const base = project?.root ?? options.cwd;
    const absolute = (value: string) => path.resolve(base, resolver.normalizePath(value));

    const files = new Set<string>();
    const patterns = new Set<string>();

    targets.forEach((target, index) => {
        if (target.origin?.recipe !== undefined) {
            return;
        }

        const scope = resolver.scope({ level: "target", target: index });

        if (target.entryPoint) {
            files.add(absolute(resolver.substituteStrict(target.entryPoint, scope, `compilation.targets[${index}].entryPoint`)));
        }

        if (target.entryGlob) {
            const pattern = resolver.substituteStrict(target.entryGlob, scope, `compilation.targets[${index}].entryGlob`);
            const split = aliases?.split(pattern);

            if (split) {
                for (const dir of aliases?.get(split.alias) ?? []) {
                    patterns.add(globs.toPosix(path.join(dir, split.rest)));
                }
            } else {
                patterns.add(globs.toPosix(absolute(pattern)));
            }
        }
    });

    const rootScope = resolver.scope();
    const fullRebuildPaths = new Set<string>();

    if (project?.configPath) fullRebuildPaths.add(project.configPath);
    if (project?.confDir) fullRebuildPaths.add(project.confDir);

    if (services.has("recipes.links")) {
        for (const link of Object.values(services.get("recipes.links").all())) {
            fullRebuildPaths.add(link.path);
        }
    }

    for (const extra of config.get("watch")?.paths ?? []) {
        const resolved = absolute(resolver.substitute(extra, rootScope));

        // A glob is watched by its static base: any change under it is a full rebuild.
        fullRebuildPaths.add(globs.hasGlob(resolved) ? globs.staticBase(resolved) : resolved);
    }

    return {
        files: [...files],
        globs: [...patterns],
        fullRebuildPaths: [...fullRebuildPaths],
        ignored: [...(options.ignored ?? [])],
    };
}

/** The paths to hand the file watcher: files, each glob's static base, and the full-rebuild paths. */
export function pathsToWatch(set: WatchSet, globs: HostGlobs): string[] {
    return [...new Set([...set.files, ...set.globs.map((pattern) => globs.staticBase(pattern)), ...set.fullRebuildPaths])];
}

/** Whether a change to a file is a full rebuild, a partial one, or nothing. Full-rebuild paths win. */
export function classifyChange(file: string, set: WatchSet, globs: HostGlobs): ChangeKind {
    const resolved = path.resolve(file);

    if (set.ignored.some((ignored) => path.resolve(ignored) === resolved)) {
        return "ignored";
    }

    if (set.fullRebuildPaths.some((full) => isInside(resolved, path.resolve(full)))) {
        return "full";
    }

    if (set.files.some((exact) => path.resolve(exact) === resolved)) {
        return "partial";
    }

    const posix = globs.toPosix(resolved);

    return set.globs.some((pattern) => globs.isMatch(posix, pattern)) ? "partial" : "ignored";
}

function isInside(child: string, parent: string): boolean {
    return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}
