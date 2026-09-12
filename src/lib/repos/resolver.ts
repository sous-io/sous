/**
 * The resolver.
 *
 * Given what a project asked for (its subscriptions, or the refs named on a
 * command line), the resolver decides exactly which recipe versions that means.
 * It works the way apt does: a ref is looked up across the cached indexes of
 * EVERY added repository at once, and a ref that genuinely exists in more than
 * one of them is an error demanding the qualified form, never a silent
 * first-match-wins.
 *
 * It then walks the dependency closure. Each resolved recipe's manifest names
 * more refs, through `depends` (fetched and addressable, but not added to the
 * project) and `subscribes` (co-subscribed with full semantics), and those refs
 * resolve the same way. The manifest lives inside the recipe's own files, so
 * the caller supplies a loader; that is also the seam where a caller decides
 * whether it is willing to fetch anything at this point.
 *
 * Two things the resolver deliberately does NOT do: it never downloads
 * anything, and it never resolves against a repository the project has not
 * added. A dependency on an unknown repository comes back as a `MissingRepo`
 * carrying its provenance, so the trust layer can ask about it by name.
 */

import semver from "semver";
import { ConfigError } from "../errors.js";
import type { IndexFile } from "./formats/index-file.js";
import type { LockKind } from "./formats/lockfile.js";
import type { RecipeManifest } from "./formats/recipe-manifest.js";
import {
  dependencyRefKey,
  dependencyRepoUrl,
  formatRef,
  parseDependencyRef,
  refKey,
  type DependencyRef,
  type ParsedRef,
} from "./ref.js";
import { shortNameFromIdentity } from "./identity.js";
import type { IndexDependency } from "./formats/index-file.js";

/** The `requestedBy` holder meaning "the project asked for this directly". */
export const PROJECT_REQUESTER = "project";

/** One thing to resolve. */
export type RefRequest = {
  /** The ref, already parsed. */
  ref: ParsedRef;
  /** Whether prerelease versions may take part in range matching. */
  prerelease?: boolean;
  /**
   * Who asked: the literal "project" for a subscription the project holds
   * directly, or the recipe key of the recipe whose manifest asked.
   */
  requestedBy: string;
  /**
   * Whether this is a co-subscription or a build dependency. Defaults to
   * "subscribes", which is what a project's own subscriptions are.
   */
  kind?: LockKind;
};

/** What the resolver needs to know about a repository the project has added. */
export type ResolverRepo = {
  /** Where the repository lives. */
  url: string;
  /**
   * The repository's canonical identity, `<host>/<owner path>/<name>`. A
   * dependency that names another repository names it by location, so this is
   * what decides whether the project has already added it, whatever short name
   * the project gave it.
   */
  identity: string;
  /** The provider it names, when it names one. */
  provider?: string;
  /** Whether it prefers a newer in-range version over the locked one. */
  alwaysPull?: boolean;
};

/**
 * Loads a resolved recipe's manifest, which is what names its dependencies.
 * Returning undefined means "not available", and the recipe is reported under
 * `missingManifests` rather than having its dependencies walked.
 */
export type RecipeManifestLoader = (
  recipe: ResolvedRecipe
) => Promise<RecipeManifest | undefined> | RecipeManifest | undefined;

/** Everything the resolver reads. */
export type ResolveContext = {
  /** The cached index of every added repository, keyed by its short name. */
  indexes: Map<string, IndexFile>;
  /** The added repositories, keyed by short name; the trust list, in other words. */
  repos: Record<string, ResolverRepo>;
  /** How a resolved recipe's manifest is loaded. */
  loadManifest: RecipeManifestLoader;
  /** Whether prereleases are allowed when a request does not say. Defaults to false. */
  prerelease?: boolean;
};

