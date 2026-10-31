/**
 * Browsing what a project trusts (ported from `src/lib/repos/catalog.ts`).
 *
 * Every trusted repository publishes an index, and the lockfile records what is pinned. Put
 * together, they answer four questions without downloading anything: which namespaces exist, what
 * is in one, which recipes exist, and everything about one recipe. Everything here is a pure
 * function over data the caller hands it.
 *
 * Refs are matched against the indexes here: `namespace`, `namespace/recipe`, a bare recipe name,
 * and any of those qualified with `repo:` or written as a location. The readings of what was typed
 * come from `refs.resolver`; the caller passes them in.
 */

import { SousError } from "@sous-io/plugin-api";
import type { IndexDependency, IndexFile, Lockfile, RecipeManifest } from "@sous-io/plugin-formats/types";
import type { NamedRef, NamespaceRef, RecipeRef, SousRef } from "@sous-io/plugin-refs/types";
import semver from "semver";
import type { NamespaceCoverage, NamespaceDetail, NamespaceListing, RecipeDetail, RecipeListing, VersionStatus } from "../types.js";
import type { DependencySource } from "./declarations.js";
import { compareBytewise } from "./util.js";

/** One trusted repository whose index sous has. */
export interface CatalogRepo {
    readonly name: string;
    readonly url?: string;
    /** Its canonical identity, so a ref written as a location finds it. */
    readonly identity?: string;
    readonly index: IndexFile;
}

/** Where one published recipe's files would be read from. */
export interface RecipeLocation {
    readonly key: string;
    readonly namespace: string;
    readonly name: string;
    readonly repo: string;
    readonly version: string;
    readonly path: string;
}

/** Everything the catalog functions read. */
export interface CatalogInputs {
    /** The repositories, in the order a one-word ref searches them: the built-in first, then config order. */
    readonly repos: readonly CatalogRepo[];
    readonly lock: Lockfile;
    /** The subscription keys the project declares. */
    readonly subscriptions: readonly string[];
    /** Linked repositories, by short name, with the checkout's path. */
    readonly linked?: Readonly<Record<string, string>>;
    /** Where one content kind's files land in this project. */
    readonly destinationsFor?: (kind: string) => string[];
    /** How a recipe's manifest entries cover a key (`recipes.declarations`). */
    readonly declarationFor?: (source: DependencySource, key: string) => { declared: string; kind: "depends" | "subscribes" } | undefined;
}

/** The namespace of a stored key. */
export function namespaceOfKey(key: string): string {
    const slash = key.indexOf("/");

    return slash === -1 ? key : key.slice(0, slash);
}

/** Splits `namespace/recipe`. */
export function splitRecipeKey(key: string): { namespace: string; name: string } {
    const slash = key.indexOf("/");

    return { namespace: key.slice(0, slash), name: key.slice(slash + 1) };
}

// --- Listings ----------------------------------------------------------------------------------

/** Every namespace every repository publishes, by namespace then repository. */
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

    return listings.sort((left, right) => compareBytewise(left.namespace, right.namespace) || compareBytewise(left.repo, right.repo));
}

/** Every recipe every repository publishes, by key then repository. */
export function listRecipes(inputs: CatalogInputs): RecipeListing[] {
    const subscriptions = new Set(inputs.subscriptions);
    const listings: RecipeListing[] = [];

    for (const repo of inputs.repos) {
        for (const key of Object.keys(repo.index.recipes)) {
            listings.push(recipeListing(key, repo, inputs, subscriptions));
        }
    }

    return listings.sort((left, right) => compareBytewise(left.key, right.key) || compareBytewise(left.repo, right.repo));
}

/** One namespace in full. */
export function describeNamespace(inputs: CatalogInputs, found: { repo: CatalogRepo; namespace: string }): NamespaceDetail {
    const subscriptions = new Set(inputs.subscriptions);
    const declared = found.repo.index.namespaces[found.namespace] ?? {};

    return {
        repo: found.repo.name,
        ...(found.repo.url === undefined ? {} : { repoUrl: found.repo.url }),
        namespace: found.namespace,
        ...(declared.description === undefined ? {} : { description: declared.description }),
        subscribed: coverageOf(found.namespace, found.repo.index, subscriptions),
        recipes: recipeKeysIn(found.repo.index, found.namespace).map((key) => recipeListing(key, found.repo, inputs, subscriptions)),
    };
}

