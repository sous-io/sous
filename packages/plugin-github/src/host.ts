/**
 * The `github` repository-host entity: which URLs are GitHub's, how a location inside a repository
 * is read, and how files are read (S4).
 *
 * ```text
 * Token sources      GITHUB_TOKEN or GH_TOKEN, then git credential fill, then gh auth token --hostname <host>
 * Read strategies    HTTP with token (the contents API), HTTP without token (the raw host), then git
 * ```
 *
 * GitHub Enterprise hosts named in the options use `https://<host>/api/v3` and `https://<host>/<owner>/<name>/raw/...`.
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
import type { LocationReading, WrittenLocation } from "@sous-io/repository-hosts";
import type { RepositoryReadRequest } from "@sous-io/plugin-recipes/types";
import { githubWorkflowFiles } from "./ci.js";
import { GH } from "./gh.js";
import { githubProposals } from "./proposals.js";
import type { GithubPluginOptions, GithubRepositoryHost } from "./types.js";

/** The host a `github://` locator means when it names none. */
export const GITHUB_HOST = "github.com";

/** The token variables read when the options name none. */
export const GITHUB_TOKEN_VARIABLES: readonly string[] = ["GITHUB_TOKEN", "GH_TOKEN"];

/** A path with each segment encoded, its `/` kept. */
function encodedPath(path: string): string {
    return path.split("/").map(encodeURIComponent).join("/");
}

/**
 * The contents API address of one file, which takes a token and sends an ETag.
 *
 * ```ts
 * githubApiFileUrl({ repository: { host: "github.com", owner: "sous-io", name: "sous-recipes", ... }, path: "sous.index.json", ref: "HEAD" });
 * // "https://api.github.com/repos/sous-io/sous-recipes/contents/sous.index.json?ref=HEAD"
 * ```
 */
export function githubApiFileUrl(request: Pick<RepositoryReadRequest, "repository" | "path" | "ref">): string {
    const { repository } = request;
    const api = repository.host === GITHUB_HOST ? "https://api.github.com" : `https://${repository.host}/api/v3`;

    return `${api}/repos/${repository.owner}/${repository.name}/contents/${encodedPath(request.path)}?ref=${encodeURIComponent(request.ref)}`;
}

/**
 * The raw address of one file, for public repositories.
 *
 * ```ts
 * githubRawFileUrl({ repository: { host: "github.com", owner: "sous-io", name: "sous-recipes", ... }, path: "sous.index.json", ref: "HEAD" });
 * // "https://raw.githubusercontent.com/sous-io/sous-recipes/HEAD/sous.index.json"
 * ```
 */
export function githubRawFileUrl(request: Pick<RepositoryReadRequest, "repository" | "path" | "ref">): string {
    const { repository } = request;
    const where =
        repository.host === GITHUB_HOST
            ? `https://raw.githubusercontent.com/${repository.owner}/${repository.name}`
            : `https://${repository.host}/${repository.owner}/${repository.name}/raw`;

    return `${where}/${encodeURIComponent(request.ref)}/${encodedPath(request.path)}`;
}

/** The headers the contents API wants, to send the file itself rather than JSON about it. */
const API_HEADERS = { Accept: "application/vnd.github.raw+json", "X-GitHub-Api-Version": "2022-11-28" };

/**
 * Builds the entity.
 *
 * ```ts
 * createGithubHost({ hosts: ["github.example.com"] }).matches("https://github.example.com/o/r"); // true
 * ```
 */
export function createGithubHost(options: GithubPluginOptions = {}): GithubRepositoryHost {
    const extraHosts = new Set((options.hosts ?? []).map((host) => host.toLowerCase()));
    const variables = options.tokenVariables ?? GITHUB_TOKEN_VARIABLES;

    return {
        id: "github",
        defaultHost: GITHUB_HOST,
        schemes: ["github"],
        features: ["fetch", "submit", "proposals"],

        readLocation: readGithubLocation,
        formatLocator: (host, repoPath, rest) => formatHostedLocator("github", GITHUB_HOST, host, repoPath, rest),

        matches(url) {
            const parts = splitRepoUrl(url);

            return parts !== undefined && (parts.host === GITHUB_HOST || extraHosts.has(parts.host));
        },

        canonicalize(url) {
            const parts = splitRepoUrl(url);

            if (parts === undefined) {
                throw invalidRepoUrl("github", url, GITHUB_HOST);
            }

            return canonicalRepository(parts.host, parts.owner, parts.name);
        },

        tokenSources: [
            envTokenSource({ variables, tokenHint: "a token that can read the repository" }),
            gitCredentialTokenSource(),
            cliTokenSource({ id: "gh", command: GH.command, args: (repository) => ["auth", "token", "--hostname", repository.host] }),
        ],

        readStrategies: [
            httpReadStrategy({ id: "http-token", label: "HTTP with token", usesToken: true, url: githubApiFileUrl, headers: () => API_HEADERS }),
            httpReadStrategy({ id: "http", label: "HTTP without token", usesToken: false, url: githubRawFileUrl, headers: () => ({ Accept: "*/*" }) }),
            gitReadStrategy(),
        ],

        fetchRecipeTree: (repository, recipePath, tag, destination, ctx) =>
            fetchRecipeTree({ urls: [repository.httpsUrl, repository.sshUrl], tag, recipePath, destination }, ctx),

        proposalNoun: "pull request",
        cli: GH,
        authStatus: (ctx) => cliAuthStatus(GH, ctx),
        ...githubProposals(),
        scaffoldFiles: githubWorkflowFiles,
    };
}

/**
 * Every reading of a location on GitHub. A repository is always an owner and a name, so the first
 * two segments are the repository and the rest names something inside it: a namespace, a recipe,
 * or a browser path after `tree/` or `blob/`.
 *
 * ```ts
 * readGithubLocation({ host: "github.com", segments: ["o", "r", "workflow", "alpha"] });
 * // [{ repoPath: "o/r", named: ["workflow", "alpha"] }]
 * ```
 */
export function readGithubLocation(location: WrittenLocation): LocationReading[] {
    const { segments } = location;

    if (segments.length < 2) {
        return [];
    }

    return readingsAfterRepository(`${segments[0]}/${withoutGitSuffix(segments[1]!)}`, segments.slice(2));
}