/** One recipe version the resolver settled on. */
export type ResolvedRecipe = {
  /** The recipe key, `namespace/recipe`. */
  key: string;
  namespace: string;
  name: string;
  /** The short name of the repository it resolves in, as this project calls it. */
  repo: string;
  /** That repository's canonical identity, which the machine-wide store is keyed by. */
  identity: string;
  /** The exact version chosen. */
  version: string;
  /** The content hash the index publishes for that version. */
  hash: string;
  /** The git tag carrying that version. */
  tag: string;
  /** The recipe folder, relative to the repository root. */
  path: string;
  /** Whether anything holds it as a co-subscription; otherwise a build dependency. */
  kind: LockKind;
  /** Everyone holding it: "project", and the key of every recipe that asked. */
  requestedBy: string[];
  /** Every range that had to be satisfied at once, with who asked for it. */
  ranges: Array<{ range: string; requestedBy: string }>;
  /** Whether prereleases took part in the match. */
  prerelease: boolean;
  /**
   * What the repository's index says this exact version depends on, when the
   * index records it. These are the versions the release resolved, so a
   * dependency of an indexed recipe is installed at the version it was
   * published against rather than at whatever its range would reach today.
   */
  dependencies?: Record<string, IndexDependency>;
};

/** A repository something needs that the project has not added. */
export type MissingRepo = {
  /**
   * The short name to record it under: the one a ref qualified it with, or one
   * derived from its location when a dependency named it by URL.
   */
  name: string;
  /** Its URL, which a dependency's locator carries. */
  url?: string;
  /** Its canonical identity, when the dependency named a location. */
  identity?: string;
  /** The provider its locator named, when it named one. */
  provider?: string;
  /** Every ref that needs it, and who asked for that ref. */
  requiredBy: Array<{ ref: string; requestedBy: string }>;
};

/** What a resolution produced. */
export type ResolveResult = {
  /** Every recipe version to install, in a stable order (by key). */
  resolved: ResolvedRecipe[];
  /** Repositories a dependency needs that the project has not added. */
  missingRepos: MissingRepo[];
  /** Resolved recipes whose manifest the loader could not produce. */
  missingManifests: string[];
  /** Any dependency cycle found, as the chain of recipe keys forming it. */
  cycles: string[][];
};

/** A pending piece of work: one ref to resolve on behalf of one holder. */
type WorkItem = RefRequest & {
  kind: LockKind;
  /**
   * Where the ref said the recipe lives, when a manifest named another
   * repository by location. The project may already have added that repository
   * under any short name at all, so it is matched by identity.
   */
  remote?: {
    /** The repository's canonical identity. */
    identity: string;
    /** Its HTTPS location, which is what adding it would be handed. */
    url: string;
    /** The provider the locator named. */
    provider?: string;
    /** The dependency exactly as the manifest wrote it, for messages. */
    written: string;
  };
};

/**
 * Turns one entry of a manifest's `depends` or `subscribes` into a piece of
 * work.
 *
 * Two things are decided here. A SIBLING ref resolves inside the declaring
 * recipe's own repository, never across the others, because that is what
 * writing it without a location means. And when the repository's index records
 * what this exact version of the parent was released against, that exact
 * version is what gets asked for, rather than whatever the declared range would
 * reach today.
 *
 * @param written - The dependency as the manifest wrote it.
 * @param parent - The recipe whose manifest declared it.
 * @param kind - Whether it was declared as a dependency or a co-subscription.
 */
function dependencyRequest(
  written: string,
  parent: ResolvedRecipe,
  kind: LockKind
): WorkItem {
  const parsed = parseDependencyRef(written);
  const pinned = parent.dependencies?.[dependencyRefKey(parsed)];

  const ref: ParsedRef = { namespace: parsed.namespace };
  if (parsed.recipe !== undefined) {
    ref.recipe = parsed.recipe;
    const range = pinned?.version ?? parsed.range ?? pinned?.range;
    if (range !== undefined) ref.range = range;
  }

  const base = {
    requestedBy: parent.key,
    kind,
    ...(parent.prerelease ? { prerelease: true } : {}),
  };

  if (parsed.kind === "sibling") {
    return { ref: { ...ref, repo: parent.repo }, ...base };
  }

  return {
    ref,
    ...base,
    remote: {
      identity: pinned?.repo ?? parsed.canonicalRepo!,
      url: dependencyRepoUrl(parsed)!,
      ...(parsed.provider === undefined ? {} : { provider: parsed.provider }),
      written: written.trim(),
    },
  };
}

