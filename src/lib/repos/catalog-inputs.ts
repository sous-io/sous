/**
 * Wiring the catalog to a running command.
 *
 * `catalog.ts` is pure: it reads indexes, a lockfile and a list of subscription
 * keys. This module is where those come from in a real project, and it is
 * deliberately the only place that knows: the subscription service for the
 * trusted repositories and their cached indexes, the lockfile service for what
 * is pinned, the links map and the store for a recipe's own files, and
 * `recipes` for where a content kind lands.
 *
 * By default nothing here downloads anything: a repository whose index has
 * never been fetched is left out of the catalog and named separately, so a
 * browsing command is safe offline. Asked for the latest, it reads each index
 * from upstream instead and writes none of it to the cache; a repository that
 * cannot be reached is read from the cache and named as not checked.
 */

import type { Settings, VarScope } from "../settings.js";
import type { SubscriptionService } from "./subscription-service.js";
import type { CatalogInputs, CatalogRepo } from "./catalog.js";
import type { IndexFile } from "./formats/index-file.js";
import { linkedPathFor, readEffectiveLinks } from "./links.js";
import { mapLinkedRecipes, readRecipeManifestIn } from "./locked-recipes.js";
import { WRITABLE_CONTENT_KINDS, destinationsFor } from "./recipe-targets.js";
import type { WritableContentKind } from "./recipe-targets.js";

/** What building the catalog's inputs needs. */
export type CatalogInputsOptions = {
  /** The subscription service for this project. */
  service: SubscriptionService;
  /** The project's `.sous/` directory. */
  sousDir: string;
  /** The merged project config. */
  settings: Settings;
  /**
   * The resolved settings scope, when the caller has one. Only the destinations
   * a recipe's files land in need it, so a command that does not show them may
   * leave it out.
   */
  scope?: VarScope;
  /** The environment to read; decides where the store and the links map are. */
  env?: NodeJS.ProcessEnv;
  /**
   * The indexes to read, when the caller has already gathered them (with
   * `readTrustedIndexes`, say, to read upstream). The cached indexes otherwise.
   */
  indexes?: TrustedIndexes;
};

/** Where to read the trusted repositories' indexes from. */
export type TrustedIndexesOptions = {
  /** Read each index from upstream rather than the cache, writing none of it. */
  latest?: boolean;
};

/** One trusted repository's index, and where it was read from. */
export type TrustedIndex = {
  /** The repository's short name. */
  name: string;
  /** Where it lives, as the project's config records it. */
  url?: string;
  /** The index that was read. */
  index: IndexFile;
  /** Whether it came from upstream just now or from the cache. */
  source: "upstream" | "cache";
};

/** Every trusted repository's index sous could read, and what it could not. */
export type TrustedIndexes = {
  /** The indexes, by repository short name, sorted. */
  repos: TrustedIndex[];
  /**
   * Trusted repositories with no index at all: never fetched, and (when the
   * latest was asked for) not reachable either. Sorted.
   */
  notFetched: string[];
  /**
   * Repositories the latest was asked for that could not be reached, and were
   * read from the cache instead. Sorted; always empty when reading the cache.
   */
  notChecked: string[];
};

/**
 * Reads the index of every repository this project trusts. From the cache by
 * default, which downloads nothing. With `latest`, from upstream, all at once,
 * and nothing fetched is written to the cache: only a command that resolves
 * versions changes what the cache holds. A repository upstream cannot answer
 * for is read from the cache and named in `notChecked`.
 *
 * @param service - The subscription service for this project.
 * @param options - Whether to read upstream.
 */
export async function readTrustedIndexes(
  service: SubscriptionService,
  options: TrustedIndexesOptions = {}
): Promise<TrustedIndexes> {
  if (options.latest !== true) return cachedTrustedIndexes(service);

  const trusted = service.currentRepos();
  const names = Object.keys(trusted).sort();
  const answers = await Promise.allSettled(names.map((name) => service.upstreamIndex(name)));

  const result: TrustedIndexes = { repos: [], notFetched: [], notChecked: [] };
  names.forEach((name, position) => {
    const url = trusted[name]?.url;
    const answer = answers[position]!;
    if (answer.status === "fulfilled") {
      result.repos.push({
        name,
        ...(url === undefined ? {} : { url }),
        index: answer.value,
        source: "upstream",
      });
      return;
    }

    // Upstream could not answer, so the cached copy stands in and says so. A
    // repository with no cached copy either is named once, as never fetched.
    const cached = service.cachedIndex(name);
    if (cached === undefined) {
      result.notFetched.push(name);
      return;
    }
    result.notChecked.push(name);
    result.repos.push({ name, ...(url === undefined ? {} : { url }), index: cached, source: "cache" });
  });
  return result;
}

