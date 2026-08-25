import path from "node:path";
import { Command, Flags } from "@oclif/core";
import {
  discoverConfig,
  expandHome,
  formatNotFoundMessage,
  refreshDiscoveredConfig,
  resolveConfigFlag,
  type DiscoveredConfig,
} from "./lib/config-discovery.js";
import { loadEnvFiles } from "./lib/env-local.js";
import {
  isConfigError,
  loadSettings,
  type ConfigContext,
  type Settings,
} from "./lib/settings.js";
import { displayError, displayErrorBlock, header, log } from "./utils/formatting.js";

/**
 * Base class for all CLI commands.
 *
 * Startup sequence:
 *   1. Locate the config. Primary-config precedence, highest first:
 *      `--config`/`-c`/`--sous-config` flag > `SOUS_CONFIG` env >
 *      `--sous-dir` flag > `SOUS_DIR` env > walk up from cwd looking for a
 *      `.sous/` directory holding sous.config.{js,mjs,json,yaml}. The conf.d
 *      drop-in directory precedence is: `--sous-confd` flag > `SOUS_CONFD` env >
 *      `<sousDir>/conf.d`. Env vars are read from the REAL environment only
 *      (never `.env.local`), because they decide where `.env.local` lives.
 *   2. Load `<.sous>/.env.local`, then `<.sous>/.env`, into process.env (never
 *      overwriting real env vars). Precedence: shell > .env.local > .env.
 *   3. Load every config layer (primary + conf.d) through the config kernel and
 *      deep-merge them. Variable resolution happens later, per command.
 *
 * There is no user-level config: nothing is read from `~/.sous`.
 */
export abstract class BaseCommand extends Command {
  static baseFlags = {
    config: Flags.string({
      char: "c",
      description:
        "Path to a sous config file (or a directory containing one). Overrides .sous/ discovery",
    }),
    "sous-config": Flags.string({
      description:
        "Alias of --config: path to a sous config file (or a directory containing one)",
    }),
    "sous-dir": Flags.string({
      description: "Path to the .sous directory to use (overrides walk-up discovery)",
    }),
    "sous-confd": Flags.string({
      description: "Path to the conf.d drop-in layer directory (overrides <sousDir>/conf.d)",
    }),
  };

  protected settings!: Settings;

  /** Where the active config was found. */
  protected configContext!: ConfigContext;

  /** The full discovery result, including how the config was located. */
  protected discovered!: DiscoveredConfig;

  /**
   * Emits the decorative CLI header during init(). The default writes it to
   * stdout. Commands whose stdout must stay machine-readable (the `xcv config *`
   * JSON commands) override this to route the banner to stderr.
   */
  protected emitHeader(): void {
    header();
  }

  /**
   * Line sink for error rendering during init()/catch(). Defaults to stdout (via
   * `log`). Commands whose stdout must stay machine-readable (the `xcv config *`
   * JSON commands) override this to route error text to stderr, so a broken
   * config never corrupts a piped stdout stream (e.g. `xcv config show | jq`).
   */
  protected errorSink: (line: string) => void = log;

  async init(): Promise<void> {
    await super.init();
    this.emitHeader();

    // Read config-locating flags off argv directly. oclif's parse() runs inside
    // each command's run(), which is too late: the config (and thus the env
    // files) must be located before any variable resolution. `SOUS_*` env vars
    // are read from the REAL environment here, BEFORE loadEnvFiles below, because
    // they decide where `.env.local` itself lives.
    const cwd = process.cwd();
    const configFlag = blankToUndefined(readConfigFlagFromArgv(this.argv));
    const sousConfigFlag = blankToUndefined(readLongFlagFromArgv(this.argv, "sous-config"));
    const sousDirFlag = blankToUndefined(readLongFlagFromArgv(this.argv, "sous-dir"));
    const sousConfdFlag = blankToUndefined(readLongFlagFromArgv(this.argv, "sous-confd"));

    // Empty-string env vars are coerced to undefined and treated as unset. A
    // bare `export SOUS_CONFD=` (or a variable that expands empty) must not turn
    // cwd into the conf.d dir, and an empty SOUS_CONFIG/SOUS_DIR must not mask a
    // lower-precedence source or disable walk-up discovery.
    const sousConfdEnv = blankToUndefined(process.env.SOUS_CONFD);
    const sousConfigEnv = blankToUndefined(process.env.SOUS_CONFIG);
    const sousDirEnv = blankToUndefined(process.env.SOUS_DIR);

    // conf.d directory: --sous-confd flag > SOUS_CONFD env > <sousDir>/conf.d.
    const confdRaw = sousConfdFlag ?? sousConfdEnv;
    const confDirOverride =
      confdRaw !== undefined ? path.resolve(cwd, expandHome(confdRaw)) : undefined;

    // Primary config, highest precedence first: --config/-c/--sous-config flag,
    // SOUS_CONFIG env, --sous-dir flag, SOUS_DIR env. All resolve with the same
    // rules as --config (a file, or a directory holding/containing a config).
    // The paired source label is carried through to resolveConfigFlag so an
    // error names the source the user actually set (not always `--config`).
    const primaryCandidates: [string | undefined, string][] = [
      [configFlag, "--config"],
      [sousConfigFlag, "--sous-config"],
      [sousConfigEnv, "SOUS_CONFIG"],
      [sousDirFlag, "--sous-dir"],
      [sousDirEnv, "SOUS_DIR"],
    ];
    const primary = primaryCandidates.find(([value]) => value !== undefined);

    let discovered: DiscoveredConfig | null;

    if (primary !== undefined) {
      const [primarySource, sourceLabel] = primary as [string, string];
      try {
        discovered = resolveConfigFlag(primarySource, cwd, confDirOverride, sourceLabel);
      } catch (error) {
        displayError(error instanceof Error ? error.message : String(error), this.errorSink);
        return this.exit(1);
      }
    } else {
      discovered = discoverConfig(cwd, confDirOverride);
    }

    if (!discovered) {
      displayErrorBlock(formatNotFoundMessage(), this.errorSink);
      return this.exit(1);
    }

    this.discovered = discovered;
    this.configContext = {
      sousDir: discovered.sousDir,
      configPath: discovered.configPath,
      confDir: discovered.confDir,
      layerPaths: discovered.layerPaths,
    };

    // Inject .sous/.env.local and .sous/.env before anything resolves variables.
    loadEnvFiles(discovered.sousDir);

    try {
      this.settings = await loadSettings(discovered);
    } catch (error) {
      displayErrorBlock(error instanceof Error ? error.message : String(error), this.errorSink);
      return this.exit(1);
    }
  }

