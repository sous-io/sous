/**
 * Asks the npm registry which versions of sous are published.
 *
 * One request: a GET of the package's abbreviated document, the same small
 * answer an install reads. Finding out what is published is the point of an
 * update, so a registry that cannot be reached is an error, never a warning.
 * The fetch is injectable, so no test reaches the network.
 */

import { PACKAGE_NAME } from "../project-install.mjs";
import { fetchText, type FetchLike } from "../repos/providers/http.js";
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
 * The registry base URL, always ending in `/`: the first non-blank value of
 * `REGISTRY_ENV_NAMES`, or `DEFAULT_REGISTRY`. npm sets `npm_config_registry`
 * for the scripts it runs, so a project's `.npmrc` registry reaches sous that
 * way too.
 *
 * registryBaseUrl({ npm_config_registry: "https://npm.example.com" })
 * // -> "https://npm.example.com/"
 */
export function registryBaseUrl(env: Readonly<Record<string, string | undefined>>): string {
  for (const name of REGISTRY_ENV_NAMES) {
    const value = env[name]?.trim();
    if (value !== undefined && value.length > 0) {
      return value.endsWith("/") ? value : `${value}/`;
    }
  }
  return DEFAULT_REGISTRY;
}

/**
 * The URL of the package's document on a registry. The scope's slash is
 * encoded, which every registry accepts.
 *
 * packageMetadataUrl("https://registry.npmjs.org/")
 * // -> "https://registry.npmjs.org/@sous-io%2fsous"
 */
export function packageMetadataUrl(base: string): string {
  return `${base}${PACKAGE_NAME.replace("/", "%2f")}`;
}

/** Options for `fetchPublishedVersions`. */
export type FetchPublishedVersionsOptions = {
  /** Where the registry override is read from. Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** The fetch implementation. Defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** How long to wait for an answer. Defaults to `REGISTRY_TIMEOUT_MS`. */
  timeoutMs?: number;
};

/**
 * Fetches and reads what the registry publishes for `@sous-io/sous`.
 *
 * @throws ConfigError naming the URL and quoting the reason when the registry
 *   cannot be reached, answers with an error status, runs past the timeout, or
 *   sends something that is not a package document.
 */
export async function fetchPublishedVersions(
  options: FetchPublishedVersionsOptions = {}
): Promise<RegistryMetadata> {
  const url = packageMetadataUrl(registryBaseUrl(options.env ?? process.env));
  const fetched = await fetchText(url, {
    label: `list of published ${PACKAGE_NAME} versions`,
    accept: ABBREVIATED_METADATA_TYPE,
    signal: AbortSignal.timeout(options.timeoutMs ?? REGISTRY_TIMEOUT_MS),
    statusHints: registryStatusHints,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  return parseRegistryMetadata(fetched.text, url);
}

/** What a failed status usually means when the URL is the package's document. */
function registryStatusHints(status: number): string[] {
  if (status === 404) {
    return [
      `  The registry has no package named ${PACKAGE_NAME}. When npm_config_registry ` +
        "names a mirror, the mirror may not carry it.",
    ];
  }
  if (status === 401 || status === 403) {
    return ["  The registry refused the request without credentials, and sous sends none."];
  }
  return [];
}