/**
 * The short name of the added repository with this identity, or undefined when
 * the project has added none. Short names are a project's own labels, so the
 * identity is what a dependency is matched on.
 *
 * @param repos - The repositories the project has added.
 * @param identity - The canonical identity to look for.
 */
function repoNamedByIdentity(
  repos: Record<string, ResolverRepo>,
  identity: string
): string | undefined {
  for (const [name, entry] of Object.entries(repos)) {
    if (entry.identity === identity) return name;
  }
  return undefined;
}

/**
 * A short name for a repository the project has not added yet, derived from its
 * location and made unique against the names already in use.
 *
 * @param repos - The repositories the project has added.
 * @param identity - The canonical identity of the repository being named.
 */
function proposeRepoName(
  repos: Record<string, ResolverRepo>,
  identity: string
): string {
  const base = shortNameFromIdentity(identity);
  if (!Object.hasOwn(repos, base)) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!Object.hasOwn(repos, candidate)) return candidate;
  }
}

/**
 * Resolves a set of refs and the whole dependency closure beneath them.
 *
 * @param requests - What the project (or the command line) asked for.
 * @param context - The cached indexes, the added repositories and a manifest loader.
 */
export async function resolveRefs(
  requests: RefRequest[],
  context: ResolveContext
): Promise<ResolveResult> {
  const resolved = new Map<string, ResolvedRecipe>();
  const missingRepos = new Map<string, MissingRepo>();
  const missingManifests = new Set<string>();
  const cycles: string[][] = [];
  /** Which recipe pulled each recipe in, used to find a cycle's chain. */
  const parents = new Map<string, string>();
  /** Recipes whose manifest has already been walked, at the version noted. */
  const walked = new Map<string, string>();

  const queue: WorkItem[] = requests.map((request) => ({
    ...request,
    kind: request.kind ?? "subscribes",
  }));

  while (queue.length > 0) {
    const item = queue.shift()!;

    // A ref naming a repository the project has not added never resolves and
    // never downloads anything; it comes back as a missing repository instead,
    // so the trust layer can ask about it by name.
    const qualifier = item.ref.repo;
    if (qualifier !== undefined && !Object.hasOwn(context.repos, qualifier)) {
      recordMissingRepo(missingRepos, {
        name: qualifier,
        requiredBy: [{ ref: formatRef(item.ref), requestedBy: item.requestedBy }],
      });
      continue;
    }

    // A dependency that named another repository by location is matched on that
    // location, so a project that already added it under some other short name
    // resolves against the copy it has. One it has not added carries its URL and
    // its provider, which is everything the trust round needs to offer to add it.
    if (item.remote !== undefined) {
      const added = repoNamedByIdentity(context.repos, item.remote.identity);
      if (added === undefined) {
        recordMissingRepo(missingRepos, {
          name: proposeRepoName(context.repos, item.remote.identity),
          url: item.remote.url,
          identity: item.remote.identity,
          ...(item.remote.provider === undefined ? {} : { provider: item.remote.provider }),
          requiredBy: [{ ref: item.remote.written, requestedBy: item.requestedBy }],
        });
        continue;
      }
      item.ref = { ...item.ref, repo: added };
    }

    if (item.ref.recipe === undefined) {
      queue.push(...expandNamespace(item, context));
      continue;
    }

    const recipe = resolveRecipeRef(item, context, resolved);
    resolved.set(recipe.key, recipe);

    if (item.requestedBy !== PROJECT_REQUESTER && !parents.has(recipe.key)) {
      parents.set(recipe.key, item.requestedBy);
    }

    // Walking a manifest is only worth doing once per version. A second holder
    // of an already-walked version adds itself and stops there; that is also
    // what keeps a dependency cycle finite.
    if (walked.get(recipe.key) === recipe.version) {
      const cycle = findCycle(recipe.key, item.requestedBy, parents);
      if (cycle !== undefined) cycles.push(cycle);
      continue;
    }
    walked.set(recipe.key, recipe.version);

    const manifest = await context.loadManifest(recipe);
    if (manifest === undefined) {
      missingManifests.add(recipe.key);
      continue;
    }

    for (const [kind, refs] of [
      ["depends", manifest.depends ?? []],
      ["subscribes", manifest.subscribes ?? []],
    ] as Array<[LockKind, string[]]>) {
      for (const written of refs) {
        queue.push(dependencyRequest(written, recipe, kind));
      }
    }
  }

  // A recipe whose version was narrowed by a later holder has had TWO of its
  // versions walked, and the dependencies discovered from the version that was
  // replaced are still sitting in `resolved`. Walk the closure once more over
  // the versions actually settled on, and keep only what that reaches.
  await keepOnlyReachable(resolved, context);

  const ordered = [...resolved.values()].sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0
  );
  for (const recipe of ordered) recipe.requestedBy.sort();

  return {
    resolved: ordered,
    missingRepos: [...missingRepos.values()].sort((left, right) =>
      left.name < right.name ? -1 : 1
    ),
    missingManifests: [...missingManifests].sort(),
    cycles,
  };
}

