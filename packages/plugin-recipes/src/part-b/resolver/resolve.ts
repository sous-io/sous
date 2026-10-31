/**
 * Resolving recipe requests to versions, and walking the dependency closure.
 *
 * It works the way apt does: a ref is looked up across the cached indexes of every trusted
 * repository at once, and a ref that exists in more than one of them is an error asking for the
 * qualified form, never a silent first match. Each resolved recipe's `depends` and `subscribes`
 * resolve the same way; a sibling ref resolves inside the declaring recipe's own repository.
 *
 * It never downloads anything, and never resolves against a repository the project does not trust:
 * a dependency on one comes back as a {@link MissingRepo}, so trust can ask about it by name.
 */

import semver from "semver";
import { ConfigError } from "@sous-io/plugin-api";
import type { DependencyKind, IndexDependency, IndexFile, IndexVersion } from "@sous-io/plugin-formats/types";
import type { RefLocation, RepoRef, SousRef } from "@sous-io/plugin-refs/types";
import type { MissingRepo, ResolvedRecipe, ResolveResult } from "../../types.js";
import { PROJECT_HOLDER } from "../constants.js";
import { identitySegments, sortKeys, splitStoredKey } from "../support.js";

/** One thing to resolve, in the resolver's own terms. */
export interface Wanted {
    readonly namespace: string;
    /** Absent for a whole namespace. */
    readonly name?: string;
    readonly range?: string;
    /** The repository qualifier: the project's short name. */
    readonly repo?: string;
    /** Where the ref said the repository lives. */
    readonly location?: RefLocation;
}

/** One request. */
export interface WantedRequest extends Wanted {
    readonly requestedBy: string;
    readonly kind?: DependencyKind;
    readonly prerelease?: boolean;
    /** How it was written, for messages. */
    readonly written?: string;
}

/** A trusted repository, as the resolver needs it. */
export interface ResolverRepo {
    readonly url: string;
    readonly identity: string;
    readonly provider?: string;
}

/** What a recipe declares. */
export interface DependencyLists {
    readonly depends: readonly string[];
    readonly subscribes: readonly string[];
}

/** Everything the resolver reads. */
export interface ResolveContext {
    /** The index of every trusted repository, by short name. */
    readonly indexes: ReadonlyMap<string, IndexFile>;
    /** The trusted repositories, by short name. */
    readonly repos: Readonly<Record<string, ResolverRepo>>;
    /** A resolved recipe's manifest lists, or `undefined` when its files are not here. */
    readonly loadManifest: (recipe: ResolvedRecipe) => Promise<DependencyLists | undefined> | DependencyLists | undefined;
    /** Every reading of a dependency as a manifest wrote it (`refs.resolver`, from `manifest`). */
    readonly parseDependency: (written: string) => SousRef[];
    readonly prerelease?: boolean;
    /** Versions to hold while every range still allows them, by key. */
    readonly keep?: Readonly<Record<string, string>>;
}

/** A recipe being resolved, before it is frozen into a {@link ResolvedRecipe}. */
type Draft = {
    -readonly [K in keyof ResolvedRecipe]: ResolvedRecipe[K] extends ReadonlyArray<infer T> ? T[] : ResolvedRecipe[K];
};

/** A pending piece of work. */
interface WorkItem {
    namespace: string;
    name?: string;
    range?: string;
    repo?: string;
    location?: RefLocation;
    requestedBy: string;
    kind: DependencyKind;
    prerelease?: boolean;
    written: string;
    /** A dependency that named another repository by location, matched by identity. */
    remote?: {
        identity: string;
        url: string;
        provider?: string;
        /** A folder path copied from a host's file view, settled once the project has the repository. */
        browsed?: { path: string; range?: string };
        pins?: Record<string, IndexDependency>;
    };
}

