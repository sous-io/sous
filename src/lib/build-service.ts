import path from "node:path";
import fs from "node:fs";
import type { ConfigContext, Settings } from "./settings.js";
import { resolveAliases, resolveCompilation, resolveRootScope } from "./settings.js";
import { resolveIncludeFiles, type ViewMap } from "./include-resolver.js";
import type { NamespaceResolver } from "./repos/namespace-resolver.js";
import { createProjectNamespaceResolver } from "./repos/locked-namespace-resolver.js";
import { buildRecipeTargets, type RecipeTargets } from "./repos/recipe-targets.js";
import { CompilationService, INCLUDE_LINE_PATTERN, resolveOutputPath } from "./markdown-compiler.js";
import type { CompilationConfig, CompilationTarget } from "./markdown-compiler.js";
import { StateService } from "./state.js";
import { isProtectedPath } from "./state.js";
import { describeLinkedRepos, protectedRepoPaths } from "./repos/links.js";
import { subscriptionServiceFor } from "./repos/subscription-service.js";
import { prepareRepositoriesForBuild } from "./build-preparation.js";
import {
  noRecipeAnswers,
  resolveRecipeAnswers,
  unansweredWarning,
  type RecipeAnswers,
} from "./vars/answers.js";
import { BULLET, footer, heading, log, warning } from "../utils/formatting.js";
import { sharedHashNames } from "../services/ref-resolver/index.js";
import { listMemories, type MemoryFile } from "./repos/recipe-memories.js";

export type BuildOptions = {
  strict?: boolean;
  rebuild?: boolean;
  dryRun?: boolean;
  noCompile?: boolean;
  noPrune?: boolean;
  /**
   * When set, only targets that transitively include this file are compiled.
   * All other targets are skipped. If no targets include this file, compilation
   * is skipped entirely.
   */
  changedFile?: string;
  /**
   * Where the active config was discovered. Threaded into variable resolution so
   * `${sousDir}` resolves and so state/PID paths default into `.sous/`.
   */
  configContext?: ConfigContext;
  /**
   * Resolves `~namespace` include and render paths against recipe namespaces.
   * Passed straight through to the compiler and to the include-graph walk, so a
   * partial rebuild follows namespace includes too.
   *
   * When it is omitted and `configContext` is given, the build builds the
   * project's own resolver from its lockfile, links map and store. Pass one
   * explicitly to override that, which is what tests do.
   */
  namespaceResolver?: NamespaceResolver;
};

/** An empty recipe-target result, for a build with no config context. */
const NO_RECIPE_TARGETS: RecipeTargets = {
  targets: [],
  destinations: [],
  watchDirs: [],
  warnings: [],
};

/**
 * The answers to every recipe variable in play for the project the context
 * describes, resolved once so a build can render with them, hand them to every
 * scope it builds, and report what is still unanswered. Empty when the caller
 * gave no config context.
 *
 * @param settings - The merged project config.
 * @param configContext - Where the active config was discovered.
 */
export function resolveProjectAnswers(
  settings: Settings,
  configContext?: ConfigContext
): RecipeAnswers {
  if (configContext === undefined) return noRecipeAnswers();
  return resolveRecipeAnswers({ settings, sousDir: configContext.sousDir });
}

/**
 * The compile targets a project's subscribed recipes contribute, for the project
 * the options describe. Empty when the caller gave no config context, which is
 * the case only in tests that build a settings object by hand.
 *
 * Each recipe's files render with that recipe's own view of the answers, and a
 * required variable nothing answered is reported through `warnings`, so every
 * caller that prints those tells the user what the build could not fill in.
 *
 * @param settings - The merged project config.
 * @param rootScope - The resolved settings scope, for `${var}` in destinations.
 * @param configContext - Where the active config was discovered.
 * @param answers - The project's recipe answers, when the caller resolved them
 *   already; resolved here otherwise.
 */
