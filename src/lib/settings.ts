import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { globSync } from "glob";
import { inferGlobBase, type CompilationConfig, type CompilationTarget, type ResolvedRuntimeContext } from "./markdown-compiler.js";
import { buildAliasMap, resolveAliasPrefix, type AliasMap } from "./include-resolver.js";
import { ENV_DEFAULTS_NAME, ENV_LOCAL_NAME, SOUS_DIR_NAME } from "./config-discovery.js";
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

export type Settings = {
  _env?: Record<string, string>;
  /**
   * Config variables. A few names are read by Sous itself:
   * `stateFilePath` overrides where the build state file is written (see
   * StateService.getFilePath), and `pidFilePath` does the same for the watcher
   * PID file. Both resolve through the settings scope.
   */
  _vars?: Record<string, string>;
  _aliases?: Record<string, string | string[]>;
  /** Optional display name for the configured project. */
  name?: string;
  compilation?: RawProjectCompilation;
  runtimeContext?: RawRuntimeContext;
  tools?: Record<string, ToolConfig>;
};

// --- Loader -------------------------------------------------------------------------------------

/**
 * Loads settings from the given config file path.
 * Supports .js / .mjs (ES module with a `config` or `default` export)
 * and .json (plain JSON matching the Settings shape).
 *
 * A JS/MJS config is imported in a FRESH Node subprocess that serialises it to
 * JSON. Two attempts are made, in this order:
 *
 *   1. Plain Node, no loader. This is what a normal ESM config needs, and it is
 *      the only thing that works for a `.sous/sous.config.js` sitting in a repo
 *      whose package.json has no `"type": "module"` (under the tsx loader such a
 *      file is treated as CJS and dies with ERR_REQUIRE_CYCLE_MODULE).
 *   2. The tsx loader, so a config may use TypeScript syntax and extensionless
 *      relative imports.
 *
 * The subprocess (rather than a direct `import()`) avoids the require(esm) cycle
 * that tsx triggers in the parent process. Because the result is round-tripped
 * through JSON, functions, RegExp, Date and undefined values are dropped.
 */
/* c8 ignore next 60 */
export async function loadSettings(configPath: string): Promise<Settings> {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Settings file not found: ${configPath}`);
  }

  if (configPath.endsWith(".json")) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse settings JSON at ${configPath}: ${message}`);
    }
    return assertFlatConfig(raw, configPath);
  }

  const settingsUrl = pathToFileURL(configPath).href;
  const loaderScript = `
    const mod = await import(${JSON.stringify(settingsUrl)});
    const raw = mod.config ?? mod.default ?? mod;
    process.stdout.write(JSON.stringify(raw));
  `;
  // Resolve tsx via module resolution so this works when npm hoists the
  // dependency (local install, npx) as well as when it nests it (global,
  // repo clone).
  let tsxPath: string;
  try {
    tsxPath = createRequire(import.meta.url).resolve("tsx/esm");
  } catch {
    tsxPath = path.resolve(CLI_ROOT, "node_modules/tsx/dist/esm/index.cjs");
  }

  const attempts: { label: string; args: string[] }[] = [
    { label: "node", args: ["--input-type=module"] },
    { label: "tsx", args: ["--import", tsxPath, "--input-type=module"] },
  ];

  const failures: string[] = [];

  for (const attempt of attempts) {
    const result = spawnSync(process.execPath, attempt.args, {
      input: loaderScript,
      encoding: "utf8",
    });

    if (result.status === 0) {
      let raw: unknown;
      try {
        raw = JSON.parse(result.stdout);
      } catch {
        throw new Error(
          `Config at ${configPath} did not produce valid JSON. It must export a plain ` +
            `object (as \`config\` or \`default\`).\n  Got: ${result.stdout.slice(0, 300)}`
        );
      }
      return assertFlatConfig(raw, configPath);
    }

    failures.push(`  [via ${attempt.label}] ${result.stderr?.trim() || "unknown error"}`);
  }

  throw new Error(`Failed to load config from ${configPath}\n${failures.join("\n\n")}`);
}

/**
 * Rejects configs written in the removed multi-project schema. One config now
 * describes exactly one project; the fields that used to live inside a
 * `projects.<key>` entry sit at the top level instead.
 */
