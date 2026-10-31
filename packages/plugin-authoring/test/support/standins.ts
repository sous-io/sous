/**
 * Stand-ins for the plugins plugin-authoring depends on, which are written in parallel: a git runner
 * that runs real git, small format parsers, the recipe hash, a ref parser for the forms the tests
 * write, the variable names and a links service. Each follows its plugin's contract closely enough
 * for authoring's behaviour to be tested against it.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "@sous-io/documents";
import {
    BufferedReporter,
    ConfigError,
    IntentOutput,
    NotFoundError,
    ReportEntryStyle,
    SousError,
    VariableSet,
    nonInteractivePrompter,
    type EntityReader,
    type Prompter,
    type Reporter,
} from "@sous-io/plugin-api";
import type {
    ContentHash,
    FormatParser,
    FormatsManifests,
    FormatsRecipeHash,
    IndexFile,
    RecipeManifest,
    RepoManifest,
    WritableFormatParser,
} from "@sous-io/plugin-formats/types";
import type { GitResult, GitRunner, GitRunOptions } from "@sous-io/plugin-git/types";
import type { RecipesLinks, RepositoryHostEntity, ResolvedLink } from "@sous-io/plugin-recipes/types";
import type {
    NamedRef,
    NamespaceRef,
    RecipeRef,
    RefLocation,
    RefsFormat,
    RefsLocations,
    RefsPicker,
    RefsResolver,
    RepoRef,
    SousRef,
} from "@sous-io/plugin-refs/types";
import type { VariablesNames } from "@sous-io/plugin-variables/types";
import type { AuthoringTools } from "../../src/tools.js";
import { GIT_ENV } from "./git-repo.js";

// --- git.runner ---------------------------------------------------------------------------------

/** A git runner that runs real git, as plugin-git's does. */
export function realGit(): GitRunner {
    const runSync = (args: readonly string[], options: GitRunOptions): GitResult => {
        const started = Date.now();
        const result = spawnSync("git", [...args], {
            cwd: options.cwd,
            encoding: "utf8",
            env: { ...GIT_ENV, ...options.env, GIT_TERMINAL_PROMPT: "0" },
            ...(options.input === undefined ? {} : { input: options.input }),
        });
        const outcome: GitResult = {
            args,
            exitCode: result.status ?? 1,
            stdout: (result.stdout ?? "").replace(/\n$/, ""),
            stderr: (result.stderr ?? "").trim(),
            durationMs: Date.now() - started,
        };

        if (outcome.exitCode !== 0 && options.reject !== false) {
            throw new SousError(`git ${args.join(" ")} failed: ${outcome.stderr || outcome.stdout}`);
        }

        return outcome;
    };
    const run = async (args: readonly string[], options: GitRunOptions) => runSync(args, options);

    return {
        run,
        runSync,
        available: async () => true,
        version: async () => "2",
        root: async (cwd) => {
            const result = runSync(["rev-parse", "--show-toplevel"], { cwd, reject: false });

            return result.exitCode === 0 ? result.stdout : undefined;
        },
        currentBranch: async (cwd) => {
            const result = runSync(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd, reject: false });

            return result.exitCode === 0 ? result.stdout : undefined;
        },
        revParse: async (ref, cwd) => {
            const result = runSync(["rev-parse", "--verify", "--quiet", ref], { cwd, reject: false });

            return result.exitCode === 0 ? result.stdout : undefined;
        },
        status: async (cwd) =>
            runSync(["status", "--porcelain"], { cwd })
                .stdout.split("\n")
                .filter((line) => line.length > 0)
                .map((line) => {
                    const target = line.slice(3);
                    const arrow = target.indexOf(" -> ");

                    return arrow === -1 ? { code: line.slice(0, 2), path: target } : { code: line.slice(0, 2), path: target.slice(arrow + 4), from: target.slice(0, arrow) };
                }),
        tags: async (cwd, pattern) => runSync(["tag", "--list", ...(pattern === undefined ? [] : [pattern])], { cwd }).stdout.split("\n").filter(Boolean),
        remoteUrl: async (cwd, remote = "origin") => {
            const result = runSync(["remote", "get-url", remote], { cwd, reject: false });

            return result.exitCode === 0 ? result.stdout : undefined;
        },
        clone: async (url, directory) => {
            runSync(["clone", "--quiet", url, directory], { cwd: path.dirname(directory) });
        },
        readRemoteFile: async () => {
            throw new SousError("not in tests");
        },
    };
}

