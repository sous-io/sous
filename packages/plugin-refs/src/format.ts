/**
 * `refs.format`: writing a ref back out (its key, its canonical form, its spelling for a person)
 * and reading the stored `namespace/recipe` keys.
 */

import { ConfigError, type ServiceContext } from "@sous-io/plugin-api";
import { KIND_LABELS, locationOf, namespaceOf, rangeOf, recipeOf, repoOf } from "./parts.js";
import type { NamedRef, NamespaceRef, RecipeRef, RefSource, RefsFormat, RefsLocations, RepoRef, SousRef } from "./types.js";

/** The part of a key that names the repository: its short name, or its identity. */
function repoPart(repo: RepoRef | undefined): string | undefined {
    return repo === undefined ? undefined : (repo.name ?? repo.location?.identity);
}

/** The path part of a key, without any repository. */
export function pathPart(ref: SousRef): string {
    switch (ref.kind) {
        case "repo":
            return ref.browsed === undefined ? "" : `tree/${ref.browsed}`;
        case "namespace":
            return ref.name;
        case "recipe":
            return ref.namespace === undefined ? ref.name : `${ref.namespace.name}/${ref.name}`;
        case "recipeFile":
            return `${pathPart(ref.recipe)}/${ref.path}`;
        case "variable":
            return `${ref.recipe === undefined ? "" : `${pathPart(ref.recipe)}.`}${ref.name}`;
        case "envVar":
            return ref.name;
    }
}

/**
 * The canonical key of a ref, without its range or query values, so one thing is never keyed twice
 * under two spellings. A repository qualifier is part of it: the same recipe in two repositories is
 * two things.
 *
 * ```ts
 * refKey(recipe "task-files" in "sous-recipes:workflow"); // -> "sous-recipes:workflow/task-files"
 * refKey(variable "apiUrl" of workflow/task-files);      // -> "workflow/task-files.apiUrl"
 * ```
 */
export function refKey(ref: SousRef): string {
    const repo = ref.kind === "envVar" ? undefined : repoPart(repoOf(ref));
    const rest = pathPart(ref);

    if (repo === undefined) {
        return rest;
    }

    return ref.kind === "repo" && rest === "" ? repo : `${repo}:${rest}`;
}

/** The key with the kind in front: what tells a namespace `workflow` from a repository `workflow`. */
export function refIdentity(ref: SousRef): string {
    return `${ref.kind} ${refKey(ref)}`;
}

/** The repository a person is told a ref lives in. */
function repoLabel(repo: RepoRef | undefined): string {
    return repo?.name ?? repo?.location?.url ?? "unknown";
}

/** True when a ref is a namespace or a recipe that names its namespace. */
export function isNamedRef(ref: SousRef): ref is NamedRef {
    return ref.kind === "namespace" || (ref.kind === "recipe" && ref.namespace !== undefined);
}

/** A namespace ref, optionally under a repository short name. */
export function namespaceRef(name: string, repo?: string): NamespaceRef {
    return { kind: "namespace", name, ...(repo === undefined ? {} : { repo: { kind: "repo", name: repo } }) };
}

/** A recipe ref with its namespace, optionally under a repository short name and with a range. */
export function recipeRef(namespace: string, name: string, options: { repo?: string; range?: string } = {}): RecipeRef {
    return {
        kind: "recipe",
        name,
        namespace: namespaceRef(namespace, options.repo),
        ...(options.range === undefined ? {} : { range: options.range }),
    };
}

