/**
 * Browsing what a project trusts.
 *
 * Every trusted repository publishes an index, and the project's lockfile
 * records what it currently pins. Put those two together and a project can be
 * asked four questions without downloading anything: which namespaces exist,
 * what is in one of them, which recipes exist, and everything about one recipe.
 * This module answers all four.
 *
 * Everything here is a pure function over data the caller hands it: the cached
 * indexes, the lockfile, and the subscription keys the project declares. A
 * recipe's own manifest (its variables, its declared dependencies and the
 * content it contributes) lives inside the recipe's files rather than in the
 * index, so the caller supplies a reader for it; a recipe whose files are not on
 * this machine is described from its index alone rather than being an error.
 *
 * Refs resolve the way `sous subscribe` resolves them: `namespace`,
 * `namespace/recipe`, and either of those qualified with `repo:`. A one-word ref
 * is searched across every trusted repository, and a word that means more than
 * one thing is an error listing what it could have meant.
 */

import semver from "semver";
import { ConfigError } from "../errors.js";
import type { IndexDependency, IndexFile } from "./formats/index-file.js";
import type { Lockfile } from "./formats/lockfile.js";
import type {
  ContentKind,
  RecipeManifest,
  VariableDefinition,
} from "./formats/recipe-manifest.js";
import { dependencyRefKey, parseDependencyRef, parseRef, type ParsedRef } from "./ref.js";
import { bareName } from "../vars/names.js";
import {
  describeReference,
  findNamespace,
  findRecipe,
  referenceReposFromIndexes,
  type ReferenceContext,
  type ReferenceMatch,
} from "../refs/index.js";

// --- What the catalog reads ---------------------------------------------------------------------

/** One trusted repository whose index has been fetched. */
export type CatalogRepo = {
  /** The short name this project calls it. */
  name: string;
  /** Where it lives, as the project's config records it. */
  url?: string;
  /** Its cached index. */
  index: IndexFile;
};

/** Where one published recipe's files would be read from. */
export type RecipeLocation = {
  /** The recipe key, `namespace/recipe`. */
  key: string;
  namespace: string;
  name: string;
  /** The short name of the repository publishing it. */
  repo: string;
  /** The version being described. */
  version: string;
  /** The recipe folder, relative to the repository root. */
  path: string;
};

/** Everything the catalog functions read. */
export type CatalogInputs = {
  /**
   * The trusted repositories with a readable index, in the order a one-word ref
   * searches them: the built-in repository first, then the ones the config
   * names, in config order.
   */
  repos: CatalogRepo[];
  /** The project's lockfile, which is where a pinned version comes from. */
  lock: Lockfile;
  /** The ref keys the project subscribes to: namespaces, and `namespace/recipe`. */
  subscriptions: string[];
  /**
   * Reads one published recipe's manifest, when its files are on this machine.
   * Returning undefined means "not available", and the recipe is described from
   * its index alone.
   */
  readManifest?: (recipe: RecipeLocation) => RecipeManifest | undefined;
  /** Where one content kind's files land in this project, when anywhere does. */
  destinationsFor?: (kind: ContentKind) => string[];
};

// --- What the catalog answers -------------------------------------------------------------------

/** How much of a namespace a project subscribes to. */
export type NamespaceCoverage = "whole namespace" | "some recipes" | "none";

/** One namespace, as the listing shows it. */
export type NamespaceListing = {
  /** The short name of the repository publishing it. */
  repo: string;
  /** The namespace name. */
  namespace: string;
  /** The namespace's one-paragraph summary, when its index carries one. */
  description?: string;
  /** How many recipes the repository publishes in it. */
  recipeCount: number;
  /** How much of it this project subscribes to. */
  subscribed: NamespaceCoverage;
};

/** One recipe, as a listing shows it. */
export type RecipeListing = {
  /** The recipe key, `namespace/recipe`. */
  key: string;
  namespace: string;
  name: string;
  /** The short name of the repository publishing it. */
  repo: string;
  /** The highest published version, prereleases considered only when nothing else is published. */
  latest?: string;
  /** The version this project's lockfile pins, when it pins one. */
  pinned?: string;
  /** True when the project subscribes to this recipe, or to the whole namespace holding it. */
  subscribed: boolean;
  /** The recipe's one-paragraph summary, when its index carries one. */
  description?: string;
};

