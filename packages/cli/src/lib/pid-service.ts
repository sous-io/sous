import fs from "node:fs";
import path from "node:path";
import type { VarScope } from "./settings.js";

/**
 * Manages PID files for the Sous watcher, enforcing single-instance per project.
 * The PID file lives at <configsRoot>/projects/<key>/sous.pid by default.
 */
export class PidService {
  /**
   * Returns the PID file path for a project.
   * Derived as: <configsRoot>/projects/<key>/sous.pid
   * Falls back to <cwd>/<key>.sous.pid if configsRoot is not available.
   */
  getFilePath(projectKey: string, projectVars?: VarScope): string {
    if (projectVars?.configsRoot) {
      return path.join(projectVars.configsRoot, "projects", projectKey, "sous.pid");
    }
    return path.join(process.cwd(), `${projectKey}.sous.pid`);
  }

  /**
   * Checks if a watcher is already running for this project.
   * - If a PID file exists and the process is alive, throws an Error.
   * - If a PID file exists but the process is dead (stale), overwrites it.
   * - If no PID file exists, creates one with the current process.pid.
   */
  async acquire(pidFilePath: string): Promise<void> {
    if (fs.existsSync(pidFilePath)) {
      const raw = fs.readFileSync(pidFilePath, "utf8").trim();
      const existingPid = parseInt(raw, 10);

      if (!isNaN(existingPid)) {
        const alive = this._isProcessAlive(existingPid);
        if (alive) {
          throw new Error(
            `A watcher is already running for project '${path.basename(path.dirname(pidFilePath))}' (PID ${existingPid}). Stop it first or delete ${pidFilePath}.`
          );
        }
        // Stale PID file — fall through and overwrite
      }
    }

    const dir = path.dirname(pidFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(pidFilePath, String(process.pid), "utf8");
  }

  /**
   * Removes the PID file. Called on clean exit.
   */
  async release(pidFilePath: string): Promise<void> {
    if (fs.existsSync(pidFilePath)) {
      fs.unlinkSync(pidFilePath);
    }
  }

  /**
   * Returns true if the given PID corresponds to a running process.
   * Uses signal 0 to probe without sending a real signal.
   */
  _isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