/**
 * The recipe version a detail describes: the pinned one when the project pins one, the latest
 * otherwise. The caller reads that version's manifest, when its files are here, for `describeRecipe`.
 */
export function describedLocation(inputs: CatalogInputs, found: { repo: CatalogRepo; key: string }): RecipeLocation | undefined {
    const listing = recipeListing(found.key, found.repo, inputs, new Set(inputs.subscriptions));
    const version = listing.pinned ?? listing.latest;
    const entry = found.repo.index.recipes[found.key]!;

    return version === undefined
        ? undefined
        : { key: found.key, namespace: listing.namespace, name: listing.name, repo: found.repo.name, version, path: entry.path };
}

/**
 * One recipe in full: every version, what it depends on, what it asks, where its files land.
 *
 * @param manifest - The described version's manifest, when its files are on this machine.
 */
export function describeRecipe(inputs: CatalogInputs, found: { repo: CatalogRepo; key: string }, manifest?: RecipeManifest): RecipeDetail {
    const subscriptions = new Set(inputs.subscriptions);
    const listing = recipeListing(found.key, found.repo, inputs, subscriptions);
    const entry = found.repo.index.recipes[found.key]!;
    const describing = listing.pinned ?? listing.latest;
    const published = describing === undefined ? undefined : entry.versions[describing];

    return {
        ...listing,
        ...(found.repo.url === undefined ? {} : { repoUrl: found.repo.url }),
        path: entry.path,
        ...(describing === undefined ? {} : { describing }),
        versions: versionListings(entry.versions, listing.latest, listing.pinned),
        dependencies: dependencyListings(published?.dependencies, manifest, inputs),
        dependenciesRecorded: published?.dependencies !== undefined,
        contents: (manifest?.contents ?? []).map((content) => ({
            kind: content.kind,
            include: [...content.include],
            destinations: inputs.destinationsFor?.(content.kind) ?? [],
        })),
        variables: manifest?.variables ?? published?.variables ?? [],
        manifestRead: manifest !== undefined,
    };
}

/**
 * The same inputs, narrowed to what this project has installed: each index keeps only the recipes
 * the lockfile pins from that repository, and the namespaces holding them (`--installed`).
 */
export function narrowToInstalled(inputs: CatalogInputs): CatalogInputs {
    const repos = inputs.repos.map((repo) => {
        const recipes = Object.fromEntries(Object.entries(repo.index.recipes).filter(([key]) => inputs.lock.recipes[key]?.repo === repo.name));
        const held = new Set(Object.keys(recipes).map(namespaceOfKey));
        const namespaces = Object.fromEntries(Object.entries(repo.index.namespaces).filter(([namespace]) => held.has(namespace)));

        return { ...repo, index: { ...repo.index, recipes, namespaces } };
    });

    return { ...inputs, repos };
}

// --- Matching refs ------------------------------------------------------------------------------

/** What a ref names among the catalog's repositories. */
export interface CatalogMatch {
    readonly ref: NamedRef;
    readonly repo: CatalogRepo;
    /** The namespace, or the recipe key. */
    readonly key: string;
    /** True when every part matched in exactly the case it was written. */
    readonly exact: boolean;
}

/** The repository a reading names (short name or location), when it names one. */
function repoOf(ref: NamedRef): { name?: string; identity?: string } | undefined {
    const repo = ref.kind === "namespace" ? ref.repo : (ref.namespace?.repo ?? ref.repo);

    if (repo === undefined) {
        return undefined;
    }

    return {
        ...(repo.name === undefined ? {} : { name: repo.name }),
        ...(repo.location?.identity === undefined ? {} : { identity: repo.location.identity }),
    };
}

function sameText(written: string, published: string): "exact" | "folded" | undefined {
    if (written === published) {
        return "exact";
    }

    return written.toLowerCase() === published.toLowerCase() ? "folded" : undefined;
}

/** A namespace ref as published, under its repository. */
export function publishedNamespaceRef(repo: CatalogRepo, namespace: string): NamespaceRef {
    const declared = repo.index.namespaces[namespace];

    return {
        kind: "namespace",
        name: namespace,
        repo: { kind: "repo", name: repo.name },
        ...(declared?.description === undefined ? {} : { description: declared.description }),
    };
}