/** One namespace in full: the namespace itself, and every recipe in it. */
export type NamespaceDetail = {
  repo: string;
  /** Where the repository lives, as the project's config records it. */
  repoUrl?: string;
  namespace: string;
  description?: string;
  subscribed: NamespaceCoverage;
  /** Every recipe the repository publishes in the namespace, by key. */
  recipes: RecipeListing[];
};

/** What one published version is to this project. */
export type VersionStatus = "latest" | "pinned" | "latest and pinned" | "other";

/** One published version of one recipe. */
export type RecipeVersionListing = {
  /** The exact version. */
  version: string;
  /** What the version is to this project. */
  status: VersionStatus;
  /** True when the index marks it a prerelease. */
  prerelease: boolean;
  /** When it was released, when the index records it. */
  releasedAt?: string;
};

/** One dependency of the version being described. */
export type RecipeDependencyListing = {
  /** The recipe key the dependency names, `namespace/recipe`. */
  key: string;
  /** The dependency exactly as the recipe's manifest wrote it, when it could be read. */
  declared?: string;
  /** Whether the manifest declared it a build dependency or a co-subscription. */
  kind?: "depends" | "subscribes";
  /** The exact version the release resolved it to, when the index records one. */
  resolvedVersion?: string;
  /** The range the index recorded instead, when it could not resolve an exact version. */
  resolvedRange?: string;
  /** The canonical identity of the repository publishing it, for a cross-repository dependency. */
  repo?: string;
};

/** One variable a recipe asks about. */
export type RecipeVariableListing = {
  /** The variable's name, as the manifest declares it. */
  name: string;
  /** The type of answer it takes. */
  type: string;
  /** The environment variable an answer is stored under. */
  env: string;
  /** True when an answer is required before the recipe is usable. */
  required: boolean;
  /** True when the answer is a secret, which sous never prints. */
  secret: boolean;
  /** The one-line question it asks. */
  prompt: string;
};

/** One content kind a recipe contributes, and where its files would land. */
export type RecipeContentListing = {
  /** The content kind, as the manifest declares it. */
  kind: ContentKind;
  /** The glob patterns the manifest includes. */
  include: string[];
  /** Every directory in this project the files would be written into. */
  destinations: string[];
};

/** One recipe in full. */
export type RecipeDetail = {
  /** The recipe key, `namespace/recipe`. */
  key: string;
  namespace: string;
  name: string;
  /** The short name of the repository publishing it. */
  repo: string;
  /** Where that repository lives, as the project's config records it. */
  repoUrl?: string;
  /** The recipe's one-paragraph summary, when its index carries one. */
  description?: string;
  /** The recipe folder, relative to the repository root. */
  path: string;
  /** The highest published version. */
  latest?: string;
  /** The version this project's lockfile pins, when it pins one. */
  pinned?: string;
  /** True when the project subscribes to this recipe, or to the whole namespace holding it. */
  subscribed: boolean;
  /**
   * The version everything else here describes: the pinned one when the project
   * pins one, and the latest published one otherwise.
   */
  describing?: string;
  /** Every published version, newest first. */
  versions: RecipeVersionListing[];
  /** What the described version depends on, by key. */
  dependencies: RecipeDependencyListing[];
  /** The variables the recipe declares, in manifest order. */
  variables: RecipeVariableListing[];
  /** What the recipe contributes, and where each kind's files land. */
  contents: RecipeContentListing[];
  /**
   * True when the recipe's own manifest could be read. When it is false, the
   * variables, the declared dependencies and the contents are unknown rather
   * than empty, because the recipe's files are not on this machine.
   */
  manifestRead: boolean;
};

// --- Listings -----------------------------------------------------------------------------------

/**
 * Every namespace every trusted repository publishes, sorted by namespace and
 * then by repository, so two repositories publishing the same namespace name sit
 * beside each other.
 *
 * @param inputs - The cached indexes, the lockfile and the project's subscriptions.
 */
