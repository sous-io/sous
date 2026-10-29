/**
 * Stand-ins for the plugins plugin-build runs by name (compiler, recipes, recipe-answers, git,
 * host, variables), each backed by a plain {@link World} a test changes, so the build's own
 * orchestration is what is tested.
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEngine, type Engine } from "@sous-io/core";
import {
    BufferedReporter,
    definePlugin,
    jsonSchema,
    type PluginDefinition,
    type Prompter,
    type ProjectInfo,
    type Sous,
} from "@sous-io/plugin-api";
import type {
    CompilationTarget,
    CompileInput,
    CompileResult,
    CompilerPruneInput,
    CompilerPruneResult,
    StateFile,
    StateFileEntry,
    WrittenFile,
    WriteOptions,
} from "@sous-io/plugin-compiler/types";
import type { DefinedVariable } from "@sous-io/plugin-recipe-answers/types";
import type {
    ActiveRecipeEntity,
    CachedIndex,
    IndexReadFailure,
    LockDiff,
    RecipesLock,
    ResolvedLink,
    ResolvedRecipe,
    ResolveOptions,
    RestoreReport,
    SkippedRecipe,
} from "@sous-io/plugin-recipes/types";
import { createBuildPlugin, type BuildPluginOptions } from "../src/index.js";

type Lockfile = ReturnType<RecipesLock["read"]>;

/** Everything the stand-ins read and record. */
export interface World {
    config: Record<string, unknown>;
    // compiler
    compileCalls: CompileInput[];
    pruneCalls: CompilerPruneInput[];
    compileResult: (input: CompileInput) => CompileResult;
    pruneResult: (input: CompilerPruneInput) => CompilerPruneResult;
    state: StateFile;
    statePath: string;
    writes: Array<{ file: string; content: string; options: WriteOptions }>;
    commits: number;
    aliases: Record<string, string[]>;
    // recipes
    lockfile: Lockfile;
    lockWrites: Array<{ lockfile: Lockfile; dryRun: boolean }>;
    resolveCalls: ResolveOptions[];
    /** The newest version of each key; a resolve keeps what `keep` names. */
    published: Record<string, { repo: string; version: string; namespace: string }>;
    restoreCalls: Array<{ keys?: readonly string[] }>;
    restoreReport: RestoreReport;
    indexes: { indexes: CachedIndex[]; failed: IndexReadFailure[] };
    indexCalls: number;
    active: ActiveRecipeEntity[];
    skipped: SkippedRecipe[];
    links: Record<string, ResolvedLink>;
    // recipe-answers
    unanswered: DefinedVariable[];
    // git
    branch: string | undefined;
}

/** A fresh world for a project root. */
export function newWorld(root: string): World {
    return {
        config: {},
        compileCalls: [],
        pruneCalls: [],
        compileResult: () => ({ ok: true, outputs: [], problems: [], durationMs: 1 }),
        pruneResult: (input) => ({ removed: [], dirsRemoved: [], dryRun: input.dryRun === true }),
        state: { lastBuild: "", resolvedVars: {}, dirs: [], files: [] },
        statePath: path.join(root, ".sous", ".state.json"),
        writes: [],
        commits: 0,
        aliases: {},
        lockfile: { formatVersion: 1, repos: {}, recipes: {} } as unknown as Lockfile,
        lockWrites: [],
        resolveCalls: [],
        published: {},
        restoreCalls: [],
        restoreReport: { restored: [], alreadyPresent: [], failed: [] },
        indexes: { indexes: [], failed: [] },
        indexCalls: 0,
        active: [],
        skipped: [],
        links: {},
        unanswered: [],
        branch: "main",
    };
}

/** A temporary project with a `.sous/` directory. */
export function tempProject(): ProjectInfo {
    const root = mkdtempSync(path.join(tmpdir(), "sous-build-"));
    const sousDir = path.join(root, ".sous");

    mkdirSync(sousDir, { recursive: true });

    return { root, sousDir, configPath: path.join(sousDir, "sous.config.jsonc"), confDir: path.join(sousDir, "conf.d") };
}

export function plugin(name: string, register: (sous: Sous) => void): PluginDefinition {
    return definePlugin({ name, version: "0.2.34", register });
}

const anything = jsonSchema({});