export function resolveRecipeTargets(
  settings: Settings,
  rootScope: Record<string, string>,
  configContext?: ConfigContext,
  answers?: RecipeAnswers
): RecipeTargets {
  if (configContext === undefined) return NO_RECIPE_TARGETS;
  const resolved = answers ?? resolveProjectAnswers(settings, configContext);
  const scopes = new Map<string, Record<string, string>>();

  const recipes = buildRecipeTargets({
    sousDir: configContext.sousDir,
    settings,
    scope: rootScope,
    scopeFor: (recipe) => {
      let scope = scopes.get(recipe.key);
      if (scope === undefined) {
        scope = resolveRootScope(settings, configContext, { answers: resolved, recipe: recipe.key });
        scopes.set(recipe.key, scope);
      }
      return scope;
    },
  });

  const missing = unansweredWarning(resolved, rootScope);
  if (missing !== undefined) recipes.warnings.push(missing);
  return recipes;
}

/**
 * Adds the recipe targets to a project's own compilation config. A project with
 * no compilation block of its own still compiles its recipes, so the config is
 * created when there is none and there is something to compile.
 *
 * @param config - The project's own compilation config, or null when it has none.
 * @param recipes - The targets the subscribed recipes contribute.
 * @param settings - The merged project config, for its aliases.
 * @param rootScope - The resolved settings scope.
 */
export function withRecipeTargets(
  config: CompilationConfig | null,
  recipes: RecipeTargets,
  settings: Settings,
  rootScope: Record<string, string>
): CompilationConfig | null {
  if (recipes.targets.length === 0) return config;
  if (config === null) {
    return {
      targets: recipes.targets,
      aliases: resolveAliases(settings, rootScope),
      includeScope: rootScope,
    };
  }
  return { ...config, targets: [...config.targets, ...recipes.targets] };
}

/**
 * The memories an active recipe publishes that no output of the build included
 * by any route (an exact path, a glob or the `#memories` view). Recipes under
 * `recipes.memories.exclude` are never listed.
 *
 * @param settings - The merged project config, for `recipes.memories`.
 * @param sousDir - The project's `.sous/` directory.
 * @param included - Every file the compile read, as real paths.
 */
export function unincludedMemories(
  settings: Settings,
  sousDir: string,
  included: ReadonlySet<string>
): MemoryFile[] {
  const memories = settings.recipes?.memories;
  return listMemories({ sousDir, first: memories?.first, exclude: memories?.exclude }).filter(
    (memory) => !included.has(realPath(memory.file))
  );
}

/** The path with symbolic links resolved, or the path itself when it cannot be read. */
function realPath(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return filePath;
  }
}

/**
 * The warning for memories no output included, or undefined when there are none.
 *
 * @param missing - What {@link unincludedMemories} found.
 */
export function unincludedMemoriesWarning(missing: readonly MemoryFile[]): string | undefined {
  if (missing.length === 0) return undefined;
  const noun = missing.length === 1 ? "memory" : "memories";
  return (
    `${missing.length} ${noun} published by your subscribed recipes ${
      missing.length === 1 ? "is" : "are"
    } not included in any output, so no agent will read ${missing.length === 1 ? "it" : "them"}:\n` +
    missing.map((memory) => `${BULLET} ${memory.recipe}: ${memory.relative}`).join("\n") +
    `\nTo include every memory, add the line "@#memories/**/*.md" to your project's instruction ` +
    `source (the file your AGENTS.md or CLAUDE.md is built from). To leave a recipe's memories out on purpose, ` +
    `list the recipe in "recipes.memories.exclude" in your sous config.`
  );
}

/**
 * The directories a build's deletions must never reach into, for the project the
 * options describe. Empty when the caller gave no config context, which is the
 * case only in tests that build a settings object by hand.
 *
 * @param options - The build options, for the config context.
 */
function protectedPathsFor(options: BuildOptions): string[] {
  if (options.configContext === undefined) return [];
  return protectedRepoPaths(options.configContext.sousDir);
}

/**
 * The namespace resolver a build should use: the one the caller supplied, or the
 * project's own, built from its lockfile. A project that locks no recipes gets
 * undefined, which leaves `~` in an include line meaning an alias and nothing
 * else.
 *
 * @param settings - The merged project config.
 * @param options - The build options, for the config context and any override.
 */
