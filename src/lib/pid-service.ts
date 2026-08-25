import fs from "node:fs";
import path from "node:path";
import type { VarScope } from "./settings.js";

/**
 * Manages PID files for the Sous watcher, enforcing a single instance per config.
 * The PID file lives at <sousDir>/sous.pid by default.
 */
export class PidService {
  /**
   * Returns the PID file path for a config.
   *
   * Precedence (mirrors StateService.getFilePath):
   *   1. A `pidFilePath` variable in the settings scope (explicit override).
   *   2. `<sousDir>/sous.pid`.
   *   3. `<cwd>/sous.pid` as a last resort.
   *
   * @param vars - The resolved settings-scope variables.
   */
  getFilePath(vars?: VarScope): string {
    if (vars?.pidFilePath) {
      return vars.pidFilePath;
    }
    if (vars?.sousDir) {
      return path.join(vars.sousDir, "sous.pid");
    }
    return path.join(process.cwd(), "sous.pid");
  }

  /**
   * Checks if a watcher is already running for this config.
   * - If a PID file exists and the process is alive, throws an Error.
   * - If a PID file exists but the process is dead (stale), overwrites it.
   * - If no PID file exists, creates one with the current process.pid.
   *
   * @param pidFilePath - Path from getFilePath().
   * @param label - Human-readable project label used in the "already running"
   *   error (e.g. `BaseCommand.projectLabel`). Falls back to a label derived
   *   from the PID file path.
   */
  async acquire(pidFilePath: string, label?: string): Promise<void> {
    if (fs.existsSync(pidFilePath)) {
      const raw = fs.readFileSync(pidFilePath, "utf8").trim();
      const existingPid = parseInt(raw, 10);

      if (!isNaN(existingPid)) {
        const alive = this._isProcessAlive(existingPid);
        if (alive) {
          throw new Error(
            `A watcher is already running for project '${label ?? deriveLabel(pidFilePath)}' (PID ${existingPid}). Stop it first or delete ${pidFilePath}.`
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

/**
 * Derives a project label from a PID file path when the caller supplied none.
 * The default PID file lives at `<project>/.sous/sous.pid`, so a plain
 * `basename(dirname(...))` would always say ".sous"; skip past that directory
 * to the project directory itself.
 */
function deriveLabel(pidFilePath: string): string {
  let dir = path.dirname(pidFilePath);
  if (path.basename(dir) === ".sous") {
    dir = path.dirname(dir);
  }
  return path.basename(dir);
}
