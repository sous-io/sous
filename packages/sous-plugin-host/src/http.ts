/**
 * `host.http`: HTTP requests, every one timed. Never throws for a status code; only when the
 * connection fails or the request runs out of time.
 *
 * Node's global `fetch` ignores the proxy variables, so when sous's environment sets
 * `HTTPS_PROXY`, `HTTP_PROXY` (or their lowercase spellings), a request goes through undici's
 * `EnvHttpProxyAgent` instead, which also honors `NO_PROXY`.
 */

import { SousError, type Environment } from "@sous-io/plugin-api";
import type { HostHttp, HttpRequest, HttpResponse } from "./types.js";

/** How long a request may take when it names no limit. */
export const DEFAULT_HTTP_TIMEOUT_MS = 15_000;

/** The `fetch` this service needs; the global one satisfies it. */
export type FetchFunction = (url: string, init: RequestInit) => Promise<Response>;

/** A request could not be made: no connection, or no answer in time. */
export class HttpError extends SousError {
    /** The address that was requested. */
    readonly url: string;
    /** True when the request ran out of time. */
    readonly timedOut: boolean;

    constructor(url: string, message: string, options: { cause?: unknown; timedOut?: boolean; details?: readonly string[] } = {}) {
        super(message, { cause: options.cause, details: options.details });
        this.url = url;
        this.timedOut = options.timedOut ?? false;
    }
}

/** What the service needs to be made. */
export interface HttpDeps {
    /** Replaces the global `fetch`, so tests never reach the network. */
    fetch?: FetchFunction;
    /** The environment the proxy variables are read from, on every request. Default: none. */
    env?: () => Environment;
}

/** The proxy settings in an environment; the lowercase spelling wins, as curl and undici read them. */
export interface ProxySettings {
    readonly httpProxy: string;
    readonly httpsProxy: string;
    readonly noProxy: string;
}

/**
 * The proxy variables an environment sets, or `undefined` when it names no proxy.
 *
 * ```ts
 * proxySettings({ HTTPS_PROXY: "http://proxy:3128", NO_PROXY: "localhost" });
 * // -> { httpProxy: "", httpsProxy: "http://proxy:3128", noProxy: "localhost" }
 * ```
 */
export function proxySettings(env: Environment): ProxySettings | undefined {
    const read = (name: string): string => (env[name.toLowerCase()] ?? env[name.toUpperCase()] ?? "").trim();
    const settings = { httpProxy: read("HTTP_PROXY"), httpsProxy: read("HTTPS_PROXY"), noProxy: read("NO_PROXY") };

    return settings.httpProxy === "" && settings.httpsProxy === "" ? undefined : settings;
}

/** A `fetch` that goes through the proxies, made once for each set of settings. */
async function proxiedFetch(settings: ProxySettings, made: Map<string, FetchFunction>): Promise<FetchFunction> {
    const key = JSON.stringify(settings);
    const existing = made.get(key);

    if (existing !== undefined) {
        return existing;
    }

    // Loaded only when a proxy is set, so an ordinary start-up never pays for it.
    const undici = await import("undici");
    // Empty strings, never undefined: undici would otherwise read process.env, not sous's environment.
    const dispatcher = new undici.EnvHttpProxyAgent(settings);
    const proxied: FetchFunction = (url, init) => undici.fetch(url, { ...(init as object), dispatcher } as Parameters<typeof undici.fetch>[1]) as unknown as Promise<Response>;

    made.set(key, proxied);

    return proxied;
}

/**
 * Why a connection failed, in the words of the error under `fetch failed`.
 *
 * ```ts
 * connectionReason(new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND gitlab.com") }));
 * // -> "getaddrinfo ENOTFOUND gitlab.com"
 * ```
 */
export function connectionReason(error: unknown): string {
    if (!(error instanceof Error)) {
        return String(error);
    }

    const cause = error.cause;

    if (cause instanceof Error) {
        const nested = (cause as { errors?: unknown }).errors;

        if (cause.message.trim() !== "") {
            return cause.message.trim();
        }

        if (Array.isArray(nested) && nested[0] instanceof Error && nested[0].message.trim() !== "") {
            return nested[0].message.trim();
        }

        const code = (cause as { code?: unknown }).code;

        if (typeof code === "string") {
            return code;
        }
    }

    return error.message;
}

/** The response headers as a plain object with lowercase names. */
function headersOf(headers: Headers): Record<string, string> {
    const plain: Record<string, string> = {};

    headers.forEach((value, name) => {
        plain[name.toLowerCase()] = value;
    });

    return plain;
}

/** Wraps a `fetch` response; the body is read once and kept. */
function wrap(response: Response, durationMs: number, requested: string): HttpResponse {
    let body: Promise<Uint8Array> | undefined;
    const read = (): Promise<Uint8Array> => (body ??= response.arrayBuffer().then((buffer) => new Uint8Array(buffer)));

    return {
        status: response.status,
        statusText: response.statusText,
        url: response.url || requested,
        redirected: response.redirected,
        headers: headersOf(response.headers),
        durationMs,
        async text() {
            return new TextDecoder().decode(await read());
        },
        async json<T = unknown>() {
            return JSON.parse(new TextDecoder().decode(await read())) as T;
        },
        bytes: read,
    };
}

/** Makes the `host.http` service. */
export function createHttp(deps: HttpDeps = {}): HostHttp {
    const proxied = new Map<string, FetchFunction>();

    const request = async (req: HttpRequest): Promise<HttpResponse> => {
        const proxy = deps.fetch === undefined && deps.env !== undefined ? proxySettings(deps.env()) : undefined;
        const fetchImpl = deps.fetch ?? (proxy === undefined ? (globalThis.fetch as FetchFunction | undefined) : await proxiedFetch(proxy, proxied));

        if (typeof fetchImpl !== "function") {
            throw new HttpError(req.url, `Sous cannot fetch ${req.url}: this Node runtime provides no global fetch. Sous requires Node 22 or newer.`);
        }

        const timeoutMs = req.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
        const timeout = AbortSignal.timeout(timeoutMs);
        const startedAt = performance.now();
        const init: RequestInit = {
            method: req.method ?? "GET",
            headers: req.headers === undefined ? undefined : { ...req.headers },
            body: req.body as RequestInit["body"],
            redirect: req.redirect ?? "follow",
            signal: req.signal === undefined ? timeout : AbortSignal.any([timeout, req.signal]),
        };

        try {
            const response = await fetchImpl(req.url, init);

            return wrap(response, performance.now() - startedAt, req.url);
        } catch (error) {
            if (timeout.aborted) {
                throw new HttpError(req.url, `The request to ${req.url} did not finish within ${Math.round(timeoutMs / 1000)} seconds.`, {
                    cause: error,
                    timedOut: true,
                });
            }

            if (req.signal?.aborted === true) {
                throw error;
            }

            // The reason is part of the message, so a caller that keeps only the message keeps it too.
            throw new HttpError(req.url, `Sous could not reach ${req.url}: ${connectionReason(error)}.`, { cause: error });
        }
    };

    return {
        request,
        get: (url, options = {}) => request({ ...options, url }),
    };
}
