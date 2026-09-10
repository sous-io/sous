import path from "node:path";
import fs from "node:fs";
import type { ConfigContext, Settings } from "./settings.js";
import { resolveAliases, resolveCompilation, resolveRootScope } from "./settings.js";
import { resolveIncludeCandidates } from "./include-resolver.js";
import type { NamespaceResolver } from "./repos/namespace-resolver.js";
import { createProjectNamespaceResolver } from "./repos/locked-namespace-resolver.js";
import { buildRecipeTargets, type RecipeTargets } from "./repos/recipe-targets.js";
import { CompilationService } from "./markdown-compiler.js";
import type { CompilationConfig, CompilationTarget } from "./markdown-compiler.js";
import { StateService } from "./state.js";
import { isProtectedPath } from "./state.js";
import { protectedRepoPaths } from "./repos/links.js";
import { log, warning } from "../utils/formatting.js";

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
 * The compile targets a project's subscribed recipes contribute, for the project
 * the options describe. Empty when the caller gave no config context, which is
 * the case only in tests that build a settings object by hand.
 *
 * @param settings - The merged project config.
 * @param rootScope - The resolved settings scope, for `${var}` in destinations.
 * @param configContext - Where the active config was discovered.
 */
export function resolveRecipeTargets(
  settings: Settings,
  rootScope: Record<string, string>,
  configContext?: ConfigContext
): RecipeTargets {
  if (configContext === undefined) return NO_RECIPE_TARGETS;
  return buildRecipeTargets({
    sousDir: configContext.sousDir,
    settings,
    scope: rootScope,
  });
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

  const includePattern = /^@([~a-zA-Z0-9_${}][a-zA-Z0-9_\-/.:${}]*\.md)$/gm;
  const baseDir = path.dirname(filePath);
  let match: RegExpExecArray | null;

  while ((match = includePattern.exec(content)) !== null) {
    const includePath = match[1].trim();
    const candidates = resolveIncludeCandidates(includePath, {
      aliases: resolveOpts.aliases,
      scope: resolveOpts.scope,
      baseDir,
      namespaceResolver: resolveOpts.namespaceResolver,
      fromFile: filePath,
    });
    const fullPath = candidates.find((c) => fs.existsSync(c)) ?? candidates[0];
    collectIncludeGraph(fullPath, resolveOpts, visited);
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
    const rootScope = resolveRootScope(settings, options.configContext);
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
      const recipes = resolveRecipeTargets(settings, rootScope, options.configContext);
      for (const notice of recipes.warnings) warning(notice);

      const config = withRecipeTargets(
        resolveCompilation(settings, rootScope),
        recipes,
        settings,
        rootScope
      );

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
    const config = withRecipeTargets(
      resolveCompilation(settings, rootScope),
      recipes,
      settings,
      rootScope
    );

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
    // A recipe destination stays current even when nothing matched a glob this
    // run, so an empty recipe never makes prune delete a directory a moment
    // before the next build refills it.
    for (const destination of recipes.destinations) currentOutputDirs.add(destination);

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
