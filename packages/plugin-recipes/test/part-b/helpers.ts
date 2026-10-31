/**
 * What part B's specs share: temporary directories, recipe and index fixtures, a fake
 * `repository-host` that serves indexes and recipe trees from memory and disk, and an engine built
 * from the real host, git, formats, refs and recipes plugins.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEngine, type Engine } from "@sous-io/core";
import { BufferedReporter, definePlugin, jsonSchema, type JsonObject, type PluginDefinition, type ProjectInfo } from "@sous-io/plugin-api";
import { formatsPlugin, hashDirectorySync } from "@sous-io/plugin-formats";
import type { ContentHash, IndexFile, RecipeManifest } from "@sous-io/plugin-formats/types";
import { gitPlugin } from "@sous-io/plugin-git";
import { createPackage, hostPlugin } from "@sous-io/plugin-host";
import { refsPlugin } from "@sous-io/plugin-refs";
import type { CanonicalRepository } from "@sous-io/plugin-refs/types";
import { stringify } from "yaml";
import { recipesPlugin } from "../../src/index.js";
import type { RepositoryHostEntity } from "../../src/types.js";
import "../../src/types.js";
import packageJson from "../../package.json" with { type: "json" };

/** A fresh temporary directory, removed by {@link cleanTemp}. */
export function tempDir(prefix = "sous-part-b-"): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));

    made.push(dir);

    return dir;
}

const made: string[] = [];

/** Removes every directory {@link tempDir} made. */
export function cleanTemp(): void {
    for (const dir of made.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/** A project rooted at a directory, its `.sous/` created. */
export function makeProject(root: string): ProjectInfo {
    const sousDir = path.join(root, ".sous");

    fs.mkdirSync(sousDir, { recursive: true });

    return { root, sousDir, configPath: undefined, confDir: path.join(sousDir, "conf.d") };
}

/** Writes a recipe directory: its manifest and files. Returns the directory. */
export function writeRecipe(dir: string, manifest: Partial<RecipeManifest> & { namespace: string; name: string; version: string }, files: Record<string, string> = {}): string {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "sous.recipe.yaml"), stringify({ formatVersion: 1, contents: [], ...manifest }), "utf8");

    for (const [relative, text] of Object.entries(files)) {
        const file = path.join(dir, relative);

        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text, "utf8");
    }

    return dir;
}

/** The content hash of a recipe directory, as the store checks it. */
export function hashOf(dir: string): ContentHash {
    return hashDirectorySync(dir);
}

/** One published version, for {@link indexFile}. */
export interface PublishedVersion {
    hash: ContentHash;
    prerelease?: boolean;
    depends?: string[];
    subscribes?: string[];
    dependencies?: IndexFile["recipes"][string]["versions"][string]["dependencies"];
}

/** An index publishing recipes: `{ "workflow/alpha": { path, versions: { "1.0.0": {...} } } }`. */
export function indexFile(name: string, recipes: Record<string, { path?: string; description?: string; versions: Record<string, PublishedVersion> }>, namespaces?: string[]): IndexFile {
    const index: IndexFile = { formatVersion: 1, name, generatedAt: "2026-10-01T00:00:00.000Z", generator: "0.2.34", namespaces: {}, recipes: {} };

    for (const namespace of namespaces ?? Object.keys(recipes).map((key) => key.split("/")[0])) {
        index.namespaces[namespace] = {};
    }

    for (const [key, recipe] of Object.entries(recipes)) {
        index.recipes[key] = {
            path: recipe.path ?? `recipes/${key}`,
            ...(recipe.description === undefined ? {} : { description: recipe.description }),
            versions: Object.fromEntries(
                Object.entries(recipe.versions).map(([version, entry]) => [
                    version,
                    { tag: `${key}@${version}`, prerelease: entry.prerelease ?? false, ...entry },
                ]),
            ),
        };
    }

    return index;
}

/** A repository the fake host serves. */
export interface FakeRepo {
    /** `https://fake.test/<owner>/<name>`. */
    url: string;
    /** The index it serves; change it to publish more. */
    index: IndexFile | undefined;
    /** The recipe trees it serves, by `<recipe path>@<tag>`. */
    trees: Record<string, string>;
    /** When set, every read fails with this reason. */
    offline?: string;
}

/** What the fake host was asked. */
export interface FakeHostCalls {
    reads: string[];
    fetches: Array<{ path: string; tag: string; destination: string }>;
}

/** A fake repository URL. */
export function fakeUrl(owner: string, name: string): string {
    return `https://fake.test/${owner}/${name}`;
}