// --- formats ------------------------------------------------------------------------------------

const EXTENSIONS = [".yaml", ".yml", ".json", ".jsonc"];

function parseText(text: string, fileName: string): unknown {
    const extension = path.extname(fileName).toLowerCase();

    return parseDocument(text, extension === ".json" || extension === ".jsonc" ? "jsonc" : "yaml").value();
}

function record(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new ConfigError(`${label} is not an object.`);
    }

    return value as Record<string, unknown>;
}

function requireString(object: Record<string, unknown>, key: string, label: string): string {
    const value = object[key];

    if (typeof value !== "string" || value.length === 0) {
        throw new ConfigError(`${label}: '${key}' is required.`);
    }

    return value;
}

export const recipeManifestParser: FormatParser<RecipeManifest> = {
    label: "recipe manifest",
    parse(value, sourceLabel) {
        const object = record(value, sourceLabel);

        if (object.formatVersion !== 1) {
            throw new ConfigError(`${sourceLabel}: 'formatVersion' must be 1.`);
        }

        for (const key of ["namespace", "name", "version"]) {
            requireString(object, key, sourceLabel);
        }

        const variables = Array.isArray(object.variables)
            ? object.variables.map((entry) => ({ required: true, secret: false, scope: "shared", ...(entry as object) }))
            : undefined;

        return { ...object, contents: Array.isArray(object.contents) ? object.contents : [], ...(variables === undefined ? {} : { variables }) } as RecipeManifest;
    },
    check(value, sourceLabel) {
        try {
            return { value: this.parse(value, sourceLabel) };
        } catch (error) {
            return { issues: [(error as Error).message] };
        }
    },
};

export const repoManifestParser: FormatParser<RepoManifest> = {
    label: "repo manifest",
    parse(value, sourceLabel) {
        const object = record(value, sourceLabel);

        requireString(object, "name", sourceLabel);

        if (!Array.isArray(object.recipes)) {
            throw new ConfigError(`${sourceLabel}: 'recipes' is required.`);
        }

        return { ...object, namespaces: (object.namespaces ?? {}) as RepoManifest["namespaces"] } as RepoManifest;
    },
    check(value, sourceLabel) {
        try {
            return { value: this.parse(value, sourceLabel) };
        } catch (error) {
            return { issues: [(error as Error).message] };
        }
    },
};

/** Stable JSON: sorted keys, two spaces, a trailing newline. */
export function stableJson(value: unknown): string {
    const sort = (item: unknown): unknown => {
        if (Array.isArray(item)) {
            return item.map(sort);
        }

        if (typeof item === "object" && item !== null) {
            return Object.fromEntries(
                Object.keys(item)
                    .sort()
                    .map((key) => [key, sort((item as Record<string, unknown>)[key])]),
            );
        }

        return item;
    };

    return `${JSON.stringify(sort(value), null, 2)}\n`;
}

export const indexFileParser: WritableFormatParser<IndexFile> = {
    label: "repository index",
    fileName: "sous.index.json",
    parse(value, sourceLabel) {
        const object = record(value, sourceLabel);

        if (object.formatVersion !== 1 || typeof object.recipes !== "object") {
            throw new ConfigError(`${sourceLabel} is not a valid index.`);
        }

        return object as IndexFile;
    },
    check(value, sourceLabel) {
        try {
            return { value: this.parse(value, sourceLabel) };
        } catch (error) {
            return { issues: [(error as Error).message] };
        }
    },
    stringify: stableJson,
    empty: () => ({ formatVersion: 1, name: "", generatedAt: "", generator: "", namespaces: {}, recipes: {} }),
};

