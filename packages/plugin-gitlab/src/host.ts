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
    httpReadStrategy,
    invalidRepoUrl,
    readingsAfterRepository,
    splitRepoUrl,
    withoutGitSuffix,
} from "@sous-io/repository-hosts";
import type { RepositoryReadRequest } from "@sous-io/plugin-recipes/types";
import type { LocationReading, WrittenLocation } from "@sous-io/repository-hosts";
import { gitlabCiFiles } from "./ci.js";
import { GLAB } from "./glab.js";
import { gitlabProposals } from "./proposals.js";
import type { GitlabPluginOptions, GitlabRepositoryHost } from "./types.js";

/** The host a `gitlab://` locator means when it names none. */
export const GITLAB_HOST = "gitlab.com";

/** The token variables read when the options name none. */
export const GITLAB_TOKEN_VARIABLES: readonly string[] = ["GITLAB_TOKEN"];

/**
 * The API address of one file in a project, the whole project path encoded.
 *
 * ```ts
 * gitlabFileUrl({ repository: { host: "gitlab.com", owner: "acme/platform", name: "recipes", ... }, path: "sous.index.json", ref: "HEAD" });
 * // "https://gitlab.com/api/v4/projects/acme%2Fplatform%2Frecipes/repository/files/sous.index.json/raw?ref=HEAD"
 * ```
 */
export function gitlabFileUrl(request: Pick<RepositoryReadRequest, "repository" | "path" | "ref">): string {
    const { repository } = request;
    const project = encodeURIComponent(`${repository.owner}/${repository.name}`);

    return `https://${repository.host}/api/v4/projects/${project}/repository/files/${encodeURIComponent(request.path)}/raw?ref=${encodeURIComponent(request.ref)}`;
}

/**
 * Builds the entity.
 *
 * ```ts
 * createGitlabHost({ hosts: ["git.example.com"] }).matches("https://git.example.com/acme/recipes"); // true
 * ```
 */
export function createGitlabHost(options: GitlabPluginOptions = {}): GitlabRepositoryHost {
    const extraHosts = new Set((options.hosts ?? []).map((host) => host.toLowerCase()));
    const variables = options.tokenVariables ?? GITLAB_TOKEN_VARIABLES;

    const isGitlab = (host: string) => host === GITLAB_HOST || host.startsWith("gitlab.") || extraHosts.has(host);

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

            return canonicalRepository(parts.host, parts.owner, parts.name);
        },

        tokenSources: [
            envTokenSource({ variables, tokenHint: "a token with read_repository" }),
            gitCredentialTokenSource(),
            cliTokenSource({ id: "glab", command: GLAB.command, args: (repository) => ["config", "get", "token", "--host", repository.host] }),
        ],

        readStrategies: [
            httpReadStrategy({ id: "http-token", label: "HTTP with token", usesToken: true, url: gitlabFileUrl }),
            httpReadStrategy({ id: "http", label: "HTTP without token", usesToken: false, url: gitlabFileUrl }),
            gitReadStrategy(),
        ],

        fetchRecipeTree: (repository, recipePath, tag, destination, ctx) =>
            fetchRecipeTree({ urls: [repository.httpsUrl, repository.sshUrl], tag, recipePath, destination }, ctx),

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
