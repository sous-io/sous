/**
 * Reading and writing the links map, and the ignore hygiene that goes with it.
 *
 * A link redirects one repository's resolution away from the store and at a
 * real working copy on disk, which is how a maintainer edits recipes: edits
 * happen in a checkout, never in the store. `sous repo link` writes an entry
 * here; `sous repo unlink` removes it and leaves the checkout alone.
 *
 * Two maps exist. The project's `.sous/sous.links.json` covers one project; the
 * machine-wide `$SOUS_HOME/sous.links.json` covers every project on the machine,
 * which is how two projects share one checkout. Both are read, and the project's
 * entries win, because the narrower decision is the more deliberate one.
 *
 * Neither map is committed. A link bypasses versions, the lockfile and freshness
 * checks, and those bypasses belong to one person's machine rather than to the
 * team; the ignore hygiene in this module is what keeps them out of the
 * repository, and `describeLinkedRepos` is what keeps them visible in build
 * output instead of silently changing what a build produces.
 */

import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "../errors.js";
import { resolveSousHome } from "../sous-home.js";
import { LINKS_FILENAME } from "./formats/common.js";
import {
  createEmptyLinksMap,
  mergeLinksMaps,
  parseLinksMap,
  stringifyLinksMap,
  type LinksMap,
  type RepoLink,
} from "./formats/links-map.js";
import { loadJsonFile } from "./load-manifest.js";

/** Directory name, inside `.sous/` or `$SOUS_HOME`, holding linked checkouts. */
export const REPOS_DIRNAME = "repos";

/** Opening marker of the block sous maintains in `.sous/.gitignore`. */
export const IGNORE_BLOCK_START = "# >>> sous managed (do not edit between these markers)";

/** Closing marker of the block sous maintains in `.sous/.gitignore`. */
export const IGNORE_BLOCK_END = "# <<< sous managed";

/**
 * The entries sous keeps inside its managed block in `.sous/.gitignore`. All of
 * them are machine-local: the links map, the build state file, the watcher's
 * PID file, and the directory linked checkouts are cloned into.
 */
export const IGNORE_BLOCK_ENTRIES = [
  LINKS_FILENAME,
  "sous.state.json",
  "sous.pid",
  `${REPOS_DIRNAME}/`,
] as const;

// --- Locations ----------------------------------------------------------------------------------

/**
 * The user-level sous directory, re-exported under the name this module has
 * always used. The one definition lives in `src/lib/sous-home.ts`, so the store,
 * the links maps and the auto-injected `${sousHome}` variable can never disagree
 * about where it is.
 *
 * @param env - The environment to read, so tests need not mutate the real one.
 */
export function resolveSousHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveSousHome(env);
}

/**
 * Path to the project's links map.
 *
 * @param sousDir - The project's discovered `.sous/` directory.
 */
export function projectLinksPath(sousDir: string): string {
  return path.join(sousDir, LINKS_FILENAME);
}

/**
 * Path to the machine-wide links map.
 *
 * @param env - The environment to read.
 */
export function globalLinksPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveSousHomeDir(env), LINKS_FILENAME);
}

/**
 * The directory a project's own linked checkouts are cloned into.
 *
 * @param sousDir - The project's discovered `.sous/` directory.
 */
export function projectReposDir(sousDir: string): string {
  return path.join(sousDir, REPOS_DIRNAME);
}

/**
 * The directory machine-wide linked checkouts are cloned into, shared by every
 * project on the machine.
 *
 * @param env - The environment to read.
 */
export function globalReposDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveSousHomeDir(env), REPOS_DIRNAME);
}

// --- Reading ------------------------------------------------------------------------------------

/**
 * Reads a links map from a path, returning an empty map when the file does not
 * exist. A file that exists but cannot be read or does not validate raises a
 * ConfigError naming it, rather than being quietly treated as empty: a link
 * changes what a build produces, so losing one must never pass unnoticed.
 *
 * @param filePath - Absolute path to the links file.
 */
export function readLinksFile(filePath: string): LinksMap {
  if (!fs.existsSync(filePath)) return createEmptyLinksMap();
  return parseLinksMap(loadJsonFile(filePath, "links map"), filePath);
}

/**
 * Reads the project's links map.
 *
 * @param sousDir - The project's discovered `.sous/` directory.
 */
export function readProjectLinks(sousDir: string): LinksMap {
  return readLinksFile(projectLinksPath(sousDir));
}

/**
 * Reads the machine-wide links map.
 *
 * @param env - The environment to read.
 */
export function readGlobalLinks(env: NodeJS.ProcessEnv = process.env): LinksMap {
  return readLinksFile(globalLinksPath(env));
}

/**
 * Reads both maps and merges them into the one map the rest of sous consults,
 * with the project's entries winning over the machine-wide ones.
 *
 * @param sousDir - The project's discovered `.sous/` directory.
 * @param env - The environment to read.
 */
export function readEffectiveLinks(
  sousDir: string,
  env: NodeJS.ProcessEnv = process.env
): Record<string, RepoLink> {
  return mergeLinksMaps(readGlobalLinks(env), readProjectLinks(sousDir));
}

/**
 * The working copy sous should read for a repository, or undefined when the
 * repository is not linked and resolution should fall through to the store.
 *
 * @param repoName - The repository's configured short name.
 * @param sousDir - The project's discovered `.sous/` directory.
 * @param env - The environment to read.
 */