/**
 * Drops every resolved recipe the settled closure no longer reaches, and trims
 * the holders and ranges of the ones that stay.
 *
 * The walk resolves refs in the order it meets them, so a recipe can be walked
 * at one version and then walked again at a lower one once a second holder
 * narrows its range. The lower version is what the closure settles on, but the
 * dependencies discovered from the higher one are already in `resolved`, held by
 * a parent that no longer declares them. Installing those is wrong twice over:
 * they are content nothing asked for, and the lockfile would record a holder
 * that does not hold them.
 *
 * So the closure is walked once more over the versions actually settled on. This
 * re-reads manifests that have already been read, which the loader serves from
 * the store; nothing is fetched. A recipe the loader cannot produce a manifest
 * for keeps everything it reached, since the alternative is dropping a
 * dependency because a manifest was unreadable.
 *
 * Versions are NOT re-picked. Trimming can only remove constraints, so the
 * version already chosen still satisfies every holder that remains; re-picking
 * could raise it and undo the narrowing that made this pass necessary.
 *
 * @param resolved - What the walk produced, edited in place.
 * @param context - The manifest loader.
 */
async function keepOnlyReachable(
  resolved: Map<string, ResolvedRecipe>,
  context: ResolveContext
): Promise<void> {
  /** Who declares each key, and under which kind, in the settled closure. */
  const holders = new Map<string, Map<string, LockKind>>();

  /** Records one declaration, and reports whether the child is newly reached. */
  const declare = (parent: string, child: string, kind: LockKind): boolean => {
    const existing = holders.get(child);
    if (existing === undefined) {
      holders.set(child, new Map([[parent, kind]]));
      return true;
    }
    const previous = existing.get(parent);
    existing.set(parent, previous === "subscribes" || kind === "subscribes" ? "subscribes" : kind);
    return false;
  };

  const queue: string[] = [];
  for (const recipe of resolved.values()) {
    if (!recipe.requestedBy.includes(PROJECT_REQUESTER)) continue;
    if (declare(PROJECT_REQUESTER, recipe.key, "subscribes")) queue.push(recipe.key);
  }

  while (queue.length > 0) {
    const key = queue.shift()!;
    const recipe = resolved.get(key);
    if (recipe === undefined) continue;

    let manifest;
    try {
      manifest = await context.loadManifest(recipe);
    } catch {
      manifest = undefined;
    }

    if (manifest === undefined) {
      // An unreadable manifest is already reported as a missing manifest. Keep
      // everything this recipe held rather than dropping a dependency over it.
      for (const other of resolved.values()) {
        if (!other.requestedBy.includes(key)) continue;
        const kind = other.kind;
        if (declare(key, other.key, kind)) queue.push(other.key);
      }
      continue;
    }

    for (const [kind, refs] of [
      ["depends", manifest.depends ?? []],
      ["subscribes", manifest.subscribes ?? []],
    ] as Array<[LockKind, string[]]>) {
      for (const written of refs) {
        let parsed: DependencyRef;
        try {
          parsed = parseDependencyRef(written);
        } catch {
          continue;
        }
        // A namespace ref means every recipe in it, exactly as the walk expanded it.
        const targets =
          parsed.recipe === undefined
            ? [...resolved.keys()].filter((entry) =>
                entry.startsWith(`${parsed.namespace}/`)
              )
            : [dependencyRefKey(parsed)];
        for (const target of targets) {
          if (!resolved.has(target)) continue;
          if (declare(key, target, kind)) queue.push(target);
        }
      }
    }
  }

  for (const [key, recipe] of [...resolved]) {
    const reached = holders.get(key);
    if (reached === undefined) {
      resolved.delete(key);
      continue;
    }
    recipe.requestedBy = [...reached.keys()];
    recipe.ranges = recipe.ranges.filter((entry) => reached.has(entry.requestedBy));
    recipe.kind = [...reached.values()].includes("subscribes") ? "subscribes" : "depends";
  }
}

