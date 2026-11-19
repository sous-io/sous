/**
 * The `compiler.files` contributor: lists every file a build writes, one config entry per output
 * of each source, under `compilation.files`. A target's `entryGlob` is matched against the disk
 * here, while the config is built, so the config says which files a build writes and the compiler
 * reads those entries instead of matching globs itself (law L8: declarations as config). It is the
 * one place a target's glob is matched.
 *
 * It runs in a config stage of its own, after stage 0 has settled, so it sees every target the
 * plugins, the recipes and the user's files add, and it runs once instead of on every pass in which
 * a target changes (and the user's files, which re-run on any change, are not made to run again by
 * its result). What goes wrong (a variable no one sets, a glob that matches nothing) is kept under
 * `compilation.listing` and reported when a build runs, as it was before, not on every command.
 */

import fs from "node:fs";
import path from "node:path";
import type { BuiltConfig, ConfigBuilder, ContributorDefinition, EntityReader, ServiceReader } from "@sous-io/sous-plugin-api";
import type { HashNameContext } from "@sous-io/sous-plugin-refs/types";
import type { ScopeRequest, VarScope, VariablesResolver } from "@sous-io/sous-plugin-variables/types";
import { buildAliasMap, resolveAliasPrefix, type AliasMap } from "./aliases.js";
import { expandPattern, type Globs } from "./globs.js";
import { resolveOutputPath } from "./paths.js";
import type { AliasesSettings, CompilationFile, CompilationFileProblem, CompilationListing, CompilationTarget } from "./types.js";

/** The contributor's id. */
export const FILES_CONTRIBUTOR = "compiler.files";

/**
 * The config stage the files are listed in, and `compilation.varOverrides` applied: after stage 0,
 * where every target is added. A contributor that adds a target in a later stage still can; the
 * build then reports that target's files were never listed.
 */
export const LISTING_STAGE = 1;

/** A target's name: its id, or its index. */
export function targetName(target: Pick<CompilationTarget, "id">, index: number): string {
    return target.id ?? String(index);
}

/** What listing needs. */
export interface ListEnvironment {
    /** The scope at a level, as far as it is known. */
    readonly scope: (request: ScopeRequest) => VarScope;
    readonly resolver: Pick<VariablesResolver, "substituteStrict" | "normalizePath">;
    /** The aliases a glob may start with; worked out on first use. */
    readonly aliases: () => AliasMap;
    readonly globs: Pick<Globs, "matchSync" | "hasGlob" | "staticBase" | "sortBytewise">;
    /** Relative paths resolve against it. */
    readonly projectRoot: string;
}

/** The files of every target, and what went wrong listing them. */
export interface ListResult {
    readonly files: CompilationFile[];
    readonly listing: CompilationListing;
}

/**
 * Lists the files of every target: one entry per source and output, in target order, a glob's
 * files in bytewise order, each output in its order. A target that cannot be listed (a variable no
 * one sets) gives no files and one problem; the others are listed.
 *
 * ```ts
 * listFiles([{ id: "docs", entryGlob: "docs/*.md", outputs: [{ destinationDir: "/p/out" }] }], env);
 * // -> { files: [{ target: "docs", targetIndex: 0, source: "/p/docs/a.md", output: 0, destination: "/p/out/a.md" }], listing: { targets: 1, problems: [] } }
 * ```
 */
export function listFiles(targets: readonly CompilationTarget[], env: ListEnvironment): ListResult {
    const files: CompilationFile[] = [];
    const problems: CompilationFileProblem[] = [];

    targets.forEach((target, index) => {
        try {
            files.push(...listTarget(target, index, env, problems));
        } catch (error) {
            problems.push({ level: "error", message: error instanceof Error ? error.message : String(error), target: targetName(target, index), targetIndex: index });
        }
    });

    return { files, listing: { targets: targets.length, problems } };
}