function assertFlatConfig(raw: unknown, configPath: string): Settings {
  if (
    raw !== null &&
    typeof raw === "object" &&
    ("projects" in raw || "defaultProject" in raw)
  ) {
    throw new ConfigError(
      `Config at ${configPath} uses the removed multi-project schema ` +
        `('projects' / 'defaultProject').\n` +
        `  A sous config now describes exactly one project. To migrate:\n` +
        `    1. Move your single project's fields (name, _vars, _aliases, compilation,\n` +
        `       runtimeContext, tools) to the top level of the config.\n` +
        `    2. Delete the 'projects' and 'defaultProject' keys.\n` +
        `  A config with several projects must be split into one config per project.`
    );
  }
  return raw as Settings;
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
 * A user-facing configuration error: the config file (or environment) is wrong,
 * not the CLI. Commands render these as a plain message with no stack trace,
 * since the stack points at Sous internals and tells the user nothing.
 */
export class ConfigError extends Error {
  readonly isConfigError = true;

  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** True when the value is a ConfigError (safe across module instances). */
export function isConfigError(error: unknown): boolean {
  return (
    error instanceof ConfigError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { isConfigError?: boolean }).isConfigError === true)
  );
}

/** Returns the names of every `${var}` reference left unresolved in a string. */
export function findUnresolvedVars(str: string): string[] {
  return [...new Set([...str.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]))];
}

/**
 * Collapses `.` and `..` segments in an already-substituted absolute path.
 *
 * Output destinations must be normalized at resolution time, not left as written.
 * A config that names a directory as `${sousDir}/..` (the natural way to reach the
 * repo root from a discovered `.sous/`) otherwise produces a `destinationDir` of
 * `/repo/.sous/../.claude/skills`, while the file paths Sous actually writes go
 * through `path.join` and come out as `/repo/.claude/skills/...`. Prune compares
 * tracked destinations against `destinationDir` by string prefix, so the two forms
 * never match and prune deletes every file compile had just written.
 *
 * Relative values are left alone: they are resolved later against a context this
 * function does not have.
 *
 * @param value - A substituted path from the config.
 * @returns The normalized path, or `value` unchanged when it is not absolute.
 */
export function normalizeConfigPath(value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : value;
}

/**
 * Substitutes `${varName}` references and throws when any reference cannot be
 * resolved from the scope. Used for every value Sous acts on (entry points,
 * destinations, prompt files, runtime-context paths) so a typo'd or missing
 * variable fails loudly instead of silently producing a literal `${var}` path.
 *
 * @param str - The raw value from the config.
 * @param scope - The resolved variable scope.
 * @param context - Where the value came from, e.g.
 *   `compilation.targets[0].entryPoint`. Named in the error.
 * @returns The fully substituted string.
 * @throws When one or more `${var}` references are unresolved.
 */