export function listNamespaces(inputs: CatalogInputs): NamespaceListing[] {
  const subscriptions = new Set(inputs.subscriptions);
  const listings: NamespaceListing[] = [];

  for (const repo of inputs.repos) {
    for (const [namespace, declared] of Object.entries(repo.index.namespaces)) {
      listings.push({
        repo: repo.name,
        namespace,
        ...(declared.description === undefined ? {} : { description: declared.description }),
        recipeCount: recipeKeysIn(repo.index, namespace).length,
        subscribed: coverageOf(namespace, repo.index, subscriptions),
      });
    }
  }

  return listings.sort(byNamespaceThenRepo);
}

/**
 * Every recipe every trusted repository publishes, sorted by key and then by
 * repository.
 *
 * @param inputs - The cached indexes, the lockfile and the project's subscriptions.
 */
export function listRecipes(inputs: CatalogInputs): RecipeListing[] {
  const subscriptions = new Set(inputs.subscriptions);
  const listings: RecipeListing[] = [];

  for (const repo of inputs.repos) {
    for (const key of Object.keys(repo.index.recipes)) {
      listings.push(recipeListing(key, repo, inputs.lock, subscriptions));
    }
  }

  return listings.sort((left, right) =>
    left.key === right.key
      ? compare(left.repo, right.repo)
      : compare(left.key, right.key)
  );
}

/**
 * One namespace in full: what the repository says about it, and every recipe it
 * publishes in it.
 *
 * @param inputs - The cached indexes, the lockfile and the project's subscriptions.
 * @param ref - The namespace, optionally qualified with `repo:`.
 */
export function describeNamespace(inputs: CatalogInputs, ref: string): NamespaceDetail {
  const found = resolveNamespaceRef(inputs, ref);
  const subscriptions = new Set(inputs.subscriptions);
  const declared = found.repo.index.namespaces[found.namespace]!;

  return {
    repo: found.repo.name,
    ...(found.repo.url === undefined ? {} : { repoUrl: found.repo.url }),
    namespace: found.namespace,
    ...(declared.description === undefined ? {} : { description: declared.description }),
    subscribed: coverageOf(found.namespace, found.repo.index, subscriptions),
    recipes: recipeKeysIn(found.repo.index, found.namespace).map((key) =>
      recipeListing(key, found.repo, inputs.lock, subscriptions)
    ),
  };
}

/**
 * One recipe in full: its identity, every version it publishes, what it depends
 * on, what it asks about, and where its files would land in this project.
 *
 * @param inputs - The cached indexes, the lockfile, the subscriptions and the manifest reader.
 * @param ref - The recipe, as `namespace/recipe`, a bare recipe name, or either qualified with `repo:`.
 */
export function describeRecipe(inputs: CatalogInputs, ref: string): RecipeDetail {
  const found = resolveRecipeRef(inputs, ref);
  const subscriptions = new Set(inputs.subscriptions);
  const listing = recipeListing(found.key, found.repo, inputs.lock, subscriptions);
  const entry = found.repo.index.recipes[found.key]!;

  const describing = listing.pinned ?? listing.latest;
  const published = entry.versions[describing ?? ""];

  const manifest =
    describing === undefined || inputs.readManifest === undefined
      ? undefined
      : inputs.readManifest({
          key: found.key,
          namespace: found.namespace,
          name: found.name,
          repo: found.repo.name,
          version: describing,
          path: entry.path,
        });

  return {
    ...listing,
    ...(found.repo.url === undefined ? {} : { repoUrl: found.repo.url }),
    path: entry.path,
    ...(describing === undefined ? {} : { describing }),
    versions: versionListings(entry.versions, listing.latest, listing.pinned),
    dependencies: dependencyListings(published?.dependencies, manifest),
    variables: (manifest?.variables ?? []).map(variableListing),
    contents: (manifest?.contents ?? []).map((content) => ({
      kind: content.kind,
      include: [...content.include],
      destinations: inputs.destinationsFor?.(content.kind) ?? [],
    })),
    manifestRead: manifest !== undefined,
  };
}

// --- Resolving a ref ----------------------------------------------------------------------------