/** The catalog's inputs, plus what could not be read. */
export type CatalogContext = {
  /** What the catalog functions read. */
  inputs: CatalogInputs;
  /**
   * Trusted repositories whose index has never been fetched, so nothing in them
   * could be listed. Sorted.
   */
  notFetched: string[];
  /**
   * Repositories the latest was asked for that could not be reached, listed
   * from the cache instead. Sorted.
   */
  notChecked: string[];
};

/**
 * Builds the catalog's inputs for one project: every trusted repository whose
 * index sous already has, the lockfile, and the subscription keys the project
 * declares.
 *
 * @param options - The subscription service, the project's directory and config.
 */
export function catalogContextFor(options: CatalogInputsOptions): CatalogContext {
  const { service } = options;
  const env = options.env ?? process.env;
  const indexes = options.indexes ?? cachedTrustedIndexes(service);

  const repos: CatalogRepo[] = indexes.repos.map((entry) => ({
    name: entry.name,
    ...(entry.url === undefined ? {} : { url: entry.url }),
    index: entry.index,
  }));

  const links = readEffectiveLinks(options.sousDir, env);
  const linked: Record<string, string> = {};
  for (const [name, link] of Object.entries(links)) linked[name] = link.path;

  const inputs: CatalogInputs = {
    repos,
    lock: service.lockService.read(),
    subscriptions: Object.keys(service.allSubscriptions()).sort(),
    linked,
    readManifest: (recipe) => {
      const directory = recipeFilesDirectory({
        service,
        sousDir: options.sousDir,
        env,
        repo: recipe.repo,
        key: recipe.key,
        namespace: recipe.namespace,
        name: recipe.name,
        version: recipe.version,
      });
      return directory === undefined ? undefined : readRecipeManifestIn(directory);
    },
    destinationsFor: (kind) => {
      // Config layers are loaded, not written into the project, so they land
      // nowhere a listing could name.
      if (!isWritableKind(kind)) return [];
      return destinationsFor(kind, {
        sousDir: options.sousDir,
        settings: options.settings,
        ...(options.scope === undefined ? {} : { scope: options.scope }),
        env,
      });
    },
  };

  return { inputs, notFetched: indexes.notFetched, notChecked: indexes.notChecked };
}

/**
 * The catalog's inputs, reading the indexes the way the options say: from the
 * cache, or with `latest` from upstream without writing to the cache.
 *
 * @param options - The subscription service, the project's directory and config,
 *   and whether to read upstream.
 */
export async function loadCatalogContext(
  options: Omit<CatalogInputsOptions, "indexes"> & TrustedIndexesOptions
): Promise<CatalogContext> {
  const indexes = await readTrustedIndexes(options.service, {
    ...(options.latest === undefined ? {} : { latest: options.latest }),
  });
  return catalogContextFor({ ...options, indexes });
}

/**
 * Every trusted repository's cached index, read synchronously.
 *
 * @param service - The subscription service for this project.
 */
function cachedTrustedIndexes(service: SubscriptionService): TrustedIndexes {
  const trusted = service.currentRepos();
  const result: TrustedIndexes = { repos: [], notFetched: [], notChecked: [] };
  for (const name of Object.keys(trusted).sort()) {
    const index = service.cachedIndex(name);
    if (index === undefined) {
      result.notFetched.push(name);
      continue;
    }
    const url = trusted[name]?.url;
    result.repos.push({ name, ...(url === undefined ? {} : { url }), index, source: "cache" });
  }
  return result;
}

/** Which recipe, at which version, in which of this project's repositories. */
export type RecipeFilesQuery = {
  /** The subscription service, which knows the store and the repository identities. */
  service: SubscriptionService;
  /** The project's `.sous/` directory, which holds the links map. */
  sousDir: string;
  /** The environment to read; decides where the store is. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** The short name of the repository publishing it. */
  repo: string;
  /** The recipe key, `namespace/recipe`. */
  key: string;
  namespace: string;
  name: string;
  /** The exact version wanted. */
  version: string;
};

/**
 * The directory one published recipe's files are read from: a linked working
 * copy when the repository is linked, and the store entry for that exact
 * version otherwise. Undefined when neither is on this machine.
 *
 * Nothing is fetched, and the directory is not checked for existence: the
 * caller reads what is there, and an absent manifest is an ordinary answer.
 *
 * @param input - The recipe's identity, and where this project keeps its state.
 */
export function recipeFilesDirectory(input: RecipeFilesQuery): string | undefined {
  const checkout = linkedPathFor(input.repo, input.sousDir, input.env ?? process.env);
  if (checkout !== undefined) {
    const linked = mapLinkedRecipes(checkout)[input.key];
    if (linked !== undefined) return linked;
  }

  const identity = input.service.identityForRepo(input.repo);
  if (identity === undefined) return undefined;

  return input.service.store.entryDir({
    identity,
    namespace: input.namespace,
    name: input.name,
    version: input.version,
  });
}

/** True when a content kind's files are written into the project. */
function isWritableKind(kind: string): kind is WritableContentKind {
  return (WRITABLE_CONTENT_KINDS as readonly string[]).includes(kind);
}
