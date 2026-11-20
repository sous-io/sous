/**
 * Where a self-managed GitLab instance is installed: at the root of its host, or under a sub-path
 * (`https://git.example.com/gitlab/...`). A URL alone cannot tell a sub-path from a group, so sous
 * asks the server once, for the first repository on the host whose path could hold one, and
 * remembers the answer in `$SOUS_HOME/cache/gitlab-instances.json`. A sub-path named in the
 * plugin's `hosts` option is used as given, and nothing is asked.
 *
 * ```jsonc
 * // $SOUS_HOME/cache/gitlab-instances.json
 * {
 *     "git.example.com": { "basePath": "gitlab", "checkedAt": "2026-11-20T10:00:00.000Z" }
 * }
 * ```
 */

import fs from "node:fs";
import path from "node:path";
import { LogLevel } from "@sous-io/sous-plugin-api";
import { canonicalRepository, hostWithoutPort, type CanonicalRepository } from "@sous-io/sous-lib-repository-hosts";
import type { RepositoryHostContext } from "@sous-io/sous-plugin-recipes/types";
import type {} from "@sous-io/sous-plugin-host/types";

/** The file the answers are kept in, under the store (`$SOUS_HOME/cache`). */
export const GITLAB_INSTANCES_FILENAME = "gitlab-instances.json";

/** How long the question to the server may take. */
const CHECK_TIMEOUT_MS = 10_000;

/** What sous remembers about one host. */
export interface RememberedInstance {
    /** The path GitLab is installed under, without slashes; `""` at the root. */
    basePath: string;
    checkedAt: string;
}

/** One GitLab host the plugin's `hosts` option names. */
export interface ConfiguredHost {
    /** The host as written, with its port when it names one: `git.example.com:8443`. */
    host: string;
    /** The sub-path it names (`gitlab`), when it names one. */
    basePath?: string;
}

/**
 * One entry of the `hosts` option, taken apart: a host, an optional port and an optional sub-path.
 *
 * ```ts
 * configuredHost("git.example.com:8443/gitlab"); // { host: "git.example.com:8443", basePath: "gitlab" }
 * configuredHost("https://git.example.com/");     // { host: "git.example.com" }
 * ```
 */
export function configuredHost(entry: string): ConfiguredHost {
    const bare = entry.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").toLowerCase();
    const slash = bare.indexOf("/");
    const host = slash === -1 ? bare : bare.slice(0, slash);
    const basePath = slash === -1 ? "" : bare.slice(slash + 1).replace(/^\/+|\/+$/g, "");

    return basePath.length === 0 ? { host } : { host, basePath };
}

/** Reads and writes the remembered answers. A missing or damaged file remembers nothing. */
export class InstanceMemory {
    constructor(readonly file: string) {}

    read(): Record<string, RememberedInstance> {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown;

            return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, RememberedInstance>) : {};
        } catch {
            return {};
        }
    }

    remember(host: string, entry: RememberedInstance): void {
        const memory = { ...this.read(), [host]: entry };
        const sorted = Object.fromEntries(Object.keys(memory).sort().map((key) => [key, memory[key]]));

        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.writeFileSync(this.file, `${JSON.stringify(sorted, null, 4)}\n`, "utf8");
        } catch {
            // The memory only saves a question; losing it costs one more request.
        }
    }
}

/**
 * The sub-paths a repository's path could start with, shortest first, root first. Each leaves at
 * least one group before the project.
 *
 * ```ts
 * candidateBasePaths("gitlab/acme"); // ["", "gitlab"]
 * candidateBasePaths("acme");        // [] (no room for a sub-path)
 * ```
 */
export function candidateBasePaths(owner: string): string[] {
    const segments = owner.split("/").filter((segment) => segment.length > 0);

    if (segments.length < 2) {
        return [];
    }

    return Array.from({ length: segments.length }, (_unused, count) => segments.slice(0, count).join("/"));
}

/** Whether a response to `<base>/api/v4/version` came from GitLab's API: JSON, and a 200, 401 or 403. */
function answeredByGitlab(status: number, contentType: string | undefined): boolean {
    return (status === 200 || status === 401 || status === 403) && /json/i.test(contentType ?? "");
}