/** Writing refs with the locators of the hosts `locations` knows. */
export function formatter(locations: () => RefsLocations): Pick<RefsFormat, "format" | "spelling" | "describe"> {
    /** The repository qualifier in front of what is named inside it. */
    const qualified = (repo: RepoRef | undefined, rest: string): string => {
        if (repo === undefined) {
            return rest;
        }

        if (repo.name !== undefined) {
            return rest === "" ? repo.name : `${repo.name}:${rest}`;
        }

        if (repo.location !== undefined) {
            const { host, repoPath, url, provider } = repo.location;
            const reader = provider === "local" ? undefined : locations().host(provider);

            if (reader !== undefined) {
                return reader.formatLocator(host, repoPath, rest);
            }

            return rest === "" ? url : `${url}/${rest}`;
        }

        return rest;
    };

    const format = (ref: SousRef): string => {
        const body = qualified(ref.kind === "envVar" ? undefined : repoOf(ref), pathPart(ref));
        const range = rangeOf(ref);
        const pairs = Object.entries(ref.vars ?? {}).map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`);

        return `${body}${range === undefined ? "" : `@${range}`}${pairs.length === 0 ? "" : `?${pairs.join("&")}`}`;
    };

    const spelling = (ref: SousRef): string => {
        const repo = ref.kind === "envVar" ? undefined : repoOf(ref);

        return repo !== undefined && repo.name === undefined && repo.location !== undefined ? format(ref) : refKey(ref);
    };

    const describe = (ref: SousRef): string => {
        const summary = ref.description === undefined ? "" : `: ${ref.description}`;
        const key = spelling(ref);

        switch (ref.kind) {
            case "repo": {
                const where = ref.location?.url;

                return `${key}  (the repository '${ref.name ?? key}'${where === undefined ? "" : `, at ${where}`})`;
            }
            case "namespace":
                return `${key}  (the whole namespace '${ref.name}' in the repository '${repoLabel(ref.repo)}')`;
            case "recipe":
                return (
                    `${key}  (the recipe '${ref.name}' in the namespace '${ref.namespace?.name ?? "unknown"}' of the ` +
                    `repository '${repoLabel(repoOf(ref))}'${summary})`
                );
            case "recipeFile":
                return `${key}  (the file '${ref.path}' of the recipe '${pathPart(ref.recipe)}'${summary})`;
            case "variable":
                return `${key}  (the variable '${ref.name}' of the recipe '${ref.recipe === undefined ? "unknown" : pathPart(ref.recipe)}'${summary})`;
            case "envVar": {
                const first = ref.variables?.[0];
                const answers =
                    first === undefined
                        ? ""
                        : ` answering '${first.name}' of the recipe '${first.recipe === undefined ? "unknown" : pathPart(first.recipe)}'`;

                return `${ref.name}  (the environment variable${answers}${summary})`;
            }
        }
    };

    return { format, spelling, describe };
}

/** Makes `refs.format` for a build. */
export function createRefsFormat(ctx: ServiceContext): RefsFormat {
    const written = formatter(() => ctx.services.get("refs.locations"));
    // A key's reading never changes, and listings read every key many times.
    const storedKeys = new Map<string, { namespace: string; name?: string }>();

    const parseNamedRef = (input: string, from: RefSource = "commandLine"): NamedRef => {
        const { refs } = ctx.services.get("refs.resolver").parse(input, from);
        const named = refs.filter((ref): ref is NamedRef => isNamedRef(ref) && locationOf(ref) === undefined);

        if (named.length === 1 && !refs.some((ref) => locationOf(ref) !== undefined)) {
            return named[0]!;
        }

        throw new ConfigError(
            `Invalid ref '${input}': this needs a namespace or a recipe named by its short form, such as 'workflow/alpha', ` +
                "and this ref names a location.",
        );
    };

    const readStoredKey = (key: string): { namespace: string; name?: string } => {
        const known = storedKeys.get(key);

        if (known !== undefined) {
            return known;
        }

        const parsed = parseNamedRef(key, "lockfile");
        const read = parsed.kind === "namespace" ? { namespace: parsed.name } : { namespace: parsed.namespace!.name, name: parsed.name };

        storedKeys.set(key, read);

        return read;
    };

    return {
        key: refKey,
        identity(ref) {
            const location = locationOf(ref);

            if (location === undefined) {
                return refKey(ref);
            }

            const rest = pathPart(ref);

            return rest === "" ? location.identity : `${location.identity}:${rest}`;
        },
        ...written,
        kindLabel: (ref) => KIND_LABELS[ref.kind],
        splitRecipeKey(key) {
            const { namespace, name } = readStoredKey(key);

            if (name === undefined) {
                throw new ConfigError(`Invalid ref '${key}': a recipe key names a namespace and a recipe.`, {
                    details: ["A stored key is written as 'namespace' or 'namespace/recipe'."],
                });
            }

            return { namespace, name };
        },
        namespaceOfKey: (key) => readStoredKey(key).namespace,
        namespaceRef,
        recipeRef,
        parseNamedRef,
        partsOf(ref) {
            const repo = repoOf(ref);
            const namespace = namespaceOf(ref);
            const recipe = recipeOf(ref);
            const range = rangeOf(ref);

            return {
                ...(repo === undefined ? {} : { repo }),
                ...(namespace === undefined ? {} : { namespace }),
                ...(recipe === undefined ? {} : { recipe }),
                ...(range === undefined ? {} : { range }),
            };
        },
    };
}