/** Resolves requests and the whole dependency closure beneath them. */
export async function resolveWanted(requests: readonly WantedRequest[], context: ResolveContext): Promise<ResolveResult> {
    const resolved = new Map<string, Draft>();
    const missingRepos = new Map<string, MissingRepo & { requiredBy: Array<{ ref: string; requestedBy: string }> }>();
    const unreadable = new Set<string>();
    const cycles: string[][] = [];
    const parents = new Map<string, string>();
    const walked = new Map<string, string>();

    const queue: WorkItem[] = requests.map((request) => ({
        ...request,
        kind: request.kind ?? "subscribes",
        written: request.written ?? describeWanted(request),
    }));

    while (queue.length > 0) {
        const item = queue.shift() as WorkItem;

        if (item.repo !== undefined && !Object.hasOwn(context.repos, item.repo) && item.remote === undefined) {
            recordMissing(missingRepos, { name: item.repo, requiredBy: [{ ref: item.written, requestedBy: item.requestedBy }] });
            continue;
        }

        if (item.remote !== undefined) {
            const added = repoNamedByIdentity(context.repos, item.remote.identity);

            if (added === undefined) {
                recordMissing(missingRepos, {
                    name: proposeRepoName(context.repos, item.remote.identity),
                    url: item.remote.url,
                    identity: item.remote.identity,
                    ...(item.remote.provider === undefined ? {} : { provider: item.remote.provider }),
                    requiredBy: [{ ref: item.written, requestedBy: item.requestedBy }],
                });
                continue;
            }

            item.repo = added;

            if (item.remote.browsed !== undefined) {
                settleBrowsedItem(item, context.indexes.get(added));
            }
        }

        if (item.name === undefined) {
            queue.push(...expandNamespace(item, context));
            continue;
        }

        const recipe = resolveRecipe(item, context, resolved);

        resolved.set(recipe.key, recipe);

        if (item.requestedBy !== PROJECT_HOLDER && !parents.has(recipe.key)) {
            parents.set(recipe.key, item.requestedBy);
        }

        if (walked.get(recipe.key) === recipe.version) {
            const cycle = findCycle(recipe.key, item.requestedBy, parents);

            if (cycle !== undefined) {
                cycles.push(cycle);
            }

            continue;
        }

        walked.set(recipe.key, recipe.version);

        const lists = (await safeLoad(context, recipe)) ?? recipe.declares;

        if (lists === undefined) {
            unreadable.add(recipe.key);
            continue;
        }

        for (const [kind, refs] of [
            ["depends", lists.depends],
            ["subscribes", lists.subscribes],
        ] as Array<[DependencyKind, readonly string[]]>) {
            for (const written of refs) {
                queue.push(dependencyRequest(written, recipe, kind, context));
            }
        }
    }

    await keepOnlyReachable(resolved, context);

    const ordered = sortKeys(resolved.keys()).map((key) => {
        const recipe = resolved.get(key) as Draft;

        recipe.requestedBy.sort();

        return recipe as ResolvedRecipe;
    });

    return {
        resolved: ordered,
        missingRepos: [...missingRepos.values()].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
        unreadable: sortKeys(unreadable),
        cycles,
    };
}

/** A manifest's lists, or `undefined` when the loader cannot give them. */
async function safeLoad(context: ResolveContext, recipe: Draft): Promise<DependencyLists | undefined> {
    try {
        return await context.loadManifest(recipe as ResolvedRecipe);
    } catch {
        return undefined;
    }
}

/** The short name of the trusted repository with an identity. */
export function repoNamedByIdentity(repos: Readonly<Record<string, ResolverRepo>>, identity: string): string | undefined {
    return Object.entries(repos).find(([, entry]) => entry.identity === identity)?.[0];
}

/** A short name for a repository the project does not trust yet, from its identity, unique among those in use. */
export function proposeRepoName(repos: Readonly<Record<string, unknown>>, identity: string): string {
    const base = identitySegments(identity).at(-1) ?? "repository";

    if (!Object.hasOwn(repos, base)) {
        return base;
    }

    for (let suffix = 2; ; suffix += 1) {
        if (!Object.hasOwn(repos, `${base}-${suffix}`)) {
            return `${base}-${suffix}`;
        }
    }
}