/** Records one more reason a repository is needed. */
function recordMissingRepo(into: Map<string, MissingRepo>, missing: MissingRepo): void {
  const existing = into.get(missing.name);
  if (existing === undefined) {
    into.set(missing.name, missing);
    return;
  }
  for (const entry of missing.requiredBy) {
    const duplicate = existing.requiredBy.some(
      (known) => known.ref === entry.ref && known.requestedBy === entry.requestedBy
    );
    if (!duplicate) existing.requiredBy.push(entry);
  }
}

/**
 * Expands a namespace ref into one request per recipe in that namespace. A
 * namespace subscription means "everything in here, including whatever is added
 * later", so the expansion happens fresh on every resolution.
 *
 * @param item - The namespace request.
 * @param context - The cached indexes and added repositories.
 */
function expandNamespace(item: WorkItem, context: ResolveContext): WorkItem[] {
  const { namespace } = item.ref;
  const qualifier = item.ref.repo;
  const expanded: WorkItem[] = [];
  const seen = new Set<string>();
  let namespaceFound = false;

  for (const [repoName, index] of context.indexes) {
    if (qualifier !== undefined && repoName !== qualifier) continue;
    if (!Object.hasOwn(index.namespaces, namespace)) continue;
    namespaceFound = true;

    for (const key of Object.keys(index.recipes)) {
      if (!key.startsWith(`${namespace}/`)) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      expanded.push({
        ref: {
          namespace,
          recipe: key.slice(namespace.length + 1),
          ...(qualifier === undefined ? {} : { repo: qualifier }),
          // A namespace ref cannot carry a range when it is WRITTEN, but a
          // namespace subscription entry can carry one, and a caller builds the
          // request from that entry. When it does, the range applies to every
          // recipe in the namespace; that is how the built-in `core`
          // subscription stays pinned to the running sous version.
          ...(item.ref.range === undefined ? {} : { range: item.ref.range }),
        },
        requestedBy: item.requestedBy,
        kind: item.kind,
        ...(item.prerelease === undefined ? {} : { prerelease: item.prerelease }),
      });
    }
  }

  if (!namespaceFound) throw unknownRefError(item, context, "namespace");

  return expanded;
}

/**
 * Resolves one recipe ref against every added repository, merging it with
 * anything already resolved for the same recipe key.
 *
 * @param item - The request being resolved.
 * @param context - The cached indexes and added repositories.
 * @param resolved - What is resolved so far, so ranges accumulate.
 */