/** A `repository-host` for `https://fake.test/...`, served from memory. */
export function fakeHost(repos: FakeRepo[], calls: FakeHostCalls = { reads: [], fetches: [] }): RepositoryHostEntity {
    const canonicalize = (url: string): CanonicalRepository => {
        const [owner, name] = url.replace(/^https:\/\/fake\.test\//, "").replace(/\.git$/, "").split("/");

        return { host: "fake.test", owner, name, httpsUrl: `https://fake.test/${owner}/${name}`, sshUrl: `git@fake.test:${owner}/${name}.git` };
    };
    const find = (repository: CanonicalRepository): FakeRepo | undefined => repos.find((repo) => repo.url === repository.httpsUrl);

    return {
        id: "fake",
        defaultHost: "fake.test",
        features: ["fetch"],
        readLocation: (location) => (location.segments.length >= 2 ? [{ repoPath: location.segments.slice(0, 2).join("/"), named: location.segments.slice(2) }] : []),
        formatLocator: (host, repoPath, rest) => `https://${host}/${repoPath}${rest ? `/${rest}` : ""}`,
        matches: (url) => url.startsWith("https://fake.test/"),
        canonicalize,
        readStrategies: [
            {
                id: "http",
                label: "HTTP",
                async read(request) {
                    calls.reads.push(request.repository.httpsUrl);
                    const repo = find(request.repository);

                    if (repo === undefined || repo.index === undefined) {
                        return { ok: false, reason: "404 not found" };
                    }

                    if (repo.offline !== undefined) {
                        return { ok: false, reason: repo.offline };
                    }

                    return { ok: true, text: JSON.stringify(repo.index), ref: request.ref };
                },
            },
        ],
        async fetchRecipeTree(repository, recipePath, tag, destination) {
            calls.fetches.push({ path: recipePath, tag, destination });
            const repo = find(repository);
            const source = repo?.trees[`${recipePath}@${tag}`];

            if (repo?.offline !== undefined || source === undefined) {
                throw new Error(repo?.offline ?? `no tree ${recipePath}@${tag}`);
            }

            fs.cpSync(source, destination, { recursive: true });
        },
    };
}

/** A plugin adding config values and entities, as the user's files would. */
export function configPlugin(data: () => JsonObject, hosts: RepositoryHostEntity[] = []): PluginDefinition {
    return definePlugin({
        name: "test-config",
        register(sous) {
            for (const host of hosts) {
                sous.entities.add("repository-host", host);
            }

            sous.config.contribute({
                id: "test-config.files",
                after: ["@sous-io/plugin-recipes"],
                contribute(config) {
                    config.root().merge(data());
                },
            });
        },
    });
}

/**
 * The installed sous, found from its package in this workspace: from plugin-host's own source the
 * lookup would reach the workspace root, whose package is not sous. A spec that brings its own
 * `test-package` plugin replaces this one.
 */
const WORKSPACE_PACKAGE = definePlugin({
    name: "test-package",
    register(sous) {
        sous.services.replace("host.package", () => createPackage({ startDir: path.resolve(import.meta.dirname, "../../../sous") }), { lifetime: "singleton" });
    },
});

/** Stand-ins for the plugins plugin-recipes depends on but part B's specs do not exercise. */
export const STUB_DEPENDENCIES: PluginDefinition[] = [
    ...["@sous-io/plugin-confd", "@sous-io/plugin-variables", "@sous-io/plugin-compiler"].map((name) => definePlugin({ name, version: packageJson.version, register() {} })),
    // Keys the specs set, which other plugins own.
    definePlugin({
        name: "test-config-keys",
        register(sous) {
            for (const id of ["_vars", "compilation", "alphaLoaded"]) {
                sous.entities.add("config-key", { id, schema: jsonSchema({}) });
            }
        },
    }),
];

/** An engine over a project, with the real plugins part B uses, built once. */
export async function startEngine(options: {
    root: string;
    home: string;
    data?: () => JsonObject;
    hosts?: RepositoryHostEntity[];
    plugins?: PluginDefinition[];
}): Promise<{ engine: Engine; reporter: BufferedReporter; project: ProjectInfo }> {
    const project = makeProject(options.root);
    const reporter = new BufferedReporter();
    const engine = createEngine({
        project,
        env: { SOUS_HOME: options.home, HOME: options.home },
        cwd: options.root,
        reporter,
        builtIns: [...STUB_DEPENDENCIES, hostPlugin, gitPlugin, formatsPlugin, refsPlugin, recipesPlugin, configPlugin(options.data ?? (() => ({})), options.hosts ?? []), ...withPackage(options.plugins ?? [])],
    });

    await engine.buildConfig();

    return { engine, reporter, project };
}

/** The plugins a spec passes, with the workspace's package unless one of them stands in for it. */
function withPackage(plugins: PluginDefinition[]): PluginDefinition[] {
    return plugins.some((plugin) => plugin.name === WORKSPACE_PACKAGE.name) ? plugins : [WORKSPACE_PACKAGE, ...plugins];
}

/** Writes a lockfile. */
export function writeLockfile(project: ProjectInfo, lockfile: unknown): void {
    fs.mkdirSync(project.sousDir, { recursive: true });
    fs.writeFileSync(path.join(project.sousDir, "sous.lock.json"), `${JSON.stringify(lockfile, null, 4)}\n`, "utf8");
}