/** Finds, remembers and reports where GitLab is installed on each host, asking each host once per process at most. */
export class GitlabInstances {
    private readonly pending = new Map<string, Promise<string | undefined>>();

    constructor(private readonly configured: ReadonlyMap<string, ConfiguredHost>) {}

    /** The `hosts` option's entry for a host, matched with or without its port. */
    configuredFor(host: string): ConfiguredHost | undefined {
        return this.configured.get(hostWithoutPort(host));
    }

    /**
     * The repository with its sub-path settled: the one the option names, the one remembered, or
     * the one the server answers at. Unchanged when the path has no room for a sub-path, the host is
     * at its root, or the server could not be asked.
     */
    async settle(repository: CanonicalRepository, ctx: RepositoryHostContext): Promise<CanonicalRepository> {
        if (repository.basePath !== undefined || candidateBasePaths(repository.owner).length === 0) {
            return repository;
        }

        let basePath = this.configuredFor(repository.host)?.basePath;

        if (basePath === undefined) {
            const key = repository.host;
            let pending = this.pending.get(key);

            if (pending === undefined) {
                pending = this.find(repository, ctx);
                this.pending.set(key, pending);
            }

            basePath = await pending;
        }

        if (basePath === undefined || basePath === "" || !repository.owner.startsWith(`${basePath}/`)) {
            return repository;
        }

        return canonicalRepository(repository.host, repository.owner, repository.name, {
            basePath,
            ...(repository.sshPort === undefined ? {} : { sshPort: repository.sshPort }),
        });
    }

    /** The remembered answer, else the server's, remembered and reported. */
    private async find(repository: CanonicalRepository, ctx: RepositoryHostContext): Promise<string | undefined> {
        const memory = memoryOf(ctx);
        const remembered = memory?.read()[repository.host];

        if (remembered !== undefined && typeof remembered.basePath === "string") {
            return remembered.basePath;
        }

        const found = await ask(repository, ctx);

        if (found === undefined) {
            return undefined;
        }

        memory?.remember(repository.host, { basePath: found, checkedAt: new Date().toISOString() });

        if (found !== "") {
            const settled = canonicalRepository(repository.host, repository.owner, repository.name, { basePath: found, ...(repository.sshPort === undefined ? {} : { sshPort: repository.sshPort }) });

            ctx.reporter.variables(
                {
                    Host: repository.host,
                    "Installed under": `/${found}`,
                    "API address": `https://${repository.host}/${found}/api/v4`,
                    "SSH clone URL": settled.sshUrl,
                    "Remembered in": memory?.file ?? "nowhere (no sous home)",
                },
                `GitLab on ${repository.host} is installed under a sub-path`,
                LogLevel.Notice,
            );
            ctx.reporter.note(`The GitLab API answered at /${found}/api/v4 on ${repository.host}, so sous reads /${found} as where GitLab is installed, not as a group.`);
        }

        return found;
    }
}

/** The memory file, or `undefined` when there is no sous home service. */
function memoryOf(ctx: RepositoryHostContext): InstanceMemory | undefined {
    if (!ctx.services.has("host.sous-home")) {
        return undefined;
    }

    return new InstanceMemory(path.join(ctx.services.get("host.sous-home").paths(ctx.env).store, GITLAB_INSTANCES_FILENAME));
}

/**
 * Asks `<base>/api/v4/version` at each candidate sub-path, root first; the first answer from
 * GitLab's API wins. `undefined` when none answered, so the next command asks again.
 */
async function ask(repository: CanonicalRepository, ctx: RepositoryHostContext): Promise<string | undefined> {
    if (!ctx.services.has("host.http")) {
        return undefined;
    }

    const http = ctx.services.get("host.http");

    for (const candidate of candidateBasePaths(repository.owner)) {
        const prefix = candidate === "" ? "" : `/${candidate}`;

        try {
            const response = await http.get(`https://${repository.host}${prefix}/api/v4/version`, {
                headers: { Accept: "application/json" },
                redirect: "manual",
                timeoutMs: CHECK_TIMEOUT_MS,
                label: `find GitLab on ${repository.host}`,
                ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
            });

            if (answeredByGitlab(response.status, response.headers["content-type"])) {
                return candidate;
            }
        } catch {
            return undefined;
        }
    }

    return undefined;
}
