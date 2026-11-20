/**
 * Helpers for `repository-host` entities: the parts of reading a repository URL every host shares.
 * Host plugins may use them; `refs.locations` itself never assumes any host.
 */

import type { CanonicalRepository, LocationReading } from "../types.js";

/** The words a host's file view puts between a repository and a path. */
const BROWSE_WORDS = new Set(["tree", "blob"]);

/** A repository's last path segment without a `.git` suffix. */
export function withoutGitSuffix(segment: string): string {
    return segment.replace(/\.git$/i, "");
}

/**
 * Every reading of the segments after a repository: what they name and, when they start with
 * `tree/` or `blob/`, the browser path they could also be. Both are returned when both are possible
 * (a namespace could be called `tree`). A leading `-` segment (GitLab's separator) is dropped.
 *
 * ```ts
 * readingsAfterRepository("o/r", ["tree", "main", "recipes", "workflow", "alpha"]);
 * // -> [{ repoPath: "o/r", browsed: "main/recipes/workflow/alpha" },
 * //     { repoPath: "o/r", named: ["tree", "main", "recipes", "workflow", "alpha"] }]
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

/** Trims a repository URL and drops a trailing slash and a trailing `.git`. */
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

/** What {@link splitRepoUrl} takes out of a repository URL. */
export interface RepositoryUrlParts {
    /** The host, with the port of an HTTPS URL that names one; an SSH URL's port is never part of it. */
    host: string;
    owner: string;
    name: string;
    /** The port an `ssh://` URL names. */
    sshPort?: number;
}

/**
 * Takes a repository URL apart into host, owner and name. Accepts the HTTPS form, the `scp`-style
 * SSH form (`git@host:owner/name.git`) and `ssh://host/owner/name`. Returns `undefined` rather than
 * throwing, so a host's `matches` can use it. An HTTPS port stays on the host; an SSH port is
 * returned on its own, because the HTTPS address never uses it.
 *
 * ```ts
 * splitRepoUrl("git@github.com:o/r.git"); // -> { host: "github.com", owner: "o", name: "r" }
 * splitRepoUrl("https://git.example.com:8443/o/r"); // -> { host: "git.example.com:8443", owner: "o", name: "r" }
 * splitRepoUrl("ssh://git@git.example.com:2222/o/r"); // -> { host: "git.example.com", owner: "o", name: "r", sshPort: 2222 }
 * ```
 */
export function splitRepoUrl(url: string): RepositoryUrlParts | undefined {
    const normalized = normalizeRepoUrl(url);

    if (normalized.length === 0) {
        return undefined;
    }

    let host: string;
    let repoPath: string;
    let sshPort: number | undefined;
    const scp = /^(?:([^@\s/]+)@)?([^@\s/:]+):(.+)$/.exec(normalized);

    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) {
        let parsed: URL;

        try {
            parsed = new URL(normalized);
        } catch {
            return undefined;
        }

        if (/^ssh:$/i.test(parsed.protocol) || /^git\+ssh:$/i.test(parsed.protocol)) {
            host = parsed.hostname.toLowerCase();
            sshPort = parsed.port === "" ? undefined : Number(parsed.port);
        } else {
            host = parsed.host.toLowerCase();
        }

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

    return { host, owner: segments.slice(0, -1).join("/"), name: segments[segments.length - 1]!, ...(sshPort === undefined ? {} : { sshPort }) };
}

/** A host without its port: `gitlab.example.com:8443` gives `gitlab.example.com`. */
export function hostWithoutPort(host: string): string {
    return host.replace(/:\d+$/, "");
}

/**
 * The canonical form of a hosted repository. The HTTPS URL carries the host's port and the whole
 * path; the SSH URL never carries the HTTPS port, takes an SSH port only from `sshPort`, and leaves
 * out a `basePath` (the path a self-managed instance is installed under).
 *
 * ```ts
 * buildCanonicalRepository("git.example.com:8443", "gitlab/acme", "recipes", { basePath: "gitlab" });
 * // httpsUrl "https://git.example.com:8443/gitlab/acme/recipes.git"
 * // sshUrl   "git@git.example.com:acme/recipes.git"
 * buildCanonicalRepository("git.example.com", "acme", "recipes", { sshPort: 2222 }).sshUrl;
 * // "ssh://git@git.example.com:2222/acme/recipes.git"
 * ```
 */
export function buildCanonicalRepository(host: string, owner: string, name: string, options: { sshPort?: number; basePath?: string } = {}): CanonicalRepository {
    const basePath = options.basePath?.replace(/^\/+|\/+$/g, "") || undefined;
    const sshOwner = basePath !== undefined && owner.startsWith(`${basePath}/`) ? owner.slice(basePath.length + 1) : owner;
    const sshHost = hostWithoutPort(host);

    return {
        host,
        owner,
        name,
        httpsUrl: `https://${host}/${owner}/${name}.git`,
        sshUrl: options.sshPort === undefined ? `git@${sshHost}:${sshOwner}/${name}.git` : `ssh://git@${sshHost}:${options.sshPort}/${sshOwner}/${name}.git`,
        ...(options.sshPort === undefined ? {} : { sshPort: options.sshPort }),
        ...(basePath === undefined || sshOwner === owner ? {} : { basePath }),
    };
}

/**
 * The default canonical locator: `<id>://<host>/<repoPath>/<rest>`, the host left out when it is
 * the host's default.
 */
export function defaultLocator(id: string, defaultHost: string | undefined, host: string, repoPath: string, rest: string): string {
    const where = host === defaultHost ? repoPath : `${host}/${repoPath}`;

    return `${id}://${where}${rest.length === 0 ? "" : `/${rest}`}`;
}