/** The lists a published version records, when it records them. */
export function indexDependencyLists(version: IndexVersion | undefined): DependencyLists | undefined {
    if (version === undefined || (version.depends === undefined && version.subscribes === undefined)) {
        return undefined;
    }

    return { depends: version.depends ?? [], subscribes: version.subscribes ?? [] };
}

// ------------------------------------------------------------------------------- refs to wanted

/** The parts of a namespace, recipe or browsed repository ref the resolver uses. */
export function wantedOf(ref: SousRef): (Wanted & { browsed?: { path: string; range?: string } }) | undefined {
    if (ref.kind === "namespace") {
        return { namespace: ref.name, ...repoParts(ref.repo) };
    }

    if (ref.kind === "recipe") {
        const repo = ref.namespace?.repo ?? ref.repo;

        if (ref.namespace === undefined) {
            return undefined;
        }

        return { namespace: ref.namespace.name, name: ref.name, ...(ref.range === undefined ? {} : { range: ref.range }), ...repoParts(repo) };
    }

    if (ref.kind === "repo" && ref.browsed !== undefined) {
        return { namespace: "", ...repoParts(ref), browsed: { path: ref.browsed, ...(ref.range === undefined ? {} : { range: ref.range }) } };
    }

    return undefined;
}

/** A repository qualifier's short name and location. */
function repoParts(repo: RepoRef | undefined): Pick<Wanted, "repo" | "location"> {
    return {
        ...(repo?.name === undefined ? {} : { repo: repo.name }),
        ...(repo?.location === undefined ? {} : { location: repo.location }),
    };
}

/** How a request is written in messages. */
function describeWanted(wanted: Wanted): string {
    const key = wanted.name === undefined ? wanted.namespace : `${wanted.namespace}/${wanted.name}`;
    const qualifier = wanted.repo === undefined ? "" : `${wanted.repo}:`;

    return `${qualifier}${key}${wanted.range === undefined ? "" : `@${wanted.range}`}`;
}

// ------------------------------------------------------------------------------ dependencies

/**
 * Turns one `depends` or `subscribes` entry into work. A sibling ref resolves inside the declaring
 * recipe's repository. When the index records what this version of the parent was released
 * against, that exact version is asked for.
 */
function dependencyRequest(written: string, parent: Draft, kind: DependencyKind, context: ResolveContext): WorkItem {
    const reading = settleDependency(written, parent, context);
    const base = { requestedBy: parent.key, kind, written: written.trim(), ...(parent.prerelease ? { prerelease: true } : {}) };
    const wanted = reading === undefined ? undefined : wantedOf(reading);

    if (wanted === undefined) {
        throw unsettledDependencyError(written, parent, context);
    }

    if (wanted.browsed !== undefined && wanted.location !== undefined) {
        return {
            namespace: "",
            ...base,
            remote: {
                identity: wanted.location.identity,
                url: wanted.location.url,
                provider: wanted.location.provider,
                browsed: wanted.browsed,
                ...(parent.dependencies === undefined ? {} : { pins: parent.dependencies }),
            },
        };
    }

    const key = wanted.name === undefined ? undefined : `${wanted.namespace}/${wanted.name}`;
    const pinned = key === undefined ? undefined : parent.dependencies?.[key];
    const range = wanted.name === undefined ? undefined : (pinned?.version ?? wanted.range ?? pinned?.range);
    const target = { namespace: wanted.namespace, ...(wanted.name === undefined ? {} : { name: wanted.name }), ...(range === undefined ? {} : { range }) };

    if (wanted.location === undefined) {
        return { ...target, ...base, repo: wanted.repo ?? parent.repo };
    }

    return {
        ...target,
        ...base,
        remote: { identity: pinned?.repo ?? wanted.location.identity, url: wanted.location.url, provider: wanted.location.provider },
    };
}

/**
 * The one reading of a dependency: the only one, else the one the release recorded, else the one
 * the project's cached indexes publish. Nothing is fetched to find out.
 */
