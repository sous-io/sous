/**
 * Stand-ins for the services a repository host uses (`host.http`, `host.processes`, `git.runner`,
 * `host.sous-home`), for tests. HTTP answers come from recorded responses; nothing touches the
 * network or runs a process.
 */

import { BufferedReporter, definePlugin, NotFoundError } from "@sous-io/plugin-api";
import type { BuiltConfig, Environment, PluginDefinition, ProjectInfo, SousSchema } from "@sous-io/plugin-api";
import type { GitResult, GitRunner, GitRunOptions } from "@sous-io/plugin-git/types";
import type { HostHttp, HostProcesses, HostSousHome, HttpRequest, HttpResponse, ProcessOptions, ProcessResult } from "@sous-io/plugin-host/types";
import type { RepositoryHostContext, RepositoryHostEntity, RepositoryReadOutcome, RepositoryReadRequest, RepositoryToken } from "@sous-io/plugin-recipes/types";
import packageJson from "../package.json" with { type: "json" };

/** One recorded HTTP response. */
export interface RecordedResponse {
    status: number;
    statusText?: string;
    headers?: Record<string, string>;
    body?: string;
}

/** A recorded answer, or a function of the request that gives one. */
export type RecordedRoute = RecordedResponse | ((request: HttpRequest) => RecordedResponse);

/** A `host.http` that answers from recordings, keyed by URL, and keeps every request. */
export interface RecordedHttp extends HostHttp {
    readonly requests: HttpRequest[];
}

/**
 * A `host.http` answering from recorded responses. An unrecorded URL fails like a lost connection.
 *
 * ```ts
 * const http = recordedHttp({
 *     "https://gitlab.com/api/v4/projects/acme%2Frecipes/repository/files/sous.index.json/raw?ref=HEAD": {
 *         status: 200, headers: { etag: '"abc"' }, body: "{}",
 *     },
 * });
 * ```
 */
export function recordedHttp(routes: Record<string, RecordedRoute>): RecordedHttp {
    const requests: HttpRequest[] = [];

    const request = async (http: HttpRequest): Promise<HttpResponse> => {
        requests.push(http);

        const route = routes[http.url];

        if (route === undefined) {
            throw new Error(`getaddrinfo ENOTFOUND (no recording for ${http.url})`);
        }

        const recorded = typeof route === "function" ? route(http) : route;
        const body = recorded.body ?? "";
        const headers = Object.fromEntries(Object.entries(recorded.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));

        return {
            status: recorded.status,
            statusText: recorded.statusText ?? "",
            url: http.url,
            redirected: false,
            headers,
            durationMs: 1,
            text: async () => body,
            json: async <T>() => JSON.parse(body) as T,
            bytes: async () => new TextEncoder().encode(body),
        };
    };

    return { requests, request, get: (url, options = {}) => request({ ...options, url, method: "GET" }) };
}

/** One process run a fake answered. */
export interface RecordedRun {
    command: string;
    args: string[];
    options: ProcessOptions | undefined;
}

/** A `host.processes` with a fixed set of installed commands and scripted answers. */
export interface FakeProcesses extends HostProcesses {
    readonly runs: RecordedRun[];
}

/** A scripted process answer. */
export type ProcessAnswer = Partial<Pick<ProcessResult, "exitCode" | "stdout" | "stderr">>;

/**
 * A `host.processes` stand-in.
 *
 * ```ts
 * fakeProcesses({ installed: ["glab"], answer: (command, args) => ({ exitCode: 0, stdout: "glpat-x\n" }) });
 * ```
 */
export function fakeProcesses(options: {
    installed?: readonly string[];
    answer?: (command: string, args: readonly string[], options: ProcessOptions | undefined) => ProcessAnswer;
}): FakeProcesses {
    const runs: RecordedRun[] = [];
    const installed = new Set(options.installed ?? []);

    const runSync = (command: string, args: readonly string[], processOptions?: ProcessOptions): ProcessResult => {
        runs.push({ command, args: [...args], options: processOptions });

        const answer = installed.has(command) ? (options.answer?.(command, args, processOptions) ?? {}) : { exitCode: 127, stderr: `${command}: not found` };

        return {
            command,
            args,
            exitCode: answer.exitCode ?? 0,
            signal: null,
            stdout: answer.stdout ?? "",
            stderr: answer.stderr ?? "",
            durationMs: 1,
            timedOut: false,
        };
    };

    return {
        runs,
        runSync,
        run: async (command, args, processOptions) => runSync(command, args, processOptions),
        runInteractive: async () => ({ exitCode: 0, signal: null, durationMs: 1 }),
        which: async (command) => (installed.has(command) ? `/usr/bin/${command}` : undefined),
    };
}

/** One git call a fake answered. */
export interface RecordedGitCall {
    method: string;
    args: unknown[];
}

/** A `git.runner` stand-in, recording every call. */
export interface FakeGit extends GitRunner {
    readonly calls: RecordedGitCall[];
}

/**
 * A `git.runner` stand-in: give the methods a test needs; the rest fail.
 *
 * ```ts
 * fakeGit({ readRemoteFile: async () => { throw new Error("git@gitlab.com: Permission denied (publickey).") } });
 * ```
 */
