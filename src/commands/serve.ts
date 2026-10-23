/**
 * PROOF OF CONCEPT: `sous serve` starts a local web editor for this project's
 * sources and opens it in the browser.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import type http from "node:http";
import { Flags } from "@oclif/core";
import { BaseCommand } from "../base-command.js";
import { CLI_ROOT } from "../lib/settings.js";
import { createServer } from "../lib/serve/server.js";
import { loadWorkspace } from "../lib/serve/workspace.js";
import { heading, log, showCommandVars } from "../utils/formatting.js";

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // The URL is printed either way.
  }
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

export default class Serve extends BaseCommand {
  static description = "Open a local web editor for this project's sources (proof of concept)";

  static examples = ["<%= config.bin %> serve", "<%= config.bin %> serve --no-launch --port 5000"];

  static flags = {
    ...BaseCommand.baseFlags,
    port: Flags.integer({ description: "Port to listen on; the next free port is used if it is taken", default: 4777 }),
    launch: Flags.boolean({
      description: "Open the editor in the browser once it is ready, or with --no-launch, only print its URL",
      default: true,
      allowNo: true,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Serve);

    const workspace = await loadWorkspace(this.settings, this.configContext);
    const token = process.env.SOUS_SERVE_TOKEN ?? crypto.randomBytes(16).toString("hex");
    const distDir = path.join(CLI_ROOT, "web", "dist");
    const server = createServer(workspace, distDir, token);
    const port = await listen(server, flags.port, 10);
    const url = `http://127.0.0.1:${port}/?token=${token}`;

    showCommandVars({
      Project: this.projectLabel,
      Files: workspace.files.length,
      URL: url,
    });
    heading("Serving");
    log("  Press Ctrl+C to stop.");

    if (flags.launch) openBrowser(url);

    await new Promise(() => {}); // keep the process alive
  }
}
