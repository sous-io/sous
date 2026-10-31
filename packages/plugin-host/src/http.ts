/**
 * `host.http`: HTTP requests, every one timed. Never throws for a status code; only when the
 * connection fails or the request runs out of time.
 */

import { SousError } from "@sous-io/plugin-api";
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
    const request = async (req: HttpRequest): Promise<HttpResponse> => {
        const fetchImpl = deps.fetch ?? (globalThis.fetch as FetchFunction | undefined);

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

            const reason = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);

            throw new HttpError(req.url, `Sous could not reach ${req.url}.`, { cause: error, details: [reason] });
        }
    };

    return {
        request,
        get: (url, options = {}) => request({ ...options, url }),
    };
}
