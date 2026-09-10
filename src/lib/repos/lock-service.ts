/**
 * The lockfile service.
 *
 * `.sous/sous.lock.json` records the exact version and content hash of
 * everything a project uses, so a fresh clone restores to the same bytes with
 * no prompts and no version drift. Together with repo trust it is the supply
 * chain defense: nothing new enters a project except through an explicit,
 * visible change to these files.
 *
 * Two behaviors are worth stating outright. Removal is REFCOUNTED: every entry
 * lists who holds it, and an entry goes only when its last holder does, so
 * unsubscribing from one recipe never quietly removes something another recipe
 * still needs. And RESTORE never decides anything: it fetches exactly what the
 * lockfile pins, never a newer version, and never asks a question.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { ConfigError } from "../errors.js";
import {
  LOCKFILE_FILENAME,
  stableJsonStringify,
} from "./formats/common.js";
import {
  createEmptyLockfile,
  parseLockfile,
  stringifyLockfile,
  type LockedRecipe,
  type Lockfile,
} from "./formats/lockfile.js";
import type { IndexFile } from "./formats/index-file.js";
import type { ResolvedRecipe } from "./resolver.js";
import type { RecipeStoreLike, StoreKey } from "./store/contract.js";
import { builtInProviders, requireProvider } from "./providers/index.js";
import type { ProviderOptions, RepoProvider } from "./providers/provider.js";

/** What the lockfile needs to know about a repository. */
export type LockRepoInput = {
  /** Where the repository lives. */
  url: string;
  /** Content hash of the index the resolution was made against, when known. */
  indexHash?: string;
};

/** One change between two lockfiles. */
export type LockChange = {
  /** The recipe key. */
  key: string;
  /** The version before, when there was one. */
  from?: string;
  /** The version after, when there is one. */
  to?: string;
};

/** What changed between two lockfiles, ready to be printed. */
export type LockDiff = {
  added: LockChange[];
  removed: LockChange[];
  updated: LockChange[];
  /** Repositories that appeared or disappeared. */
  reposAdded: string[];
  reposRemoved: string[];
  /** True when nothing at all changed. */
  unchanged: boolean;
  /** The whole thing as plain-language lines, one per change. */
  lines: string[];
};

/** How a restore is carried out. */
export type RestoreOptions = {
  /** The store to fill. */
  store: RecipeStoreLike;
  /** The cached index of each repository, which is where a recipe's folder path comes from. */
  indexes: Map<string, IndexFile>;
  /** The providers to choose from. Defaults to the built-ins. */
  providers?: RepoProvider[];
  /** Options handed to every provider call. */
  providerOptions?: ProviderOptions;
};

/** What a restore did. */
export type RestoreReport = {
  /** Recipes fetched into the store. */
  restored: string[];
  /** Recipes the store already held, verified against the locked hash. */
  alreadyPresent: string[];
};

/** Reads, writes and applies a project's lockfile. */
export class LockService {
  private readonly sousDir: string;

  constructor(sousDir: string) {
    this.sousDir = sousDir;
  }

  /** Where the lockfile lives. */
  get filePath(): string {
    return path.join(this.sousDir, LOCKFILE_FILENAME);
  }

