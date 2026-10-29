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
import { buildCanonicalRepository, defaultLocator, normalizeRepoUrl, readingsAfterRepository, splitRepoUrl, withoutGitSuffix } from "@sous-io/plugin-refs";
import type { CanonicalRepository } from "@sous-io/plugin-refs/types";

// Taking a URL apart is plugin-refs' (`refs.locations` owns locations); these are its helpers,
// re-exported so a host plugin needs only this package.
export { normalizeRepoUrl, readingsAfterRepository, splitRepoUrl, withoutGitSuffix };

/** The parts of a repository URL every host needs: what {@link splitRepoUrl} gives. */
export type RepositoryUrlParts = NonNullable<ReturnType<typeof splitRepoUrl>>;

/**
 * The canonical form of a hosted repository: its HTTPS and SSH clone URLs.
 *
 * ```ts
 * canonicalRepository("github.com", "sous-io", "sous-recipes").sshUrl;
 * // "git@github.com:sous-io/sous-recipes.git"
 * ```
 */
export function canonicalRepository(host: string, owner: string, name: string): CanonicalRepository {
    return buildCanonicalRepository(host, owner, name);
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
    if (separator === "/") {
        return defaultLocator(scheme, defaultHost, host, repoPath, rest);
    }

    const where = host === defaultHost ? repoPath : `${host}/${repoPath}`;

    return `${scheme}://${where}${rest.length === 0 ? "" : `${separator}${rest}`}`;
}
