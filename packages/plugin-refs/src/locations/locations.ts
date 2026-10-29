/**
 * `refs.locations`: where a repository lives and its canonical identity, read through the
 * `repository-host` entities. Which hosts exist is theirs to say; nothing here knows any host.
 */

import { ConfigError, type EntityReader } from "@sous-io/plugin-api";
import type { CanonicalRepository, RefLocation, RefsLocations, RepositoryLocator } from "../types.js";
import { repositoryIdentity, shortNameFromIdentity } from "./identity.js";

/** The entity kind hosts are, defined by plugin-recipes. Reading it needs no dependency (S6). */
export const REPOSITORY_HOST_KIND = "repository-host";

/** Schemes that are ordinary URLs rather than a host's own locator scheme. */
const URL_SCHEMES = new Set(["http", "https", "ssh", "git", "git+ssh", "ssh+git"]);

/** A URL that names its scheme. */
const SCHEME = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/is;

/** Every `repository-host` entity, in plugin order. */
export function repositoryHosts(entities: EntityReader): RepositoryLocator[] {
    return entities.list(REPOSITORY_HOST_KIND) as unknown as RepositoryLocator[];
}

/** The schemes a host's locators use. */
export function schemesOf(host: RepositoryLocator): readonly string[] {
    return host.schemes ?? [host.id];
}

/** The ids of the hosts that read hosted locations, sorted, for messages. */
export function hostedIds(hosts: readonly RepositoryLocator[]): string[] {
    return hosts
        .filter((host) => host.defaultHost !== undefined)
        .map((host) => host.id)
        .sort();
}

/** Makes `refs.locations` over the hosts an entity reader holds. */
export function createRefsLocations(entities: EntityReader): RefsLocations {
    const hosts = (): RepositoryLocator[] => repositoryHosts(entities);
    const hostById = (id: string): RepositoryLocator | undefined => hosts().find((host) => host.id === id);
    const hostFor = (url: string): RepositoryLocator | undefined => hosts().find((host) => host.matches(url));

    /** A locator such as `github://o/r` as the HTTPS URL of the repository it names. */
    const asUrl = (url: string): { url: string; host?: RepositoryLocator } => {
        const scheme = SCHEME.exec(url.trim());

        if (scheme === null || URL_SCHEMES.has(scheme[1]!.toLowerCase())) {
            return { url };
        }

        const name = scheme[1]!.toLowerCase();
        const host = hosts().find((entry) => schemesOf(entry).includes(name));

        if (host?.defaultHost === undefined) {
            return { url };
        }

        const path = scheme[2]!.replace(/^\/+/, "");
        const first = path.split("/")[0] ?? "";
        const where = first.includes(".") ? path : `${host.defaultHost}/${path}`;

        return { url: `https://${where}`, host };
    };

    const requireHost = (url: string, provider?: string): RepositoryLocator => {
        const known = hosts().map((host) => host.id).join(", ") || "none";

        if (provider !== undefined) {
            const named = hostById(provider);

            if (named === undefined) {
                throw new ConfigError(`The repository at ${url} names the provider '${provider}', which sous does not have.`, {
                    details: [`Sous has these providers: ${known}.`],
                });
            }

            // A named host is honoured for a host nobody recognizes (a self-hosted instance). It is
            // refused only when a different host plainly owns the URL.
            if (!named.matches(url)) {
                const owner = hostFor(url);

                if (owner !== undefined && owner.id !== named.id) {
                    throw new ConfigError(`The ${named.id} provider does not handle ${url}; the ${owner.id} provider does.`, {
                        details: [`Drop '--provider' and let sous work it out, or name '${owner.id}'.`],
                    });
                }
            }

            return named;
        }

        const detected = hostFor(url);

        if (detected !== undefined) {
            return detected;
        }

        throw new ConfigError(`Sous does not recognize the host in the repository URL ${url}.`, {
            details: [
                `Sous has these providers: ${known}. For a self-hosted instance, name the provider that ` +
                    `host runs on the repository entry, as in 'sous repo add ${url} --provider <provider>'.`,
            ],
        });
    };

    const canonicalize = (url: string, provider?: string): CanonicalRepository => {
        const target = asUrl(url);
        const host = provider === undefined && target.host !== undefined ? target.host : requireHost(target.url, provider);

        return host.canonicalize(target.url);
    };

    return {
        fromUrl(url, provider) {
            try {
                const target = asUrl(url);
                const host = provider === undefined && target.host !== undefined ? target.host : requireHost(target.url, provider);
                const canonical = host.canonicalize(target.url);

                return {
                    provider: host.id,
                    host: canonical.host,
                    repoPath: `${canonical.owner}/${canonical.name}`,
                    identity: repositoryIdentity(canonical),
                    url,
                };
            } catch {
                return undefined;
            }
        },

        locationFor(provider, host, repoPath) {
            const reader = hostById(provider);

            if (reader === undefined) {
                throw new ConfigError(`No provider '${provider}' reads the repository ${host}/${repoPath}.`);
            }

            const url = `https://${host}/${repoPath}`;

            return { provider, host, repoPath, identity: repositoryIdentity(reader.canonicalize(url)), url };
        },

        canonicalize,
        identity: (url, provider) => repositoryIdentity(canonicalize(url, provider)),
        identityOf: (repository) => repositoryIdentity(repository),
        hostFor,
        host: hostById,
        hosts,
        shortName: shortNameFromIdentity,
    };
}

/** A location, or `undefined` when its host cannot read it (a path of one segment, say). */
export function tryLocationFor(locations: RefsLocations, provider: string, host: string, repoPath: string): RefLocation | undefined {
    try {
        return locations.locationFor(provider, host, repoPath);
    } catch {
        return undefined;
    }
}