/** The diff between two lockfiles, by version. */
export function diffLocks(before: Lockfile, after: Lockfile): LockDiff {
    const added = Object.keys(after.recipes)
        .filter((key) => !before.recipes[key])
        .map((key) => ({ key, to: after.recipes[key]!.version }));
    const removed = Object.keys(before.recipes)
        .filter((key) => !after.recipes[key])
        .map((key) => ({ key, from: before.recipes[key]!.version }));
    const updated = Object.keys(after.recipes)
        .filter((key) => before.recipes[key] && before.recipes[key]!.version !== after.recipes[key]!.version)
        .map((key) => ({ key, from: before.recipes[key]!.version, to: after.recipes[key]!.version }));

    return { added, removed, updated, reposAdded: [], reposRemoved: [], unchanged: added.length + removed.length + updated.length === 0 };
}

/** The stand-in plugins. */
export function standIns(world: World): PluginDefinition[] {
    const variables = plugin("@sous-io/plugin-variables", (sous) => {
        sous.entities.add("config-key", { id: "_vars", schema: anything });
        sous.services.add("variables.resolver", (config, ctx) => {
            const scope = (): Record<string, string> => ({
                projectRoot: ctx.project?.root ?? "",
                sousDir: ctx.project?.sousDir ?? "",
                ...((config.get("_vars") as Record<string, string> | undefined) ?? {}),
            });
            const substitute = (text: string, values: Readonly<Record<string, string>>) =>
                text.replace(/\$\{(\w+)\}/gu, (whole, name: string) => values[name] ?? whole);

            return {
                substitute,
                substituteStrict: (text: string, values: Readonly<Record<string, string>>) => substitute(text, values),
                normalizePath: (value: string) => path.normalize(value),
                scope: () => scope(),
            } as never;
        });
    });

    const host = plugin("@sous-io/plugin-host", (sous) => {
        sous.services.add(
            "host.globs",
            () =>
                ({
                    isMatch: (file: string, pattern: string | readonly string[]) =>
                        [pattern].flat().some((one) => path.matchesGlob(file, one)),
                    hasGlob: (text: string) => /[*?[{]/u.test(text),
                    staticBase: (pattern: string) => {
                        const parts = pattern.split("/");
                        const index = parts.findIndex((part) => /[*?[{]/u.test(part));

                        return index === -1 ? path.dirname(pattern) : parts.slice(0, index).join("/") || "/";
                    },
                    toPosix: (value: string) => value.split(path.sep).join("/"),
                }) as never,
            { lifetime: "singleton" },
        );
    });

    const git = plugin("@sous-io/plugin-git", (sous) => {
        sous.services.add("git.runner", () => ({ currentBranch: async () => world.branch }) as never, { lifetime: "singleton" });
    });

    const compiler = plugin("@sous-io/plugin-compiler", (sous) => {
        sous.entities.add("config-key", { id: "compilation", schema: anything });
        sous.entities.add("config-key", { id: "_aliases", schema: anything });
        sous.services.add("compiler.state", () => ({
            path: () => world.statePath,
            read: () => world.state,
            entries: () => world.state.files,
            filesFrom: (filter: { recipe?: string }) => world.state.files.filter((entry) => entry.origin?.recipe === filter.recipe),
            isTracked: (file: string) => world.state.files.some((entry) => entry.dest === file),
        }));
        sous.services.add("compiler.writer", () => ({
            write: async (file: string, content: string, options: WriteOptions): Promise<WrittenFile> => {
                world.writes.push({ file, content, options });

                return { file, action: options.dryRun ? "would-create" : "created", bytes: content.length };
            },
            remove: async () => ({ removed: [], dirsRemoved: [] }),
            commit: async () => {
                world.commits += 1;
            },
        }));
        sous.services.add("compiler.aliases", () => ({
            all: () => world.aliases,
            get: (name: string) => world.aliases[name],
            split: (value: string) => {
                const alias = Object.keys(world.aliases).find((name) => value.startsWith(`${name}/`));

                return alias ? { alias, rest: value.slice(alias.length + 1) } : undefined;
            },
        }));
        sous.intents.add({
            intent: "compiler.compile",
            internal: true,
            handle: async (input) => {
                world.compileCalls.push(input);

                return world.compileResult(input);
            },
        });
        sous.intents.add({
            intent: "compiler.prune",
            internal: true,
            handle: async (input) => {
                world.pruneCalls.push(input);

                return world.pruneResult(input);
            },
        });
    });

    const recipes = plugin("@sous-io/plugin-recipes", (sous) => {
        for (const id of ["repos", "subscriptions", "store"]) {
            sous.entities.add("config-key", { id, schema: anything });
        }

        const resolve = async (options: ResolveOptions = {}) => {
            world.resolveCalls.push(options);

            const resolved = Object.entries(world.published).map(([key, published]) => ({
                key,
                namespace: published.namespace,
                name: key.split("/")[1]!,
                repo: published.repo,
                version: options.keep?.[key] ?? published.version,
                requestedBy: ["project"],
            })) as unknown as ResolvedRecipe[];

            return { resolved, missingRepos: [], unreadable: [], cycles: [] };
        };

        sous.services.add("recipes.lock", () => ({
            path: () => "/lock",
            read: () => world.lockfile,
            write: async (lockfile: Lockfile, options: { dryRun?: boolean } = {}) => {
                const diff = diffLocks(world.lockfile, lockfile);

                world.lockWrites.push({ lockfile, dryRun: options.dryRun === true });

                if (!options.dryRun) {
                    world.lockfile = lockfile;
                }

                return diff;
            },
            diff: diffLocks,
            fromResolved: (resolved: readonly ResolvedRecipe[], previous?: Lockfile) =>
                ({
                    formatVersion: 1,
                    repos: previous?.repos ?? {},
                    recipes: Object.fromEntries(
                        resolved.map((recipe) => [recipe.key, { repo: recipe.repo, version: recipe.version, hash: "h", requestedBy: ["project"], kind: "subscribes" }]),
                    ),
                }) as unknown as Lockfile,
            restore: async (options: { keys?: readonly string[] } = {}) => {
                world.restoreCalls.push(options);

                return world.restoreReport;
            },
            get: (key: string) => world.lockfile.recipes[key],
        }));
        sous.services.add("recipes.resolver", () => ({
            resolve: async () => resolve(),
            resolveSubscriptions: resolve,
            reachable: () => [],
        }));
        sous.services.add("recipes.active", () => ({
            list: () => world.active,
            get: (key: string) => world.active.find((recipe) => recipe.id === key),
            skipped: () => world.skipped,
            contents: () => [],
            variables: () => [],
        }));
        sous.services.add("recipes.index-cache", () => ({
            getAll: async () => {
                world.indexCalls += 1;

                return world.indexes;
            },
        }) as never);
        sous.services.add("recipes.links", () => ({ all: () => world.links }) as never);
    });

    const answers = plugin("@sous-io/plugin-recipe-answers", (sous) => {
        sous.services.add("recipe-answers.answers", () => ({
            get: () => ({ merged: {}, byRecipe: {}, unanswered: world.unanswered, secrets: new Set<string>() }),
            forRecipe: () => ({}),
        }));
    });

    const config = plugin("test-config", (sous) => {
        sous.config.contribute({
            id: "test-config",
            contribute(builder) {
                for (const [key, value] of Object.entries(world.config)) {
                    builder.atPath(key).setValue(value);
                }
            },
        });
    });

    return [host, variables, git, compiler, recipes, answers, config];
}

/** An engine with plugin-build and the stand-ins, its config built. */
export interface Harness {
    engine: Engine;
    world: World;
    project: ProjectInfo;
    reporter: BufferedReporter;
    run<T = unknown>(intent: string, input?: Record<string, unknown>, options?: { prompter?: Prompter }): Promise<T>;
}

/** Starts a harness. */
export async function harness(
    options: { world?: (world: World) => void; plugin?: BuildPluginOptions; project?: ProjectInfo; extra?: PluginDefinition[] } = {},
): Promise<Harness> {
    const project = options.project ?? tempProject();
    const world = newWorld(project.root);

    options.world?.(world);

    const reporter = new BufferedReporter();
    const engine = createEngine({
        project,
        builtIns: [...standIns(world), createBuildPlugin(options.plugin), ...(options.extra ?? [])],
        reporter: new BufferedReporter(),
    });

    await engine.buildConfig();

    return {
        engine,
        world,
        project,
        reporter,
        run: <T>(intent: string, input: Record<string, unknown> = {}, runOptions: { prompter?: Prompter } = {}) =>
            engine.submit({ intent, input }, { reporter, ...(runOptions.prompter ? { prompter: runOptions.prompter } : {}) }) as Promise<T>,
    };
}

/** A state file entry. */
export function entry(dest: string, recipe?: string): StateFileEntry {
    return {
        dest,
        srcHash: "s",
        destHash: "d",
        size: 1,
        builtAt: "2026-10-29T00:00:00.000Z",
        ...(recipe ? { origin: { recipe } } : {}),
    };
}

/** A compilation target with one output. */
export function target(fields: Partial<CompilationTarget>): CompilationTarget {
    return { outputs: [{ destinationFile: "/out/AGENTS.md" }], ...fields };
}

/** A locked recipe. */
export function locked(version: string, repo = "acme") {
    return { repo, version, hash: "h", requestedBy: ["project"], kind: "subscribes" };
}
