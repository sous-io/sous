/**
 * The built-in `ref-pruner` entities, one per place a ref is written: the command line, a config
 * file's subscription keys, a recipe manifest, a key sous stored, and an include line.
 */

import { isStoredKind, rangeOf, repoOf, shortKey } from "../parts.js";
import { splitSegments } from "../names.js";
import type { RefPrunerEntity, SousRef } from "../types.js";
import { hasLocation, hasRepoName, isLocal, KEBAB_REASON, rulePruner, type RefPruneRule } from "./rules.js";

/** What a short ref with a path is told. */
const NO_PATHS =
    "a short ref has at most two path segments, a namespace and a recipe. A folder path " +
    "inside a repository is written as a URL copied from the browser instead.";

/** The stored key of a reading, lowercased and quoted. */
const lowerKey = (ref: SousRef): string => `'${shortKey(ref).toLowerCase()}'`;

/**
 * The command line allows every form. It refuses a repository on this machine written as a
 * location (it is added by its path), a file inside a recipe and a glob.
 */
export const commandLinePruner: RefPrunerEntity = rulePruner({
    id: "commandLine",
    source: "commandLine",
    rules: [
        {
            matches: isLocal,
            action: "drop",
            message: "a repository on this machine is added by its path, and its recipes are then named by their short form.",
            instead: "'sous repo add <path>', then 'namespace/recipe'",
        },
        { matches: (ref) => ref.kind === "recipeFile", action: "drop", message: NO_PATHS, instead: "'namespace/recipe', or the URL copied from the browser" },
        {
            matches: (ref) => ref.glob === true,
            action: "drop",
            message: "a name here must be kebab-case (a letter, then letters, digits or hyphens), so a glob pattern is not accepted.",
            instead: "the name itself",
        },
    ],
});

/** The rules a config key and a stored key share, after their own. */
const sharedStoredRules: readonly RefPruneRule[] = [
    {
        matches: (ref) => ref.kind === "namespace" && ref.wildcard === true,
        action: "drop",
        message: "a whole namespace is stored as its name alone.",
        instead: lowerKey,
    },
    { matches: (ref) => ref.vars !== undefined, action: "drop", message: "a stored key carries no query values.", instead: lowerKey },
    { matches: (ref) => shortKey(ref) !== shortKey(ref).toLowerCase(), action: "drop", message: "stored names are lowercase.", instead: lowerKey },
];

/** A subscription key in a config layer: only `namespace` or `namespace/recipe`, lowercase. */
export const configPruner: RefPrunerEntity = rulePruner({
    id: "config",
    source: "config",
    rules: [
        {
            matches: hasLocation,
            action: "drop",
            message: "a config file names a subscription by its short form; the repository it lives in is a separate entry under 'repos'.",
            instead: (_ref, input) =>
                `'namespace/recipe', or run 'sous subscribe ${input.trim()}', which adds the repository and writes the subscription in its short form`,
        },
        { matches: (ref) => !isStoredKind(ref), action: "drop", message: KEBAB_REASON, instead: "'namespace/recipe'" },
        {
            matches: hasRepoName,
            action: "drop",
            message: (ref) =>
                "the repository a subscription resolves into is recorded in the lockfile, not in the key. To choose between " +
                `repositories, run 'sous subscribe ${repoOf(ref)?.name}:${shortKey(ref).toLowerCase()}', which records the choice.`,
            instead: lowerKey,
        },
        { matches: (ref) => ref.glob === true, action: "drop", message: "a glob pattern is not a stored key; names here must be kebab-case.", instead: lowerKey },
        {
            matches: (ref) => rangeOf(ref) !== undefined,
            action: "drop",
            message: "a subscription's version range belongs in the entry's own 'range' field.",
            instead: (ref) => `${lowerKey(ref)}: { range: '${rangeOf(ref)}' }`,
        },
        ...sharedStoredRules,
    ],
});

/** A key sous stored itself: the lockfile, the index and the store. */
export const lockfilePruner: RefPrunerEntity = rulePruner({
    id: "lockfile",
    source: "lockfile",
    rules: [
        { matches: hasLocation, action: "drop", message: "a stored key never names a location.", instead: "'namespace/recipe'" },
        { matches: (ref) => !isStoredKind(ref), action: "drop", message: KEBAB_REASON, instead: "'namespace/recipe'" },
        { matches: hasRepoName, action: "drop", message: "a stored key never names a repository.", instead: lowerKey },
        { matches: (ref) => ref.glob === true, action: "drop", message: "a glob pattern is not a stored key; names here must be kebab-case.", instead: lowerKey },
        { matches: (ref) => rangeOf(ref) !== undefined, action: "drop", message: "a stored key carries no version range.", instead: lowerKey },
        ...sharedStoredRules,
    ],
});

/** Lowercases the names of a namespace or a recipe, as a published manifest stores them. */
function lowercaseNames(ref: SousRef): SousRef {
    if (ref.kind === "namespace") {
        return { ...ref, name: ref.name.toLowerCase() };
    }

    if (ref.kind === "recipe") {
        return {
            ...ref,
            name: ref.name.toLowerCase(),
            ...(ref.namespace === undefined ? {} : { namespace: { ...ref.namespace, name: ref.namespace.name.toLowerCase() } }),
        };
    }

    return ref;
}

