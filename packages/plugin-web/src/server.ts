/**
 * `web.serve`: serves the web editor on 127.0.0.1 and runs the browser's intents over one
 * WebSocket.
 *
 * Security. The socket can run any intent, so only the page sous opened may use it:
 * - the server listens on 127.0.0.1 only;
 * - a socket's first message must carry the random token, which reaches the page in the URL's
 *   fragment (`#token=...`), so it is never sent in a request or written to a log;
 * - a socket whose `Origin` is not this server is refused, because browsers apply no cross-site
 *   rules to WebSockets and any page could otherwise open one.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CancelledError, IntentOutputs, SousError, toJsonSchema, type BuiltConfig, type Context, type IntentOutputs as Outputs } from "@sous-io/plugin-api";
import type {} from "@sous-io/plugin-build/types";
import type {} from "@sous-io/plugin-host/types";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage, IntentSummary, PreviewSetting, ServerMessage } from "./protocol.js";
import { SocketPrompter, SocketReporter } from "./socket-io.js";

export interface ServeInput {
    port?: number;
    launch?: boolean;
}

export type ServeResult = {
    url: string;
    port: number;
};

const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".json": "application/json",
};

/** Where the built frontend is: `web/dist` next to this plugin's `dist`. */
function distDir(): string {
    return fileURLToPath(new URL("../web/dist", import.meta.url));
}

function sameToken(given: unknown, token: string): boolean {
    if (typeof given !== "string" || given.length !== token.length) {
        return false;
    }

    return timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

function listen(server: http.Server, port: number, tries: number): Promise<number> {
    return new Promise((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException) => {
            server.off("listening", onListening);

            if (error.code === "EADDRINUSE" && tries > 1) {
                resolve(listen(server, port + 1, tries - 1));
            } else {
                reject(error);
            }
        };
        const onListening = () => {
            server.off("error", onError);
            resolve(port);
        };

        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
    });
}

function serveStatic(root: string, req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const requested = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
    const inside = requested === root || requested.startsWith(root + path.sep);
    const file = inside && existsSync(requested) && statSync(requested).isFile() ? requested : path.join(root, "index.html");

    if (!existsSync(file)) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end(`The web editor is not built. Run: pnpm --filter @sous-io/plugin-web build`);

        return;
    }

    res.writeHead(200, {
        "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
        "cache-control": file.endsWith("index.html") ? "no-store" : "max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
    });
    createReadStream(file).pipe(res);
}

function describeIntents(ctx: Context): IntentSummary[] {
    return ctx.engine.intents.list().map(({ definition, plugin }) => {
        const summary: IntentSummary = {
            intent: definition.intent,
            plugin,
            readOnly: typeof definition.readOnly === "function" ? "depends" : definition.readOnly === true,
            internal: definition.internal === true,
            background: definition.background === true,
        };

        if (definition.summary !== undefined) summary.summary = definition.summary;
        if (definition.input !== undefined) summary.input = toJsonSchema(definition.input);

        return summary;
    });
}


function errorOf(error: unknown): { message: string; kind?: string; details?: string[]; cancelled?: boolean } {
    if (error instanceof CancelledError) {
        return { message: error.message, kind: "cancelled", cancelled: true };
    }

    if (error instanceof SousError) {
        const result: { message: string; kind?: string; details?: string[] } = { message: error.message, kind: error.sousErrorKind };

        if (error.details.length > 0) result.details = [...error.details];

        return result;
    }

    return { message: error instanceof Error ? error.message : String(error) };
}

/** One browser tab's socket: its runs, their cancel signals and their questions. */
class Session {
    private readonly runs = new Map<number, { controller: AbortController; prompter: SocketPrompter }>();
    private trusted = false;

    constructor(
        private readonly socket: WebSocket,
        private readonly ctx: Context,
        private readonly token: string,
        private readonly whatIf: (settings: PreviewSetting[]) => Promise<BuiltConfig>,
    ) {
        // A socket that does not say the token within 5 seconds is closed.
        const timer = setTimeout(() => this.trusted || socket.close(4401, "No token"), 5000);

        socket.on("message", (raw) => void this.receive(String(raw)));
        socket.on("close", () => {
            clearTimeout(timer);

            for (const run of this.runs.values()) {
                run.controller.abort(new Error("The browser closed the connection."));
                run.prompter.abandon();
            }

            this.runs.clear();
        });
    }

    get isTrusted(): boolean {
        return this.trusted;
    }

    send(message: ServerMessage): void {
        if (this.socket.readyState === this.socket.OPEN) {
            this.socket.send(JSON.stringify(message));
        }
    }

