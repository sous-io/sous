import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHttp } from "@sous-io/plugin-host";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RepositoryReadRequest } from "@sous-io/plugin-recipes/types";
import { httpReadStrategy, isSignInPage } from "./http-strategy.js";
import { hostContext, recordedHttp, type RecordedRoute } from "./testing.js";
import { canonicalRepository } from "./urls.js";

const URL = "https://example.com/file";
const request: RepositoryReadRequest = { repository: canonicalRepository("example.com", "o", "r"), path: "sous.index.json", ref: "HEAD" };

const withToken = httpReadStrategy({ id: "http-token", label: "HTTP with token", usesToken: true, url: () => URL });
const without = httpReadStrategy({ id: "http", label: "HTTP without token", usesToken: false, url: () => URL });

function ctxFor(routes: Record<string, RecordedRoute>) {
    const http = recordedHttp(routes);

    return { http, ctx: hostContext({ services: { "host.http": http } }) };
}

describe("httpReadStrategy()", () => {
    /**
     * A 200 gives the text, the ref asked for and the ETag sent.
     *
     * GET https://example.com/file -> 200, ETag "abc" -> { ok: true, text, ref: "HEAD", etag: "\"abc\"" }
     */
    it("should give the text and the ETag of a 200", async () => {
        const { ctx } = ctxFor({ [URL]: { status: 200, headers: { ETag: '"abc"' }, body: "{}" } });

        expect(await without.read(request, ctx)).toEqual({ ok: true, text: "{}", ref: "HEAD", etag: '"abc"' });
    });

    /**
     * The token goes in `Authorization: Bearer`; a cached ETag in `If-None-Match`; a 304 is "not modified".
     *
     * read({ ...request, token, etag: "\"abc\"" }) -> 304 -> { ok: true, notModified: true }
     */
    it("should send the token and the ETag, and read a 304 as not modified", async () => {
        const { http, ctx } = ctxFor({ [URL]: { status: 304, headers: { etag: '"abc"' } } });
        const outcome = await withToken.read({ ...request, etag: '"abc"', token: { value: "t0k", source: "GITLAB_TOKEN" } }, ctx);

        expect(outcome).toEqual({ ok: true, notModified: true, etag: '"abc"' });
        expect(http.requests[0]?.headers).toMatchObject({ Authorization: "Bearer t0k", "If-None-Match": '"abc"' });
        expect(http.requests[0]?.redirect).toBe("manual");
    });

    /**
     * A strategy that uses a token fails at once without one.
     *
     * withToken.read(request) // -> { ok: false, reason: "no token found" }
     */
    it("should fail without a token when it needs one", async () => {
        const { http, ctx } = ctxFor({});

        expect(await withToken.read(request, ctx)).toEqual({ ok: false, reason: "no token found" });
        expect(http.requests).toEqual([]);
    });

    /**
     * A redirect to a sign-in page means the repository is private; other redirects
     * are followed.
     *
     * 302 Location: https://gitlab.com/users/sign_in -> "302 to sign-in page: the repository is private"
     */
    it("should read a redirect to sign-in as private, and follow other redirects", async () => {
        const signIn = ctxFor({ [URL]: { status: 302, headers: { location: "https://gitlab.com/users/sign_in" } } });

        expect(await without.read(request, signIn.ctx)).toEqual({ ok: false, reason: "302 to sign-in page: the repository is private" });

        const moved = ctxFor({
            [URL]: { status: 301, headers: { location: "/moved" } },
            "https://example.com/moved": { status: 200, body: "moved" },
        });

        expect(await without.read(request, moved.ctx)).toMatchObject({ ok: true, text: "moved" });
    });

    /**
     * Error statuses become a few words, which differ with a token.
     *
     * 404 without token -> "404: no sous.index.json at HEAD, or the repository is private"
     */
    it("should describe error statuses", async () => {
        const token = { value: "t", source: "GITHUB_TOKEN" };
        const answer = async (status: number, withIt: boolean) => {
            const { ctx } = ctxFor({ [URL]: { status, statusText: "Teapot" } });

            return withIt ? withToken.read({ ...request, token }, ctx) : without.read(request, ctx);
        };

        expect(await answer(404, false)).toEqual({ ok: false, reason: "404: no sous.index.json at HEAD, or the repository is private" });
        expect(await answer(404, true)).toEqual({ ok: false, reason: "404: no sous.index.json at HEAD, or the token cannot read the repository" });
        expect(await answer(401, true)).toEqual({ ok: false, reason: "401: the token was refused" });
        expect(await answer(401, false)).toEqual({ ok: false, reason: "401: the repository is private" });
        expect(await answer(418, false)).toEqual({ ok: false, reason: "418 Teapot" });
    });

    /**
     * A failed connection is a failure, not a throw.
     *
     * // no route recorded -> { ok: false, reason: "could not connect: getaddrinfo ENOTFOUND ..." }
     */
    it("should turn a failed connection into a reason", async () => {
        const { ctx } = ctxFor({});
        const outcome = await without.read(request, ctx);

        expect(outcome.ok).toBe(false);
        expect(outcome.ok === false && outcome.reason).toMatch(/^could not connect: getaddrinfo ENOTFOUND/);
    });
});

