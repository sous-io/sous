import path from "node:path";
import fs from "node:fs";
import type { Settings } from "./settings.js";
import { resolveProjectCompilation, resolveRootScope } from "./settings.js";
import { CompilationService } from "./markdown-compiler.js";
import type { CompilationConfig, CompilationTarget } from "./markdown-compiler.js";
import { StateService } from "./state.js";
import { log } from "../utils/formatting.js";

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
};

/**
 * Recursively collects all file paths reachable from `filePath` via @include chains.
 * Returns a Set of absolute paths. The `visited` set prevents infinite loops.
 *
 * Only matches @<path>.md include lines (same pattern as CompilationService.processIncludes).
 */
function collectIncludeGraph(filePath: string, visited: Set<string> = new Set()): Set<string> {
  if (visited.has(filePath)) return visited;
  visited.add(filePath);

  if (!fs.existsSync(filePath)) return visited;

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return visited;
  }

  const includePattern = /^@([a-zA-Z0-9_\-/.]+\.md)$/gm;
  const baseDir = path.dirname(filePath);
  let match: RegExpExecArray | null;

  while ((match = includePattern.exec(content)) !== null) {
    const includePath = match[1].trim();
    const fullPath = path.resolve(baseDir, includePath);
    collectIncludeGraph(fullPath, visited);
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
 */
export function findAffectedTargets(
  filePath: string,
  config: CompilationConfig
): CompilationTarget[] {
  return config.targets.filter(target => {
    const graph = collectIncludeGraph(target.rootInputPath);
    return graph.has(filePath);
  });
}

export class BuildService {
  /**
   * Runs compile + prune for a project.
   * Returns true if all steps succeeded.
   */
  async build(
    projectKey: string,
    settings: Settings,
    options: BuildOptions = {}
  ): Promise<boolean> {
    const rootScope = resolveRootScope(settings);
    const project = settings.projects[projectKey];

    if (!project) {
      throw new Error(`Project '${projectKey}' not found in settings`);
    }

    const stateService = new StateService();
    const stateFilePath = stateService.getFilePath(projectKey, rootScope);

    let success = true;

    // When --rebuild, clear all previously written files before compiling so that
    // orphaned outputs (files no longer produced by the current config) are removed.
    // Prune cannot catch these because compile overwrites the state file before prune runs.
    if (options.rebuild && !options.dryRun && !options.noCompile) {
      const existingState = await stateService.load(stateFilePath);
      if (existingState?.files.length) {
        stateService.deleteTrackedFiles(existingState.files, existingState.dirs);
      }
    }

    // Compile step
    if (!options.noCompile) {
      const config = resolveProjectCompilation(project, rootScope);
      if (config) {
        let effectiveConfig: CompilationConfig = config;

        if (options.changedFile) {
          const affectedTargets = findAffectedTargets(options.changedFile, config);
          if (affectedTargets.length === 0) {
            log(`  ⊘ No targets affected by change to ${options.changedFile} — skipping compilation`);
          } else {
            effectiveConfig = { ...config, targets: affectedTargets };
            const compiler = new CompilationService({
              strict: options.strict,
              rebuild: options.rebuild,
              dryRun: options.dryRun,
            });
            const compileOk = await compiler.compile(effectiveConfig, stateFilePath);
            if (!compileOk) success = false;
          }
        } else {
          const compiler = new CompilationService({
            strict: options.strict,
            rebuild: options.rebuild,
            dryRun: options.dryRun,
          });
          const compileOk = await compiler.compile(effectiveConfig, stateFilePath);
          if (!compileOk) success = false;
        }
      }
    }

    // Prune step
    if (!options.noPrune && success) {
      await this.prune(projectKey, settings, stateFilePath, options.dryRun);
    }

    return success;
  }

  /**
   * Removes output files that are tracked in state but no longer in the current config.
   * Also removes Sous-created directories that are now empty.
   */
  async prune(
    projectKey: string,
    settings: Settings,
    stateFilePath: string,
    dryRun = false
  ): Promise<void> {
    const stateService = new StateService();
    const state = await stateService.load(stateFilePath);
    if (!state || state.files.length === 0) return;

    const rootScope = resolveRootScope(settings);
    const project = settings.projects[projectKey];
    const config = project ? resolveProjectCompilation(project, rootScope) : null;

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

    // A state entry is current if it matches an explicit destinationFile, or if its dest
    // path falls under an active destinationDir (glob target output).
    function isCurrentOutput(dest: string): boolean {
      if (currentOutputFiles.has(dest)) return true;
      for (const dir of currentOutputDirs) {
        if (dest.startsWith(dir + path.sep) || dest.startsWith(dir + "/")) return true;
      }
      return false;
    }

    // Find files to prune
    const toDelete = state.files.filter(f => !isCurrentOutput(f.dest));

    if (dryRun) {
      for (const entry of toDelete) {
        console.log(`  ○ would prune: ${entry.dest}`);
      }
      return;
    }

    stateService.deleteTrackedFiles(toDelete, state.dirs);
    for (const entry of toDelete) console.log(`  ✗ pruned: ${entry.dest}`);

    // Update state: remove pruned entries and any dirs that no longer exist
    state.files = state.files.filter(f => isCurrentOutput(f.dest));
    state.dirs = state.dirs.filter(d => fs.existsSync(d));
    await stateService.save(stateFilePath, state);
  }
}
