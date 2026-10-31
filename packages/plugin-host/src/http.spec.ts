import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