function resolveNamespaceResolver(
  settings: Settings,
  options: BuildOptions
): NamespaceResolver | undefined {
  if (options.namespaceResolver !== undefined) return options.namespaceResolver;
  if (options.configContext === undefined) return undefined;
  return createProjectNamespaceResolver({
    sousDir: options.configContext.sousDir,
    settings,
  });
}

/**
 * Recursively collects all file paths reachable from `filePath` via @include chains.
 * Returns a Set of absolute paths. The `visited` set prevents infinite loops.
 *
 * Matches the same @<path>.md include lines as CompilationService.processIncludes,
 * including alias/`${var}` paths, resolving each via the same candidate logic
 * (first existing wins).
 */
function collectIncludeGraph(
  filePath: string,
  resolveOpts: {
    aliases?: Record<string, string[]>;
    scope?: Record<string, string>;
    namespaceResolver?: NamespaceResolver;
    views?: ViewMap;
  } = {},
  visited: Set<string> = new Set()
): Set<string> {
  if (visited.has(filePath)) return visited;
  visited.add(filePath);

  if (!fs.existsSync(filePath)) return visited;

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return visited;
  }

  const baseDir = path.dirname(filePath);

  for (const line of content.split("\n")) {
    const match = INCLUDE_LINE_PATTERN.exec(line.trimEnd());
    if (match === null) continue;
    const { files, candidates } = resolveIncludeFiles(match[1].trim(), {
      aliases: resolveOpts.aliases,
      views: resolveOpts.views,
      scope: resolveOpts.scope,
      baseDir,
      namespaceResolver: resolveOpts.namespaceResolver,
      fromFile: filePath,
    });
    // A file that does not exist yet is still part of the graph, as its first candidate.
    for (const fullPath of files.length > 0 ? files : candidates.slice(0, 1)) {
      collectIncludeGraph(fullPath, resolveOpts, visited);
    }
  }

  return visited;
}

/**
 * Returns the subset of compilation targets that transitively include `filePath`.
 * A target is affected if its `rootInputPath` equals `filePath`, or if `filePath`
 * is reachable via @include chains from `rootInputPath`.
 *
 * Uses a simple recursive file scan — reads each .md file and checks for
 * @<path> include lines. Does not compile; just walks the include graph.
 *
 * @param filePath - The changed file.
 * @param config - The resolved compilation config.
 * @param namespaceResolver - Optional resolver so `~namespace` includes are followed too.
 */
export function findAffectedTargets(
  filePath: string,
  config: CompilationConfig,
  namespaceResolver?: NamespaceResolver
): CompilationTarget[] {
  return config.targets.filter(target => {
    const graph = collectIncludeGraph(target.rootInputPath, {
      aliases: config.aliases,
      views: config.views,
      scope: config.includeScope,
      namespaceResolver,
    });
    return graph.has(filePath);
  });
}

/**
 * Resolves the state file path for a config.
 *
 * The path is derived from the resolved settings scope, so a `stateFilePath`
 * or `sousDir` defined in `_vars` (or injected by discovery) is honoured.
 *
 * @param settings - The loaded settings.
 * @param configContext - Where the config was discovered (supplies `sousDir`).
 * @returns Absolute path to the state file.
 */
export function resolveStateFilePath(
  settings: Settings,
  configContext?: ConfigContext
): string {
  const scope = resolveRootScope(settings, configContext);
  return new StateService().getFilePath(scope);
}