describe("httpReadStrategy() redirects, against local servers", () => {
    const servers: Server[] = [];
    const seen: Array<{ server: string; url: string; headers: IncomingHttpHeaders }> = [];
    let first = "";
    let second = "";

    /** A server that records each request, and answers `/same` and `/cross` with a redirect. */
    async function listen(name: string): Promise<string> {
        const server = createServer((req, res) => {
            seen.push({ server: name, url: req.url ?? "/", headers: req.headers });

            if (req.url === "/same") {
                res.writeHead(302, { Location: "/file" }).end();
            } else if (req.url === "/cross") {
                res.writeHead(302, { Location: `${second}/file` }).end();
            } else {
                res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
            }
        });

        servers.push(server);
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

        return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }

    beforeAll(async () => {
        first = await listen("first");
        second = await listen("second");
    });

    afterAll(async () => {
        await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    });

    /** A token strategy that reads `path` from the first server, through the real `host.http`. */
    function readFrom(path: string) {
        const strategy = httpReadStrategy({ id: "http-token", label: "HTTP with token", usesToken: true, url: () => `${first}${path}` });

        return strategy.read({ ...request, token: { value: "s3cret", source: "GITLAB_TOKEN" } }, hostContext({ services: { "host.http": createHttp() } }));
    }

    /**
     * A redirect within the same origin (scheme, host and port) keeps the token.
     *
     * GET first/same (Authorization: Bearer s3cret) -> 302 /file -> GET first/file (Authorization: Bearer s3cret)
     */
    it("should keep the token on a redirect to the same origin", async () => {
        seen.length = 0;

        expect(await readFrom("/same")).toMatchObject({ ok: true, text: "{}" });
        expect(seen.map((one) => [one.server, one.url, one.headers.authorization])).toEqual([
            ["first", "/same", "Bearer s3cret"],
            ["first", "/file", "Bearer s3cret"],
        ]);
    });

    /**
     * A redirect to another origin drops the token, so it never reaches a host it was not meant for.
     *
     * GET first/cross (Authorization: Bearer s3cret) -> 302 second/file -> GET second/file (no Authorization)
     */
    /**
     * A failed connection keeps its cause (DNS, refused), not only "could not reach" (#204 bug 20).
     *
     * GET http://sous-test.invalid/sous.index.json
     * // -> { ok: false, reason: "could not reach http://sous-test.invalid/sous.index.json: getaddrinfo ENOTFOUND sous-test.invalid" }
     */
    it("should keep the cause of a failed connection in the reason", async () => {
        const strategy = httpReadStrategy({ id: "http", label: "HTTP without token", usesToken: false, url: () => "http://sous-test.invalid/sous.index.json" });
        const outcome = await strategy.read(request, hostContext({ services: { "host.http": createHttp() } }));

        expect(outcome.ok === false && outcome.reason).toMatch(/^could not reach http:\/\/sous-test\.invalid\/sous\.index\.json: getaddrinfo (ENOTFOUND|EAI_AGAIN) sous-test\.invalid$/);
    });

    it("should drop the token on a redirect to another origin", async () => {
        seen.length = 0;

        expect(await readFrom("/cross")).toMatchObject({ ok: true, text: "{}" });
        expect(seen.map((one) => [one.server, one.url, one.headers.authorization])).toEqual([
            ["first", "/cross", "Bearer s3cret"],
            ["second", "/file", undefined],
        ]);
    });
});

describe("isSignInPage()", () => {
    /**
     * isSignInPage("https://gitlab.com/users/sign_in"); // -> true
     */
    it("should recognize GitLab and GitHub sign-in pages", () => {
        expect(isSignInPage("https://gitlab.com/users/sign_in")).toBe(true);
        expect(isSignInPage("https://github.com/login?return_to=x")).toBe(true);
        expect(isSignInPage("https://example.com/moved")).toBe(false);
    });
});