export const manifests: FormatsManifests = {
    find(directory, kind) {
        const base = kind === "repo" ? "sous.repo" : "sous.recipe";

        return EXTENSIONS.map((extension) => path.join(directory, `${base}${extension}`)).find((file) => fs.existsSync(file));
    },
    async readRecipe(directory) {
        const file = this.find(directory, "recipe");

        return file === undefined ? undefined : { path: file, manifest: recipeManifestParser.parse(await this.readFile(file), file) };
    },
    async readRepo(directory) {
        const file = this.find(directory, "repo");

        return file === undefined ? undefined : { path: file, manifest: repoManifestParser.parse(await this.readFile(file), file) };
    },
    async requireRecipe(directory) {
        const found = await this.readRecipe(directory);

        if (found === undefined) {
            throw new NotFoundError("recipe manifest", directory);
        }

        return found;
    },
    async requireRepo(directory) {
        const found = await this.readRepo(directory);

        if (found === undefined) {
            throw new NotFoundError("repo manifest", directory);
        }

        return found;
    },
    parseText,
    async readFile(file) {
        return parseText(fs.readFileSync(file, "utf8"), file);
    },
};

/** The recipe hash: every file's path, length and bytes, in bytewise order; links and `.git` skipped. */
export const recipeHash: FormatsRecipeHash = {
    async hashDirectory(directory) {
        return this.hashDirectorySync(directory);
    },
    hashDirectorySync(directory) {
        const files: string[] = [];
        const walk = (dir: string, prefix: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.name === ".git" || entry.isSymbolicLink()) {
                    continue;
                }

                const relative = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;

                if (entry.isDirectory()) {
                    walk(path.join(dir, entry.name), relative);
                } else if (entry.isFile()) {
                    files.push(relative);
                }
            }
        };

        walk(directory, "");
        files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));

        const hash = createHash("sha256");

        for (const file of files) {
            const bytes = fs.readFileSync(path.join(directory, ...file.split("/")));

            hash.update(`${file}\0${bytes.length}\0`);
            hash.update(bytes);
            hash.update("\0");
        }

        return `sha256-${hash.digest("hex")}` as ContentHash;
    },
    equal: (left, right) => left.toLowerCase() === right.toLowerCase(),
    isHash: (text): text is ContentHash => /^sha256-[0-9a-f]{64}$/.test(text),
};

// --- refs -----------------------------------------------------------------------------------------

/** A location for a locator, as plugin-refs would give it. */
export function locationFor(provider: string, host: string, repoPath: string): RefLocation {
    return { provider, host, repoPath, identity: `${host}/${repoPath}`, url: `https://${host}/${repoPath}` };
}

const DEFAULT_HOSTS: Record<string, string> = { github: "github.com", gitlab: "gitlab.com" };

function splitRange(text: string): { body: string; range?: string } {
    const at = text.lastIndexOf("@");

    return at > 0 ? { body: text.slice(0, at), range: text.slice(at + 1) } : { body: text };
}

/** The named ref a list of segments reads as, under an optional repository. */
function namedRef(segments: readonly string[], range: string | undefined, repo: RepoRef | undefined): NamedRef | undefined {
    if (segments.length === 1 || (segments.length === 2 && segments[1] === "*")) {
        return { kind: "namespace", name: segments[0]!, ...(repo === undefined ? {} : { repo }), ...(segments[1] === "*" ? { wildcard: true as const } : {}) };
    }

    if (segments.length === 2) {
        const namespace: NamespaceRef = { kind: "namespace", name: segments[0]!, ...(repo === undefined ? {} : { repo }) };

        return { kind: "recipe", name: segments[1]!, namespace, ...(range === undefined ? {} : { range }) };
    }

    return undefined;
}

