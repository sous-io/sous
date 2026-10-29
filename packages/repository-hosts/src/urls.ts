/**
 * Taking repository URLs apart, the way every hosted `repository-host` entity does.
 *
 * Three spellings are accepted, because all three are what people paste:
 *
 * ```text
 * https://gitlab.com/acme/platform/recipes.git
 * git@gitlab.com:acme/platform/recipes.git
 * ssh://git@gitlab.com/acme/platform/recipes
 * ```
 */

import { ConfigError } from "@sous-io/plugin-api";
import type { CanonicalRepository, LocationReading } from "@sous-io/plugin-refs/types";

/** The parts of a repository URL every host needs. */
export interface RepositoryUrlParts {
    /** The host, lowercased: `gitlab.com`. */
    host: string;
    /** Every path segment before the last: `acme/platform`. */
    owner: string;
    /** The last segment, without `.git`. */
    name: string;
}

/** The words a host's file view puts between a repository and a path. */
const BROWSE_WORDS = new Set(["tree", "blob"]);

/**
 * A segment without a `.git` suffix.
 *
 * ```ts
 * withoutGitSuffix("recipes.git"); // "recipes"
 * ```
 */
export function withoutGitSuffix(segment: string): string {
    return segment.replace(/\.git$/i, "");
}

/**
 * A URL trimmed, without trailing slashes or a trailing `.git`.
 *
 * ```ts
 * normalizeRepoUrl(" https://github.com/o/r.git/ "); // "https://github.com/o/r"
 * ```
 */
export function normalizeRepoUrl(url: string): string {
    let value = url.trim();

    while (value.endsWith("/")) {
        value = value.slice(0, -1);
    }

    if (value.endsWith(".git")) {
        value = value.slice(0, -4);
    }

    return value;
}

/**
 * The host, owner and name of a repository URL, or `undefined` when it names no repository.
 *
 * ```ts
 * splitRepoUrl("git@gitlab.com:acme/platform/recipes.git");
 * // { host: "gitlab.com", owner: "acme/platform", name: "recipes" }
 * ```
 */
export function splitRepoUrl(url: string): RepositoryUrlParts | undefined {
    const normalized = normalizeRepoUrl(url);

    if (normalized.length === 0) {
        return undefined;
    }

    let host: string;
    let repoPath: string;

    const scp = /^(?:([^@\s/]+)@)?([^@\s/:]+):(.+)$/.exec(normalized);

    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) {
        let parsed: URL;

        try {
            parsed = new URL(normalized);
        } catch {
            return undefined;
        }

        host = parsed.host.toLowerCase();
        repoPath = parsed.pathname.replace(/^\/+/, "");
    } else if (scp !== null) {
        host = scp[2]!.toLowerCase();
        repoPath = scp[3]!.replace(/^\/+/, "");
    } else {
        return undefined;
    }

    const segments = repoPath.split("/").filter((segment) => segment.length > 0);

    if (segments.length < 2 || host.length === 0) {
        return undefined;
    }

    return { host, owner: segments.slice(0, -1).join("/"), name: segments[segments.length - 1]! };
}

/**
 * The canonical form of a hosted repository: its HTTPS and SSH clone URLs.
 *
 * ```ts
 * canonicalRepository("github.com", "sous-io", "sous-recipes").sshUrl;
 * // "git@github.com:sous-io/sous-recipes.git"
 * ```
 */
export function canonicalRepository(host: string, owner: string, name: string): CanonicalRepository {
    return {
        host,
        owner,
        name,
        httpsUrl: `https://${host}/${owner}/${name}.git`,
        sshUrl: `git@${host}:${owner}/${name}.git`,
    };
}

/**
 * The error for a URL a host cannot take apart.
 *
 * @param hostId - The host entity's id: `github`.
 * @param example - The host to show in the example: `github.com`.
 */
export function invalidRepoUrl(hostId: string, url: string, example: string): ConfigError {
    return new ConfigError(`'${url}' is not a ${hostId} repository URL that sous can read.`, {
        details: [`A repository URL names an owner and a repository, as in 'https://${example}/owner/repository'.`],
    });
}

/**
 * Every reading of the segments after a repository: what they name and, when they start with
 * `tree/` or `blob/`, the browser path they could also be. A leading `-` (GitLab's separator) is
 * dropped first.
 *
 * ```ts
 * readingsAfterRepository("o/r", ["tree", "main", "recipes", "workflow"]);
 * // [{ repoPath: "o/r", browsed: "main/recipes/workflow" },
 * //  { repoPath: "o/r", named: ["tree", "main", "recipes", "workflow"] }]
 * ```
 */
export function readingsAfterRepository(repoPath: string, rest: readonly string[]): LocationReading[] {
    const after = rest[0] === "-" ? rest.slice(1) : [...rest];
    const readings: LocationReading[] = [];

    if (after.length >= 2 && BROWSE_WORDS.has(after[0]!.toLowerCase())) {
        readings.push({ repoPath, browsed: after.slice(1).join("/") });
    }

    readings.push({ repoPath, named: after });

    return readings;
}

/**
 * `<scheme>://<host>/<repoPath>/<rest>`, leaving the host out when it is the default one.
 *
 * ```ts
 * formatHostedLocator("github", "github.com", "github.com", "o/r", "workflow/alpha");
 * // "github://o/r/workflow/alpha"
 * ```
 *
 * @param separator - What goes between the repository and `rest`: `/`, or `/-/` for GitLab.
 */
export function formatHostedLocator(
    scheme: string,
    defaultHost: string | undefined,
    host: string,
    repoPath: string,
    rest: string,
    separator = "/",
): string {
    const where = host === defaultHost ? repoPath : `${host}/${repoPath}`;

    return `${scheme}://${where}${rest.length === 0 ? "" : `${separator}${rest}`}`;
}