/** A recipe ref as published, under its namespace and repository. */
export function publishedRecipeRef(repo: CatalogRepo, key: string): RecipeRef {
    const { namespace, name } = splitRecipeKey(key);
    const description = repo.index.recipes[key]?.description;

    return {
        kind: "recipe",
        name,
        namespace: { kind: "namespace", name: namespace, repo: { kind: "repo", name: repo.name } },
        ...(description === undefined ? {} : { description }),
    };
}

/**
 * Every namespace or recipe in the catalog that any reading names, of the kinds asked, exact
 * spellings first, then in repository order. A recipe reading keeps its range.
 */
export function findInCatalog(inputs: CatalogInputs, readings: readonly SousRef[], kinds: ReadonlyArray<"namespace" | "recipe">): CatalogMatch[] {
    const matches = new Map<string, CatalogMatch>();
    const add = (match: CatalogMatch): void => {
        const id = `${match.repo.name}:${match.ref.kind}:${match.key}`;
        const known = matches.get(id);

        if (known === undefined || (!known.exact && match.exact)) {
            matches.set(id, match);
        }
    };

    for (const reading of readings) {
        if ((reading.kind !== "namespace" && reading.kind !== "recipe") || !kinds.includes(reading.kind)) {
            continue;
        }

        const wanted = repoOf(reading);
        const repos = inputs.repos.filter(
            (repo) =>
                wanted === undefined ||
                (wanted.name !== undefined && sameText(wanted.name, repo.name) !== undefined) ||
                (wanted.identity !== undefined && repo.identity !== undefined && wanted.identity.toLowerCase() === repo.identity.toLowerCase()),
        );

        for (const repo of repos) {
            if (reading.kind === "namespace") {
                for (const namespace of Object.keys(repo.index.namespaces)) {
                    const same = sameText(reading.name, namespace);

                    if (same) {
                        add({ ref: publishedNamespaceRef(repo, namespace), repo, key: namespace, exact: same === "exact" });
                    }
                }

                continue;
            }

            for (const key of Object.keys(repo.index.recipes)) {
                const { namespace, name } = splitRecipeKey(key);
                const sameName = sameText(reading.name, name);
                const sameNamespace = reading.namespace === undefined ? "exact" : sameText(reading.namespace.name, namespace);

                if (sameName && sameNamespace) {
                    const ref: RecipeRef = { ...publishedRecipeRef(repo, key), ...(reading.range === undefined ? {} : { range: reading.range }) };

                    add({ ref, repo, key, exact: sameName === "exact" && sameNamespace === "exact" });
                }
            }
        }
    }

    const order = new Map(inputs.repos.map((repo, index) => [repo.name, index]));

    return [...matches.values()].sort(
        (left, right) => Number(right.exact) - Number(left.exact) || (order.get(left.repo.name) ?? 0) - (order.get(right.repo.name) ?? 0) || compareBytewise(left.key, right.key),
    );
}

/** How a match is listed in an error: `repository:key`. */
export function describeMatch(match: CatalogMatch): string {
    return `${match.repo.name}:${match.key}`;
}

/** The error a ref that matched nothing raises, naming what was searched. */
export function unknownRefError(inputs: CatalogInputs, ref: string, what: "namespace" | "recipe", notFetched: readonly string[] = []): SousError {
    const searched = inputs.repos.length === 0 ? "none" : inputs.repos.map((repo) => repo.name).join(", ");

    return new SousError(`No repository this project trusts publishes a ${what} called '${ref}'.`, {
        details: [
            `Repositories with an index sous has read: ${searched}.`,
            ...(notFetched.length === 0 ? [] : [`These repositories are trusted but their index could not be read, so nothing in them was searched: ${notFetched.join(", ")}.`]),
            `Run 'sous repo search ${ref}' to look for something like it, or 'sous repo add <url>' to add the repository that publishes it.`,
        ],
    });
}

// --- Pieces ------------------------------------------------------------------------------------

function recipeKeysIn(index: IndexFile, namespace: string): string[] {
    return Object.keys(index.recipes)
        .filter((key) => namespaceOfKey(key) === namespace)
        .sort(compareBytewise);
}

function coverageOf(namespace: string, index: IndexFile, subscriptions: Set<string>): NamespaceCoverage {
    if (subscriptions.has(namespace)) {
        return "whole namespace";
    }

    return recipeKeysIn(index, namespace).some((key) => subscriptions.has(key)) ? "some recipes" : "none";
}