/**
 * Parses the forms the tests write: `ns`, `ns/*`, `ns/name[@range]`, `github://owner/repo/ns[/name][@range]`,
 * a nested `gitlab://a/b/c/d` (several readings), and `https://host/owner/repo/tree/<branch>/<path>` (a browsed path).
 */
export function parseTestRef(input: string): SousRef[] {
    const { body, range } = splitRange(input.trim());
    const scheme = /^([a-z]+):\/\/(.*)$/.exec(body);

    if (scheme === null) {
        if (/^[a-z][a-z0-9-]*(\/([a-z][a-z0-9-]*|\*))?$/.test(body)) {
            return [namedRef(body.split("/"), range, undefined)!];
        }

        if (/^[a-z][a-z0-9-]*$/.test(body)) {
            return [{ kind: "repo", name: body }];
        }

        throw new ConfigError(`'${input}' is not a ref.`);
    }

    const [, provider, rest] = scheme as unknown as [string, string, string];
    const segments = rest.split("/").filter(Boolean);

    if (provider === "https" && segments[0] === "gitlab.com" && !segments.includes("-")) {
        return parseTestRef(`gitlab://${segments.slice(1).join("/")}${range === undefined ? "" : `@${range}`}`);
    }

    if (provider === "https") {
        const [host, owner, name, tree, ...browsed] = segments;
        const location = locationFor(host === "gitlab.com" ? "gitlab" : "github", host!, `${owner}/${name}`);

        if (tree === "tree" || tree === "-") {
            return [{ kind: "repo", location, browsed: browsed.filter((part) => part !== "tree").join("/"), ...(range === undefined ? {} : { range }) }];
        }

        return [{ kind: "repo", location }];
    }

    const host = DEFAULT_HOSTS[provider] ?? provider;
    const readings: SousRef[] = [];
    const ends = provider === "gitlab" ? [...Array(segments.length).keys()].map((index) => index + 1).filter((end) => end >= 2) : [2];

    for (const end of ends) {
        const named = segments.slice(end);
        const repo: RepoRef = { kind: "repo", location: locationFor(provider, host, segments.slice(0, end).join("/")) };
        const ref = named.length === 0 ? repo : namedRef(named, range, repo);

        // A range leaves only recipe readings.
        if (ref !== undefined && (named.length > 0 || ends.length === 1) && (range === undefined || ref.kind === "recipe")) {
            readings.push(ref);
        }
    }

    return readings;
}

/** The repository a ref sits in. */
function repoOfRef(ref: SousRef): RepoRef | undefined {
    if (ref.kind === "repo") {
        return ref;
    }

    if (ref.kind === "namespace") {
        return ref.repo;
    }

    if (ref.kind === "recipe") {
        return ref.namespace?.repo ?? ref.repo;
    }

    return undefined;
}

