import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { globSync } from "glob";
import { inferGlobBase, type CompilationConfig, type CompilationTarget, type ResolvedRuntimeContext } from "./markdown-compiler.js";
import { warning } from "../utils/formatting.js";

const __filename = fileURLToPath(import.meta.url);

/** Resolved path to the cli/ package root (two levels up from src/lib/) */
export const CLI_ROOT = path.resolve(path.dirname(__filename), "../..");

/** Version string read from package.json at module load time. */
const _pkgJson = JSON.parse(
  fs.readFileSync(path.join(CLI_ROOT, "package.json"), "utf8")
) as { version: string };
export const SOUS_VERSION: string = _pkgJson.version;

// --- Variable scope ------------------------------------------------------------------------------

/** A flat map of resolved variable names to their string values. */
export type VarScope = Record<string, string>;

// --- Raw settings types (matching settings.local.js shape) --------------------------------------

type RawOutput = {
  _if?: Record<string, { eq: string }>;
  _vars?: Record<string, string>;
  destinationFile?: string;
  destinationDir?: string;
};

type RawRuntimeContext = {
  generate: boolean;
  /** ${var} path to the git repo root used for branch detection. */
  gitRoot: string;
  /** ${var} path where the generated session-context file is written. */
  outputPath: string;
  /** ${var} root directory for task files; branch name is appended to locate the active file. */
  taskFileRoot: string;
  /** Regex pattern string; branches matching this pattern trigger task file lookup. */
  branchPattern?: string;
};

type RawTarget = {
  _vars?: Record<string, string>;
  /** Point-to-point source file path. Exactly one of entryPoint or entryGlob must be set. */
  entryPoint?: string;
  /** Glob pattern expanding to multiple source files. Exactly one of entryPoint or entryGlob must be set. */
  entryGlob?: string;
  /**
   * Explicit base directory for computing relative output paths when using destinationDir.
   * Only meaningful for entryGlob targets. When omitted, inferred from the glob pattern.
   */
  globBase?: string;
  /**
   * When true, the compiler generates a runtime session context file (branch name, task file)
   * alongside the entry point before compilation. Only meaningful for AGENTS-style entry points.
   */
  generateRuntimeContext?: boolean;
  outputs: RawOutput[];
};

type RawProjectCompilation = {
  _vars?: Record<string, string>;
  includeSourceComments?: boolean;
  targets: RawTarget[];
};

/** Configuration for a launchable tool (e.g. claude, codex). */
type ToolConfig = {
  /** The executable command to run. */
  command: string;
  /** Arguments passed before the prompt file argument. */
  args?: string[];
  /**
   * Path to a file whose contents are appended as the final argument to the command.
   * Path is resolved through the project's var scope.
   */
  promptFile?: string;
};

export type RawProject = {
  _vars?: Record<string, string>;
  name: string;
  compilation?: RawProjectCompilation;
  runtimeContext?: RawRuntimeContext;
  tools?: Record<string, ToolConfig>;
  stateFilePath?: string;
};

export type Settings = {
  _env?: Record<string, string>;
  _vars?: Record<string, string>;
  defaultProject?: string;
  projects: Record<string, RawProject>;
};

// --- Loader -------------------------------------------------------------------------------------

/**
 * Loads settings from the given config file path.
 * Supports .js / .mjs (ES module with a `config` or `default` export)
 * and .json (plain JSON matching the Settings shape).
 */
/* c8 ignore next 42 */
export async function loadSettings(configPath: string): Promise<Settings> {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Settings file not found: ${configPath}`);
  }

  if (configPath.endsWith(".json")) {
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
      return raw as Settings;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse settings JSON at ${configPath}: ${message}`);
    }
  }

  // JS/MJS module — spawn a fresh Node process (no tsx loader) to import the config
  // and serialize it to JSON. This avoids tsx's require(esm) cycle issue when user
  // config files use static ESM imports.
  const settingsUrl = pathToFileURL(configPath).href;
  const loaderScript = `
    import { pathToFileURL } from 'node:url';
    const mod = await import(${JSON.stringify(settingsUrl)});
    const raw = mod.config ?? mod.default ?? mod;
    process.stdout.write(JSON.stringify(raw));
  `;
  // Run with tsx so user config files can use TypeScript and extensionless imports.
  // A fresh subprocess avoids the require(esm) cycle that occurs in the parent process.
  const tsxPath = path.resolve(CLI_ROOT, "node_modules/tsx/dist/esm/index.cjs");
  const result = spawnSync(
    process.execPath,
    ["--import", tsxPath, "--input-type=module"],
    { input: loaderScript, encoding: "utf8" }
  );
  if (result.status !== 0) {
    const message = result.stderr?.trim() || "unknown error";
    throw new Error(`Failed to load settings from ${configPath}: ${message}`);
  }
  try {
    return JSON.parse(result.stdout) as Settings;
  } catch {
    throw new Error(`Failed to parse settings output from ${configPath}: ${result.stdout}`);
  }
}

