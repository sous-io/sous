import path from "node:path";
import { Command, Flags } from "@oclif/core";
import {
  discoverConfig,
  formatNotFoundMessage,
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
import { displayError, displayErrorBlock, header } from "./utils/formatting.js";

/**
 * Base class for all CLI commands.
 *
 * Startup sequence:
 *   1. Locate the config — `--config <path>` wins, otherwise walk up from cwd
 *      looking for a `.sous/` directory holding sous.config.{js,mjs,json}.
 *   2. Load `<.sous>/.env.local`, then `<.sous>/.env`, into process.env (never
 *      overwriting real env vars). Precedence: shell > .env.local > .env.
 *   3. Load the config file. Variable resolution happens later, per command.
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
  };

  protected settings!: Settings;

  /** Where the active config was found. */
  protected configContext!: ConfigContext;

  /** The full discovery result, including how the config was located. */
  protected discovered!: DiscoveredConfig;

  async init(): Promise<void> {
    await super.init();
    header();

    // Read --config off argv directly. oclif's parse() runs inside each command's
    // run(), which is too late: env vars must be injected before any resolution.
    const configFlag = readConfigFlagFromArgv(this.argv);

    let discovered: DiscoveredConfig | null;

    if (configFlag !== undefined) {
      try {
        discovered = resolveConfigFlag(configFlag);
      } catch (error) {
        displayError(error instanceof Error ? error.message : String(error));
        return this.exit(1);
      }
    } else {
      discovered = discoverConfig();
    }

    if (!discovered) {
      displayErrorBlock(formatNotFoundMessage());
      return this.exit(1);
    }

    this.discovered = discovered;
    this.configContext = {
      sousDir: discovered.sousDir,
      configPath: discovered.configPath,
    };

    // Inject .sous/.env.local and .sous/.env before anything resolves variables.
    loadEnvFiles(discovered.sousDir);

    try {
      this.settings = await loadSettings(discovered.configPath);
    } catch (error) {
      displayErrorBlock(error instanceof Error ? error.message : String(error));
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
      displayErrorBlock(error.message);
      return this.exit(1);
    }
    return super.catch(error);
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