export const refsFormat: RefsFormat = {
    key(ref) {
        if (ref.kind === "recipe") {
            return `${ref.namespace?.name}/${ref.name}`;
        }

        return ref.kind === "namespace" ? ref.name : ref.kind === "repo" ? (ref.name ?? ref.location?.identity ?? "") : "";
    },
    identity(ref) {
        return `${repoOfRef(ref)?.location?.identity ?? ""}/${this.key(ref)}`;
    },
    format(ref) {
        const repo = repoOfRef(ref);
        const prefix = repo?.location === undefined ? "" : `${repo.location.provider}://${repo.location.repoPath}/`;

        if (ref.kind === "repo") {
            return ref.location === undefined ? (ref.name ?? "") : `${ref.location.provider}://${ref.location.repoPath}${ref.browsed === undefined ? "" : `/${ref.browsed}`}`;
        }

        return `${prefix}${this.key(ref)}`;
    },
    spelling(ref) {
        return this.format(ref);
    },
    describe(ref) {
        return this.format(ref);
    },
    kindLabel: (ref) => ref.kind,
    splitRecipeKey(key) {
        const slash = key.indexOf("/");

        return { namespace: key.slice(0, slash), name: key.slice(slash + 1) };
    },
    namespaceOfKey: (key) => key.split("/")[0]!,
    namespaceRef: (name, repo) => ({ kind: "namespace", name, ...(repo === undefined ? {} : { repo: { kind: "repo", name: repo } }) }),
    recipeRef: (namespace, name, options) => ({
        kind: "recipe",
        name,
        namespace: { kind: "namespace", name: namespace, ...(options?.repo === undefined ? {} : { repo: { kind: "repo", name: options.repo } }) },
        ...(options?.range === undefined ? {} : { range: options.range }),
    }),
    parseNamedRef(input) {
        const ref = parseTestRef(input)[0];

        if (ref === undefined || (ref.kind !== "namespace" && ref.kind !== "recipe")) {
            throw new ConfigError(`'${input}' names no namespace or recipe.`);
        }

        return ref;
    },
    partsOf(ref) {
        const repo = repoOfRef(ref);
        const namespace = ref.kind === "namespace" ? ref : ref.kind === "recipe" ? ref.namespace : undefined;
        const recipe = ref.kind === "recipe" ? (ref as RecipeRef) : undefined;
        const range = ref.kind === "recipe" ? ref.range : ref.kind === "repo" ? ref.range : undefined;

        return { ...(repo === undefined ? {} : { repo }), ...(namespace === undefined ? {} : { namespace }), ...(recipe === undefined ? {} : { recipe }), ...(range === undefined ? {} : { range }) };
    },
};

/** A resolver over the test parser; `known` lists what lookups find for `resolve`. */
export function refsResolver(known: SousRef[] = []): RefsResolver {
    const parse = (input: string) => ({ input, refs: parseTestRef(input), dropped: [], warnings: [], usedLookup: false });

    return {
        parse,
        async resolve(request) {
            const kinds = request.kinds;
            const matches = known.filter(
                (ref) => (kinds === undefined || kinds.includes(ref.kind)) && (refsFormat.key(ref) === request.input || (ref.kind === "repo" && ref.name === request.input)),
            );

            return { input: request.input, refs: matches, dropped: [], warnings: [], usedLookup: true };
        },
        resolveSync: (request) => parse(request.input),
        isValid: (input) => {
            try {
                return parseTestRef(input).length > 0;
            } catch {
                return false;
            }
        },
        findInString: () => [],
    };
}

/** A picker that takes the one match, the first with `acceptFirst`, and otherwise asks. */
export const refsPicker: RefsPicker = {
    async pick(matches, options, io) {
        if (matches.length === 0) {
            throw new NotFoundError("ref", options.search, `Nothing matches '${options.search}'.`, { details: options.details ?? [] });
        }

        if (matches.length === 1 || options.acceptFirst === true) {
            return matches[0]!;
        }

        return io.prompter.askChoice({
            message: options.prompt ?? `Which '${options.search}' did you mean?`,
            answeredBy: "--accept-first",
            choices: matches.map((ref) => ({ label: refsFormat.format(ref), value: ref })),
        });
    },
    facts: (ref, search) => ({ search, resolvedTo: refsFormat.format(ref), kind: ref.kind }),
};

export function refsLocations(hosts: () => RepositoryHostEntity[]): RefsLocations {
    return {
        fromUrl: () => undefined,
        locationFor,
        canonicalize: (url) => {
            const host = hosts().find((entry) => entry.matches(url));

            if (host === undefined) {
                throw new ConfigError(`No host reads ${url}.`);
            }

            return host.canonicalize(url);
        },
        identity: (url) => url,
        identityOf: (repository) => `${repository.host}/${repository.owner}/${repository.name}`,
        hostFor: (url) => hosts().find((entry) => entry.matches(url)),
        host: (id) => hosts().find((entry) => entry.id === id),
        shortName: (identity) => identity.split("/").pop() ?? identity,
        hosts,
    };
}

// --- variables --------------------------------------------------------------------------------------

