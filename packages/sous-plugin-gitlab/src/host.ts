/**
 * The `gitlab` repository-host entity: which URLs are GitLab's, how a location inside a project is
 * read, and how files are read.
 *
 * ```text
 * Token sources      GITLAB_TOKEN, then git credential fill, then glab config get token --host <host>
 * Read strategies    HTTP with token, HTTP without token (both at the API address), then git
 * ```
 *
 * The API address encodes the whole project path, so a nested group's `/` becomes `%2F`:
 *
 * ```text
 * https://gitlab.com/api/v4/projects/acme%2Fplatform%2Frecipes/repository/files/sous.index.json/raw?ref=HEAD
 * ```
 *
 * A self-managed instance may use a port and a sub-path. The HTTPS port stays in the HTTPS and API
 * addresses, the SSH URL takes a port only from an SSH URL that names one, and the sub-path
 * (settled by `GitlabInstances`) goes in front of `/api/v4` and out of the SSH path:
 *
 * ```text
 * https://git.example.com:8443/gitlab/acme/recipes
 *   API    https://git.example.com:8443/gitlab/api/v4/projects/acme%2Frecipes/...
 *   HTTPS  https://git.example.com:8443/gitlab/acme/recipes.git
 *   SSH    git@git.example.com:acme/recipes.git
 * ```
 */

import {
    canonicalRepository,
    cliAuthStatus,
    cliTokenSource,
    envTokenSource,
    fetchRecipeTree,
    formatHostedLocator,
    gitCredentialTokenSource,
    gitReadStrategy,
    hostWithoutPort,
    httpReadStrategy,
    invalidRepoUrl,
    readingsAfterRepository,
    splitRepoUrl,
    withoutGitSuffix,
} from "@sous-io/sous-lib-repository-hosts";
import type { RepositoryReadRequest, RepositoryReadStrategy } from "@sous-io/sous-plugin-recipes/types";
import type { CanonicalRepository, LocationReading, WrittenLocation } from "@sous-io/sous-lib-repository-hosts";
import { gitlabCiFiles } from "./ci.js";
import { GLAB } from "./glab.js";
import { configuredHost, GitlabInstances, type ConfiguredHost } from "./instance.js";
import { gitlabProposals } from "./proposals.js";
import type { GitlabPluginOptions, GitlabRepositoryHost } from "./types.js";

/** The host a `gitlab://` locator means when it names none. */
export const GITLAB_HOST = "gitlab.com";

/** The token variables read when the options name none. */
export const GITLAB_TOKEN_VARIABLES: readonly string[] = ["GITLAB_TOKEN"];

/** The header GitLab names a file's content hash in; it sends no `ETag` for a file. */
export const GITLAB_CONTENT_HASH_HEADER = "x-gitlab-content-sha256";

/**
 * The API root of a project's instance, and the project path the API names, the sub-path left out.
 *
 * ```ts
 * gitlabApi({ host: "git.example.com:8443", owner: "gitlab/acme", name: "recipes", basePath: "gitlab", ... });
 * // { root: "https://git.example.com:8443/gitlab/api/v4", project: "acme/recipes" }
 * ```
 */
export function gitlabApi(repository: CanonicalRepository): { root: string; project: string } {
    const base = repository.basePath;
    const owner = base !== undefined && repository.owner.startsWith(`${base}/`) ? repository.owner.slice(base.length + 1) : repository.owner;

    return { root: `https://${repository.host}${base === undefined ? "" : `/${base}`}/api/v4`, project: `${owner}/${repository.name}` };
}

/**
 * The API address of one file in a project, the whole project path encoded.
 *
 * ```ts
 * gitlabFileUrl({ repository: { host: "gitlab.com", owner: "acme/platform", name: "recipes", ... }, path: "sous.index.json", ref: "HEAD" });
 * // "https://gitlab.com/api/v4/projects/acme%2Fplatform%2Frecipes/repository/files/sous.index.json/raw?ref=HEAD"
 * ```
 */
export function gitlabFileUrl(request: Pick<RepositoryReadRequest, "repository" | "path" | "ref">): string {
    return `${gitlabFileMetaUrl(request).replace(/\?ref=/, "/raw?ref=")}`;
}

/**
 * The API address of one file's details, answered to a `HEAD` request with its content hash in
 * `X-Gitlab-Content-Sha256` and no body.
 *
 * ```ts
 * gitlabFileMetaUrl({ repository, path: "sous.index.json", ref: "HEAD" });
 * // "https://gitlab.com/api/v4/projects/acme%2Frecipes/repository/files/sous.index.json?ref=HEAD"
 * ```
 */
export function gitlabFileMetaUrl(request: Pick<RepositoryReadRequest, "repository" | "path" | "ref">): string {
    const { root, project } = gitlabApi(request.repository);

    return `${root}/projects/${encodeURIComponent(project)}/repository/files/${encodeURIComponent(request.path)}?ref=${encodeURIComponent(request.ref)}`;
}

/** A read strategy that settles the repository's sub-path before it reads. */
function settling(strategy: RepositoryReadStrategy, instances: GitlabInstances): RepositoryReadStrategy {
    return { ...strategy, read: async (request, ctx) => strategy.read({ ...request, repository: await instances.settle(request.repository, ctx) }, ctx) };
}

/**
 * Builds the entity.
 *
 * ```ts
 * createGitlabHost({ hosts: ["git.example.com"] }).matches("https://git.example.com/acme/recipes"); // true
 * ```
 */