/** One namespace a ref resolved to. */
export type ResolvedNamespace = {
  /** The repository publishing it. */
  repo: CatalogRepo;
  /** The namespace name. */
  namespace: string;
};

/** One recipe a ref resolved to. */
export type ResolvedRecipeRef = {
  /** The repository publishing it. */
  repo: CatalogRepo;
  /** The recipe key, `namespace/recipe`. */
  key: string;
  namespace: string;
  name: string;
};

/**
 * The namespace a ref names. A one-word ref is searched across every trusted
 * repository; a word that names a namespace in two of them is an error listing
 * both.
 *
 * @param inputs - The cached indexes.
 * @param ref - The namespace, optionally qualified with `repo:`.
 */
export function resolveNamespaceRef(inputs: CatalogInputs, ref: string): ResolvedNamespace {
  const parsed = parseRef(ref);

  if (parsed.recipe !== undefined) {
    throw new ConfigError(
      `'${ref}' names the recipe '${parsed.recipe}', not a namespace.\n` +
        `  The namespace it belongs to is '${parsed.namespace}'.`
    );
  }

  const matches = findNamespace(refSearchString(parsed), referenceContext(inputs));

  if (matches.length === 1) {
    return { repo: repoNamed(inputs, matches[0]!.repo!), namespace: matches[0]!.namespace! };
  }

  if (matches.length > 1) throw ambiguousError(ref, "namespace", matches);

  const asRecipe = findRecipe(refSearchString(parsed), referenceContext(inputs));
  if (parsed.repo === undefined && asRecipe.length > 0) {
    throw new ConfigError(
      `No repository this project trusts publishes a namespace called ` +
        `'${parsed.namespace}'.\n` +
        `  It is the name of a recipe:\n` +
        asRecipe.map((candidate) => `    ${describeReference(candidate)}`).join("\n")
    );
  }

  throw unknownError(inputs, ref, "namespace", parsed.repo);
}

/**
 * The recipe a ref names. A two-segment ref names it exactly; a one-word ref is
 * searched as a recipe name across every trusted repository, and a name two of
 * them publish is an error listing both.
 *
 * @param inputs - The cached indexes.
 * @param ref - The recipe, as `namespace/recipe`, a bare recipe name, or either qualified with `repo:`.
 */
export function resolveRecipeRef(inputs: CatalogInputs, ref: string): ResolvedRecipeRef {
  const parsed = parseRef(ref);
  const search = refSearchString(parsed);
  const context = referenceContext(inputs);

  const matches = findRecipe(search, context);

  if (matches.length === 1) {
    const match = matches[0]!;
    return {
      repo: repoNamed(inputs, match.repo!),
      key: `${match.namespace}/${match.recipe}`,
      namespace: match.namespace!,
      name: match.recipe!,
    };
  }

  if (matches.length > 1) throw ambiguousError(ref, "recipe", matches);

  const asNamespace = findNamespace(search, context);
  if (asNamespace.length > 0) {
    throw new ConfigError(
      `No repository this project trusts publishes a recipe called ` +
        `'${parsed.namespace}'.\n` +
        `  It is the name of a namespace:\n` +
        asNamespace.map((candidate) => `    ${describeReference(candidate)}`).join("\n")
    );
  }

  throw unknownError(inputs, ref, "recipe", parsed.repo);
}

// --- The pieces ---------------------------------------------------------------------------------

/** Every recipe key one index publishes in one namespace, sorted. */
function recipeKeysIn(index: IndexFile, namespace: string): string[] {
  return Object.keys(index.recipes)
    .filter((key) => key.slice(0, key.indexOf("/")) === namespace)
    .sort();
}

/**
 * How much of one namespace a project subscribes to: the whole namespace when it
 * subscribes to the namespace itself, some recipes when it subscribes to at
 * least one recipe in it, and none otherwise.
 *
 * @param namespace - The namespace name.
 * @param index - The index publishing it.
 * @param subscriptions - The ref keys the project subscribes to.
 */
