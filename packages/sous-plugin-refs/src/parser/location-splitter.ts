/**
 * Reads a repository written as a location: a URL, an SSH remote, a host's own locator
 * (`github://...`) or a host path.
 *
 * Nothing host-specific lives here. Where a repository path ends and what a browser path looks like
 * are each host's own rule, asked through `readLocation`, which may answer more than one way (a
 * GitLab nested group does not say where the project path ends).
 */

import type { ServiceContext } from "@sous-io/plugin-api";
import { hostedIds, schemesOf, tryLocationFor } from "../locations/locations.js";
import type { PartialRef, RefSplitterEntity, RefsLocations, RepoRef, RepositoryLocator } from "../types.js";
import { finishRef, splitter } from "./partial-ref.js";

/** A URL that names its scheme, with the scheme and the rest captured. */
const SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/is;

/** The `scp`-style SSH form, with the host and the path captured. */
const SCP_PATTERN = /^[^@\s/:]+@([^@\s/:]+):(.+)$/s;

/** Schemes that are ordinary URLs rather than a host's own locator scheme. */
const URL_SCHEMES = new Set(["http", "https", "ssh", "git", "git+ssh", "ssh+git"]);

/** Schemes that name a repository on this machine. */
const LOCAL_SCHEMES = new Set(["local", "file"]);

/**
 * True when a written ref names a location rather than a short name. A short name never carries
 * `://`, an `@` before a `:`, or a dot in its first segment.
 *
 * ```ts
 * looksLikeLocation("github.com/o/r");      // -> true
 * looksLikeLocation("repo:workflow/alpha"); // -> false
 * ```
 */
export function looksLikeLocation(ref: string): boolean {
    const trimmed = ref.trim();

    if (SCHEME_PATTERN.test(trimmed) || SCP_PATTERN.test(trimmed)) {
        return true;
    }

    const first = trimmed.split("/")[0] ?? "";

    return trimmed.includes("/") && first.includes(".") && !first.includes(":");
}

/** A location, taken apart only as far as every host agrees. */
interface Taken {
    host: RepositoryLocator;
    hostName: string;
    segments: string[];
}

/** A URL path's segments, decoded, with empty ones dropped. */
function pathSegments(pathname: string): string[] {
    return pathname
        .split(/[?#]/)[0]!
        .split("/")
        .map((segment) => {
            try {
                return decodeURIComponent(segment);
            } catch {
                return segment;
            }
        })
        .filter((segment) => segment.length > 0);
}

/** A repository on this machine: kept as a location the pruners can refuse. */
function local(state: PartialRef, path: string): PartialRef {
    return finishRef(state, {
        kind: "repo",
        location: {
            provider: "local",
            host: "localhost",
            repoPath: path,
            identity: `localhost/${path.replace(/^\/+/, "")}`,
            url: state.rest,
        },
    });
}

/** The host that recognizes a host name, asked with the URL the location would start with. */
function forHost(state: PartialRef, hosts: readonly RepositoryLocator[], hostName: string, segments: string[]): Taken | undefined {
    const probe = `https://${hostName}/${segments.slice(0, 2).join("/")}`;
    const host = hosts.find((entry) => entry.matches(probe));

    if (host !== undefined && host.defaultHost !== undefined) {
        return { host, hostName, segments };
    }

    const ids = hostedIds(hosts);

    state.problems.push(
        `sous does not recognize the host '${hostName}'. For a self-hosted instance, write the ` +
            `location with the provider's scheme and the host, as in ` +
            `'${ids[0] ?? "gitlab"}://${hostName}/owner/repository/namespace/recipe' (sous has these ` +
            `providers: ${ids.join(", ") || "none"}).`,
    );

    return undefined;
}

/** Takes the host-agnostic parts out of a location, or records why it cannot be read. */
function take(state: PartialRef, hosts: readonly RepositoryLocator[], scheme: RegExpExecArray | null): Taken | undefined {
    const body = state.rest;

    if (scheme !== null) {
        const name = scheme[1]!.toLowerCase();

        if (URL_SCHEMES.has(name)) {
            let url: URL;

            try {
                url = new URL(body);
            } catch {
                state.problems.push("the URL could not be read.");

                return undefined;
            }

            return forHost(state, hosts, url.host.toLowerCase(), pathSegments(url.pathname));
        }

        const host = hosts.find((entry) => schemesOf(entry).includes(name));

        if (host?.defaultHost === undefined) {
            state.problems.push(
                `'${name}' is not a provider sous can read a location from. The scheme of a locator ` +
                    `is the provider's own identifier; sous has these: ${hostedIds(hosts).join(", ") || "none"}. ` +
                    "An ordinary 'https://' URL works too.",
            );

            return undefined;
        }

        let segments = pathSegments(scheme[2]!);
        let hostName = host.defaultHost;

        if (segments[0]?.includes(".") === true) {
            hostName = segments[0].toLowerCase();
            segments = segments.slice(1);
        }

        return { host, hostName, segments };
    }

    const scp = SCP_PATTERN.exec(body);

    if (scp !== null) {
        return forHost(state, hosts, scp[1]!.toLowerCase(), pathSegments(scp[2]!));
    }

    const all = pathSegments(body);

    return forHost(state, hosts, all[0]!.toLowerCase(), all.slice(1));
}

/** Reads one location with the hosts and locations given. */
export function readLocation(state: PartialRef, locations: RefsLocations): PartialRef[] {
    if (state.repo !== undefined || !looksLikeLocation(state.rest)) {
        return [state];
    }

    const scheme = SCHEME_PATTERN.exec(state.rest);

    if (scheme !== null && LOCAL_SCHEMES.has(scheme[1]!.toLowerCase())) {
        return [local(state, scheme[2]!)];
    }

    const taken = take(state, locations.hosts(), scheme);

    if (taken === undefined) {
        return [];
    }

    const { host, hostName, segments } = taken;
    const specific: PartialRef[] = [];
    const repositories: RepoRef[] = [];

    for (const reading of host.readLocation({ host: hostName, segments })) {
        const location = tryLocationFor(locations, host.id, hostName, reading.repoPath);

        if (location === undefined) {
            continue;
        }

        if (reading.browsed !== undefined) {
            const browsed = reading.browsed.replace(/^\/+|\/+$/g, "");

            if (browsed.length > 0) {
                specific.push(finishRef(state, { kind: "repo", location, browsed, ...(state.range === undefined ? {} : { range: state.range }) }));
            }

            continue;
        }

        const named = reading.named ?? [];

        if (named.length === 0) {
            repositories.push({ kind: "repo", location });
        } else {
            specific.push({ ...state, rest: named.join("/"), repo: { kind: "repo", location } });
        }
    }

    // A reading of the whole repository is only kept when nothing more specific was read, because
    // a namespace or a recipe is what a ref is for.
    if (specific.length > 0) {
        return specific;
    }

    if (repositories.length === 0) {
        state.problems.push(
            `the ${host.id} provider cannot read a namespace or a recipe from this location. ` +
                `After the repository, a location names a namespace and optionally a recipe, as in ` +
                `'${host.formatLocator(hostName, "owner/repository", "workflow/alpha")}'.`,
        );

        return [];
    }

    if (state.range !== undefined) {
        state.problems.push("a version range applies to a recipe, not to a repository.");

        return [];
    }

    return repositories.map((repo) => finishRef(state, repo));
}

/** Reads a location into a repository, leaving the names after it for the name/path splitter. */
export const locationSplitter: RefSplitterEntity = splitter("location", 30, (state, ctx: ServiceContext) =>
    readLocation(state, ctx.services.get("refs.locations")),
);