/** `apiUrl` → `API_URL`. */
export function toUpperSnake(name: string): string {
    return name
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
        .replace(/[-\s.]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_|_$/g, "")
        .toUpperCase();
}

export const variableNames: VariablesNames = {
    envPrefix: "SOUS_VAR_",
    toUpperSnake,
    sharedName: (variable) => `SOUS_VAR_${toUpperSnake(variable)}`,
    recipeScopedName: (namespace, recipe, variable) => `SOUS_VAR_${toUpperSnake(namespace)}_${toUpperSnake(recipe)}_${toUpperSnake(variable)}`,
    namespaceScopedName: (namespace, variable) => `SOUS_VAR_${toUpperSnake(namespace)}_${toUpperSnake(variable)}`,
    bareName: (definition) => definition.env ?? `SOUS_VAR_${toUpperSnake(definition.name)}`,
    isVariableName: (text) => /^[a-z][a-zA-Z0-9]*$/.test(text),
    isEnvName: (text) => /^[A-Z][A-Z0-9_]*$/.test(text),
};

// --- recipes.links -------------------------------------------------------------------------------

/** An in-memory links service. */
export function memoryLinks(initial: ResolvedLink[] = []): RecipesLinks & { readonly entries: Map<string, ResolvedLink> } {
    const entries = new Map(initial.map((link) => [link.repo, link]));

    return {
        entries,
        all: () => Object.fromEntries(entries),
        get: (repo) => entries.get(repo),
        path: (scope) => `/links/${scope}.json`,
        set: async (repo, link, scope) => {
            const resolved: ResolvedLink = { repo, path: link.path, origin: link.origin, linkedAt: "2026-10-29T00:00:00.000Z", scope };

            entries.set(repo, resolved);

            return resolved;
        },
        remove: async (repo) => {
            const link = entries.get(repo);

            entries.delete(repo);

            return link;
        },
    };
}

// --- the bundle ------------------------------------------------------------------------------------

/** What a test may set on the tools. */
export interface TestToolsOptions {
    reporter?: Reporter;
    prompter?: Prompter;
    hosts?: RepositoryHostEntity[];
    links?: RecipesLinks;
    known?: SousRef[];
    sousVersion?: string;
    git?: GitRunner;
    /** Where `sous repo link` would have cloned checkouts. */
    cloneDirectories?: string[];
}

/** Authoring's tools, built from the stand-ins. */
export function testTools(options: TestToolsOptions = {}): AuthoringTools & { reporter: Reporter } {
    const hosts = options.hosts ?? [];
    const entities: EntityReader = {
        get: ((kind: string, id: string) => (kind === "repository-host" ? hosts.find((host) => host.id === id) : undefined)) as EntityReader["get"],
        list: ((kind: string) => (kind === "repository-host" ? hosts : [])) as EntityReader["list"],
        has: (kind, id) => kind === "repository-host" && hosts.some((host) => host.id === id),
        describe: (() => []) as EntityReader["describe"],
        kinds: () => ["repository-host"],
    };
    const reporter = options.reporter ?? new BufferedReporter();

    return {
        git: options.git ?? realGit(),
        manifests,
        recipeManifest: recipeManifestParser,
        repoManifest: repoManifestParser,
        indexFile: indexFileParser,
        hash: recipeHash,
        refs: refsResolver(options.known),
        format: refsFormat,
        locations: refsLocations(() => hosts),
        declarations: undefined,
        names: variableNames,
        entities,
        env: {},
        reporter,
        prompter: options.prompter ?? nonInteractivePrompter,
        results: [],
        commandVariables: (extra = {}) => new IntentOutput({ title: "Command Variables", result: new VariableSet(extra), style: ReportEntryStyle.CommandVariables }),
        sousVersion: options.sousVersion ?? "1.0.0-test",
        hostContext: () => ({ reporter }) as never,
        links: () => options.links,
        picker: () => refsPicker,
        cloneDirectories: () => options.cloneDirectories ?? [],
    };
}