export function linkedPathFor(
  repoName: string,
  sousDir: string,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  return readEffectiveLinks(sousDir, env)[repoName]?.path;
}

// --- Writing ------------------------------------------------------------------------------------

/**
 * Writes a links map, creating its directory if needed. Returns the path it was
 * written to.
 *
 * @param filePath - Absolute path to the links file.
 * @param map - The map to write.
 */
export function writeLinksFile(filePath: string, map: LinksMap): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, stringifyLinksMap(map), "utf8");
  return filePath;
}

/**
 * Writes the project's links map.
 *
 * @param sousDir - The project's discovered `.sous/` directory.
 * @param map - The map to write.
 */
export function writeProjectLinks(sousDir: string, map: LinksMap): string {
  return writeLinksFile(projectLinksPath(sousDir), map);
}

/**
 * Writes the machine-wide links map.
 *
 * @param map - The map to write.
 * @param env - The environment to read.
 */
export function writeGlobalLinks(
  map: LinksMap,
  env: NodeJS.ProcessEnv = process.env
): string {
  return writeLinksFile(globalLinksPath(env), map);
}

// --- Build output notice ------------------------------------------------------------------------

/**
 * The lines a build prints when anything is linked, so a checkout standing in
 * for a published repository is never a silent change. Returns an empty array
 * when nothing is linked, which is the signal to print nothing at all.
 *
 * @param sousDir - The project's discovered `.sous/` directory.
 * @param env - The environment to read.
 */
export function describeLinkedRepos(
  sousDir: string,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const links = readEffectiveLinks(sousDir, env);
  const names = Object.keys(links).sort();
  if (names.length === 0) return [];

  const lines = [
    names.length === 1
      ? "One repository is LINKED to a working copy on this machine."
      : `${names.length} repositories are LINKED to working copies on this machine.`,
    "Their recipes are read from those checkouts, so versions, the lockfile and",
    "freshness checks do not apply to them.",
    "",
  ];

  for (const name of names) {
    lines.push(`${name} -> ${links[name]!.path}`);
  }

  lines.push("");
  lines.push("Run 'sous repo unlink <name>' to go back to the published versions.");
  return lines;
}

// --- Ignore hygiene -----------------------------------------------------------------------------

/**
 * Makes sure git ignores everything sous keeps inside `.sous/` that belongs to
 * one machine rather than to the team. Two files are maintained, and both are
 * safe to write again on every link:
 *
 * - `.sous/repos/.gitignore`, holding a single `*`, so a linked checkout cloned
 *   underneath it is invisible to the project's own repository (the `*` covers
 *   the ignore file itself, so the directory contributes nothing at all).
 * - a delimited managed block inside `.sous/.gitignore`. Only the lines between
 *   the markers are ever rewritten; anything the user put above or below them is
 *   left exactly as it was.
 *
 * @param sousDir - The project's discovered `.sous/` directory.
 */
export function ensureReposIgnoreFiles(sousDir: string): void {
  const reposDir = projectReposDir(sousDir);
  fs.mkdirSync(reposDir, { recursive: true });
  writeIfChanged(path.join(reposDir, ".gitignore"), "*\n");

  const gitignorePath = path.join(sousDir, ".gitignore");
  const existing = fs.existsSync(gitignorePath)
    ? fs.readFileSync(gitignorePath, "utf8")
    : undefined;
  writeIfChanged(gitignorePath, applyManagedIgnoreBlock(existing, gitignorePath));
}

/**
 * Returns the contents of `.sous/.gitignore` with sous's managed block present
 * and up to date, leaving every line outside the markers untouched. Exported so
 * the behavior can be tested without touching a filesystem.
 *
 * @param existing - The file's current contents, or undefined when there is no file.
 * @param label - The file's path, named if the block turns out to be damaged.
 */
export function applyManagedIgnoreBlock(
  existing: string | undefined,
  label = ".sous/.gitignore"
): string {
  const block = [IGNORE_BLOCK_START, ...IGNORE_BLOCK_ENTRIES, IGNORE_BLOCK_END];

  if (existing === undefined || existing.trim() === "") {
    return `${block.join("\n")}\n`;
  }

  const lines = existing.split("\n");
  const start = lines.findIndex((line) => line.trim() === IGNORE_BLOCK_START);

  if (start === -1) {
    const prefix = existing.endsWith("\n") ? existing : `${existing}\n`;
    const separator = prefix.endsWith("\n\n") ? "" : "\n";
    return `${prefix}${separator}${block.join("\n")}\n`;
  }

  const end = lines.findIndex(
    (line, index) => index > start && line.trim() === IGNORE_BLOCK_END
  );

  if (end === -1) {
    throw new ConfigError(
      `The sous managed block in ${label} has no closing marker.\n` +
        `  It opens with '${IGNORE_BLOCK_START}' but the line '${IGNORE_BLOCK_END}' ` +
        `is missing, so sous cannot tell where the block ends.\n` +
        `  Add the closing marker back, or delete the opening one, and run the ` +
        `command again.`
    );
  }

  const rebuilt = [...lines.slice(0, start), ...block, ...lines.slice(end + 1)];
  const joined = rebuilt.join("\n");
  return joined.endsWith("\n") ? joined : `${joined}\n`;
}

// --- Helpers ------------------------------------------------------------------------------------

/** Writes a file only when its contents would change, so links stay idempotent. */
function writeIfChanged(filePath: string, contents: string): void {
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === contents) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}