function coverageOf(
  namespace: string,
  index: IndexFile,
  subscriptions: Set<string>
): NamespaceCoverage {
  if (subscriptions.has(namespace)) return "whole namespace";
  const some = recipeKeysIn(index, namespace).some((key) => subscriptions.has(key));
  return some ? "some recipes" : "none";
}

/**
 * One recipe's listing row: what the index publishes, what the lockfile pins,
 * and whether the project subscribes to it.
 *
 * @param key - The recipe key.
 * @param repo - The repository publishing it.
 * @param lock - The project's lockfile.
 * @param subscriptions - The ref keys the project subscribes to.
 */
function recipeListing(
  key: string,
  repo: CatalogRepo,
  lock: Lockfile,
  subscriptions: Set<string>
): RecipeListing {
  const entry = repo.index.recipes[key]!;
  const namespace = key.slice(0, key.indexOf("/"));
  const name = key.slice(namespace.length + 1);
  const latest = latestVersion(Object.keys(entry.versions), entry.versions);

  // A locked entry pins one recipe from one repository. Two repositories can
  // publish the same key, so the row only claims the pin when the lockfile says
  // the recipe came from this repository.
  const locked = lock.recipes[key];
  const pinned = locked !== undefined && locked.repo === repo.name ? locked.version : undefined;

  return {
    key,
    namespace,
    name,
    repo: repo.name,
    ...(latest === undefined ? {} : { latest }),
    ...(pinned === undefined ? {} : { pinned }),
    subscribed: subscriptions.has(key) || subscriptions.has(namespace),
    ...(entry.description === undefined ? {} : { description: entry.description }),
  };
}

/**
 * The highest published version. Prereleases are considered only when a recipe
 * has published nothing else, so a repository mid-prerelease still reports a
 * latest version rather than none.
 *
 * @param versions - Every published version string.
 * @param published - The index entries those versions carry.
 */
function latestVersion(
  versions: string[],
  published: Record<string, { prerelease: boolean }>
): string | undefined {
  const stable = versions.filter((version) => published[version]?.prerelease !== true);
  const pool = stable.length > 0 ? stable : versions;
  return semver.maxSatisfying(pool, "*", { includePrerelease: true }) ?? undefined;
}

/**
 * Every published version, newest first, each labeled with what it is to this
 * project.
 *
 * @param versions - The index's version entries.
 * @param latest - The highest published version.
 * @param pinned - The version the lockfile pins, when it pins one.
 */
function versionListings(
  versions: Record<string, { prerelease: boolean; releasedAt?: string }>,
  latest: string | undefined,
  pinned: string | undefined
): RecipeVersionListing[] {
  return Object.keys(versions)
    .sort((left, right) => semver.rcompare(left, right, { loose: true }))
    .map((version) => {
      const entry = versions[version]!;
      const isLatest = version === latest;
      const isPinned = version === pinned;
      const status: VersionStatus =
        isLatest && isPinned
          ? "latest and pinned"
          : isLatest
            ? "latest"
            : isPinned
              ? "pinned"
              : "other";
      return {
        version,
        status,
        prerelease: entry.prerelease,
        ...(entry.releasedAt === undefined ? {} : { releasedAt: entry.releasedAt }),
      };
    });
}

/**
 * What one version depends on, from both sides: the dependencies the recipe's
 * manifest declares, and the versions the release resolved them to in the
 * index. A dependency that appears on only one side is still a row, because the
 * two disagreeing is exactly what somebody reading this needs to see.
 *
 * @param resolved - The index's record of what the version was released against.
 * @param manifest - The recipe's manifest, when its files could be read.
 */
function dependencyListings(
  resolved: Record<string, IndexDependency> | undefined,
  manifest: RecipeManifest | undefined
): RecipeDependencyListing[] {
  const rows = new Map<string, RecipeDependencyListing>();

  for (const [key, entry] of Object.entries(resolved ?? {})) {
    rows.set(key, {
      key,
      ...(entry.version === undefined ? {} : { resolvedVersion: entry.version }),
      ...(entry.range === undefined ? {} : { resolvedRange: entry.range }),
      ...(entry.repo === undefined ? {} : { repo: entry.repo }),
    });
  }

  for (const [kind, declared] of [
    ["depends", manifest?.depends ?? []],
    ["subscribes", manifest?.subscribes ?? []],
  ] as Array<["depends" | "subscribes", string[]]>) {
    for (const written of declared) {
      let key: string;
      try {
        key = dependencyRefKey(parseDependencyRef(written));
      } catch {
        // A manifest sous cannot parse is still worth showing; it is listed
        // under what it was written as, so the reader sees the bad entry.
        key = written;
      }
      rows.set(key, { ...(rows.get(key) ?? { key }), declared: written, kind });
    }
  }

  return [...rows.values()].sort((left, right) => compare(left.key, right.key));
}