export class BuildService {
  /**
   * Runs compile + prune for the configured project.
   * Returns true if all steps succeeded.
   */
  async build(settings: Settings, options: BuildOptions = {}): Promise<boolean> {
    // The recipe answers are resolved once here and handed to every scope the
    // build assembles, so the lockfile and the manifests are read one time.
    const answers = resolveProjectAnswers(settings, options.configContext);
    const rootScope = resolveRootScope(settings, options.configContext, { answers });
    const namespaceResolver = resolveNamespaceResolver(settings, options);
    const protectedPaths = protectedPathsFor(options);

    const stateService = new StateService();
    const stateFilePath = resolveStateFilePath(settings, options.configContext);

    let success = true;

    // When --rebuild, clear all previously written files before compiling so the
    // rebuild starts from a physically clean slate. Orphaned outputs are also
    // caught by prune (compile carries prior state entries forward), so this is
    // the aggressive path: delete everything up front rather than prune after.
    if (options.rebuild && !options.dryRun && !options.noCompile) {
      const existingState = await stateService.load(stateFilePath);
      if (existingState?.files.length) {
        stateService.deleteTrackedFiles(
          existingState.files,
          existingState.dirs,
          protectedPaths
        );
      }
    }

    // Compile step. The recipes this project subscribes to contribute compile
    // targets alongside its own, so a recipe's files are compiled by exactly the
    // same machinery as everything else, and are pruned and cleared by it too.
    if (!options.noCompile) {
      const recipes = resolveRecipeTargets(settings, rootScope, options.configContext, answers);
      for (const notice of recipes.warnings) warning(notice);

      const withoutViews = withRecipeTargets(
        resolveCompilation(settings, rootScope),
        recipes,
        settings,
        rootScope
      );
      // The files each view lists (`#memories`), worked out once per build.
      const config: CompilationConfig | null =
        withoutViews === null || options.configContext === undefined
          ? withoutViews
          : {
              ...withoutViews,
              views: sharedHashNames().viewMap({
                sousDir: options.configContext.sousDir,
                settings,
              }),
            };

      if (config) {
        let effectiveConfig: CompilationConfig = config;

        if (options.changedFile) {
          const affectedTargets = findAffectedTargets(
            options.changedFile,
            config,
            namespaceResolver
          );
          if (affectedTargets.length === 0) {
            log(`  ⊘ No targets affected by change to ${options.changedFile} — skipping compilation`);
          } else {
            effectiveConfig = { ...config, targets: affectedTargets };
            const compiler = new CompilationService({
              strict: options.strict,
              rebuild: options.rebuild,
              dryRun: options.dryRun,
              namespaceResolver,
            });
            const compileOk = await compiler.compile(effectiveConfig, stateFilePath);
            if (!compileOk) success = false;
          }
        } else {
          const compiler = new CompilationService({
            strict: options.strict,
            rebuild: options.rebuild,
            dryRun: options.dryRun,
            namespaceResolver,
          });
          const compileOk = await compiler.compile(effectiveConfig, stateFilePath);
          if (!compileOk) success = false;

          // Only a full build knows every route an include can take, so only a
          // full build that compiled cleanly checks that every memory got in.
          if (compileOk && options.configContext !== undefined) {
            const notice = unincludedMemoriesWarning(
              unincludedMemories(settings, options.configContext.sousDir, compiler.includedFiles())
            );
            if (notice !== undefined) warning(notice);
          }
        }
      }
    }

    // Prune step
    if (!options.noPrune && success) {
      await this.prune(settings, stateFilePath, options.dryRun, options.configContext);
    }

    return success;
  }

