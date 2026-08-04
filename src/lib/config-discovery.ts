import fs from "node:fs";
import path from "node:path";

/**
 * The directory name sous looks for when walking up from the working directory.
 */
export const SOUS_DIR_NAME = ".sous";

/**
 * Config file names searched inside a `.sous/` directory, in priority order.
 * The first one that exists wins.
 */
export const CONFIG_FILE_NAMES = [
  "sous.config.js",
  "sous.config.mjs",
  "sous.config.json",
] as const;

/**
 * The name of the optional shared-defaults env file inside `.sous/`. This file
 * is meant to be committed: it holds values a whole team shares, never secrets.
 */
export const ENV_DEFAULTS_NAME = ".env";

/** The name of the optional machine-specific env file inside `.sous/`. */
export const ENV_LOCAL_NAME = ".env.local";

/** A located sous configuration. */
export type DiscoveredConfig = {
  /** Absolute path to the config file itself. */
  configPath: string;
  /**
   * Absolute path to the `.sous/` directory holding the config, when the config
   * was found by walking up. For an explicit `--config` path this is the config
   * file's parent directory, whatever it is called.
   */
  sousDir: string;
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
 * Returns the first config file that exists inside `sousDir`, or null.
 */
export function findConfigInSousDir(sousDir: string): string | null {
  for (const name of CONFIG_FILE_NAMES) {
    const candidate = path.join(sousDir, name);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

/**
 * Walks up from `startDir` looking for a `.sous/` directory that contains one of
 * CONFIG_FILE_NAMES. The first directory with a match wins; a `.sous/` directory
 * without a config file does not stop the walk.
 *
 * @param startDir - Directory to start from (normally `process.cwd()`).
 * @returns The discovered config, or null when nothing was found.
 */
export function discoverConfig(startDir: string = process.cwd()): DiscoveredConfig | null {
  for (const dir of candidateDirs(startDir)) {
    const sousDir = path.join(dir, SOUS_DIR_NAME);
    if (!fs.existsSync(sousDir) || !fs.statSync(sousDir).isDirectory()) continue;

    const configPath = findConfigInSousDir(sousDir);
    if (configPath) return { configPath, sousDir, source: "walk-up" };
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
      return { configPath: direct, sousDir: resolved, source: "flag" };
    }

    const nested = path.join(resolved, SOUS_DIR_NAME);
    if (fs.existsSync(nested) && fs.statSync(nested).isDirectory()) {
      const nestedConfig = findConfigInSousDir(nested);
      if (nestedConfig) {
        return { configPath: nestedConfig, sousDir: nested, source: "flag" };
      }
    }

    throw new Error(
      `--config points at a directory with no sous config file: ${resolved}\n` +
        `Looked for: ${CONFIG_FILE_NAMES.join(", ")}`
    );
  }

  return { configPath: resolved, sousDir: path.dirname(resolved), source: "flag" };
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
    '      defaultProject: "myproject",',
    "      projects: {",
    "        myproject: {",
    '          name: "My Project",',
    "          compilation: {",
    "            targets: [",
    "              {",
    '                entryPoint: "${sousDir}/AGENTS.md",',
    '                outputs: [{ destinationFile: "${projectRoot}/AGENTS.md" }],',
    "              },",
    "            ],",
    "          },",
    "        },",
    "      },",
    "    };",
  ].join("\n");
}
