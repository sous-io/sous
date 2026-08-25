import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "./errors.js";

/**
 * The directory name sous looks for when walking up from the working directory.
 */
export const SOUS_DIR_NAME = ".sous";

/**
 * Primary config file names searched inside a `.sous/` directory. Exactly ONE of
 * these may exist per `.sous/`; more than one is a hard error (no silent
 * first-match-wins).
 */
export const CONFIG_FILE_NAMES = [
  "sous.config.js",
  "sous.config.mjs",
  "sous.config.json",
  "sous.config.yaml",
] as const;

/**
 * The drop-in config layer directory inside `.sous/`. Every
 * `conf.d/*.{js,mjs,json,yaml}` file (non-recursive) is loaded after the
 * primary config and deep-merged in bytewise filename order.
 */
export const CONFD_DIR_NAME = "conf.d";

/** File extensions recognised as config layers inside `conf.d/`. */
export const LAYER_EXTENSIONS = [".js", ".mjs", ".json", ".yaml"] as const;

/**
 * The name of the optional shared-defaults env file inside `.sous/`. This file
 * is meant to be committed: it holds values a whole team shares, never secrets.
 */
export const ENV_DEFAULTS_NAME = ".env";

/** The name of the optional machine-specific env file inside `.sous/`. */
export const ENV_LOCAL_NAME = ".env.local";

/** A located sous configuration. */
export type DiscoveredConfig = {
  /** Absolute path to the primary config file itself. */
  configPath: string;
  /**
   * Absolute path to the `.sous/` directory holding the config, when the config
   * was found by walking up. For an explicit `--config` path this is the config
   * file's parent directory, whatever it is called.
   */
  sousDir: string;
  /** Absolute path to the `conf.d/` drop-in directory (may not exist). */
  confDir: string;
  /**
   * Ordered absolute paths of every config layer: the primary config first,
   * then the `conf.d/` layers in bytewise filename order.
   */
  layerPaths: string[];
  /** How the config was located. */
  source: "flag" | "walk-up";
};

/**
 * Returns the list of directories to check, starting at `startDir` and walking
 * up to the filesystem root. Used by discovery and by the not-found error message.
 */
export function candidateDirs(startDir: string): string[] {
  const dirs: string[] = [];
  let current = path.resolve(startDir);

  for (;;) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return dirs;
}

/**
 * Returns the primary config file inside `sousDir`, or null when none exists.
 *
 * @throws ConfigError when MORE THAN ONE primary candidate exists — sous never
 *   silently picks one of several `sous.config.*` files.
 */
export function findConfigInSousDir(sousDir: string): string | null {
  const found: string[] = [];
  for (const name of CONFIG_FILE_NAMES) {
    const candidate = path.join(sousDir, name);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      found.push(candidate);
    }
  }

  if (found.length > 1) {
    throw new ConfigError(
      `Multiple primary sous config files found in ${sousDir}:\n` +
        found.map((f) => `    ${f}`).join("\n") +
        `\n  A .sous/ directory may hold exactly one of: ${CONFIG_FILE_NAMES.join(", ")}.\n` +
        `  Keep one primary config and move the rest into ${CONFD_DIR_NAME}/ (with unique names) or delete them.`
    );
  }

  return found[0] ?? null;
}

/**
 * Compares two strings bytewise (plain `<` on the string), locale-independent
 * so layer order is identical on every machine. Note this is NOT numeric:
 * `10-` sorts before `2-` (zero-pad layer prefixes if that matters).
 */
function bytewiseCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Lists the config layer files inside a `conf.d/` directory: every
 * `*.{js,mjs,json,yaml}` file directly inside it (non-recursive), sorted
 * bytewise by filename. A missing directory yields an empty list.
 */
export function listConfDirLayers(confDir: string): string[] {
  if (!fs.existsSync(confDir) || !fs.statSync(confDir).isDirectory()) return [];

  return fs
    .readdirSync(confDir)
    .filter((name) => {
      const ext = path.extname(name).toLowerCase();
      if (!(LAYER_EXTENSIONS as readonly string[]).includes(ext)) return false;
      const full = path.join(confDir, name);
      return fs.statSync(full).isFile();
    })
    .sort(bytewiseCompare)
    .map((name) => path.join(confDir, name));
}

/**
 * Asserts that every loaded config file (primary + conf.d layers) has a unique
 * baseName — the filename minus its FINAL extension. Two layers named
 * `500-repos.json` and `500-repos.yaml` would otherwise merge in an order that
 * depends on their extensions, which is never what the author meant.
 *
 * @throws ConfigError naming both conflicting files.
 */
export function assertUniqueLayerBaseNames(layerPaths: string[]): void {
  const seen = new Map<string, string>();
  for (const layerPath of layerPaths) {
    const base = path.basename(layerPath, path.extname(layerPath));
    const existing = seen.get(base);
    if (existing !== undefined) {
      throw new ConfigError(
        `Duplicate config layer baseName '${base}':\n` +
          `    ${existing}\n` +
          `    ${layerPath}\n` +
          `  Every loaded config file (the primary config and all ${CONFD_DIR_NAME}/ layers) must have a\n` +
          `  unique filename once its final extension is removed. Rename one of them.`
      );
    }
    seen.set(base, layerPath);
  }
}

/**
 * Builds a full DiscoveredConfig from a located primary config: computes the
 * conf.d directory, enumerates its layers, and runs the duplicate-baseName check.
 */
