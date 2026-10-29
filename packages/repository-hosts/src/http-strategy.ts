/**
 * The HTTP read strategies (S4, "Read strategies"): one GET of one file, with or without a token,
 * through `host.http` (timed, L5). Redirects are followed by hand, so a redirect to a sign-in page
 * is seen for what it is: a private repository.
 */

import type {
    RepositoryHostContext,
    RepositoryReadOutcome,
    RepositoryReadRequest,
    RepositoryToken,
} from "@sous-io/plugin-recipes/types";
import type { HttpResponse } from "@sous-io/plugin-host/types";
import type { ExplainedReadStrategy } from "./types.js";

/** How many redirects are followed before giving up. */
const MAX_REDIRECTS = 3;

/** How an HTTP strategy is built. */
export interface HttpReadStrategyOptions {
    /** `http-token` or `http`. */
    id: string;
    /** `HTTP with token`. */
    label: string;
    /** True when it sends the token; it is skipped when none is found. */
    usesToken: boolean;
    /** The address of the file. */
    url(request: RepositoryReadRequest): string;
    /** More request headers, such as `Accept`. */
    headers?(request: RepositoryReadRequest): Record<string, string>;
    /** The header that carries the token. Default `Authorization: Bearer <token>`. */
    authorization?(token: RepositoryToken): Record<string, string>;
}

/**
 * A read strategy that GETs one file over HTTP.
 *
 * ```ts
 * httpReadStrategy({
 *     id: "http",
 *     label: "HTTP without token",
 *     usesToken: false,
 *     url: ({ repository, path, ref }) => `https://raw.githubusercontent.com/${repository.owner}/${repository.name}/${ref}/${path}`,
 * });
 * ```
 */
export function httpReadStrategy(options: HttpReadStrategyOptions): ExplainedReadStrategy {
    return {
        id: options.id,
        label: options.label,
        usesToken: options.usesToken,

        async read(request, ctx) {
            const token = options.usesToken ? request.token : undefined;

            if (options.usesToken && token === undefined) {
                return { ok: false, reason: "no token found" };
            }

            const headers: Record<string, string> = {
                Accept: "application/json",
                ...options.headers?.(request),
                ...(token === undefined ? {} : (options.authorization ?? bearer)(token)),
                ...(request.etag === undefined ? {} : { "If-None-Match": request.etag }),
            };

            return readOverHttp(options.url(request), headers, request, token !== undefined, ctx);
        },
    };
}

/** `Authorization: Bearer <token>`. */
function bearer(token: RepositoryToken): Record<string, string> {
    return { Authorization: `Bearer ${token.value}` };
}

/** Requests the file, following ordinary redirects by hand, and says what the answer means. */
async function readOverHttp(
    url: string,
    headers: Record<string, string>,
    request: RepositoryReadRequest,
    withToken: boolean,
    ctx: RepositoryHostContext,
): Promise<RepositoryReadOutcome> {
    const http = ctx.services.get("host.http");
    let address = url;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        let response: HttpResponse;

        try {
            response = await http.get(address, {
                headers,
                redirect: "manual",
                label: `read ${request.path} from ${request.repository.host}`,
                ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
            });
        } catch (error) {
            return { ok: false, reason: `could not connect: ${firstLine(error)}` };
        }

        if (response.status === 304) {
            return { ok: true, notModified: true, ...etagOf(response) };
        }

        if (response.status >= 200 && response.status < 300) {
            return { ok: true, text: await response.text(), ref: request.ref, ...etagOf(response) };
        }

        if (response.status >= 300 && response.status < 400) {
            const location = response.headers["location"];

            if (location === undefined) {
                return { ok: false, reason: `${response.status} redirect with no address` };
            }

            if (isSignInPage(location)) {
                return { ok: false, reason: `${response.status} to sign-in page: the repository is private` };
            }

            address = new URL(location, address).toString();
            continue;
        }

        return { ok: false, reason: describeStatus(response, request, withToken) };
    }

    return { ok: false, reason: `more than ${MAX_REDIRECTS} redirects` };
}

/** The ETag of a response, as an object to spread. */
function etagOf(response: HttpResponse): { etag?: string } {
    const etag = response.headers["etag"];

    return etag === undefined ? {} : { etag };
}

/**
 * Whether a redirect goes to a sign-in page.
 *
 * ```ts
 * isSignInPage("https://gitlab.com/users/sign_in"); // true
 * isSignInPage("https://github.com/login?return_to=..."); // true
 * ```
 */
export function isSignInPage(location: string): boolean {
    return /\/(users\/)?sign[_-]?in\b|\/login\b|\/session\b/i.test(location);
}

/** What an error status means, in a few words. */
function describeStatus(response: HttpResponse, request: RepositoryReadRequest, withToken: boolean): string {
    const { status } = response;
    const file = `no ${request.path} at ${request.ref}`;

    switch (status) {
        case 401:
            return withToken ? "401: the token was refused" : "401: the repository is private";
        case 403:
            return withToken ? "403: the token cannot read this repository" : "403: the repository is private, or the host refused the request";
        case 404:
            return withToken ? `404: ${file}, or the token cannot read the repository` : `404: ${file}, or the repository is private`;
        case 429:
            return "429: too many requests; try again later";
        default:
            return `${status} ${response.statusText}`.trim();
    }
}

/** The first line of an error's message. */
export function firstLine(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);

    return message.split("\n")[0]!.trim();
}
