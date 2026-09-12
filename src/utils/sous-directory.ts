/**
 * Self-describing directories.
 *
 * Sous creates a handful of directories for its own bookkeeping: the managed
 * config layers, linked checkouts, the machine-wide recipe cache, the user-level
 * sous directory itself. Somebody who finds one of them months later, or an
 * agent reading the repository for the first time, should be able to learn what
 * it is without leaving the directory.
 *
 * So every directory sous creates for itself gets three small files the first
 * time it is created:
 *
 * - `README.md`, a short plain-language explanation of what the directory is,
 *   who writes to it, whether it may be edited or deleted, and whether it is
 *   committed.
 * - `AGENTS.md` and `CLAUDE.md`, each a single line pointing at the README.
 *
 * None of the three is ever overwritten. A user who rewrites the README, or who
 * puts real instructions in `AGENTS.md`, keeps what they wrote forever.
 *
 * Rendered OUTPUT directories are deliberately NOT covered by this: what lands
 * in `.claude/skills/`, in a recipe's output destination, or anywhere else a
 * compilation target writes belongs to the user, and sous does not add files of
 * its own to it.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveSousHome } from "../lib/sous-home.js";

/** The three files written into every sous-created directory. */
export const README_FILENAME = "README.md";

/** Agent instruction file names; both hold the same single pointer line. */
export const AGENT_POINTER_FILENAMES = ["AGENTS.md", "CLAUDE.md"] as const;

/** The one line both agent instruction files contain. */
export const AGENT_POINTER_LINE = "Read `./README.md` for information about this directory.";

/** The README text for a sous-created directory. */
export type SousDirectoryReadme = {
  /** The heading, naming the directory in plain language. */
  title: string;
  /** One or more paragraphs of body text; blank lines are added between them. */
  body: string | string[];
};

/** Renders the README body into its final markdown text. */
function renderReadme(readme: SousDirectoryReadme): string {
  const paragraphs = Array.isArray(readme.body) ? readme.body : [readme.body];
  return `# ${readme.title}\n\n${paragraphs.join("\n\n")}\n`;
}

/**
 * Writes a file only when it does not exist yet. The exclusive write flag makes
 * the check and the write one operation, so two sous processes racing to create
 * the same directory cannot overwrite each other. Any failure is swallowed: a
 * missing explanatory file is never a reason for a command to fail.
 *
 * @param filePath - Absolute path of the file to create.
 * @param contents - What to write when the file is absent.
 */
function writeIfAbsent(filePath: string, contents: string): void {
  try {
    fs.writeFileSync(filePath, contents, { encoding: "utf8", flag: "wx" });
  } catch {
    // Already there, or not writable; either way there is nothing to do.
  }
}

/**
 * Creates one of sous's own bookkeeping directories and makes it
 * self-describing: `README.md` holding the given explanation, plus `AGENTS.md`
 * and `CLAUDE.md` pointing at it. Files that already exist are left exactly as
 * they are.
 *
 * Safe to call on every command; it is idempotent and cheap.
 *
 * @param directory - Absolute path of the directory to create.
 * @param readme - The explanation written into `README.md` on first creation.
 * @returns The directory path, so calls can be inlined.
 */
export function ensureSousDirectory(
  directory: string,
  readme: SousDirectoryReadme
): string {
  fs.mkdirSync(directory, { recursive: true });

  writeIfAbsent(path.join(directory, README_FILENAME), renderReadme(readme));
  for (const name of AGENT_POINTER_FILENAMES) {
    writeIfAbsent(path.join(directory, name), `${AGENT_POINTER_LINE}\n`);
  }

  return directory;
}

// --- The directories sous creates for itself ----------------------------------------------------
//
// Each function below owns the wording for one directory, so every call site is a
// single line and the same explanation is written no matter which command got
// there first.

/**
 * Ensures a project's `conf.d/` drop-in layer directory.
 *
 * @param directory - Absolute path to the project's `conf.d/` directory.
 */
export function ensureConfdDirectory(directory: string): string {
  return ensureSousDirectory(directory, {
    title: "conf.d: drop-in configuration layers",
    body: [
      "Every `.js`, `.mjs`, `.json`, `.jsonc` or `.yaml` file directly inside this " +
        "directory is a configuration layer. Sous loads them after the project's main " +
        "`sous.config.*` file, in filename order, and merges each one over what came " +
        "before it.",
      "Layers numbered 500 through 599 are written by sous itself (for example " +
        "`500-repos.jsonc`, recording the repositories this project trusts). Sous edits " +
        "those files by key, so your comments, key order and formatting survive; it never " +
        "touches the main config or any layer outside that band.",
      "You may add, edit and delete layers here yourself, including the ones sous writes. " +
        "This directory is normally committed to version control along with the rest of " +
        "`.sous/`; keep machine-specific paths and secrets out of it and put them in " +
        "`.sous/.env.local` instead.",
    ],
  });
}