/**
 * One variable row: what it is called, what kind of answer it takes, and the
 * environment variable an answer is stored under.
 *
 * @param definition - The variable definition from the recipe's manifest.
 */
function variableListing(definition: VariableDefinition): RecipeVariableListing {
  return {
    name: definition.name,
    type: definition.type,
    // The manifest may bind an existing environment variable; otherwise the
    // answer is stored under the name sous derives from the variable's own.
    env: bareName(definition),
    required: definition.required,
    secret: definition.secret,
    prompt: definition.prompt,
  };
}

/**
 * The repository a match named. Every match comes from this catalog's own
 * repositories, so the lookup always finds one.
 *
 * @param inputs - The cached indexes.
 * @param name - The repository's short name.
 */
function repoNamed(inputs: CatalogInputs, name: string): CatalogRepo {
  return inputs.repos.find((repo) => repo.name === name)!;
}

/** This catalog's repositories, in the shape a reference searches. */
function referenceContext(inputs: CatalogInputs): ReferenceContext {
  return {
    repos: referenceReposFromIndexes(
      inputs.repos.map((repo) => repo.name),
      new Map(inputs.repos.map((repo) => [repo.name, repo.index])),
      Object.fromEntries(inputs.repos.map((repo) => [repo.name, repo.url]))
    ),
  };
}

/**
 * A parsed ref written back out as a reference, without its version range: the
 * range says which version to use, never which thing is meant.
 *
 * @param parsed - The parsed ref.
 */
function refSearchString(parsed: ParsedRef): string {
  const path = parsed.recipe === undefined ? parsed.namespace : `${parsed.namespace}/${parsed.recipe}`;
  return parsed.repo === undefined ? path : `${parsed.repo}:${path}`;
}

/** The error a ref that could have meant several things raises. */
function ambiguousError(
  ref: string,
  what: "namespace" | "recipe",
  candidates: ReferenceMatch[]
): ConfigError {
  return new ConfigError(
    `'${ref}' names a ${what} in more than one repository this project trusts:\n` +
      candidates.map((candidate) => `    ${describeReference(candidate)}`).join("\n") +
      `\n  Name the repository as well, as 'repository:${ref}', to say which one you mean.`
  );
}

/** The error a ref that matched nothing raises, naming what was searched. */
function unknownError(
  inputs: CatalogInputs,
  ref: string,
  what: "namespace" | "recipe",
  qualifier: string | undefined
): ConfigError {
  if (qualifier !== undefined && !inputs.repos.some((repo) => repo.name === qualifier)) {
    return new ConfigError(
      `This project trusts no repository called '${qualifier}', so '${ref}' could not ` +
        `be looked up.\n` +
        `  Repositories with an index sous has read: ${describeRepos(inputs)}.`
    );
  }

  return new ConfigError(
    `No repository this project trusts publishes a ${what} called '${ref}'.\n` +
      `  Repositories with an index sous has read: ${describeRepos(inputs)}.`
  );
}

/** The repositories that were searched, in plain language. */
function describeRepos(inputs: CatalogInputs): string {
  if (inputs.repos.length === 0) return "none";
  return inputs.repos.map((repo) => repo.name).join(", ");
}

/** Sorts namespace listings by namespace, then by repository. */
function byNamespaceThenRepo(left: NamespaceListing, right: NamespaceListing): number {
  return left.namespace === right.namespace
    ? compare(left.repo, right.repo)
    : compare(left.namespace, right.namespace);
}

/** Bytewise string ordering, so a listing sorts the same on every machine. */
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