function settleDependency(written: string, parent: Draft, context: ResolveContext): SousRef | undefined {
    const readings = context.parseDependency(written);

    if (readings.length === 1) {
        return readings[0];
    }

    const confirmed = readings.filter((reading) => isConfirmedByRecord(reading, parent.dependencies));

    if (confirmed.length === 1) {
        return confirmed[0];
    }

    const known = readings.filter((reading) => knownLocally(reading, context));

    return known.length === 1 ? known[0] : undefined;
}

/** Whether what a version's index entry recorded confirms a reading of one of its dependencies. */
export function isConfirmedByRecord(candidate: SousRef, recorded: Record<string, IndexDependency> | undefined): boolean {
    const wanted = wantedOf(candidate);

    if (wanted === undefined) {
        return false;
    }

    const identity = wanted.location?.identity;
    const records = Object.entries(recorded ?? {}).filter(([, record]) => (identity === undefined ? record?.repo === undefined : record?.repo === identity));

    if (wanted.browsed !== undefined) {
        return identity !== undefined && records.length > 0;
    }

    if (wanted.name === undefined) {
        return records.some(([key]) => key.startsWith(`${wanted.namespace}/`));
    }

    return records.some(([key]) => key === `${wanted.namespace}/${wanted.name}`);
}

/** Whether a reading's repository is trusted and its cached index publishes what the reading names. */
function knownLocally(reading: SousRef, context: ResolveContext): boolean {
    const wanted = wantedOf(reading);

    if (wanted?.location === undefined) {
        return false;
    }

    const added = repoNamedByIdentity(context.repos, wanted.location.identity);
    const index = added === undefined ? undefined : context.indexes.get(added);

    if (index === undefined) {
        return false;
    }

    if (wanted.browsed !== undefined) {
        return settleBrowsed(wanted.browsed.path, index).length > 0;
    }

    return wanted.name === undefined ? Object.hasOwn(index.namespaces, wanted.namespace) : Object.hasOwn(index.recipes, `${wanted.namespace}/${wanted.name}`);
}

/**
 * What a browsed path names in an index: the deepest recipe whose folder holds it, else a
 * namespace when everything under the folder is one. The first segments are the branch.
 *
 * ```ts
 * settleBrowsed("main/recipes/workflow/alpha/skills", index); // [{ namespace: "workflow", name: "alpha" }]
 * ```
 */
export function settleBrowsed(browsed: string, index: IndexFile): Array<{ namespace: string; name?: string }> {
    const segments = browsed.split("/").filter((segment) => segment.length > 0);
    const recipes = Object.entries(index.recipes)
        .map(([key, recipe]) => ({ key, path: (recipe.path ?? "").replace(/^\.?\/+|\/+$/g, "") }))
        .filter((entry) => entry.path.length > 0);
    const found = new Map<string, { namespace: string; name?: string }>();

    for (let start = 1; start < segments.length; start += 1) {
        const folder = segments.slice(start).join("/");
        const deepest = recipes.filter((entry) => folder === entry.path || folder.startsWith(`${entry.path}/`)).sort((left, right) => right.path.length - left.path.length)[0];

        if (deepest !== undefined) {
            found.set(deepest.key, splitStoredKey(deepest.key));
        }
    }

    if (found.size > 0) {
        return [...found.values()];
    }

    for (let start = 1; start < segments.length; start += 1) {
        const folder = segments.slice(start).join("/");
        const namespaces = new Set(recipes.filter((entry) => entry.path.startsWith(`${folder}/`)).map((entry) => splitStoredKey(entry.key).namespace));

        if (namespaces.size === 1) {
            const [namespace] = namespaces;

            found.set(namespace, { namespace });
        }
    }

    return [...found.values()];
}