function resolveRecipeRef(
  item: WorkItem,
  context: ResolveContext,
  resolved: Map<string, ResolvedRecipe>
): ResolvedRecipe {
  const key = refKey(item.ref);
  const qualifier = item.ref.repo;

  const candidates: Array<{ repo: string; index: IndexFile }> = [];
  for (const [repoName, index] of context.indexes) {
    if (qualifier !== undefined && repoName !== qualifier) continue;
    if (Object.hasOwn(index.recipes, key)) candidates.push({ repo: repoName, index });
  }

  if (candidates.length === 0) throw unknownRefError(item, context, "recipe");
  if (candidates.length > 1) throw ambiguousRefError(item, candidates.map((c) => c.repo));

  const chosen = candidates[0]!;
  const entry = chosen.index.recipes[key]!;
  const previous = resolved.get(key);

  if (previous !== undefined && previous.repo !== chosen.repo) {
    throw new ConfigError(
      `The recipe '${key}' is being taken from two different repositories at once: ` +
        `'${previous.repo}' and '${chosen.repo}'.\n` +
        `  Qualify the refs that ask for it, so each one says which repository it means.`
    );
  }

  const ranges = [...(previous?.ranges ?? [])];
  const range = item.ref.range ?? "*";
  if (!ranges.some((known) => known.range === range && known.requestedBy === item.requestedBy)) {
    ranges.push({ range, requestedBy: item.requestedBy });
  }

  const prerelease =
    (previous?.prerelease ?? false) ||
    (item.prerelease ?? context.prerelease ?? false);

  const version = pickVersion(key, entry, ranges, prerelease);
  const versionEntry = entry.versions[version]!;

  const requestedBy = [...(previous?.requestedBy ?? [])];
  if (!requestedBy.includes(item.requestedBy)) requestedBy.push(item.requestedBy);

  const namespace = key.slice(0, key.indexOf("/"));
  return {
    key,
    namespace,
    name: key.slice(namespace.length + 1),
    repo: chosen.repo,
    identity: context.repos[chosen.repo]?.identity ?? chosen.repo,
    version,
    hash: versionEntry.hash,
    tag: versionEntry.tag,
    path: entry.path,
    ...(versionEntry.dependencies === undefined
      ? {}
      : { dependencies: versionEntry.dependencies }),
    // A recipe held as a co-subscription by anyone is a co-subscription; a
    // build dependency only stays one while nothing subscribes to it.
    kind: previous?.kind === "subscribes" || item.kind === "subscribes" ? "subscribes" : "depends",
    requestedBy,
    ranges,
    prerelease,
  };
}

/**
 * Picks the highest published version satisfying every range at once.
 * Prereleases stay out of the match unless they were opted into.
 *
 * @param key - The recipe key, for error messages.
 * @param entry - The recipe's index entry.
 * @param ranges - Every range that has to hold, with who asked for it.
 * @param prerelease - Whether prereleases may match.
 */
function pickVersion(
  key: string,
  entry: IndexFile["recipes"][string],
  ranges: Array<{ range: string; requestedBy: string }>,
  prerelease: boolean
): string {
  const published = Object.keys(entry.versions);
  const eligible = prerelease
    ? published
    : published.filter((version) => entry.versions[version]!.prerelease !== true);

  let candidates = eligible;
  for (const { range } of ranges) {
    candidates = candidates.filter((version) =>
      semver.satisfies(version, range, { includePrerelease: prerelease })
    );
  }

  const best = semver.maxSatisfying(candidates, "*", { includePrerelease: prerelease });
  if (best !== null) return best;

  const asked = ranges
    .map(({ range, requestedBy }) => `    ${range} (required by ${requestedBy})`)
    .join("\n");
  const available = sortVersions(published).join(", ");
  const prereleaseNote = prerelease
    ? ""
    : "\n  Prerelease versions were not considered. A subscription may opt into them " +
      "with 'prerelease: true', and 'sous subscribe' with '--prerelease'.";

  throw new ConfigError(
    `No published version of '${key}' satisfies what was asked for.\n` +
      `  Version ${ranges.length === 1 ? "range" : "ranges"} asked for:\n${asked}\n` +
      `  Versions this repository publishes: ${available}.${prereleaseNote}`
  );
}

