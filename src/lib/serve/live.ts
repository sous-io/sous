/**
 * PROOF OF CONCEPT for `sous serve`. Watches every source file and every built
 * output on disk, and tells open browsers when one changes, over server-sent
 * events. A changed source means "this file changed on disk"; any change also
 * re-runs the preview build, so outputs, tokens and hand edits stay current.
 */
import type http from "node:http";
import path from "node:path";
import chokidar from "chokidar";
import { runPreviewBuild } from "./preview-build.js";
import type { Workspace } from "./workspace.js";

type Client = http.ServerResponse;

export function startLive(workspace: Workspace) {
  const clients = new Set<Client>();
  const idByPath = new Map(workspace.files.filter((f) => !f.virtualContent).map((f) => [f.path, f.id]));
  const outputs = workspace.files.flatMap((f) => f.outputs.map((o) => path.join(workspace.projectRoot, o)));

  const send = (event: unknown) => {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const c of clients) c.write(line);
  };

  let rebuildTimer: NodeJS.Timeout | undefined;
  const rebuildSoon = () => {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(async () => {
      await runPreviewBuild(workspace).catch(() => null);
      send({ type: "build" });
    }, 400);
  };

  const watcher = chokidar.watch([...idByPath.keys(), ...outputs], { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 150 } });
  const onChange = (file: string) => {
    const id = idByPath.get(file);
    if (id) send({ type: "source", id, path: path.relative(workspace.projectRoot, file) });
    else send({ type: "output", path: path.relative(workspace.projectRoot, file) });
    rebuildSoon();
  };
  watcher.on("change", onChange).on("add", onChange).on("unlink", onChange);
  watcher.on("error", (e) => process.stderr.write(`[live] ${String(e)}\n`));

  return {
    /** Handles GET /api/events: a server-sent event stream. */
    handle(req: http.IncomingMessage, res: http.ServerResponse) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ type: "hello", watching: idByPath.size + outputs.length })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 20000);
      req.on("close", () => {
        clearInterval(ping);
        clients.delete(res);
      });
    },
  };
}