/**
 * Ensures a project's `.sous/repos/` directory of linked checkouts.
 *
 * @param directory - Absolute path to the project's `repos/` directory.
 */
export function ensureProjectReposDirectory(directory: string): string {
  return ensureSousDirectory(directory, {
    title: "repos: linked repository checkouts",
    body: [
      "`sous repo link` clones a recipe repository in here so you can work on it and on " +
        "this project at the same time. Each checkout is an ordinary git working copy; " +
        "sous reads from it and never writes to it.",
      "Everything here is machine-local. The `.gitignore` beside this file holds a single " +
        "`*`, so nothing in this directory (these explanatory files included) is visible " +
        "to the project's own repository.",
      "It is safe to delete a checkout once you have run `sous repo unlink` for it; sous " +
        "goes back to the published version of that repository.",
    ],
  });
}

/**
 * Ensures the user-level sous directory, `$SOUS_HOME` (`~/.sous` by default).
 *
 * @param directory - Absolute path to the user-level sous directory.
 */
export function ensureSousHomeDirectory(directory: string): string {
  return ensureSousDirectory(directory, {
    title: "Your user-level sous directory",
    body: [
      "This is `$SOUS_HOME` (`~/.sous` unless you set that variable). It holds the sous " +
        "state that belongs to this machine rather than to any one project: the recipe " +
        "cache in `cache/`, globally linked checkouts in `repos/`, and the machine-wide " +
        "links map `sous.links.json`.",
      "No project reads its configuration from here, and nothing in here is committed " +
        "anywhere. Sous recreates whatever it needs, so you can delete any of it; you " +
        "will lose only cached downloads and the record of which repositories you linked " +
        "globally.",
    ],
  });
}

/**
 * Explains the parent directory too, but ONLY when it really is the user-level
 * sous directory. A store rooted somewhere else (a test fixture, a root somebody
 * pointed at by hand) must never leave explanatory files in a directory sous
 * does not own, such as the system temporary directory.
 *
 * @param directory - The child directory whose parent is being considered.
 */
function ensureParentWhenSousHome(directory: string): void {
  const parent = path.resolve(path.dirname(directory));
  if (parent !== path.resolve(resolveSousHome())) return;
  ensureSousHomeDirectory(parent);
}

/**
 * Ensures the machine-wide recipe store root, `$SOUS_HOME/cache/`.
 *
 * @param directory - Absolute path to the store root.
 */
export function ensureStoreRootDirectory(directory: string): string {
  ensureParentWhenSousHome(directory);
  return ensureSousDirectory(directory, {
    title: "cache: the machine-wide recipe store",
    body: [
      "Sous downloads every recipe version it needs into this directory, one immutable " +
        "folder per version, and verifies each one against its content hash before using " +
        "it. Builds read from here, so a version is downloaded once and shared by every " +
        "project on this machine.",
      "The store is disposable. Everything in it can be fetched again from the pins in " +
        "each project's lockfile, so you may delete any part of it at any time; " +
        "`sous repo gc` does the same thing tidily. Nothing here is committed, and " +
        "editing a stored file only makes sous discard the entry as corrupted.",
    ],
  });
}

/**
 * Ensures the machine-wide directory of globally linked checkouts,
 * `$SOUS_HOME/repos/`.
 *
 * @param directory - Absolute path to the global repos directory.
 */
export function ensureGlobalReposDirectory(directory: string): string {
  ensureParentWhenSousHome(directory);
  return ensureSousDirectory(directory, {
    title: "repos: globally linked repository checkouts",
    body: [
      "`sous repo link --global` clones a recipe repository in here, where every project " +
        "on this machine can use the same checkout. Each one is an ordinary git working " +
        "copy; sous reads from it and never writes to it.",
      "Everything here is machine-local and is not committed anywhere. It is safe to " +
        "delete a checkout once no project links to it any more; sous goes back to the " +
        "published version of that repository.",
    ],
  });
}

/**
 * Ensures the cached repository index directory, `$SOUS_HOME/cache/_indexes/`.
 *
 * @param directory - Absolute path to the index cache directory.
 */
export function ensureIndexCacheDirectory(directory: string): string {
  ensureStoreRootDirectory(path.dirname(directory));
  return ensureSousDirectory(directory, {
    title: "_indexes: cached repository indexes",
    body: [
      "Each repository sous knows about publishes one small index file listing the " +
        "recipes and versions it offers. Sous keeps a copy of each here, beside a " +
        "`.meta.json` sidecar recording when that copy was fetched.",
      "Sous writes these files; there is nothing here to edit. Deleting any of them is " +
        "safe and costs only a refetch the next time the repository is consulted. Nothing " +
        "here is committed.",
    ],
  });
}