export function createGitlabHost(options: GitlabPluginOptions = {}): GitlabRepositoryHost {
    // Keyed by the host without its port, so an entry matches a URL with or without one.
    const configured = new Map<string, ConfiguredHost>((options.hosts ?? []).map((entry) => configuredHost(entry)).map((entry) => [hostWithoutPort(entry.host), entry]));
    const instances = new GitlabInstances(configured);
    const variables = options.tokenVariables ?? GITLAB_TOKEN_VARIABLES;

    const isGitlab = (host: string) => {
        const bare = hostWithoutPort(host);

        return bare === GITLAB_HOST || bare.startsWith("gitlab.") || configured.has(bare);
    };

    return {
        id: "gitlab",
        defaultHost: GITLAB_HOST,
        schemes: ["gitlab"],
        features: ["fetch", "submit", "proposals"],

        readLocation: readGitlabLocation,

        // The canonical locator always marks where the project path ends with `-`, because a
        // nested group reads more than one way without it.
        formatLocator: (host, repoPath, rest) => formatHostedLocator("gitlab", GITLAB_HOST, host, repoPath, rest, "/-/"),

        matches(url) {
            const parts = splitRepoUrl(url);

            return parts !== undefined && isGitlab(parts.host);
        },

        canonicalize(url) {
            const parts = splitRepoUrl(url);

            if (parts === undefined) {
                throw invalidRepoUrl("gitlab", url, GITLAB_HOST);
            }

            const entry = configured.get(hostWithoutPort(parts.host));
            // An SSH URL's host has no HTTPS port; the option's entry supplies it.
            const host = entry !== undefined && hostWithoutPort(entry.host) !== entry.host && parts.host === hostWithoutPort(parts.host) ? entry.host : parts.host;

            return canonicalRepository(host, parts.owner, parts.name, {
                ...(parts.sshPort === undefined ? {} : { sshPort: parts.sshPort }),
                ...(entry?.basePath === undefined ? {} : { basePath: entry.basePath }),
            });
        },

        tokenSources: [
            envTokenSource({ variables, tokenHint: "a token with read_repository" }),
            gitCredentialTokenSource(),
            cliTokenSource({
                id: "glab",
                command: GLAB.command,
                args: (repository) => ["config", "get", "token", "--host", repository.host],
                login: (repository) => `glab auth login --hostname ${repository.host}`,
            }),
        ],

        // GitLab sends no ETag for a file, so a cached index is checked against its content hash.
        readStrategies: [
            httpReadStrategy({ id: "http-token", label: "HTTP with token", usesToken: true, url: gitlabFileUrl, contentHash: { header: GITLAB_CONTENT_HASH_HEADER, url: gitlabFileMetaUrl } }),
            httpReadStrategy({ id: "http", label: "HTTP without token", usesToken: false, url: gitlabFileUrl, contentHash: { header: GITLAB_CONTENT_HASH_HEADER, url: gitlabFileMetaUrl } }),
            gitReadStrategy(),
        ].map((strategy) => settling(strategy, instances)),

        // A token goes to an HTTPS clone with the user name GitLab accepts for any token.
        fetchRecipeTree: async (repository, recipePath, tag, destination, ctx, options = {}) => {
            const settled = await instances.settle(repository, ctx);

            return fetchRecipeTree({ urls: [settled.httpsUrl, settled.sshUrl], tag, recipePath, destination, ...options, tokenUser: "oauth2" }, ctx);
        },

        proposalNoun: "merge request",
        cli: GLAB,
        authStatus: (ctx) => cliAuthStatus(GLAB, ctx),
        ...gitlabProposals(),
        scaffoldFiles: gitlabCiFiles,
    };
}

/**
 * Every reading of a location on GitLab. A project path nests (`group/sub/project`), so where it
 * ends is certain only at a `-` segment or a `.git` suffix. Otherwise every split leaving a
 * project of two segments or more, and at most a namespace and a recipe after it, is a reading;
 * the caller keeps the one an index confirms.
 *
 * ```ts
 * readGitlabLocation({ host: "gitlab.com", segments: ["a", "b", "c", "d"] });
 * // project "a/b" naming "c/d", project "a/b/c" naming "d", project "a/b/c/d" naming nothing
 * ```
 */
export function readGitlabLocation(location: WrittenLocation): LocationReading[] {
    const { segments } = location;
    const separator = segments.indexOf("-");

    if (separator >= 2) {
        return readingsAfterRepository(projectPath(segments.slice(0, separator)), segments.slice(separator));
    }

    const suffixed = segments.findIndex((segment) => /\.git$/i.test(segment));

    if (suffixed >= 1) {
        return readingsAfterRepository(projectPath(segments.slice(0, suffixed + 1)), segments.slice(suffixed + 1));
    }

    const readings: LocationReading[] = [];

    for (let end = 2; end <= segments.length; end++) {
        const rest = segments.slice(end);

        if (rest.length <= 2) {
            readings.push({ repoPath: projectPath(segments.slice(0, end)), named: rest });
        }
    }

    return readings;
}

/** A project path from its segments, the last one's `.git` dropped. */
function projectPath(segments: readonly string[]): string {
    const last = segments.length - 1;

    return segments.map((segment, index) => (index === last ? withoutGitSuffix(segment) : segment)).join("/");
}