function listTarget(target: CompilationTarget, index: number, env: ListEnvironment, problems: CompilationFileProblem[]): CompilationFile[] {
    const where = `compilation.targets[${index}]`;
    const name = targetName(target, index);
    const scopeKey = target.origin?.recipe;
    const keyed = scopeKey === undefined ? {} : { scopeKey };
    const scope = env.scope({ level: "target", target: index, ...keyed });
    const toPath = (value: string, context: string, inScope: VarScope = scope) =>
        path.resolve(env.projectRoot, env.resolver.normalizePath(env.resolver.substituteStrict(value, inScope, context)));
    const sources = [target.entryPoint, target.entryGlob, target.content].filter((source) => source !== undefined).length;

    // The schema refuses these once the config settles; until then there is nothing to list.
    if (sources !== 1 || (target.content !== undefined && target.id === undefined) || !Array.isArray(target.outputs)) {
        return [];
    }

    // The outputs' destinations, substituted once for every source of the target.
    const outputs = target.outputs.map((output, outputIndex) => {
        const hasVars = output._vars !== undefined && Object.keys(output._vars).length > 0;
        const vars = hasVars ? env.scope({ level: "output", target: index, output: outputIndex, ...keyed }) : scope;
        const at = `${where}.outputs[${outputIndex}]`;

        return {
            outputIndex,
            harness: output.harness,
            ...(output.destinationFile === undefined ? {} : { destinationFile: toPath(output.destinationFile, `${at}.destinationFile`, vars) }),
            ...(output.destinationDir === undefined ? {} : { destinationDir: toPath(output.destinationDir, `${at}.destinationDir`, vars) }),
        };
    });
    const entriesFor = (source: string, globBase: string | undefined): CompilationFile[] =>
        outputs.flatMap((output) => {
            const destination = resolveOutputPath({ source, ...(globBase === undefined ? {} : { globBase }) }, output);

            if (destination === undefined) {
                return [];
            }

            return [
                {
                    target: name,
                    targetIndex: index,
                    source,
                    output: output.outputIndex,
                    destination,
                    ...(output.harness === undefined ? {} : { harness: output.harness }),
                },
            ];
        });

    if (target.content !== undefined) {
        return entriesFor(path.join(env.projectRoot, target.id!), env.projectRoot);
    }

    if (target.entryPoint !== undefined) {
        const source = toPath(target.entryPoint, `${where}.entryPoint`);
        const globBase = target.globBase === undefined ? undefined : toPath(target.globBase, `${where}.globBase`);

        return entriesFor(source, globBase);
    }

    // A leading alias (`#project/skills/**`) gives one pattern per alias base; the first base
    // that matches any file wins, as the first existing candidate of an include does.
    const rawPattern = env.resolver.normalizePath(env.resolver.substituteStrict(target.entryGlob!, scope, `${where}.entryGlob`));
    const candidates = resolveAliasPrefix(rawPattern, aliasesFor(rawPattern, env)).map((candidate) => path.resolve(env.projectRoot, candidate));
    let pattern = candidates[0]!;
    let matched: string[] = [];

    for (const candidate of candidates) {
        const found = expandPattern(env.globs as Globs, candidate, { dot: false });

        if (found.length > 0) {
            pattern = candidate;
            matched = found;
            break;
        }
    }

    const globBase = target.globBase === undefined ? path.resolve(env.globs.staticBase(pattern.split(path.sep).join("/"))) : toPath(target.globBase, `${where}.globBase`);

    // A target whose folder does not exist yet (the project-skills target `sous init` writes,
    // before the first skill) has nothing to compile, which is not a mistake worth a warning on
    // every build. A folder that exists but matches nothing still gets one.
    if (matched.length === 0 && fs.existsSync(globBase)) {
        problems.push({ level: "warning", message: `Glob pattern matched no files:\n${candidates.join("\n")}`, target: name, targetIndex: index });
    }

    return matched.flatMap((source) => entriesFor(source, globBase));
}

/** The aliases, worked out only for a pattern that may start with one. */
function aliasesFor(pattern: string, env: ListEnvironment): AliasMap {
    return path.isAbsolute(pattern) ? {} : env.aliases();
}

/** What the contributor needs from the plugin. */
export interface FilesContributorOptions {
    /** The plugin's name, given to a `#` name's `bases`. */
    readonly plugin: string;
    /** The singleton services: `variables.resolver` and `host.globs`. */
    readonly services: ServiceReader;
}