  /**
   * Renders a configuration error as a plain, readable message instead of an
   * oclif stack trace. The stack for a ConfigError points at Sous internals and
   * tells the user nothing about the config mistake they need to fix.
   *
   * Anything that is not a ConfigError falls through to oclif's normal handling,
   * where a stack trace IS useful (it is a bug in Sous).
   */
  protected async catch(error: Error & { exitCode?: number }): Promise<unknown> {
    if (isConfigError(error)) {
      displayErrorBlock(error.message, this.errorSink);
      return this.exit(1);
    }
    return super.catch(error);
  }

  /**
   * Re-runs discovery and reloads settings, committing the result onto this
   * command only if everything loads cleanly (last-good semantics: a failed
   * reload throws and leaves the previously loaded config untouched).
   *
   * Used by watch mode when a full-rebuild path (the config file, the conf.d
   * directory, or the templating dir) changes: conf.d layer files can appear or
   * disappear at runtime, so the ordered layer list must be rebuilt (and the
   * duplicate-baseName check re-run) before settings reload.
   */
  protected async reloadDiscoveredConfig(): Promise<void> {
    const refreshed = refreshDiscoveredConfig(this.discovered);
    const reloaded = await loadSettings(refreshed);

    // Commit only after a clean load, so a broken edit keeps the last-good config.
    this.discovered = refreshed;
    this.configContext = {
      sousDir: refreshed.sousDir,
      configPath: refreshed.configPath,
      confDir: refreshed.confDir,
      layerPaths: refreshed.layerPaths,
    };
    this.settings = reloaded;
  }

  /**
   * Human-readable label for the configured project: the config's `name` when
   * set, otherwise the basename of the directory holding `.sous/`.
   */
  protected get projectLabel(): string {
    return this.settings.name ?? path.basename(path.dirname(this.configContext.sousDir));
  }
}

/**
 * Pulls the value of `--config` / `-c` out of a raw argv array.
 * Supports `--config X`, `--config=X`, `-c X`, and `-cX`.
 *
 * Scanning stops at a bare `--`: anything after it belongs to a launched tool
 * (see `launch`'s pass-through args), never to sous.
 *
 * @param argv - Raw arguments (oclif's `this.argv`, i.e. argv minus the command).
 * @returns The flag value, or undefined when the flag is absent.
 */
export function readConfigFlagFromArgv(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--") return undefined;
    if (arg === "--config" || arg === "-c") return argv[i + 1];
    if (arg.startsWith("--config=")) return arg.slice("--config=".length);
    if (arg.startsWith("-c") && arg.length > 2 && !arg.startsWith("-c-")) return arg.slice(2);
  }
  return undefined;
}

/**
 * Coerces an empty or whitespace-only string to `undefined`, passing every other
 * value through unchanged.
 *
 * Config-locating inputs (`SOUS_CONFIG`, `SOUS_DIR`, `SOUS_CONFD`, and their flag
 * aliases) must treat an empty value as "unset", never as a real path. A bare
 * `export SOUS_CONFD=` (or a variable that expands empty) would otherwise resolve
 * to cwd and load every file in the working directory as a config layer; an empty
 * `SOUS_CONFIG` / `SOUS_DIR` would mask a lower-precedence source and disable
 * walk-up discovery. Normalising to `undefined` up front lets the plain `??`
 * precedence chain fall through correctly.
 */
export function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.trim() === "" ? undefined : value;
}

/**
 * Pulls the value of a long-only flag (`--<flagName> VALUE` or
 * `--<flagName>=VALUE`) out of a raw argv array. Used for the `--sous-config`,
 * `--sous-dir` and `--sous-confd` aliases, which — like `--config` — must be
 * read before oclif's parse() so the config is located before env files load.
 *
 * Scanning stops at a bare `--` for the same reason as `readConfigFlagFromArgv`:
 * anything after it belongs to a launched tool, never to sous.
 *
 * @param argv - Raw arguments (oclif's `this.argv`).
 * @param flagName - The flag name without leading dashes (e.g. `sous-dir`).
 * @returns The flag value, or undefined when the flag is absent (or has no value).
 */
export function readLongFlagFromArgv(argv: string[], flagName: string): string | undefined {
  const long = `--${flagName}`;
  const eq = `${long}=`;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--") return undefined;
    if (arg === long) return argv[i + 1];
    if (arg.startsWith(eq)) return arg.slice(eq.length);
  }
  return undefined;
}
