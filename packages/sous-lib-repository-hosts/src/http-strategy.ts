/**
 * The HTTP read strategies: one GET of one file, with or without a token,
 * through `host.http` (timed). Redirects are followed by hand, so a redirect to a sign-in page
 * is seen for what it is: a private repository.
 */

import type {
    RepositoryHostContext,
    RepositoryReadOutcome,
    RepositoryReadRequest,
    RepositoryToken,
} from "@sous-io/sous-plugin-recipes/types";
import type { HttpResponse } from "@sous-io/sous-plugin-host/types";
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
    /** True when the server may answer with a copy it cached for a while (`raw.githubusercontent.com`). */
    servesCachedCopies?: boolean;
    /** True when only a read that must see the current file uses it (GitHub's API without a token). */
    onlyForCurrentReads?: boolean;
    /**
     * For a server that sends no `ETag` but names the file's content hash in a header (GitLab's
     * `X-Gitlab-Content-Sha256`): the header, and the address a `HEAD` request reads it from. The
     * hash is kept as the cached copy's ETag, written `<header>:<hash>`, and a later read asks for
     * the header alone; the same hash answers "not modified" without downloading the file.
     */
    contentHash?: {
        header: string;
        url(request: RepositoryReadRequest): string;
    };
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
        ...(options.servesCachedCopies === true ? { servesCachedCopies: true } : {}),
        ...(options.onlyForCurrentReads === true ? { onlyForCurrentReads: true } : {}),

        async read(request, ctx) {
            const token = options.usesToken ? request.token : undefined;

            if (options.usesToken && token === undefined) {
                return { ok: false, reason: "no token found" };
            }

            const hashed = options.contentHash === undefined ? undefined : contentHashOf(options.contentHash.header, request.etag);
            const headers: Record<string, string> = {
                Accept: "application/json",
                ...options.headers?.(request),
                ...(request.etag === undefined || hashed !== undefined ? {} : { "If-None-Match": request.etag }),
            };
            const tokenHeaders = token === undefined ? {} : (options.authorization ?? bearer)(token);

            if (options.contentHash !== undefined && hashed !== undefined) {
                const unchanged = await sameContentHash(options.contentHash, hashed, headers, tokenHeaders, request, ctx);

                if (unchanged) {
                    return { ok: true, notModified: true, ...(request.etag === undefined ? {} : { etag: request.etag }) };
                }
            }

            return readOverHttp(options.url(request), headers, tokenHeaders, request, token !== undefined, ctx, options.contentHash?.header);
        },
    };
}

/**
 * The content hash a cached copy's ETag holds, when it was written by a strategy with a
 * `contentHash` header: `x-gitlab-content-sha256:ab12...` gives `ab12...`.
 */
function contentHashOf(header: string, etag: string | undefined): string | undefined {
    const prefix = `${header.toLowerCase()}:`;

    return etag !== undefined && etag.toLowerCase().startsWith(prefix) ? etag.slice(prefix.length) : undefined;
}

/**
 * Whether the file's content hash, read with one `HEAD` request, is still the cached copy's. Any
 * other answer (an error status, no header, no connection) is `false`, and the file is downloaded.
 */
async function sameContentHash(
    contentHash: NonNullable<HttpReadStrategyOptions["contentHash"]>,
    cached: string,
    headers: Record<string, string>,
    tokenHeaders: Record<string, string>,
    request: RepositoryReadRequest,
    ctx: RepositoryHostContext,
): Promise<boolean> {
    try {
        const response = await ctx.services.get("host.http").request({
            url: contentHash.url(request),
            method: "HEAD",
            headers: { ...headers, ...tokenHeaders },
            redirect: "manual",
            label: `check ${request.path} on ${request.repository.host}`,
            ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        });

        return response.status >= 200 && response.status < 300 && response.headers[contentHash.header.toLowerCase()] === cached;
    } catch {
        return false;
    }
}

/** `Authorization: Bearer <token>`. */
function bearer(token: RepositoryToken): Record<string, string> {
    return { Authorization: `Bearer ${token.value}` };
}

/**
 * Requests the file, following ordinary redirects by hand, and says what the answer means. The token
 * headers go only to the origin (scheme, host and port) the request started at: a redirect to
 * another origin is followed without them, as `fetch` itself does.
 */
async function readOverHttp(
    url: string,
    headers: Record<string, string>,
    tokenHeaders: Record<string, string>,
    request: RepositoryReadRequest,
    withToken: boolean,
    ctx: RepositoryHostContext,
    contentHashHeader?: string,
): Promise<RepositoryReadOutcome> {
    const http = ctx.services.get("host.http");
    const origin = new URL(url).origin;
    let address = url;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        let response: HttpResponse;

        try {
            response = await http.get(address, {
                headers: new URL(address).origin === origin ? { ...headers, ...tokenHeaders } : headers,
                redirect: "manual",
                label: `read ${request.path} from ${request.repository.host}`,
                ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
            });
        } catch (error) {
            const said = firstLine(error);

            // host.http's own wording already names the address and the cause (DNS, refused).
            return { ok: false, reason: /^Sous could not reach /.test(said) ? said.replace(/^Sous could not reach /, "could not reach ").replace(/\.$/, "") : `could not connect: ${said}` };
        }

        if (response.status === 304) {
            return { ok: true, notModified: true, ...etagOf(response) };
        }

        if (response.status >= 200 && response.status < 300) {
            return { ok: true, text: await response.text(), ref: request.ref, ...etagOf(response, contentHashHeader) };
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

        return { ok: false, reason: describeStatus(response, request, withToken), status: response.status };
    }

    return { ok: false, reason: `more than ${MAX_REDIRECTS} redirects` };
}

/**
 * The ETag of a response, as an object to spread. A response with no `ETag` but with the content
 * hash header gives that hash, written `<header>:<hash>`, so a later read can check it.
 */
function etagOf(response: HttpResponse, contentHashHeader?: string): { etag?: string } {
    const etag = response.headers["etag"];

    if (etag !== undefined) {
        return { etag };
    }

    const hash = contentHashHeader === undefined ? undefined : response.headers[contentHashHeader.toLowerCase()];

    return hash === undefined || hash.length === 0 ? {} : { etag: `${contentHashHeader!.toLowerCase()}:${hash}` };
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
