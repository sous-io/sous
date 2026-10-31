/**
 * Asks the npm registry which versions of sous are published.
 *
 * One request: a GET of the package's abbreviated document, the same small answer an install
 * reads. Finding out what is published is the point of an update, so a registry that cannot be
 * reached is an error, never a warning. The request goes through `host.http`, so it is timed and
 * a test never reaches the network.
 */

import { ConfigError, type Environment } from "@sous-io/plugin-api";
import type { HostHttp } from "@sous-io/plugin-host/types";
import { PACKAGE_NAME } from "./installs.js";
import { parseRegistryMetadata, type RegistryMetadata } from "./versions.js";

/** The registry sous asks when the environment names no other. */
export const DEFAULT_REGISTRY = "https://registry.npmjs.org/";

/** The media type of the abbreviated package document. */
export const ABBREVIATED_METADATA_TYPE = "application/vnd.npm.install-v1+json";

/** How long the registry has to answer before the request is abandoned. */
export const REGISTRY_TIMEOUT_MS = 15_000;

/** The environment variables that name another registry, in the order they are read. */
export const REGISTRY_ENV_NAMES = ["npm_config_registry", "NPM_CONFIG_REGISTRY"] as const;

/**
 * The registry base URL, always ending in `/`: the first non-blank value of `REGISTRY_ENV_NAMES`,
 * or `DEFAULT_REGISTRY`. npm sets `npm_config_registry` for the scripts it runs, so a project's
 * `.npmrc` registry reaches sous that way too.
 *
 * ```ts
 * registryBaseUrl({ npm_config_registry: "https://npm.example.com" }); // "https://npm.example.com/"
 * ```
 */
export function registryBaseUrl(env: Environment): string {
    for (const name of REGISTRY_ENV_NAMES) {
        const value = env[name]?.trim();

        if (value !== undefined && value.length > 0) {
            return value.endsWith("/") ? value : `${value}/`;
        }
    }

    return DEFAULT_REGISTRY;
}

/**
 * The URL of the package's document on a registry. The scope's slash is encoded, which every
 * registry accepts.
 *
 * ```ts
 * packageMetadataUrl("https://registry.npmjs.org/"); // "https://registry.npmjs.org/@sous-io%2fsous"
 * ```
 */
export function packageMetadataUrl(base: string): string {
    return `${base}${PACKAGE_NAME.replace("/", "%2f")}`;
}

/** The registry URL an update reads, for front ends to show. */
export function registryUrl(env: Environment): string {
    return packageMetadataUrl(registryBaseUrl(env));
}

/**
 * Fetches and reads what the registry publishes for `@sous-io/sous`.
 *
 * @throws ConfigError naming the URL and giving the reason when the registry cannot be reached,
 *   answers with an error status, or sends something that is not a package document.
 */
export async function fetchPublishedVersions(http: HostHttp, env: Environment): Promise<RegistryMetadata> {
    const url = registryUrl(env);
    let text: string;

    try {
        const response = await http.get(url, {
            headers: { accept: ABBREVIATED_METADATA_TYPE },
            timeoutMs: REGISTRY_TIMEOUT_MS,
            label: `list of published ${PACKAGE_NAME} versions`,
        });

        if (response.status < 200 || response.status >= 300) {
            throw new ConfigError(`The registry answered ${response.status} ${response.statusText} for ${url}.`, {
                details: statusHints(response.status),
            });
        }

        text = await response.text();
    } catch (error) {
        if (error instanceof ConfigError) {
            throw error;
        }

        throw new ConfigError(`Could not read the list of published ${PACKAGE_NAME} versions from ${url}.`, {
            details: [error instanceof Error ? error.message : String(error)],
            cause: error,
        });
    }

    return parseRegistryMetadata(text, url);
}

/** What a failed status usually means when the URL is the package's document. */
function statusHints(status: number): string[] {
    if (status === 404) {
        return [
            `The registry has no package named ${PACKAGE_NAME}. When npm_config_registry names a mirror, the mirror may not carry it.`,
        ];
    }

    if (status === 401 || status === 403) {
        return ["The registry refused the request without credentials, and sous sends none."];
    }

    return [];
}
