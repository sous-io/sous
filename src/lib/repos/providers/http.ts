/**
 * The tiny HTTPS client the providers use to fetch a repo's index file.
 *
 * Only one kind of request is ever made: a plain GET of a raw file, optionally
 * carrying a bearer token so private repositories work. `fetch` is Node's own
 * global, and it is injectable so tests never reach the network.
 */

import { ConfigError } from "../../errors.js";

/** The shape of `fetch` this module needs; the global satisfies it. */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
  headers: { get: (name: string) => string | null };
}>;

/** What a successful raw-file GET returns. */
export type FetchedText = {
  /** The file's contents. */
  text: string;
  /** The entity tag the server sent, when it sent one. */
  etag?: string;
};

/** Options for a raw-file GET. */
export type FetchTextOptions = {
  /** A bearer token, when one is available for the host. */
  token?: string;
  /** The fetch implementation to use. Defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** What the URL is, named in error messages (for example "repo index"). */
  label?: string;
  /** Cancels the request, for a caller that will not wait past a deadline. */
  signal?: AbortSignal;
  /** The `Accept` header to send. Defaults to `application/json`. */
  accept?: string;
  /**
   * The lines that explain a failed status to the reader. Defaults to the
   * hints about a sous repository (a missing index, a private repository), so
   * a caller fetching anything else names its own.
   */
  statusHints?: (status: number) => string[];
};

/**
 * What a failed status usually means when the URL names a file in a sous
 * repository: the default for `FetchTextOptions.statusHints`.
 *
 * @param status - The HTTP status the server answered with.
 */
function repositoryStatusHints(status: number): string[] {
  if (status === 404) {
    return [
      "  Either the repository publishes no sous index yet, or the URL names a " +
        "repository that does not exist.",
    ];
  }
  if (status === 401 || status === 403) {
    return [
      "  The repository is private or the request was not authorized. Sous uses a " +
        "token from the environment, or from the provider's command line tool when " +
        "one is installed and signed in.",
    ];
  }
  return [];
}

/**
 * GETs a URL and returns its body as text. Any non-2xx response, or a transport
 * failure, becomes a ConfigError that names the URL and the status, and says
 * plainly what the status usually means (for a sous repository, unless the
 * caller passes `statusHints`).
 *
 * @param url - The absolute HTTPS URL to fetch.
 * @param options - Bearer token, fetch implementation, error label, `Accept`
 *   header and status hints.
 */
export async function fetchText(
  url: string,
  options: FetchTextOptions = {}
): Promise<FetchedText> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const label = options.label ?? "file";

  if (typeof fetchImpl !== "function") {
    throw new ConfigError(
      `Sous cannot fetch the ${label} at ${url}: this Node runtime provides no global fetch.\n` +
        `  Sous requires Node 22 or newer.`
    );
  }

  const headers: Record<string, string> = { Accept: options.accept ?? "application/json" };
  if (options.token !== undefined && options.token.length > 0) {
    headers["Authorization"] = `Bearer ${options.token}`;
  }

  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(
      url,
      options.signal === undefined ? { headers } : { headers, signal: options.signal }
    );
  } catch (error) {
    throw new ConfigError(
      `Sous could not reach ${url} while fetching the ${label}.\n` +
        `  ${(error as Error).message}`
    );
  }

  if (!response.ok) {
    const lines = [
      `Sous could not fetch the ${label} from ${url}.`,
      `  The server answered ${response.status} ${response.statusText}.`,
    ];
    lines.push(...(options.statusHints ?? repositoryStatusHints)(response.status));
    throw new ConfigError(lines.join("\n"));
  }

  const text = await response.text();
  const etag = response.headers.get("etag");
  return etag === null ? { text } : { text, etag };
}