/** Settles a browsed path once the project has the repository it names. */
function settleBrowsedItem(item: WorkItem, index: IndexFile | undefined): void {
    const remote = item.remote as NonNullable<WorkItem["remote"]>;
    const browsed = remote.browsed as NonNullable<NonNullable<WorkItem["remote"]>["browsed"]>;
    const settled = index === undefined ? [] : settleBrowsed(browsed.path, index);
    let found = settled.length === 1 ? settled[0] : undefined;

    if (found === undefined) {
        // The folder may have moved since the release; the key it settled on then is recorded.
        const recorded = Object.keys(remote.pins ?? {}).filter((key) => remote.pins?.[key]?.repo === remote.identity);

        if (recorded.length === 1) {
            found = splitStoredKey(recorded[0]);
        }
    }

    if (found === undefined) {
        throw new ConfigError(
            `The dependency '${item.written}' names a folder, and the index of the repository at ${remote.url} ${settled.length === 0 ? "publishes no recipe there" : "publishes several recipes there"}.`,
            { details: [`It was required by the recipe '${item.requestedBy}'. Write the dependency as the recipe it means, such as '${remote.url}/<namespace>/<recipe>'.`] },
        );
    }

    const key = found.name === undefined ? undefined : `${found.namespace}/${found.name}`;
    const pinned = key === undefined ? undefined : remote.pins?.[key];

    item.namespace = found.namespace;
    item.name = found.name;
    item.range = found.name === undefined ? undefined : (pinned?.version ?? browsed.range ?? pinned?.range);
}

/** The error for a dependency that reads more than one way with nothing to settle it. */
function unsettledDependencyError(written: string, parent: Draft, context: ResolveContext): ConfigError {
    const readings = context.parseDependency(written);

    return new ConfigError(`The dependency '${written.trim()}' of the recipe '${parent.key}' can be read ${readings.length} ways, and nothing says which one it means.`, {
        details: [
            `A release records which one it settled on in the index; the index of '${parent.repo}' records none for this version.`,
            "Release the recipe again with this version of sous, or write the dependency so it reads one way.",
        ],
    });
}

// ------------------------------------------------------------------------------- resolving

/** Expands a namespace request into one per recipe in it, fresh on every resolution. */
function expandNamespace(item: WorkItem, context: ResolveContext): WorkItem[] {
    const expanded: WorkItem[] = [];
    const seen = new Set<string>();
    let found = false;

    for (const [repoName, index] of context.indexes) {
        if ((item.repo !== undefined && repoName !== item.repo) || !Object.hasOwn(index.namespaces, item.namespace)) {
            continue;
        }

        found = true;

        for (const key of Object.keys(index.recipes)) {
            if (!key.startsWith(`${item.namespace}/`) || seen.has(key)) {
                continue;
            }

            seen.add(key);
            expanded.push({
                namespace: item.namespace,
                name: key.slice(item.namespace.length + 1),
                // A namespace subscription's range applies to every recipe in it: that is how the
                // built-in `core` subscription stays pinned to the running sous version.
                ...(item.range === undefined ? {} : { range: item.range }),
                ...(item.repo === undefined ? {} : { repo: item.repo }),
                requestedBy: item.requestedBy,
                kind: item.kind,
                written: item.written,
                ...(item.prerelease === undefined ? {} : { prerelease: item.prerelease }),
            });
        }
    }

    if (!found) {
        throw unknownRefError(item, context, "namespace");
    }

    return expanded;
}