  /**
   * Removes output files that are tracked in state but no longer in the current config.
   * Also removes Sous-created directories that are now empty.
   */
  async prune(
    settings: Settings,
    stateFilePath: string,
    dryRun = false,
    configContext?: ConfigContext
  ): Promise<void> {
    const stateService = new StateService();
    const state = await stateService.load(stateFilePath);
    if (!state || state.files.length === 0) return;

    const protectedPaths = configContext ? protectedRepoPaths(configContext.sousDir) : [];
    const rootScope = resolveRootScope(settings, configContext);
    const recipes = resolveRecipeTargets(settings, rootScope, configContext);
    const config = resolveCompilation(settings, rootScope);

    // Collect the current output set: explicit files and active destinationDir prefixes
    const currentOutputFiles = new Set<string>();
    const currentOutputDirs = new Set<string>();
    if (config) {
      for (const target of config.targets) {
        for (const output of target.outputs) {
          if (output.destinationFile) currentOutputFiles.add(output.destinationFile);
          if (output.destinationDir) currentOutputDirs.add(output.destinationDir);
        }
      }
    }

    // Recipe targets are counted file by file rather than by their destination
    // directory. Every subscribed recipe writes into the same directory, so a
    // directory prefix would make everything ever written there look current and
    // an unsubscribed recipe's files would stay forever.
    for (const target of recipes.targets) {
      for (const output of target.outputs) {
        const dest = resolveOutputPath(target, output);
        if (dest !== undefined) currentOutputFiles.add(dest);
      }
    }

    // A state entry is current if it matches an explicit destinationFile, or if its dest
    // path falls under an active destinationDir (glob target output).
    function isCurrentOutput(dest: string): boolean {
      if (currentOutputFiles.has(dest)) return true;
      for (const dir of currentOutputDirs) {
        if (dest.startsWith(dir + path.sep) || dest.startsWith(dir + "/")) return true;
      }
      return false;
    }

    // Find files to prune. Anything inside a linked checkout or the shared
    // recipe store is never a prune candidate, whatever the state file says.
    const toDelete = state.files.filter(
      f => !isCurrentOutput(f.dest) && !isProtectedPath(f.dest, protectedPaths)
    );

    if (dryRun) {
      for (const entry of toDelete) {
        console.log(`  ○ would prune: ${entry.dest}`);
      }
      return;
    }

    stateService.deleteTrackedFiles(toDelete, state.dirs, protectedPaths);
    for (const entry of toDelete) console.log(`  ✗ pruned: ${entry.dest}`);

    // Update state: remove pruned entries and any dirs that no longer exist
    const deleted = new Set(toDelete.map(entry => entry.dest));
    state.files = state.files.filter(f => !deleted.has(f.dest));
    state.dirs = state.dirs.filter(d => fs.existsSync(d));
    await stateService.save(stateFilePath, state);
  }
}

/** What {@link runProjectBuild} is given. */
export type ProjectBuildInput = {
  /** The merged project config, reloaded after any change a command made. */
  settings: Settings;
  /** Where the active config was discovered. */
  configContext: ConfigContext;
  /** The shell environment as it was before the env files were injected. */
  shellEnv?: NodeJS.ProcessEnv;
  /** The build's own options; every one defaults to what a plain `sous build` uses. */
  options?: Omit<BuildOptions, "configContext">;
  /** The heading printed above the compile and prune step. Defaults to "Building". */
  heading?: string;
};

/**
 * The one build every command runs: `build`, `init`, `launch`, `prune`,
 * `repo remove`, `repo unlink`, `subscription add`, `subscription remove` and
 * `subscription update` all come through here, so a project is built the same
 * way whichever of them the user typed.
 *
 * In order, it announces every linked repository, prepares the project's
 * recipes (seeds the core recipe, locks new subscriptions, restores whatever
 * the store is missing, checks upstream and reports newer versions), and then
 * compiles and prunes. A dry run prepares nothing, because preparing writes the
 * lockfile and the store. A partial rebuild in watch mode (one changed source
 * file) prepares nothing either: the config did not change, so neither did the
 * recipes it needs.
 *
 * @param input - The project, the build options and the heading.
 * @returns True when compile and prune both succeeded; false after any compile error.
 */
export async function runProjectBuild(input: ProjectBuildInput): Promise<boolean> {
  const options = input.options ?? {};
  const partial = options.changedFile !== undefined;

  // A linked repository is read from a working copy instead of a published
  // version, so it is announced on every build; a build that silently produced
  // something different would be far worse than a noisy one.
  if (!partial) {
    const linked = describeLinkedRepos(input.configContext.sousDir);
    if (linked.length > 0) warning(linked.join("\n"));
  }

  if (!options.dryRun && !partial) {
    await prepareRepositoriesForBuild(
      subscriptionServiceFor({
        configContext: input.configContext,
        settings: input.settings,
        ...(input.shellEnv === undefined ? {} : { shellEnv: input.shellEnv }),
      })
    );
  }

  heading(input.heading ?? "Building");
  const succeeded = await new BuildService().build(input.settings, {
    ...options,
    configContext: input.configContext,
  });
  footer();
  return succeeded;
}
