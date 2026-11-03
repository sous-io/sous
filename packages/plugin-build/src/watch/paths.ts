import path from "node:path";
import type { BuiltConfig, ProjectInfo } from "@sous-io/plugin-api";
import type { HostGlobs } from "@sous-io/plugin-host/types";
import type { WatchedPaths } from "../types.js";

/** What a change is: which kind of watched path it falls under, or nothing watched. */
export type ChangeKind = "config" | "source" | "output" | "ignored";

/** What {@link watchSet} adds to what the config says. */
export interface WatchSetOptions {
    /** Where relative paths resolve with no project. */
    cwd: string;
    /** Files never reported. */
    ignored?: readonly string[];
    /** More paths or globs, counted as sources. */
    extra?: readonly string[];
    /** Also the targets a recipe added. */
    recipes?: boolean;
    /** Output files to watch. */
    outputs?: readonly string[];
}

/**
 * Works out what to watch from a config. Each compilation target's `entryPoint` is watched as a
 * file and its `entryGlob` as a pattern (alias prefixes expanded to every base, as compiling does).
 * Targets a recipe added are left out unless `recipes` is set: a recipe's files only change in a
 * linked checkout, which is watched whole. `content` targets have no source file.
 *
 * ```ts
 * watchSet(ctx.config, ctx.project, globs, { cwd });
 * // { files: ["/p/prompts/AGENTS.md"], globs: ["/p/skills/**\/*.md"], config: ["/p/.sous/sous.config.ts", "/p/.sous/conf.d"], extra: [], outputs: [], ignored: [] }
 * ```
 */
export function watchSet(config: BuiltConfig, project: ProjectInfo | undefined, globs: HostGlobs, options: WatchSetOptions): WatchedPaths {
    const services = config.services;
    const resolver = services.get("variables.resolver");
    const aliases = services.has("compiler.aliases") ? services.get("compiler.aliases") : undefined;
    const targets = config.get("compilation")?.targets ?? [];
    const base = project?.root ?? options.cwd;
    const absolute = (value: string) => path.resolve(base, resolver.normalizePath(value));

    const files = new Set<string>();
    const patterns = new Set<string>();

    targets.forEach((target, index) => {
        if (target.origin?.recipe !== undefined && !options.recipes) {
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
    // A glob is watched by its static base: any change under it counts.
    const byBase = (value: string) => (globs.hasGlob(value) ? globs.staticBase(value) : value);
    const configPaths = new Set<string>();

    if (project?.configPath) configPaths.add(project.configPath);
    if (project?.confDir) configPaths.add(project.confDir);

    if (services.has("recipes.links")) {
        for (const link of Object.values(services.get("recipes.links").all())) {
            configPaths.add(link.path);
        }
    }

    for (const extra of config.get("watch")?.paths ?? []) {
        configPaths.add(byBase(absolute(resolver.substitute(extra, rootScope))));
    }

    return {
        files: [...files],
        globs: [...patterns],
        config: [...configPaths],
        extra: [...new Set((options.extra ?? []).map((extra) => byBase(path.resolve(base, extra))))],
        outputs: [...new Set((options.outputs ?? []).map((output) => path.resolve(base, output)))],
        ignored: [...(options.ignored ?? [])],
    };
}

/** The paths to hand the file watcher: files, each glob's static base, the config paths, the extra paths and the outputs. */
export function pathsToWatch(set: WatchedPaths, globs: HostGlobs): string[] {
    return [...new Set([...set.files, ...set.globs.map((pattern) => globs.staticBase(pattern)), ...set.config, ...set.extra, ...set.outputs])];
}

/** What a change to a file is. Ignored files win, then config paths, then sources, then outputs. */
export function classifyChange(file: string, set: WatchedPaths, globs: HostGlobs): ChangeKind {
    const resolved = path.resolve(file);

    if (set.ignored.some((ignored) => path.resolve(ignored) === resolved)) {
        return "ignored";
    }

    if (set.config.some((config) => isInside(resolved, path.resolve(config)))) {
        return "config";
    }

    if (set.files.some((exact) => path.resolve(exact) === resolved) || set.extra.some((extra) => isInside(resolved, path.resolve(extra)))) {
        return "source";
    }

    const posix = globs.toPosix(resolved);

    if (set.globs.some((pattern) => globs.isMatch(posix, pattern))) {
        return "source";
    }

    return set.outputs.some((output) => path.resolve(output) === resolved) ? "output" : "ignored";
}

function isInside(child: string, parent: string): boolean {
    return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}