  /**
   * Reads and validates the lockfile. A project that has locked nothing yet has
   * no file, and gets an empty lockfile rather than an error.
   */
  read(): Lockfile {
    let text: string;
    try {
      text = fs.readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return createEmptyLockfile();
      throw new ConfigError(
        `Sous could not read the lockfile at ${this.filePath}.\n  ${(error as Error).message}`
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new ConfigError(
        `Sous could not read the lockfile at ${this.filePath} as JSON.\n` +
          `  ${(error as Error).message}\n` +
          `  The lockfile is written by sous and committed with the project; restoring it ` +
          `from version control is usually the quickest fix.`
      );
    }

    return parseLockfile(parsed, this.filePath);
  }

  /**
   * Writes the lockfile, keys sorted, through a temporary file so a reader
   * never sees a half-written lock.
   *
   * @param lock - The lockfile to write.
   */
  write(lock: Lockfile): string {
    fs.mkdirSync(this.sousDir, { recursive: true });
    const temporary = path.join(this.sousDir, `.${LOCKFILE_FILENAME}.tmp-${process.pid}`);
    try {
      fs.writeFileSync(temporary, stringifyLockfile(lock), "utf8");
      fs.renameSync(temporary, this.filePath);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw new ConfigError(
        `Sous could not write the lockfile at ${this.filePath}.\n  ${(error as Error).message}`
      );
    }
    return this.filePath;
  }

  /**
   * Builds the lockfile a resolution implies. Recipes the resolution covered
   * are replaced outright, since the resolver worked out who holds each one;
   * anything the resolution did not mention is carried through untouched, so a
   * partial install never drops the rest of the project.
   *
   * @param lock - The lockfile as it stands.
   * @param resolved - What the resolver settled on.
   * @param repos - The repositories those recipes came from.
   */
  applyResolution(
    lock: Lockfile,
    resolved: ResolvedRecipe[],
    repos: Record<string, LockRepoInput>
  ): Lockfile {
    const recipes: Record<string, LockedRecipe> = { ...lock.recipes };

    for (const recipe of resolved) {
      recipes[recipe.key] = {
        repo: recipe.repo,
        version: recipe.version,
        hash: recipe.hash,
        requestedBy: [...recipe.requestedBy].sort(),
        kind: recipe.kind,
      };
    }

    const usedRepos = new Set(Object.values(recipes).map((entry) => entry.repo));
    const lockedRepos: Lockfile["repos"] = {};
    for (const name of [...usedRepos].sort()) {
      const known = repos[name];
      const previous = lock.repos[name];
      const url = known?.url ?? previous?.url;
      if (url === undefined) {
        throw new ConfigError(
          `The lockfile cannot record the recipes from '${name}' because nothing knows ` +
            `that repository's URL.\n` +
            `  Add it with 'sous repo add <url>', so the lockfile can name where its ` +
            `recipes came from.`
        );
      }
      const indexHash = known?.indexHash ?? previous?.indexHash;
      lockedRepos[name] = { url, ...(indexHash === undefined ? {} : { indexHash }) };
    }

    return { formatVersion: 1, repos: lockedRepos, recipes: sortRecipes(recipes) };
  }

  /**
   * Drops one holder from the lockfile. Every recipe that holder pulled in
   * loses it too, and an entry goes only once nothing holds it any more, which
   * is what makes an unsubscribe safe.
   *
   * @param lock - The lockfile as it stands.
   * @param holder - The holder to remove: "project", or a recipe key.
   */
  removeHolder(lock: Lockfile, holder: string): Lockfile {
    const recipes: Record<string, LockedRecipe> = {};
    for (const [key, entry] of Object.entries(lock.recipes)) {
      recipes[key] = { ...entry, requestedBy: [...entry.requestedBy] };
    }

    // Removing a holder can orphan the recipes it held, which can orphan more
    // in turn, so the removal repeats until a pass changes nothing.
    let pending = [holder];
    while (pending.length > 0) {
      const going = pending;
      pending = [];

      for (const [key, entry] of Object.entries(recipes)) {
        const kept = entry.requestedBy.filter((name) => !going.includes(name));
        if (kept.length === entry.requestedBy.length) continue;
        if (kept.length === 0) {
          delete recipes[key];
          pending.push(key);
        } else {
          entry.requestedBy = kept;
        }
      }
    }

    const usedRepos = new Set(Object.values(recipes).map((entry) => entry.repo));
    const lockedRepos: Lockfile["repos"] = {};
    for (const name of [...usedRepos].sort()) {
      lockedRepos[name] = lock.repos[name]!;
    }

    return { formatVersion: 1, repos: lockedRepos, recipes: sortRecipes(recipes) };
  }

  /**
   * Compares two lockfiles and describes the difference in plain language, for
   * the summary a command prints before or after it writes one.
   *
   * @param before - The lockfile as it was.
   * @param after - The lockfile as it will be.
   */
  diff(before: Lockfile, after: Lockfile): LockDiff {
    const added: LockChange[] = [];
    const removed: LockChange[] = [];
    const updated: LockChange[] = [];

    for (const [key, entry] of Object.entries(after.recipes)) {
      const previous = before.recipes[key];
      if (previous === undefined) {
        added.push({ key, to: entry.version });
      } else if (previous.version !== entry.version) {
        updated.push({ key, from: previous.version, to: entry.version });
      }
    }
    for (const [key, entry] of Object.entries(before.recipes)) {
      if (!Object.hasOwn(after.recipes, key)) removed.push({ key, from: entry.version });
    }

    const reposAdded = Object.keys(after.repos)
      .filter((name) => !Object.hasOwn(before.repos, name))
      .sort();
    const reposRemoved = Object.keys(before.repos)
      .filter((name) => !Object.hasOwn(after.repos, name))
      .sort();

    const byKey = (left: LockChange, right: LockChange) => (left.key < right.key ? -1 : 1);
    added.sort(byKey);
    removed.sort(byKey);
    updated.sort(byKey);

    const lines: string[] = [];
    for (const name of reposAdded) lines.push(`Repository added: ${name}`);
    for (const change of added) lines.push(`Adding ${change.key} version ${change.to}`);
    for (const change of updated) {
      lines.push(`Updating ${change.key} from version ${change.from} to version ${change.to}`);
    }
    for (const change of removed) {
      lines.push(`Removing ${change.key}, which nothing needs any more`);
    }
    for (const name of reposRemoved) {
      lines.push(`Repository no longer needed: ${name}`);
    }

    const unchanged =
      added.length === 0 &&
      removed.length === 0 &&
      updated.length === 0 &&
      reposAdded.length === 0 &&
      reposRemoved.length === 0;
    if (unchanged) lines.push("Nothing changed.");

    return { added, removed, updated, reposAdded, reposRemoved, unchanged, lines };
  }

  /**
   * Makes the store hold exactly what the lockfile pins. A recipe the store
   * already has, whose hash still verifies, is left alone; anything else is
   * fetched at the locked version's tag and stored under the locked hash, which
   * fails loudly if what arrives does not match.
   *
   * Nothing here decides a version and nothing here asks a question. That is
   * what makes a fresh clone reproducible.
   *
   * @param lock - The lockfile to restore.
   * @param options - The store, the cached indexes, and the providers.
   */
  async restore(lock: Lockfile, options: RestoreOptions): Promise<RestoreReport> {
    const providers = options.providers ?? builtInProviders();
    const report: RestoreReport = { restored: [], alreadyPresent: [] };

    for (const [key, entry] of Object.entries(lock.recipes)) {
      const namespace = key.slice(0, key.indexOf("/"));
      const storeKey: StoreKey = {
        repo: entry.repo,
        namespace,
        name: key.slice(namespace.length + 1),
        version: entry.version,
      };

      const hit = await options.store.get(storeKey);
      if (hit !== undefined && hit.entry.hash === entry.hash) {
        report.alreadyPresent.push(key);
        continue;
      }

      const index = options.indexes.get(entry.repo);
      const indexRecipe = index?.recipes[key];
      const version = indexRecipe?.versions[entry.version];
      if (index === undefined || indexRecipe === undefined || version === undefined) {
        throw new ConfigError(
          `The lockfile pins '${key}' at version ${entry.version} from the repository ` +
            `'${entry.repo}', and that repository's index does not offer it.\n` +
            `  Either the index has not been fetched yet, or the version has been ` +
            `withdrawn upstream. Run 'sous repo list' to see what sous currently has.`
        );
      }

      const repoUrl = lock.repos[entry.repo]!.url;
      const provider = requireProvider(repoUrl, undefined, providers);
      const canonical = provider.canonicalize(repoUrl);

      const workDir = await fsp.mkdtemp(path.join(options.store.root, ".sous-restore-"));
      const fetchDir = path.join(workDir, storeKey.name);
      try {
        await provider.fetchRecipeTree(
          canonical,
          indexRecipe.path,
          version.tag,
          fetchDir,
          options.providerOptions ?? {}
        );
        await options.store.put(storeKey, fetchDir, entry.hash);
        report.restored.push(key);
      } finally {
        await fsp.rm(workDir, { recursive: true, force: true });
      }
    }

    report.restored.sort();
    report.alreadyPresent.sort();
    return report;
  }

  /**
   * Renders a lockfile exactly as `write` would, without writing it. Used by
   * dry runs, which show what would change and touch nothing.
   *
   * @param lock - The lockfile to render.
   */
  preview(lock: Lockfile): string {
    return stableJsonStringify(lock);
  }
}

/** Rebuilds a recipe map with its keys in sorted order. */
function sortRecipes(recipes: Record<string, LockedRecipe>): Record<string, LockedRecipe> {
  const sorted: Record<string, LockedRecipe> = {};
  for (const key of Object.keys(recipes).sort()) sorted[key] = recipes[key]!;
  return sorted;
}
