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
import { formatRef, parseRef, refKey, type ParsedRef } from "./ref.js";

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
  /** The short name of the repository it resolves in. */
  repo: string;
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
};

/** A repository something needs that the project has not added. */
export type MissingRepo = {
  /** The repository's short name, as the ref qualified it. */
  name: string;
  /** Its URL, when anything knew it. Nothing in a manifest carries one today. */
  url?: string;
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
type WorkItem = RefRequest & { kind: LockKind };

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
        queue.push({
          ref: parseRef(written),
          requestedBy: recipe.key,
          kind,
          ...(recipe.prerelease ? { prerelease: true } : {}),
        });
      }
    }
  }

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
    version,
    hash: versionEntry.hash,
    tag: versionEntry.tag,
    path: entry.path,
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
  const written = formatRef(item.ref);
  const searched = [...context.indexes.keys()];
  const where =
    searched.length === 0
      ? "  This project has added no repositories yet."
      : `  Repositories searched: ${searched.join(", ")}.`;
  const asker =
    item.requestedBy === PROJECT_REQUESTER
      ? ""
      : `\n  It was required by the recipe '${item.requestedBy}'.`;

  return new ConfigError(
    `No added repository publishes the ${what} '${written}'.\n` +
      `${where}${asker}\n` +
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