/**
 * An entry of a recipe manifest's `depends` or `subscribes` list. A bare ref names a namespace or a
 * recipe in the same repository, and a location names one in another. It refuses a `repo:`
 * qualifier (one project's private name), a repository on this machine, a whole repository with
 * nothing inside it, and everything that is not a namespace or a recipe.
 */
export const manifestPruner: RefPrunerEntity = rulePruner({
    id: "manifest",
    source: "manifest",
    normalize: lowercaseNames,
    rules: [
        {
            matches: hasRepoName,
            action: "drop",
            message: "a 'repo:' qualifier names a short name that only the consuming project knows, so it cannot appear in a published manifest.",
            instead: (ref) =>
                `${lowerKey(ref)} for a recipe in this same repository, or name the other repository by its location, as in ` +
                `'github://owner/repository/${shortKey(ref).toLowerCase()}'`,
        },
        {
            matches: isLocal,
            action: "drop",
            message: "a local repository is a consumer's convenience, not a published location, so a manifest cannot depend on one.",
            instead: "the recipe's published location, such as 'github://owner/repository/namespace/recipe'",
        },
        { matches: (ref) => ref.kind === "recipeFile", action: "drop", message: NO_PATHS, instead: "'namespace/recipe', or the URL copied from the browser" },
        { matches: (ref) => ref.glob === true, action: "drop", message: KEBAB_REASON, instead: "'namespace/recipe'" },
        {
            matches: (ref) => ref.kind === "repo" && ref.browsed === undefined && ref.location !== undefined,
            action: "drop",
            message: (ref) =>
                `it names the repository at ${ref.kind === "repo" ? ref.location?.url : "that location"} and nothing inside it, and a ` +
                "dependency is a namespace or a recipe.",
            instead: (ref, _input, ctx) => {
                if (ref.kind !== "repo" || ref.location === undefined) {
                    return "'github://owner/repository'";
                }

                const { host, repoPath, url, provider } = ref.location;
                const reader = ctx.services.get("refs.locations").host(provider);

                return `'${reader === undefined ? `${url}/namespace/recipe` : reader.formatLocator(host, repoPath, "namespace/recipe")}'`;
            },
        },
        {
            matches: (ref) => ref.kind === "recipe" && ref.namespace === undefined,
            action: "drop",
            message: (ref) =>
                rangeOf(ref) === undefined
                    ? "a recipe is named with its namespace here, and a bare name is read as a namespace."
                    : "a version range applies to a recipe, and namespaces are not versioned. Name the recipe with its namespace.",
            instead: "'namespace/recipe', optionally with a range such as '@^1.1'",
        },
        {
            matches: (ref) => !isStoredKind(ref) && !(ref.kind === "repo" && ref.browsed !== undefined),
            action: "drop",
            message: KEBAB_REASON,
            instead: "'namespace/recipe'",
        },
        { matches: (ref) => ref.vars !== undefined, action: "drop", message: "a manifest's dependency carries no query values.", instead: lowerKey },
    ],
});

/** The spelling a refused include is told to use: `namespace/recipe/path`. */
function includeInstead(ref: SousRef): string {
    if (ref.kind !== "recipeFile") {
        return "'namespace/recipe/path/to/file.md'";
    }

    return `'${ref.recipe.namespace?.name ?? "namespace"}/${ref.recipe.name}/${ref.path}'`;
}

/**
 * The path of a template include line, its sigil taken off. Only a file inside a recipe is
 * allowed, and its path, namespace and recipe may be globs. A `repo:` qualifier may name the
 * repository by this project's short name. A location never counts, and neither does a range (the
 * version is the one the project pins).
 */
export const includePruner: RefPrunerEntity = rulePruner({
    id: "include",
    source: "include",
    rules: [
        {
            matches: (ref) => ref.kind !== "recipeFile",
            action: "drop",
            message: "an include line names a file inside a recipe: its namespace, its recipe and the path inside it.",
            instead: includeInstead,
        },
        {
            matches: hasLocation,
            action: "drop",
            message: "an include line never names a location; it reads the recipes this project pins.",
            instead: includeInstead,
        },
        {
            matches: (ref) => rangeOf(ref) !== undefined,
            action: "drop",
            message: "an include line takes no version range; the version of a recipe is the one this project pins.",
            instead: includeInstead,
        },
        {
            matches: (ref) => ref.kind === "recipeFile" && splitSegments(ref.path).some((part) => part === "." || part === ".."),
            action: "drop",
            message: "the path inside a recipe may not contain '.' or '..' segments.",
            instead: includeInstead,
        },
    ],
});

/** Every built-in pruner. */
export const BUILT_IN_PRUNERS: readonly RefPrunerEntity[] = [commandLinePruner, configPruner, manifestPruner, lockfilePruner, includePruner];