/** One recipe's row: what the index publishes, what the lockfile pins, whether the project subscribes. */
export function recipeListing(key: string, repo: CatalogRepo, inputs: Pick<CatalogInputs, "lock" | "linked">, subscriptions: ReadonlySet<string>): RecipeListing {
    const entry = repo.index.recipes[key]!;
    const { namespace, name } = splitRecipeKey(key);
    const latest = latestVersion(entry.versions);
    // Two repositories can publish one key, so the row claims the pin only for the repository it came from.
    const locked = inputs.lock.recipes[key];
    const pinned = locked !== undefined && locked.repo === repo.name ? locked.version : undefined;
    const linkedPath = pinned === undefined ? undefined : inputs.linked?.[repo.name];

    return {
        key,
        namespace,
        name,
        repo: repo.name,
        ...(latest === undefined ? {} : { latest }),
        ...(pinned === undefined ? {} : { pinned }),
        ...(linkedPath === undefined ? {} : { linkedPath }),
        subscribed: subscriptions.has(key) || subscriptions.has(namespace),
        ...(entry.description === undefined ? {} : { description: entry.description }),
    };
}

/** The highest published version; prereleases count only when nothing else is published. */
export function latestVersion(versions: Readonly<Record<string, { prerelease?: boolean }>>): string | undefined {
    const all = Object.keys(versions).filter((version) => semver.valid(version, { loose: true }) !== null);
    const stable = all.filter((version) => versions[version]?.prerelease !== true);

    return semver.maxSatisfying(stable.length > 0 ? stable : all, "*", { includePrerelease: true, loose: true }) ?? undefined;
}

function versionListings(
    versions: Readonly<Record<string, { prerelease: boolean; releasedAt?: string }>>,
    latest: string | undefined,
    pinned: string | undefined,
): RecipeDetail["versions"] {
    return Object.keys(versions)
        .sort((left, right) => {
            const a = semver.valid(left, { loose: true });
            const b = semver.valid(right, { loose: true });

            return a !== null && b !== null ? semver.rcompare(a, b, { loose: true }) : compareBytewise(right, left);
        })
        .map((version) => {
            const entry = versions[version]!;
            const status: VersionStatus =
                version === latest && version === pinned ? "latest and pinned" : version === latest ? "latest" : version === pinned ? "pinned" : "other";

            return { version, status, prerelease: entry.prerelease, ...(entry.releasedAt === undefined ? {} : { releasedAt: entry.releasedAt }) };
        });
}

/**
 * What one version depends on, from both sides: the dependencies the index recorded at release, and
 * those the manifest declares. A dependency on only one side is still a row.
 */
function dependencyListings(
    resolved: Readonly<Record<string, IndexDependency>> | undefined,
    manifest: RecipeManifest | undefined,
    inputs: Pick<CatalogInputs, "declarationFor">,
): RecipeDetail["dependencies"] {
    type Row = { -readonly [K in keyof RecipeDetail["dependencies"][number]]: RecipeDetail["dependencies"][number][K] };
    const rows = new Map<string, Row>();
    const lists = manifest === undefined ? undefined : { depends: manifest.depends ?? [], subscribes: manifest.subscribes ?? [] };

    for (const [key, entry] of Object.entries(resolved ?? {})) {
        const declaration =
            entry.declared !== undefined && entry.kind !== undefined
                ? { declared: entry.declared, kind: entry.kind }
                : lists === undefined
                  ? undefined
                  : inputs.declarationFor?.(lists, key);

        rows.set(key, {
            key,
            ...(entry.version === undefined ? {} : { resolvedVersion: entry.version }),
            ...(entry.range === undefined ? {} : { resolvedRange: entry.range }),
            ...(entry.repo === undefined ? {} : { repo: entry.repo }),
            ...(declaration === undefined ? {} : { declared: declaration.declared, kind: declaration.kind }),
        });
    }

    // A manifest entry no recorded row covers is still shown, under what it was written as.
    const covered = new Set([...rows.values()].map((row) => row.declared));

    for (const [kind, entries] of [
        ["depends", lists?.depends ?? []],
        ["subscribes", lists?.subscribes ?? []],
    ] as const) {
        for (const written of entries) {
            if (covered.has(written.trim())) {
                continue;
            }

            const key = written.trim().replace(/@.*$/, "");

            rows.set(key, { ...(rows.get(key) ?? { key }), declared: written, kind });
        }
    }

    return [...rows.values()].sort((left, right) => compareBytewise(left.key, right.key));
}