/** Resolves one recipe request, merging it with what is already resolved for the key. */
function resolveRecipe(item: WorkItem, context: ResolveContext, resolved: Map<string, Draft>): Draft {
    const key = `${item.namespace}/${item.name}`;
    const candidates: string[] = [];

    for (const [repoName, index] of context.indexes) {
        if ((item.repo === undefined || repoName === item.repo) && Object.hasOwn(index.recipes, key)) {
            candidates.push(repoName);
        }
    }

    if (candidates.length === 0) {
        throw unknownRefError(item, context, "recipe");
    }

    if (candidates.length > 1) {
        throw ambiguousRefError(item, key, candidates);
    }

    const repo = candidates[0];
    const entry = (context.indexes.get(repo) as IndexFile).recipes[key];
    const previous = resolved.get(key);

    if (previous !== undefined && previous.repo !== repo) {
        throw new ConfigError(`The recipe '${key}' is being taken from two repositories at once: '${previous.repo}' and '${repo}'.`, {
            details: ["Qualify the refs that ask for it, so each one says which repository it means."],
        });
    }

    const ranges = [...(previous?.ranges ?? [])];
    const range = item.range ?? "*";

    if (!ranges.some((known) => known.range === range && known.requestedBy === item.requestedBy)) {
        ranges.push({ range, requestedBy: item.requestedBy });
    }

    const prerelease = (previous?.prerelease ?? false) || (item.prerelease ?? context.prerelease ?? false);
    const version = pickVersion(key, entry, ranges, prerelease, context.keep?.[key]);
    const versionEntry = entry.versions[version];
    const declares = indexDependencyLists(versionEntry);
    const requestedBy = [...(previous?.requestedBy ?? [])];

    if (!requestedBy.includes(item.requestedBy)) {
        requestedBy.push(item.requestedBy);
    }

    return {
        key,
        namespace: item.namespace,
        name: item.name as string,
        repo,
        identity: context.repos[repo]?.identity ?? repo,
        version,
        hash: versionEntry.hash,
        tag: versionEntry.tag,
        path: entry.path,
        ...(versionEntry.dependencies === undefined ? {} : { dependencies: versionEntry.dependencies }),
        ...(versionEntry.variables === undefined ? {} : { variables: versionEntry.variables }),
        ...(declares === undefined ? {} : { declares: { depends: [...declares.depends], subscribes: [...declares.subscribes] } }),
        kind: previous?.kind === "subscribes" || item.kind === "subscribes" ? "subscribes" : "depends",
        requestedBy,
        ranges,
        prerelease,
    } as Draft;
}

/** The highest published version satisfying every range at once; prereleases only when opted into. */
export function pickVersion(key: string, entry: IndexFile["recipes"][string], ranges: ReadonlyArray<{ range: string; requestedBy: string }>, prerelease: boolean, keep?: string): string {
    const published = Object.keys(entry.versions);
    let candidates = prerelease ? published : published.filter((version) => entry.versions[version].prerelease !== true);

    for (const { range } of ranges) {
        candidates = candidates.filter((version) => semver.satisfies(version, range, { includePrerelease: prerelease }));
    }

    if (keep !== undefined && Object.hasOwn(entry.versions, keep) && ranges.every(({ range }) => semver.satisfies(keep, range, { includePrerelease: true }))) {
        return keep;
    }

    const best = semver.maxSatisfying(candidates, "*", { includePrerelease: prerelease });

    if (best !== null) {
        return best;
    }

    const asked = ranges.map(({ range, requestedBy }) => `  ${range} (required by ${requestedBy})`);
    const available = [...published].sort((left, right) => semver.rcompare(left, right, { loose: true })).join(", ");

    throw new ConfigError(`No published version of '${key}' satisfies what was asked for.`, {
        details: [
            `Version ${ranges.length === 1 ? "range" : "ranges"} asked for:`,
            ...asked,
            `Versions this repository publishes: ${available}.`,
            ...(prerelease ? [] : ["Prerelease versions were not considered. A subscription may opt into them with 'prerelease: true', and 'sous subscribe' with '--prerelease'."]),
        ],
    });
}

/** The error for a ref no trusted repository publishes, naming the repositories searched. */
function unknownRefError(item: WorkItem, context: ResolveContext, what: "namespace" | "recipe"): ConfigError {
    const searched = [...context.indexes.keys()];
    const index = item.repo === undefined ? undefined : context.indexes.get(item.repo);
    const details = [
        searched.length === 0 ? "This project has added no repositories yet." : `Repositories searched: ${searched.join(", ")}.`,
        ...(item.requestedBy === PROJECT_HOLDER ? [] : [`It was required by the recipe '${item.requestedBy}'.`]),
        ...(index === undefined
            ? []
            : [`The repository '${item.repo}' publishes: ${Object.keys(index.recipes).length === 0 ? "nothing yet" : sortKeys(Object.keys(index.recipes)).join(", ")}.`]),
        "Add the repository that publishes it with 'sous repo add <url>', then try again.",
    ];

    return new ConfigError(`No added repository publishes the ${what} '${item.written}'.`, { details });
}