    private async receive(raw: string): Promise<void> {
        let message: ClientMessage;

        try {
            message = JSON.parse(raw) as ClientMessage;
        } catch {
            return;
        }

        if (!this.trusted) {
            if (message.type === "hello" && sameToken(message.token, this.token)) {
                this.trusted = true;
                this.send({
                    type: "ready",
                    project: this.ctx.project ? { name: path.basename(this.ctx.project.root), root: this.ctx.project.root } : null,
                    sous: { version: this.ctx.engine.app.version },
                    intents: describeIntents(this.ctx),
                });
            } else {
                this.socket.close(4401, "Wrong token");
            }

            return;
        }

        switch (message.type) {
            case "run":
                await this.run(message.id, message.intent, message.input, message.preview);
                break;
            case "answer":
                this.runs.get(message.id)?.prompter.answer(message.ask, message.value, message.cancelled === true);
                break;
            case "cancel":
                this.runs.get(message.id)?.controller.abort(new Error("Cancelled in the browser."));
                break;
        }
    }

    private async run(id: number, intent: string, input: unknown, preview: PreviewSetting[] | undefined): Promise<void> {
        const started = performance.now();
        const controller = new AbortController();
        const send = (message: ServerMessage) => this.send(message);
        const prompter = new SocketPrompter(id, send);

        this.runs.set(id, { controller, prompter });

        try {
            const config = preview && preview.length > 0 ? await this.whatIf(preview) : undefined;
            const outputs: Outputs = await this.ctx.engine.submit(
                { intent, input: (input ?? {}) as never },
                {
                    reporter: new SocketReporter(id, send),
                    prompter,
                    signal: controller.signal,
                    cwd: this.ctx.project?.root ?? this.ctx.cwd,
                    ...(config ? { config } : {}),
                },
            );

            this.send({ type: "result", id, ok: true, data: outputs.toPlain(), ms: Math.round(performance.now() - started) });
        } catch (error) {
            this.send({ type: "result", id, ok: false, error: errorOf(error), ms: Math.round(performance.now() - started) });
        } finally {
            prompter.abandon();
            this.runs.delete(id);
        }
    }
}

export async function serveWeb(input: ServeInput, ctx: Context): Promise<Outputs<ServeResult>> {
    const token = ctx.env.SOUS_SERVE_TOKEN ?? randomBytes(16).toString("hex");
    const root = distDir();
    const server = http.createServer((req, res) => serveStatic(root, req, res));
    const sockets = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
    const sessions = new Set<Session>();
    const port = await listen(server, input.port ?? 4777, 10);
    const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...(ctx.env.SOUS_SERVE_ORIGINS ?? "").split(",").filter(Boolean)]);

    const whatIf = (settings: PreviewSetting[]) =>
        ctx.engine.buildConfig({
            extraContributors: [
                {
                    id: "web/preview",
                    contribute(config) {
                        for (const setting of settings) {
                            config.atPath(setting.path).set(setting.value as never);
                        }
                    },
                },
            ],
        });

    const broadcast = (message: ServerMessage) => {
        for (const session of sessions) {
            if (session.isTrusted) session.send(message);
        }
    };

    server.on("upgrade", (req, socket, head) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");

        if (url.pathname !== "/ws" || !origins.has(String(req.headers.origin ?? ""))) {
            socket.write("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
            socket.destroy();

            return;
        }

        sockets.handleUpgrade(req, socket, head, (ws) => {
            const session = new Session(ws, ctx, token, whatIf);

            sessions.add(session);
            ws.on("close", () => sessions.delete(session));
        });
    });

    // Files changing on disk: the config is rebuilt before the next chain, and every tab is told.
    const watcher = ctx.services.get("build.watcher").watch({ outputs: true }, (batch) => {
        if (batch.config) {
            ctx.configChanged();
            broadcast({ type: "event", name: "config.changed", data: {} });
        }

        broadcast({ type: "event", name: "files.changed", data: batch });
    });

    const url = `http://127.0.0.1:${port}/#token=${token}`;

    ctx.reporter.info(`The web editor is at ${url}`);
    ctx.reporter.info("Press Ctrl+C to stop.");

    if (input.launch !== false) {
        const [command, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];

        // Opening a browser is a convenience: the URL is printed either way.
        ctx.services
            .get("host.processes")
            .run(command as string, args as string[])
            .catch(() => {});
    }

    await new Promise<void>((resolve) => {
        const stop = () => resolve();

        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        ctx.signal.addEventListener("abort", stop, { once: true });
    });

    await watcher.close();

    for (const client of sockets.clients) client.close(1001, "sous serve stopped");

    await new Promise<void>((resolve) => server.close(() => resolve()));

    return IntentOutputs.of<ServeResult>({ url: `http://127.0.0.1:${port}/`, port });
}
