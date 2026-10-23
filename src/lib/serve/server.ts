/**
 * PROOF OF CONCEPT for `sous serve`. A small HTTP server for the web editor:
 * it serves the built frontend (web/dist) and a JSON API.
 *
 * It listens on 127.0.0.1 only, and every API call must carry the random token
 * printed in the URL, because the API returns variable values.
 *
 * API:
 *   GET  /api/workspace                -> project, files (without vars)
 *   GET  /api/file?id=<id>             -> file content, its variables, and a first render
 *   POST /api/render {id, source}      -> a render of the edited source
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { renderTemplate } from "./render.js";
import type { Workspace } from "./workspace.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export function maskVars(vars: Record<string, string>, secretNames: string[]): Record<string, string> {
  const secret = new Set(secretNames);
  const looksSecret = /(secret|token|password|api[_-]?key|private)/i;
  return Object.fromEntries(
    Object.entries(vars).map(([k, v]) => [k, secret.has(k) || looksSecret.test(k) ? "••••••" : v])
  );
}

export function createServer(workspace: Workspace, distDir: string, token: string): http.Server {
  const fileById = new Map(workspace.files.map((f) => [f.id, f]));

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname.startsWith("/api/")) {
      if (req.headers["x-sous-token"] !== token) return sendJson(res, 401, { error: "Missing or wrong token" });
      try {
        if (url.pathname === "/api/workspace") {
          return sendJson(res, 200, {
            projectName: workspace.projectName,
            projectRoot: workspace.projectRoot,
            branch: workspace.branch,
            files: workspace.files.map(({ vars: _vars, virtualContent: _content, ...rest }) => rest),
          });
        }
        if (url.pathname === "/api/file") {
          const file = fileById.get(url.searchParams.get("id") ?? "");
          if (!file) return sendJson(res, 404, { error: "No such file" });
          const content = file.virtualContent ?? fs.readFileSync(file.path, "utf8");
          const render = await renderTemplate(workspace, file, content);
          return sendJson(res, 200, {
            content,
            vars: maskVars(file.vars, workspace.secretNames),
            secretNames: workspace.secretNames,
            render,
          });
        }
        if (url.pathname === "/api/render" && req.method === "POST") {
          const { id, source } = JSON.parse(await readBody(req)) as { id: string; source: string };
          const file = fileById.get(id);
          if (!file) return sendJson(res, 404, { error: "No such file" });
          return sendJson(res, 200, await renderTemplate(workspace, file, source));
        }
        return sendJson(res, 404, { error: "Unknown endpoint" });
      } catch (error) {
        return sendJson(res, 500, { error: (error as Error).message });
      }
    }

    // Static frontend; unknown paths fall back to index.html.
    const requested = path.normalize(path.join(distDir, url.pathname));
    const inside = requested.startsWith(distDir);
    const file =
      inside && fs.existsSync(requested) && fs.statSync(requested).isFile() ? requested : path.join(distDir, "index.html");
    if (!fs.existsSync(file)) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`The web editor is not built. Run: npm --prefix ${path.dirname(distDir)} run build`);
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
}