// --- Variable Resolution -------------------------------------------------------------------------

/**
 * Substitutes ${varName} references in a string using the provided scope.
 * Unknown variable references are left as-is.
 */
export function substituteVars(str: string, scope: VarScope): string {
  return str.replace(/\$\{([^}]+)\}/g, (match, name: string) => scope[name] ?? match);
}

/**
 * Resolves a _vars block into a new scope by:
 * 1. Merging the inherited scope with the block (block keys take precedence)
 * 2. Topologically sorting intra-block dependencies so vars can reference each other
 * 3. Substituting all variable references in topological order
 */
export function resolveScope(block: Record<string, string>, inherited: VarScope): VarScope {
  const blockKeys = Object.keys(block);

  // Warn if user defines vars in the reserved 'sous*' namespace
  for (const key of blockKeys) {
    if (key.startsWith("sous")) {
      console.warn(`Warning: variable '${key}' uses the reserved 'sous*' namespace and may conflict with auto-injected variables.`);
    }
  }

  // Build intra-block dependency map (only deps on other block keys, not inherited)
  const deps = new Map<string, Set<string>>();
  for (const key of blockKeys) {
    const refs = [...block[key].matchAll(/\$\{([^}]+)\}/g)].map(m => m[1]);
    deps.set(key, new Set(refs.filter(r => blockKeys.includes(r))));
  }

  // Topological sort (DFS with cycle guard)
  const sorted: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(key: string): void {
    if (visited.has(key)) return;
    if (visiting.has(key)) {
      // Circular dep — add as-is to avoid infinite loop
      sorted.push(key);
      return;
    }
    visiting.add(key);
    for (const dep of deps.get(key) ?? []) {
      visit(dep);
    }
    visiting.delete(key);
    visited.add(key);
    sorted.push(key);
  }

  for (const key of blockKeys) {
    visit(key);
  }

  // Resolve in topological order, starting from the inherited scope
  const scope: VarScope = { ...inherited };
  for (const key of sorted) {
    scope[key] = substituteVars(block[key], scope);
  }

  return scope;
}

/**
 * Builds the auto-injected variable scope. These vars are always available
 * and injected first, before _env and _vars.
 * The 'sous*' namespace is reserved — warns if user defines a var starting with 'sous'.
 */
export function buildAutoVars(): VarScope {
  return {
    sousRootPath: CLI_ROOT,
    sousVersion: SOUS_VERSION,
  };
}

/**
 * Resolves the top-level _env block into a VarScope.
 * Each entry maps a config var name (key) to an environment variable name (value).
 * Throws a clear error if any referenced env var is not set.
 * Only called on the root Settings object — _env is top-level only.
 */
export function resolveEnvScope(settings: Settings): VarScope {
  const env = settings._env ?? {};
  const scope: VarScope = {};

  for (const [varName, envVarName] of Object.entries(env)) {
    const value = process.env[envVarName];
    if (value === undefined) {
      throw new Error(
        `_env resolution failed: environment variable '${envVarName}' (mapped to '${varName}') is not set`
      );
    }
    scope[varName] = value;
  }

  return scope;
}

/**
 * Resolves the root-level _vars from a Settings object into a scope.
 * Chains: auto-vars → env scope → root _vars.
 */
export function resolveRootScope(settings: Settings): VarScope {
  const autoVars = buildAutoVars();
  const envScope = resolveEnvScope(settings);
  const baseScope = { ...autoVars, ...envScope };
  return resolveScope(settings._vars ?? {}, baseScope);
}

/** A resolved tool configuration with promptFile path substituted. */
export type ResolvedToolConfig = {
  command: string;
  args?: string[];
  promptFile?: string;
};

/**
 * Resolves a project's tools config, substituting vars in promptFile paths.
 * Returns an empty object if no tools are configured.
 */
export function resolveProjectTools(
  project: RawProject,
  rootScope: VarScope = {}
): Record<string, ResolvedToolConfig> {
  if (!project.tools) return {};

  const projectScope = resolveScope(project._vars ?? {}, rootScope);

  return Object.fromEntries(
    Object.entries(project.tools).map(([name, tool]) => [
      name,
      {
        command: tool.command,
        ...(tool.args !== undefined && { args: tool.args }),
        ...(tool.promptFile !== undefined && {
          promptFile: substituteVars(tool.promptFile, projectScope),
        }),
      },
    ])
  );
}

// --- Compilation Resolution ----------------------------------------------------------------------

/**
 * Resolves a RawRuntimeContext into a ResolvedRuntimeContext by substituting
 * ${var} references and converting branchPattern from string to RegExp.
 */
function resolveRuntimeContext(raw: RawRuntimeContext, scope: VarScope): ResolvedRuntimeContext {
  return {
    gitRoot: substituteVars(raw.gitRoot, scope),
    outputPath: substituteVars(raw.outputPath, scope),
    taskFileRoot: substituteVars(raw.taskFileRoot, scope),
    branchPattern: new RegExp(raw.branchPattern ?? "PT-"),
  };
}

