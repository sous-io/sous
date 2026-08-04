import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { VarScope } from "./settings.js";

// --- Types ---------------------------------------------------------------------------------------

/** A single file entry tracked by the state file. */
export type StateFileEntry = {
  /** Absolute destination path of the output file. */
  dest: string;
  /** SHA-256 hex hash of the source content at build time. */
  srcHash: string;
  /** SHA-256 hex hash of the destination file content at build time. */
  destHash: string;
  /** File size in bytes. */
  size: number;
  /** ISO timestamp when this file was last written. */
  builtAt: string;
};

/** The full state tracked for a project across builds. */
export type StateFile = {
  /** ISO timestamp of the last successful build. */
  lastBuild: string;
  /** The resolved variable scope used during the last build. */
  resolvedVars: VarScope;
  /** Absolute paths of directories that Sous created (not pre-existing). */
  dirs: string[];
  /** All output files written by Sous for this project. */
  files: StateFileEntry[];
};

// --- StateService --------------------------------------------------------------------------------

/**
 * Manages reading and writing the project state file.
 * The state file tracks all files and directories Sous has written,
 * enabling xcv prune and xcv clear to clean up precisely.
 */
export class StateService {
  /**
   * Derives the state file path for a project.
   *
   * Precedence:
   *   1. A `stateFilePath` variable in the PROJECT scope (explicit override).
   *   2. `<sousDir>/sous.state.json` for a single-project config, or
   *      `<sousDir>/<key>.sous.state.json` when the config defines several
   *      projects (they must not share one state file).
   *   3. `<cwd>/<key>.sous.state.json` as a last resort.
   *
   * @param projectKey - The project's key in the config's `projects` map.
   * @param projectVars - The resolved PROJECT-scope variables. `sousDir` is
   *   auto-injected by buildAutoVars when a config has been discovered.
   * @param projectCount - How many projects the active config defines. Defaults
   *   to 1 (the expected case: one `.sous/` per project).
   */
  getFilePath(projectKey: string, projectVars?: VarScope, projectCount = 1): string {
    if (projectVars?.stateFilePath) {
      return projectVars.stateFilePath;
    }
    if (projectVars?.sousDir) {
      const fileName = projectCount > 1 ? `${projectKey}.sous.state.json` : "sous.state.json";
      return path.join(projectVars.sousDir, fileName);
    }
    return path.join(process.cwd(), `${projectKey}.sous.state.json`);
  }

  /** Loads the state file for a project. Returns null if it does not exist. */
  async load(filePath: string): Promise<StateFile | null> {
    if (!fs.existsSync(filePath)) return null;
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      return JSON.parse(raw) as StateFile;
    } catch {
      return null;
    }
  }

  /** Deletes all tracked files and removes any now-empty tracked directories. */
  deleteTrackedFiles(files: StateFileEntry[], dirs: string[]): void {
    for (const entry of files) {
      if (fs.existsSync(entry.dest)) fs.rmSync(entry.dest);
    }
    const sortedDirs = [...dirs].sort(
      (a, b) => b.split(path.sep).length - a.split(path.sep).length
    );
    for (const dir of sortedDirs) {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
      }
    }
  }

  /** Saves the state file to disk, creating parent directories as needed. */
  async save(filePath: string, state: StateFile): Promise<void> {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
  }
}

// --- Hash utilities ------------------------------------------------------------------------------

/** Computes a SHA-256 hex hash of a file's contents. */
export async function hashFile(filePath: string): Promise<string> {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

/** Computes a SHA-256 hex hash of an in-memory string. */
export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

// --- Directory tracking --------------------------------------------------------------------------

/**
 * Records that Sous created a directory.
 * Only records if the directory is not already tracked.
 */
export function recordDirCreation(dir: string, state: StateFile): void {
  if (!state.dirs.includes(dir)) {
    state.dirs.push(dir);
  }
}

/**
 * Returns true if Sous created this directory (i.e., it is tracked in the state file).
 */
export function didSousCreateDir(dir: string, state: StateFile): boolean {
  return state.dirs.includes(dir);
}