export function substituteVarsStrict(str: string, scope: VarScope, context: string): string {
  const result = substituteVars(str, scope);
  const unresolved = findUnresolvedVars(result);

  if (unresolved.length > 0) {
    const names = unresolved.map((n) => `\${${n}}`).join(", ");
    const plural = unresolved.length === 1 ? "variable" : "variables";
    const available = Object.keys(scope).sort();
    throw new ConfigError(
      `Unresolved ${plural} ${names} in ${context}\n` +
        `  raw value: ${str}\n` +
        `  Define ${unresolved.length === 1 ? "it" : "them"} in a _vars block, or map ` +
        `${unresolved.length === 1 ? "it" : "them"} from the environment via the top-level ` +
        `_env block (values can come from .sous/.env.local or .sous/.env).\n` +
        `  Variables in scope here: ${available.length > 0 ? available.join(", ") : "(none)"}`
    );
  }

  return result;
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
 * Where the active config came from. Threaded through variable resolution so
 * configs can reference their own `.sous/` directory and so error messages can
 * point at the right `.env.local` / `.env`.
 */
export type ConfigContext = {
  /** Absolute path to the `.sous/` directory holding the config. */
  sousDir: string;
  /** Absolute path to the config file itself. */
  configPath: string;
};

/**
 * Builds the auto-injected variable scope. These vars are always available
 * and injected first, before _env and _vars.
 * The 'sous*' namespace is reserved — warns if user defines a var starting with 'sous'.
 *
 * @param context - The discovered config location. When supplied, adds
 *   `sousDir` and `sousConfigPath` so configs can build paths relative to
 *   their own `.sous/` directory.
 */
export function buildAutoVars(context?: ConfigContext): VarScope {
  return {
    sousRootPath: CLI_ROOT,
    sousVersion: SOUS_VERSION,
    ...(context !== undefined && {
      sousDir: context.sousDir,
      sousConfigPath: context.configPath,
    }),
  };
}

/**
 * Resolves the top-level _env block into a VarScope.
 * Each entry maps a config var name (key) to an environment variable name (value).
 * Throws a clear error if any referenced env var is not set.
 * Only called on the root Settings object — _env is top-level only.
 *
 * @param settings - The root settings object.
 * @param context - The discovered config location, used to name the
 *   `.sous/.env.local` and `.sous/.env` files in the error message.
 */
export function resolveEnvScope(settings: Settings, context?: ConfigContext): VarScope {
  const env = settings._env ?? {};
  const scope: VarScope = {};

  for (const [varName, envVarName] of Object.entries(env)) {
    const value = process.env[envVarName];
    if (value === undefined) {
      const envLocalPath = context
        ? path.join(context.sousDir, ENV_LOCAL_NAME)
        : `${SOUS_DIR_NAME}/${ENV_LOCAL_NAME}`;
      const envDefaultsPath = context
        ? path.join(context.sousDir, ENV_DEFAULTS_NAME)
        : `${SOUS_DIR_NAME}/${ENV_DEFAULTS_NAME}`;
      throw new ConfigError(
        `_env resolution failed: environment variable '${envVarName}' (mapped to config ` +
          `var '${varName}') is not set.\n` +
          `  Define it in ${envLocalPath} as:\n` +
          `    ${envVarName}=<value>\n` +
          `  ...or, if the value is shared by the whole team and is not a secret, in ` +
          `${envDefaultsPath} (committed).\n` +
          `  ...or export it in your shell before running sous.`
      );
    }
    scope[varName] = value;
  }

  return scope;
}

/**
 * Resolves the root-level _vars from a Settings object into a scope.
 * Chains: auto-vars → env scope → root _vars.
 *
 * @param settings - The root settings object.
 * @param context - The discovered config location (optional in tests).
 */
export function resolveRootScope(settings: Settings, context?: ConfigContext): VarScope {
  const autoVars = buildAutoVars(context);
  const envScope = resolveEnvScope(settings, context);
  const baseScope = { ...autoVars, ...envScope };
  return resolveScope(settings._vars ?? {}, baseScope);
}

/**
 * Built-in `@include` aliases, always available and reserved (their names begin
 * with `~` so user `_aliases` can never shadow them). Add new entries here as
 * needed — keep names kebab-case.
 *
 * - `~sous-shared` → the Sous CLI's `shared-prompts` directory (the only dir
 *   downstream projects consume; path into it, e.g. `@~sous-shared/skills/...`).
 * - `~project`     → the consuming project's root (`projectRoot`).
 */
export function buildBuiltInAliases(scope: VarScope): AliasMap {
  const sousRoot = scope.sousRootPath ?? CLI_ROOT;
  const builtIns: AliasMap = {
    "~sous-shared": [path.join(sousRoot, "shared-prompts")],
  };
  if (scope.projectRoot) builtIns["~project"] = [scope.projectRoot];
  return builtIns;
}

/**
 * Resolve the full `@include` alias map: built-ins, then the config's
 * `_aliases` block (user entries prepend, so they are tried first and fall
 * through to built-in bases of the same name). User alias names starting
 * with `~` are rejected (reserved).
 *
 * @param settings - The loaded settings (for the `_aliases` block).
 * @param scope - The resolved settings scope (for ${var} substitution + projectRoot).
 */
export function resolveAliases(settings: Settings, scope: VarScope): AliasMap {
  return buildAliasMap({
    builtIns: buildBuiltInAliases(scope),
    userAliases: [settings._aliases],
    scope,
    onError: warning,
  });
}

/** A resolved tool configuration with promptFile path substituted. */
export type ResolvedToolConfig = {
  command: string;
  args?: string[];
  promptFile?: string;
};

/**
 * Resolves the config's tools block, substituting vars in promptFile paths.
 * Returns an empty object if no tools are configured.
 *
 * @param settings - The loaded settings.
 * @param scope - The resolved settings scope (from resolveRootScope).
 */
export function resolveTools(
  settings: Settings,
  scope: VarScope = {}
): Record<string, ResolvedToolConfig> {
  if (!settings.tools) return {};

  return Object.fromEntries(
    Object.entries(settings.tools).map(([name, tool]) => [
      name,
      {
        command: tool.command,
        ...(tool.args !== undefined && { args: tool.args }),
        ...(tool.promptFile !== undefined && {
          promptFile: substituteVarsStrict(
            tool.promptFile,
            scope,
            `tools.${name}.promptFile`
          ),
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
function resolveRuntimeContext(
  raw: RawRuntimeContext,
  scope: VarScope,
  context: string
): ResolvedRuntimeContext {
  return {
    gitRoot: substituteVarsStrict(raw.gitRoot, scope, `${context}.gitRoot`),
    outputPath: substituteVarsStrict(raw.outputPath, scope, `${context}.outputPath`),
    taskFileRoot: substituteVarsStrict(raw.taskFileRoot, scope, `${context}.taskFileRoot`),
    branchPattern: new RegExp(raw.branchPattern ?? "PT-"),
  };
}

/**
 * Resolves the config's compilation block into the shape the compiler expects.
 * Walks the config tree resolving _vars at each level (settings → compilation → target → output).
 * Pass scope from resolveRootScope(settings) to thread the settings vars down.
 * Returns null if the config has no compilation block.
 */
export function resolveCompilation(
  settings: Settings,
  scope: VarScope = {}
): CompilationConfig | null {
  if (!settings.compilation) return null;

  const compilationScope = resolveScope(settings.compilation._vars ?? {}, scope);
  const aliases = resolveAliases(settings, scope);

  return {
    includeSourceComments: settings.compilation.includeSourceComments,
    aliases,
    includeScope: scope,
    targets: settings.compilation.targets.flatMap((target, targetIndex): CompilationTarget[] => {
      const targetScope = resolveScope(target._vars ?? {}, compilationScope);
      const where = `compilation.targets[${targetIndex}]`;
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
          .map((output, outputIndex) => {
            const outputScope = resolveScope(output._vars ?? {}, scope);
            const outputWhere = `${where}.outputs[${outputIndex}]`;
            return {
              ...(output.destinationFile !== undefined && {
                destinationFile: normalizeConfigPath(
                  substituteVarsStrict(
                    output.destinationFile,
                    outputScope,
                    `${outputWhere}.destinationFile`
                  )
                ),
              }),
              ...(output.destinationDir !== undefined && {
                destinationDir: normalizeConfigPath(
                  substituteVarsStrict(
                    output.destinationDir,
                    outputScope,
                    `${outputWhere}.destinationDir`
                  )
                ),
              }),
              vars: outputScope,
            };
          });
      }

      if (hasSingle) {
        const runtimeContext =
          target.generateRuntimeContext && settings.runtimeContext
            ? resolveRuntimeContext(settings.runtimeContext, scope, "runtimeContext")
            : undefined;
        return [{
          rootInputPath: normalizeConfigPath(
            substituteVarsStrict(target.entryPoint!, targetScope, `${where}.entryPoint`)
          ),
          ...(runtimeContext !== undefined && { runtimeContext }),
          outputs: resolveOutputs(targetScope),
        }];
      }

      /* c8 ignore start */
      // Glob target: expand pattern into one CompilationTarget per matched file, skipping dirs.
      // A leading alias (`~sous-shared/skills/**`) expands to one candidate pattern per alias
      // base; the first base that matches any files wins, mirroring the first-existing-wins
      // rule of @include resolution.
      const rawPattern = substituteVarsStrict(target.entryGlob!, targetScope, `${where}.entryGlob`);
      const patternCandidates = resolveAliasPrefix(rawPattern, aliases);
      let pattern = patternCandidates[0];
      let matchedFiles: string[] = [];
      for (const candidate of patternCandidates) {
        const matches = globSync(candidate, { absolute: true })
          .filter(filePath => fs.statSync(filePath).isFile());
        if (matches.length > 0) {
          pattern = candidate;
          matchedFiles = matches;
          break;
        }
      }

      if (matchedFiles.length === 0) {
        warning(`Glob pattern matched no files:\n${patternCandidates.join("\n")}`);
      }

      const globBase = normalizeConfigPath(
        target.globBase
          ? substituteVarsStrict(target.globBase, targetScope, `${where}.globBase`)
          : inferGlobBase(pattern)
      );
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
 * Returns the watch configuration for the config's compilation targets.
 *
 * - entryPoint targets → exact file path in `files`.
 * - entryGlob targets → resolved glob string in `globs`.
 *
 * Alias prefixes in entryGlob patterns are expanded (every base of the alias
 * is watched, matching compile's fall-through resolution).
 */
export function resolveWatchConfig(settings: Settings, scope: VarScope = {}): WatchConfig {
  if (!settings.compilation) return { files: [], globs: [] };

  const compilationScope = resolveScope(settings.compilation._vars ?? {}, scope);
  const aliases = resolveAliases(settings, scope);
  const files: string[] = [];
  const globs: string[] = [];

  for (const [targetIndex, target] of settings.compilation.targets.entries()) {
    const targetScope = resolveScope(target._vars ?? {}, compilationScope);
    const where = `compilation.targets[${targetIndex}]`;

    if (target.entryPoint) {
      files.push(substituteVarsStrict(target.entryPoint, targetScope, `${where}.entryPoint`));
    }

    if (target.entryGlob) {
      const pattern = substituteVarsStrict(target.entryGlob, targetScope, `${where}.entryGlob`);
      globs.push(...resolveAliasPrefix(pattern, aliases));
    }
  }

  return {
    files: [...new Set(files)],
    globs: [...new Set(globs)],
  };
}