/** The error for a ref more than one repository publishes; sous never picks a winner. */
function ambiguousRefError(item: WorkItem, key: string, repos: readonly string[]): ConfigError {
    const range = item.range === undefined || item.range === "*" ? "" : `@${item.range}`;

    return new ConfigError(`The ref '${key}' is published by more than one added repository: ${repos.join(", ")}.`, {
        details: [
            ...(item.requestedBy === PROJECT_HOLDER ? [] : [`It was required by the recipe '${item.requestedBy}'.`]),
            "Say which repository you mean by qualifying the ref with its name:",
            ...repos.map((repo) => `  ${repo}:${key}${range}`),
        ],
    });
}

/** Records one more reason a repository is needed. */
function recordMissing(into: Map<string, MissingRepo & { requiredBy: Array<{ ref: string; requestedBy: string }> }>, missing: MissingRepo & { requiredBy: Array<{ ref: string; requestedBy: string }> }): void {
    const existing = into.get(missing.name);

    if (existing === undefined) {
        into.set(missing.name, missing);
        return;
    }

    for (const entry of missing.requiredBy) {
        if (!existing.requiredBy.some((known) => known.ref === entry.ref && known.requestedBy === entry.requestedBy)) {
            existing.requiredBy.push(entry);
        }
    }
}

/** The chain of recipes from a recipe back to itself, or `undefined`. A cycle is reported, never an error. */
function findCycle(key: string, from: string, parents: Map<string, string>): string[] | undefined {
    if (from === PROJECT_HOLDER) {
        return undefined;
    }

    const chain = [key];
    const guard = new Set<string>();
    let current: string | undefined = from;

    while (current !== undefined && current !== PROJECT_HOLDER) {
        chain.push(current);

        if (current === key) {
            return chain.reverse();
        }

        if (guard.has(current)) {
            return undefined;
        }

        guard.add(current);
        current = parents.get(current);
    }

    return undefined;
}

/**
 * Drops every resolved recipe the settled closure no longer reaches, and trims holders and ranges.
 * A recipe walked at one version and narrowed to another by a later holder leaves behind what the
 * first version declared; this second walk, over the versions settled on, keeps only what is
 * reached. Versions are not re-picked.
 */
async function keepOnlyReachable(resolved: Map<string, Draft>, context: ResolveContext): Promise<void> {
    const holders = new Map<string, Map<string, DependencyKind>>();
    const declare = (parent: string, child: string, kind: DependencyKind): boolean => {
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
        if (recipe.requestedBy.includes(PROJECT_HOLDER) && declare(PROJECT_HOLDER, recipe.key, "subscribes")) {
            queue.push(recipe.key);
        }
    }

    while (queue.length > 0) {
        const key = queue.shift() as string;
        const recipe = resolved.get(key);

        if (recipe === undefined) {
            continue;
        }

        const lists = (await safeLoad(context, recipe)) ?? recipe.declares;

        if (lists === undefined) {
            for (const other of resolved.values()) {
                if (other.requestedBy.includes(key) && declare(key, other.key, other.kind)) {
                    queue.push(other.key);
                }
            }

            continue;
        }

        for (const [kind, refs] of [
            ["depends", lists.depends],
            ["subscribes", lists.subscribes],
        ] as Array<[DependencyKind, readonly string[]]>) {
            for (const written of refs) {
                for (const target of dependencyTargets(written, recipe, context, resolved)) {
                    if (resolved.has(target) && declare(key, target, kind)) {
                        queue.push(target);
                    }
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

/** The resolved keys one dependency of a recipe reaches, the way the walk reached them. */
function dependencyTargets(written: string, holder: Draft, context: ResolveContext, resolved: Map<string, Draft>): string[] {
    let item: WorkItem;

    try {
        item = dependencyRequest(written, holder, "depends", context);

        if (item.remote?.browsed !== undefined) {
            const added = repoNamedByIdentity(context.repos, item.remote.identity);

            settleBrowsedItem(item, added === undefined ? undefined : context.indexes.get(added));
        }
    } catch {
        return [];
    }

    return item.name === undefined ? [...resolved.keys()].filter((key) => key.startsWith(`${item.namespace}/`)) : [`${item.namespace}/${item.name}`];
}