function buildDiscoveredConfig(
  configPath: string,
  sousDir: string,
  source: DiscoveredConfig["source"]
): DiscoveredConfig {
  const confDir = path.join(sousDir, CONFD_DIR_NAME);
  const layerPaths = [configPath, ...listConfDirLayers(confDir)];
  assertUniqueLayerBaseNames(layerPaths);
  return { configPath, sousDir, confDir, layerPaths, source };
}

/**
 * Re-runs the conf.d enumeration and duplicate-baseName check for an existing
 * discovery. Used by watch mode: layer files can appear or disappear while
 * watching, so the layer list must be rebuilt before every settings reload.
 */
export function refreshDiscoveredConfig(discovered: DiscoveredConfig): DiscoveredConfig {
  return buildDiscoveredConfig(discovered.configPath, discovered.sousDir, discovered.source);
}

/**
 * Walks up from `startDir` looking for a `.sous/` directory that contains one of
 * CONFIG_FILE_NAMES. The first directory with a match wins; a `.sous/` directory
 * without a config file does not stop the walk.
 *
 * @param startDir - Directory to start from (normally `process.cwd()`).
 * @returns The discovered config, or null when nothing was found.
 * @throws ConfigError when a `.sous/` holds several primary configs, or when
 *   loaded layer baseNames collide.
 */
export function discoverConfig(startDir: string = process.cwd()): DiscoveredConfig | null {
  for (const dir of candidateDirs(startDir)) {
    const sousDir = path.join(dir, SOUS_DIR_NAME);
    if (!fs.existsSync(sousDir) || !fs.statSync(sousDir).isDirectory()) continue;

    const configPath = findConfigInSousDir(sousDir);
    if (configPath) return buildDiscoveredConfig(configPath, sousDir, "walk-up");
  }

  return null;
}

/**
 * Resolves an explicit `--config` value into a DiscoveredConfig.
 *
 * The value may point at a config file or at a directory. A directory is searched
 * for CONFIG_FILE_NAMES, and if the directory itself is not named `.sous`, its
 * `.sous/` child is searched too — so `--config .` works inside a project root.
 *
 * @param configFlag - The raw `--config` value (relative paths resolve against cwd).
 * @param cwd - Base directory for relative paths.
 * @returns The resolved config.
 * @throws When the path does not exist or holds no recognised config file.
 */
export function resolveConfigFlag(
  configFlag: string,
  cwd: string = process.cwd()
): DiscoveredConfig {
  const resolved = path.resolve(cwd, expandHome(configFlag));

  if (!fs.existsSync(resolved)) {
    throw new Error(`--config path not found: ${resolved}`);
  }

  if (fs.statSync(resolved).isDirectory()) {
    const direct = findConfigInSousDir(resolved);
    if (direct) {
      return buildDiscoveredConfig(direct, resolved, "flag");
    }

    const nested = path.join(resolved, SOUS_DIR_NAME);
    if (fs.existsSync(nested) && fs.statSync(nested).isDirectory()) {
      const nestedConfig = findConfigInSousDir(nested);
      if (nestedConfig) {
        return buildDiscoveredConfig(nestedConfig, nested, "flag");
      }
    }

    throw new Error(
      `--config points at a directory with no sous config file: ${resolved}\n` +
        `Looked for: ${CONFIG_FILE_NAMES.join(", ")}`
    );
  }

  return buildDiscoveredConfig(resolved, path.dirname(resolved), "flag");
}

/**
 * Expands a leading `~` to the user's home directory. Leaves other paths alone.
 */
export function expandHome(inputPath: string): string {
  if (inputPath === "~") return process.env.HOME ?? inputPath;
  if (inputPath.startsWith("~/")) {
    const home = process.env.HOME;
    if (home) return path.join(home, inputPath.slice(2));
  }
  return inputPath;
}

/**
 * Builds the message shown when no config could be found. Names every directory
 * that was checked and shows how to fix it.
 *
 * @param startDir - The directory discovery started from.
 */
export function formatNotFoundMessage(startDir: string = process.cwd()): string {
  const dirs = candidateDirs(startDir);
  const shown = dirs.slice(0, 8);
  const omitted = dirs.length - shown.length;

  const checked = shown
    .map((dir) => `    ${path.join(dir, SOUS_DIR_NAME)}/`)
    .join("\n");

  const more = omitted > 0 ? `\n    ... and ${omitted} more parent director${omitted === 1 ? "y" : "ies"}` : "";

  return [
    "No sous config found.",
    "",
    `Starting at ${startDir}, sous walked up looking for a ${SOUS_DIR_NAME}/ directory`,
    `containing one of: ${CONFIG_FILE_NAMES.join(", ")}`,
    "",
    "  Checked:",
    checked + more,
    "",
    "  To fix this, either:",
    `    1. Create ${SOUS_DIR_NAME}/${CONFIG_FILE_NAMES[0]} in your project root, or`,
    "    2. Pass the config explicitly: xcv <command> --config <path>",
    "",
    `  A minimal ${CONFIG_FILE_NAMES[0]}:`,
    "",
    "    export const config = {",
    '      name: "My Project",',
    '      _vars: { projectRoot: "${sousDir}/.." },',
    "      compilation: {",
    "        targets: [",
    "          {",
    '            entryPoint: "${sousDir}/AGENTS.md",',
    '            outputs: [{ destinationFile: "${projectRoot}/AGENTS.md" }],',
    "          },",
    "        ],",
    "      },",
    "    };",
  ].join("\n");
}