/**
 * Resolves a project's compilation config into the shape the compiler expects.
 * Walks the config tree resolving _vars at each level (root → project → target → output).
 * Pass rootScope from resolveRootScope(settings) to thread root vars down.
 * Returns null if the project has no compilation config.
 */
export function resolveProjectCompilation(
  project: RawProject,
  rootScope: VarScope = {}
): CompilationConfig | null {
  if (!project.compilation) return null;

  const projectScope = resolveScope(project._vars ?? {}, rootScope);
  const compilationScope = resolveScope(project.compilation._vars ?? {}, projectScope);

  return {
    includeSourceComments: project.compilation.includeSourceComments,
    targets: project.compilation.targets.flatMap((target): CompilationTarget[] => {
      const targetScope = resolveScope(target._vars ?? {}, compilationScope);
      const hasSingle = target.entryPoint !== undefined;
      const hasGlob = target.entryGlob !== undefined;

      if (hasSingle && hasGlob) {
        throw new Error("Target cannot have both entryPoint and entryGlob");
      }
      if (!hasSingle && !hasGlob) {
        throw new Error("Target must have either entryPoint or entryGlob");
      }

      /**
       * Resolves the outputs array for a target, filtering by _if conditions and substituting vars.
       */
      function resolveOutputs(scope: VarScope) {
        return target.outputs
          .filter(output => {
            if (!output._if) return true;
            const outputScope = resolveScope(output._vars ?? {}, scope);
            return Object.entries(output._if).every(([varName, condition]) => {
              const val = outputScope[varName] ?? scope[varName] ?? compilationScope[varName];
              return val === condition.eq;
            });
          })
          .map(output => {
            const outputScope = resolveScope(output._vars ?? {}, scope);
            return {
              ...(output.destinationFile !== undefined && {
                destinationFile: substituteVars(output.destinationFile, outputScope),
              }),
              ...(output.destinationDir !== undefined && {
                destinationDir: substituteVars(output.destinationDir, outputScope),
              }),
              vars: outputScope,
            };
          });
      }

      if (hasSingle) {
        const runtimeContext =
          target.generateRuntimeContext && project.runtimeContext
            ? resolveRuntimeContext(project.runtimeContext, projectScope)
            : undefined;
        return [{
          rootInputPath: substituteVars(target.entryPoint!, targetScope),
          ...(runtimeContext !== undefined && { runtimeContext }),
          outputs: resolveOutputs(targetScope),
        }];
      }

      /* c8 ignore start */
      // Glob target: expand pattern into one CompilationTarget per matched file, skipping dirs
      const pattern = substituteVars(target.entryGlob!, targetScope);
      const matchedFiles = globSync(pattern, { absolute: true })
        .filter(filePath => fs.statSync(filePath).isFile());

      if (matchedFiles.length === 0) {
        warning(`Glob pattern matched no files:\n${pattern}`);
      }

      const globBase = target.globBase
        ? substituteVars(target.globBase, targetScope)
        : inferGlobBase(pattern);
      return matchedFiles.map(filePath => ({
        rootInputPath: filePath,
        globBase,
        outputs: resolveOutputs(targetScope),
      }));
      /* c8 ignore stop */
    }),
  };
}

/** Resolved watch configuration for a project. */
export type WatchConfig = {
  /** Exact file paths — watched directly by chokidar. Trigger partial rebuilds. */
  files: string[];
  /**
   * Glob patterns — chokidar watches their base directories; incoming events are
   * filtered against these patterns before triggering a partial rebuild.
   */
  globs: string[];
  /**
   * Additional paths (files or directories) that trigger a full rebuild when changed.
   * Used for the settings file, templating directory, and config imports.
   */
  fullRebuildPaths?: string[];
};

/**
 * Returns the watch configuration for a project's compilation targets.
 *
 * - entryPoint targets → exact file path in `files`.
 * - entryGlob targets → resolved glob string in `globs`.
 */
export function resolveWatchConfig(project: RawProject, rootScope: VarScope = {}): WatchConfig {
  if (!project.compilation) return { files: [], globs: [] };

  const projectScope = resolveScope(project._vars ?? {}, rootScope);
  const compilationScope = resolveScope(project.compilation._vars ?? {}, projectScope);
  const files: string[] = [];
  const globs: string[] = [];

  for (const target of project.compilation.targets) {
    const targetScope = resolveScope(target._vars ?? {}, compilationScope);

    if (target.entryPoint) {
      files.push(substituteVars(target.entryPoint, targetScope));
    }

    if (target.entryGlob) {
      globs.push(substituteVars(target.entryGlob, targetScope));
    }
  }

  return {
    files: [...new Set(files)],
    globs: [...new Set(globs)],
  };
}
