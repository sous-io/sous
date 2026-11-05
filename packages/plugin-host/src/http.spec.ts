import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttp, HttpError } from "./http.js";

describe("host.http against a local server", () => {
    let server: Server;
    let base: string;
    const http = createHttp();

    beforeAll(async () => {
        server = createServer((request, response) => {
            const url = request.url ?? "/";

            if (url === "/json") {
                response.setHeader("Content-Type", "application/json");
                response.setHeader("ETag", '"abc"');
                response.end('{"ok":true}');
            } else if (url === "/missing") {
                response.statusCode = 404;
                response.end("nothing here");
            } else if (url === "/redirect") {
                response.statusCode = 302;
                response.setHeader("Location", "/json");
                response.end();
            } else if (url === "/slow") {
                setTimeout(() => response.end("late"), 2000).unref();
            } else if (url === "/echo") {
                const chunks: Buffer[] = [];

                request.on("data", (chunk: Buffer) => chunks.push(chunk));
                request.on("end", () => response.end(`${request.method} ${request.headers.authorization} ${Buffer.concat(chunks).toString()}`));
            } else {
                response.end("hello");
            }
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

    /** A GET gives the status, lowercase headers, a timing and a body read as text, JSON or bytes. */
    it("should get text, json and bytes", async () => {
        const response = await http.get(`${base}/json`);

        expect(response.status).toBe(200);
        expect(response.headers["content-type"]).toBe("application/json");
        expect(response.headers.etag).toBe('"abc"');
        expect(response.durationMs).toBeGreaterThanOrEqual(0);
        expect(await response.json()).toEqual({ ok: true });
        expect(await response.text()).toBe('{"ok":true}');
        expect(new TextDecoder().decode(await response.bytes())).toBe('{"ok":true}');
    });

    /** A status code is data, not an error. */
    it("should not throw for a 404", async () => {
        const response = await http.get(`${base}/missing`);

        expect(response.status).toBe(404);
        expect(await response.text()).toBe("nothing here");
    });

    /** Redirects are followed by default and shown when asked. */
    it("should follow or show a redirect", async () => {
        const followed = await http.get(`${base}/redirect`);

        expect(followed.redirected).toBe(true);
        expect(followed.url).toBe(`${base}/json`);

        const manual = await http.request({ url: `${base}/redirect`, redirect: "manual" });

        expect(manual.status).toBe(302);
        expect(manual.headers.location).toBe("/json");
    });

    /** Method, headers and body reach the server. */
    it("should send the method, headers and body", async () => {
        const response = await http.request({ url: `${base}/echo`, method: "POST", headers: { Authorization: "Bearer t" }, body: "data" });

        expect(await response.text()).toBe("POST Bearer t data");
    });

    /** A request past its limit fails with a timeout. */
    it("should time out", async () => {
        const error = await http.get(`${base}/slow`, { timeoutMs: 50 }).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(HttpError);
        expect((error as HttpError).timedOut).toBe(true);
    });

    /** A caller's own signal cancels the request. */
    it("should stop when the caller aborts", async () => {
        const controller = new AbortController();
        const pending = http.get(`${base}/slow`, { signal: controller.signal }).catch((caught: unknown) => caught);

        controller.abort();

        expect(await pending).not.toBeInstanceOf(HttpError);
    });

    /** A closed port is a connection failure naming the address and the reason. */
    it("should fail when it cannot connect", async () => {
        const error = await http.get("http://127.0.0.1:1/").catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(HttpError);
        expect((error as HttpError).message).toContain("http://127.0.0.1:1/");
        expect((error as HttpError).timedOut).toBe(false);
    });

    /**
     * The message carries why the connection failed, so a caller that keeps only the message (the
     * read chain's attempt lines) keeps the cause too (#204 bug 20).
     *
     * GET http://sous-test.invalid/ -> "Sous could not reach http://sous-test.invalid/: getaddrinfo ENOTFOUND sous-test.invalid."
     */
    it("should name the cause of a failed connection in the message", async () => {
        const error = await http.get("http://sous-test.invalid/", { timeoutMs: 5000 }).catch((caught: unknown) => caught);

        expect((error as HttpError).message).toMatch(/^Sous could not reach http:\/\/sous-test\.invalid\/: getaddrinfo (ENOTFOUND|EAI_AGAIN) sous-test\.invalid\.$/);
    });
});

describe("host.http with a stand-in fetch", () => {
    /** The injected fetch is used, so tests never reach the network. */
    it("should use the fetch it is given", async () => {
        const http = createHttp({ fetch: async () => new Response("stub", { status: 201, statusText: "Created" }) });
        const response = await http.get("https://example.test/x");

        expect(response.status).toBe(201);
        expect(await response.text()).toBe("stub");
    });
});

describe("host.http through a proxy", () => {
    let target: Server;
    let proxy: Server;
    let targetPort = 0;
    let proxyUrl = "";
    /** What the proxy was asked for: a CONNECT's `host:port`, or an absolute URL. */
    const proxied: string[] = [];

    beforeAll(async () => {
        target = createServer((request, response) => response.end(`target saw ${request.url}`));
        await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
        targetPort = (target.address() as AddressInfo).port;

        // A tiny proxy: every request, whatever host it names, goes to the target server.
        proxy = createServer((request, response) => {
            proxied.push(request.url ?? "");
            response.end(`target saw ${new URL(request.url ?? "/").pathname}`);
        });
        proxy.on("connect", (request, socket) => {
            proxied.push(request.url ?? "");
            const upstream = connect(targetPort, "127.0.0.1", () => {
                socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
                upstream.pipe(socket);
                socket.pipe(upstream);
            });

            upstream.on("error", () => socket.destroy());
            socket.on("error", () => upstream.destroy());
        });
        await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
        proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
        proxy.closeAllConnections();
        target.closeAllConnections();
        await Promise.all([new Promise((resolve) => proxy.close(resolve)), new Promise((resolve) => target.close(resolve))]);
    });

    /**
     * With HTTP_PROXY set in sous's environment, a request goes through the proxy. The host name
     * cannot be resolved, so only the proxy can answer.
     *
     * env HTTP_PROXY=http://127.0.0.1:<proxy>; GET http://sous-proxy-test.invalid/index -> "target saw /index"
     */
    it("should send a request through HTTP_PROXY", async () => {
        proxied.length = 0;
        const http = createHttp({ env: () => ({ HTTP_PROXY: proxyUrl }) });
        const response = await http.get("http://sous-proxy-test.invalid/index");

        expect(await response.text()).toBe("target saw /index");
        expect(proxied.some((asked) => asked.includes("sous-proxy-test.invalid"))).toBe(true);
    });

    /**
     * The lowercase spelling counts too.
     *
     * env http_proxy=http://127.0.0.1:<proxy> -> the request goes through the proxy
     */
    it("should read the lowercase http_proxy", async () => {
        const http = createHttp({ env: () => ({ http_proxy: proxyUrl }) });

        expect(await (await http.get("http://sous-proxy-test.invalid/lower")).text()).toBe("target saw /lower");
    });

    /**
     * A host NO_PROXY names is requested directly, so here it cannot be resolved.
     *
     * env HTTP_PROXY=<proxy>, NO_PROXY=sous-proxy-test.invalid -> HttpError, and the proxy saw nothing
     */
    it("should go direct to a host NO_PROXY names", async () => {
        proxied.length = 0;
        const http = createHttp({ env: () => ({ HTTP_PROXY: proxyUrl, NO_PROXY: "sous-proxy-test.invalid" }) });
        const error = await http.get("http://sous-proxy-test.invalid/direct", { timeoutMs: 5000 }).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(HttpError);
        expect(proxied).toEqual([]);
    });
});