/**
 * The `compiler.files` contributor: sets `compilation.files` and `compilation.listing` from every
 * target the config holds.
 */
export function filesContributor(options: FilesContributorOptions): ContributorDefinition {
    return {
        id: FILES_CONTRIBUTOR,
        stage: LISTING_STAGE,
        after: ["*"],
        contribute(config) {
            const targets = config.atPath(["compilation", "targets"]).get<CompilationTarget[]>();
            const list = Array.isArray(targets) ? targets : [];
            const resolver = options.services.get("variables.resolver");
            const globs = options.services.get("host.globs");
            const projectRoot = config.project?.root ?? path.resolve("/");
            const { files, listing } = listFiles(list, {
                scope: cachedScopes(config, resolver),
                resolver,
                aliases: once(() => builderAliases(config, options.plugin, options.services, resolver, projectRoot)),
                globs,
                projectRoot,
            });

            config.atPath(["compilation", "files"]).set(files);
            config.atPath(["compilation", "listing"]).set(listing);
        },
    };
}

/**
 * Scopes read through the builder, each worked out once per run: most targets (a recipe's skill
 * files) share their scope with many others, and building a scope reads every variable source.
 */
function cachedScopes(config: ConfigBuilder, resolver: Pick<VariablesResolver, "scopeIn">): (request: ScopeRequest) => VarScope {
    const cache = new Map<string, VarScope>();
    const targets = config.atPath(["compilation", "targets"]);
    const cached = (request: ScopeRequest): VarScope => {
        const key = JSON.stringify([request.level, request.target, request.output, request.scopeKey]);
        let scope = cache.get(key);

        if (scope === undefined) {
            scope = resolver.scopeIn(config, request);
            cache.set(key, scope);
        }

        return scope;
    };
    const keyed = (scopeKey: string | undefined) => (scopeKey === undefined ? {} : { scopeKey });

    // A target or an output with no `_vars` of its own has the scope of the level above it.
    const scopeAt = (request: ScopeRequest): VarScope => {
        if (request.level === "output" && targets.atPath([request.target!, "outputs", request.output!, "_vars"]).get() === undefined) {
            return scopeAt({ level: "target", target: request.target!, ...keyed(request.scopeKey) });
        }

        if (request.level === "target" && targets.atPath([request.target!, "_vars"]).get() === undefined) {
            return cached({ level: "compilation", ...keyed(request.scopeKey) });
        }

        return cached(request);
    };

    return scopeAt;
}

/** Calls a function once, on first use. */
function once<T>(make: () => T): () => T {
    let value: { readonly v: T } | undefined;

    return () => {
        value ??= { v: make() };

        return value.v;
    };
}

/**
 * The aliases as the builder sees them: the `#` names that stand for directories, then `_aliases`
 * over them, as the compiler's runtime builds them from a finished config.
 */
function builderAliases(
    config: ConfigBuilder,
    plugin: string,
    services: ServiceReader,
    resolver: Pick<VariablesResolver, "scopeIn" | "substitute" | "normalizePath">,
    projectRoot: string,
): AliasMap {
    const scope = resolver.scopeIn(config, {});
    const entities: EntityReader = {
        get: (kind, id) => config.entity(kind, id),
        list: (kind) => config.entities(kind),
        has: (kind, id) => config.entity(kind as never, id) !== undefined,
        describe: () => [],
        kinds: () => [],
    };
    const reader = {
        get: (at: string) => config.atPath(at).get(),
        has: (at: string) => config.atPath(at).exists(),
        value: () => config.root().get(),
    } as unknown as BuiltConfig;
    const context: HashNameContext = { plugin, config: reader, services, entities, project: config.project, env: config.env, scope };
    const builtIns: AliasMap = {};

    for (const entity of config.entities("hash-name")) {
        if (!entity.view) {
            builtIns[`#${entity.id}`] = (entity.bases?.(context) ?? []).map((base) => path.resolve(projectRoot, base));
        }
    }

    return buildAliasMap({
        builtIns,
        userAliases: [config.atPath("_aliases").get<AliasesSettings>()],
        substitute: (text) => path.resolve(projectRoot, resolver.normalizePath(resolver.substitute(text, scope))),
    });
}

