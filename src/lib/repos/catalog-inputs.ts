/**
 * Wiring the catalog to a running command.
 *
 * `catalog.ts` is pure: it reads indexes, a lockfile and a list of subscription
 * keys. This module is where those come from in a real project, and it is
 * deliberately the only place that knows: the subscription service for the
 * trusted repositories and their cached indexes, the lockfile service for what
 * is pinned, the links map and the store for a recipe's own files, and
 * `recipeOutputs` for where a content kind lands.
 *
 * Nothing here downloads anything. A repository whose index has never been
 * fetched is left out of the catalog and named separately, so a browsing command
 * is safe offline.
 */

import type { Settings, VarScope } from "../settings.js";
import type { SubscriptionService } from "./subscription-service.js";
import type { CatalogInputs, CatalogRepo } from "./catalog.js";
import { linkedPathFor } from "./links.js";
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
};

/** The catalog's inputs, plus what could not be read. */
export type CatalogContext = {
  /** What the catalog functions read. */
  inputs: CatalogInputs;
  /**
   * Trusted repositories whose index has never been fetched, so nothing in them
   * could be listed. Sorted.
   */
  notFetched: string[];
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

  const repos: CatalogRepo[] = [];
  const notFetched: string[] = [];

  const trusted = service.currentRepos();
  for (const name of Object.keys(trusted).sort()) {
    const index = service.cachedIndex(name);
    if (index === undefined) {
      notFetched.push(name);
      continue;
    }
    const url = trusted[name]?.url;
    repos.push({ name, ...(url === undefined ? {} : { url }), index });
  }

  const inputs: CatalogInputs = {
    repos,
    lock: service.lockService.read(),
    subscriptions: Object.keys(service.allSubscriptions()).sort(),
    readManifest: (recipe) => {
      const directory = recipeDirectory({
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

  return { inputs, notFetched };
}

/**
 * The directory one published recipe's files are read from: a linked working
 * copy when the repository is linked, and the store entry for that exact
 * version otherwise. Undefined when neither is on this machine.
 *
 * @param input - The recipe's identity, and where this project keeps its state.
 */
function recipeDirectory(input: {
  service: SubscriptionService;
  sousDir: string;
  env: NodeJS.ProcessEnv;
  repo: string;
  key: string;
  namespace: string;
  name: string;
  version: string;
}): string | undefined {
  const checkout = linkedPathFor(input.repo, input.sousDir, input.env);
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