export function fakeGit(overrides: Partial<GitRunner> & { runAnswer?: (args: readonly string[], options: GitRunOptions) => Partial<GitResult> }): FakeGit {
    const calls: RecordedGitCall[] = [];
    const missing = (name: string) => () => {
        throw new Error(`fakeGit: ${name} was not scripted`);
    };

    const run = async (args: readonly string[], options: GitRunOptions): Promise<GitResult> => {
        const answer = overrides.runAnswer?.(args, options) ?? { exitCode: 1, stderr: "not scripted" };
        const result: GitResult = { args, exitCode: answer.exitCode ?? 0, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "", durationMs: 1 };

        if (result.exitCode !== 0 && options.reject !== false) {
            throw Object.assign(new Error(`git ${args.join(" ")} failed`), { stderr: result.stderr });
        }

        return result;
    };

    const git: GitRunner = {
        run: overrides.run ?? run,
        runSync: overrides.runSync ?? missing("runSync"),
        available: overrides.available ?? (async () => true),
        version: overrides.version ?? (async () => "2.47.1"),
        root: overrides.root ?? missing("root"),
        currentBranch: overrides.currentBranch ?? missing("currentBranch"),
        revParse: overrides.revParse ?? missing("revParse"),
        status: overrides.status ?? missing("status"),
        tags: overrides.tags ?? missing("tags"),
        remoteUrl: overrides.remoteUrl ?? missing("remoteUrl"),
        clone: overrides.clone ?? missing("clone"),
        readRemoteFile: overrides.readRemoteFile ?? missing("readRemoteFile"),
    };

    const recorded = Object.fromEntries(
        Object.entries(git).map(([name, fn]) => [
            name,
            (...args: unknown[]) => {
                calls.push({ method: name, args });

                return (fn as (...a: unknown[]) => unknown)(...args);
            },
        ]),
    ) as unknown as GitRunner;

    return Object.assign(recorded, { calls });
}

/** A `host.sous-home` rooted at a directory. */
export function fakeSousHome(root: string): HostSousHome {
    return {
        paths: () => ({
            root,
            store: `${root}/cache`,
            indexCache: `${root}/cache/_indexes`,
            repos: `${root}/repos`,
            links: `${root}/sous.links.json`,
            readStrategies: `${root}/cache/read-strategies.json`,
        }),
        resolve: (...segments) => [root, ...segments].join("/"),
    };
}

/** A `RepositoryHostContext` over some stand-in services. */
export interface FakeHostContext extends RepositoryHostContext {
    readonly reporter: BufferedReporter;
}

/**
 * A context for calling a host's methods in a test.
 *
 * ```ts
 * const ctx = hostContext({ services: { "host.http": http }, env: { GITLAB_TOKEN: "glpat-x" } });
 * ```
 */
export function hostContext(options: { services?: Record<string, unknown>; env?: Environment; project?: ProjectInfo } = {}): FakeHostContext {
    const services = options.services ?? {};
    const reader = {
        get(name: string) {
            if (!(name in services)) {
                throw new NotFoundError("service", name);
            }

            return services[name];
        },
        has: (name: string) => name in services,
    };

    return {
        plugin: "test",
        config: {} as BuiltConfig,
        services: reader as RepositoryHostContext["services"],
        entities: { get: () => undefined, list: () => [], has: () => false, describe: () => [], kinds: () => [] } as unknown as RepositoryHostContext["entities"],
        project: options.project,
        env: options.env ?? {},
        reporter: new BufferedReporter(),
    };
}

/** A schema that accepts any value as it is, functions included. */
const anything = {
    "~standard": { version: 1, vendor: "test", validate: (value: unknown) => ({ value }) },
} as unknown as SousSchema;

/**
 * Stand-ins for the plugins a host plugin depends on, for loading it into a real engine:
 * plugin-recipes (defining `repository-host`), plugin-host and plugin-git. `options` sets
 * `plugins.options` for the plugins named.
 *
 * ```ts
 * createEngine({ builtIns: [...standInPlugins({ "@sous-io/plugin-gitlab": { hosts: ["git.example.com"] } }), gitlabPlugin] });
 * ```
 */
export function standInPlugins(options: Record<string, unknown> = {}): PluginDefinition[] {
    const version = packageJson.version;

    return [
        definePlugin({
            name: "@sous-io/plugin-recipes",
            version,
            register(sous) {
                sous.entities.define("repository-host", anything);
                sous.entities.add("config-key", { id: "plugins", schema: anything });
                sous.config.contribute({
                    id: "test/plugin-options",
                    before: ["*"],
                    contribute(config) {
                        for (const [name, value] of Object.entries(options)) {
                            config.atPath(["plugins", "options", name]).set(value);
                        }
                    },
                });
            },
        }),
        definePlugin({ name: "@sous-io/plugin-host", version, register() {} }),
        definePlugin({ name: "@sous-io/plugin-git", version, register() {} }),
        definePlugin({ name: "@sous-io/plugin-formats", version, register() {} }),
    ];
}

/**
 * The first token a host's token sources find, asked in order, as the index cache asks them.
 *
 * ```ts
 * await firstToken(host, repository, ctx); // { value: "glpat-x", source: "GITLAB_TOKEN" }
 * ```
 */
export async function firstToken(
    host: Pick<RepositoryHostEntity, "tokenSources">,
    repository: RepositoryReadRequest["repository"],
    ctx: RepositoryHostContext,
): Promise<RepositoryToken | undefined> {
    for (const source of host.tokenSources ?? []) {
        const token = await source.token(repository, ctx);

        if (token !== undefined) {
            return token;
        }
    }

    return undefined;
}

/**
 * Runs one of a host's read strategies by id.
 *
 * ```ts
 * await readWith(host, "http", { repository, path: "sous.index.json", ref: "HEAD" }, ctx);
 * ```
 */
export async function readWith(
    host: Pick<RepositoryHostEntity, "readStrategies">,
    id: string,
    request: RepositoryReadRequest,
    ctx: RepositoryHostContext,
): Promise<RepositoryReadOutcome> {
    const strategy = host.readStrategies.find((candidate) => candidate.id === id);

    if (strategy === undefined) {
        throw new Error(`no read strategy "${id}"`);
    }

    return strategy.read(request, ctx);
}
