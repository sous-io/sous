import fs from "node:fs";
import path from "node:path";
import type { ProjectInfo } from "@sous-io/plugin-api";
import type { BuildPid } from "./types.js";

/** The PID file's name inside `.sous/`, as before the refactor. */
export const PID_FILE_NAME = "sous.pid";

/** Whether a process is running: signal 0 probes without sending anything. */
export function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);

        return true;
    } catch (error) {
        // EPERM: the process exists but belongs to someone else.
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

/** What {@link PidFile} needs. */
export interface PidFileOptions {
    /** `_vars.pidFilePath`, substituted, when set. */
    explicitPath?: string;
    project: ProjectInfo | undefined;
    /** Where to fall back to with no project: the process's directory. */
    cwd: string;
    /** Probes a PID. Default {@link isProcessAlive}. */
    isAlive?: (pid: number) => boolean;
}

/**
 * The watcher's PID file (S6, `build.pid`): one watcher per project. Its path is
 * `_vars.pidFilePath` when set, then `<sousDir>/sous.pid`, then `sous.pid` in the working directory.
 *
 * ```ts
 * const pid = new PidFile({ project, cwd: project.root });
 *
 * if (pid.isRunning()) throw new ConflictError(...);
 * pid.write();
 * ```
 */
export class PidFile implements BuildPid {
    private readonly file: string;
    private readonly isAlive: (pid: number) => boolean;

    constructor(options: PidFileOptions) {
        this.file =
            options.explicitPath ??
            (options.project ? path.join(options.project.sousDir, PID_FILE_NAME) : path.join(options.cwd, PID_FILE_NAME));
        this.isAlive = options.isAlive ?? isProcessAlive;
    }

    path(): string {
        return this.file;
    }

    read(): number | undefined {
        let raw: string;

        try {
            raw = fs.readFileSync(this.file, "utf8");
        } catch {
            return undefined;
        }

        const pid = Number.parseInt(raw.trim(), 10);

        return Number.isNaN(pid) ? undefined : pid;
    }

    write(pid: number = process.pid): void {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, String(pid), "utf8");
    }

    remove(): void {
        fs.rmSync(this.file, { force: true });
    }

    isRunning(): boolean {
        const pid = this.read();

        return pid !== undefined && this.isAlive(pid);
    }
}

/**
 * The project label the "already running" error names: the project directory, or, with no
 * project, the directory holding the PID file (skipping `.sous`).
 */
export function projectLabel(project: ProjectInfo | undefined, pidFile: string): string {
    if (project) {
        return path.basename(project.root);
    }

    let dir = path.dirname(pidFile);

    if (path.basename(dir) === ".sous") {
        dir = path.dirname(dir);
    }

    return path.basename(dir);
}