/** Sorts version strings newest first, leaving anything unparsable at the end. */
function sortVersions(versions: string[]): string[] {
  return [...versions].sort((left, right) => semver.rcompare(left, right, { loose: true }));
}

/**
 * Builds the error for a ref that no added repository publishes. It names the
 * repositories that were searched, because "not found" almost always means
 * "the repository publishing it has not been added yet".
 *
 * @param item - The request that could not be resolved.
 * @param context - The cached indexes and added repositories.
 * @param what - Whether a namespace or a recipe was being looked for.
 */
function unknownRefError(
  item: WorkItem,
  context: ResolveContext,
  what: "namespace" | "recipe"
): ConfigError {
  const written = item.remote?.written ?? formatRef(item.ref);
  const searched = [...context.indexes.keys()];
  const where =
    searched.length === 0
      ? "  This project has added no repositories yet."
      : `  Repositories searched: ${searched.join(", ")}.`;
  const asker =
    item.requestedBy === PROJECT_REQUESTER
      ? ""
      : `\n  It was required by the recipe '${item.requestedBy}'.`;

  // When the ref said WHICH repository, the useful answer is what that
  // repository does publish: a dependency that names something it has never
  // heard of is almost always a typo or a recipe that was renamed.
  const named = item.ref.repo;
  const index = named === undefined ? undefined : context.indexes.get(named);
  const publishes =
    index === undefined
      ? ""
      : `\n  The repository '${named}' publishes: ${
          Object.keys(index.recipes).length === 0
            ? "nothing yet"
            : Object.keys(index.recipes).sort().join(", ")
        }.`;

  return new ConfigError(
    `No added repository publishes the ${what} '${written}'.\n` +
      `${where}${asker}${publishes}\n` +
      `  Add the repository that publishes it with 'sous repo add <url>', then try again.`
  );
}

/**
 * Builds the error for a ref that resolves in more than one repository. Sous
 * never picks a winner; it shows the qualified form for each repository and
 * asks which one was meant.
 *
 * @param item - The ambiguous request.
 * @param repos - The repositories that publish it.
 */
function ambiguousRefError(item: WorkItem, repos: string[]): ConfigError {
  const key = refKey(item.ref);
  const range = item.ref.range === undefined ? "" : `@${item.ref.range}`;
  const qualified = repos.map((repo) => `    ${repo}:${key}${range}`).join("\n");
  const asker =
    item.requestedBy === PROJECT_REQUESTER
      ? ""
      : ` It was required by the recipe '${item.requestedBy}'.`;

  return new ConfigError(
    `The ref '${key}' is published by more than one added repository: ${repos.join(", ")}.` +
      `${asker}\n` +
      `  Say which repository you mean by qualifying the ref with its name:\n${qualified}`
  );
}

/**
 * Finds the chain of recipes leading from a recipe back to itself, or undefined
 * when there is none. A cycle is reported rather than treated as an error: the
 * closure is still finite, and two recipes that co-subscribe to each other are
 * unusual but not broken.
 *
 * @param key - The recipe reached a second time.
 * @param from - The recipe that reached it.
 * @param parents - Who pulled each recipe in.
 */
function findCycle(
  key: string,
  from: string,
  parents: Map<string, string>
): string[] | undefined {
  if (from === PROJECT_REQUESTER) return undefined;

  const chain = [key];
  let current: string | undefined = from;
  const guard = new Set<string>();
  while (current !== undefined && current !== PROJECT_REQUESTER) {
    chain.push(current);
    if (current === key) return chain.reverse();
    if (guard.has(current)) return undefined;
    guard.add(current);
    current = parents.get(current);
  }
  return undefined;
}
