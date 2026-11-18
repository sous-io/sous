/**
 * Backups: before the compiler overwrites or removes a file whose content it did not produce (a
 * file it never wrote, or an output edited by hand since it wrote it), it copies the file to
 * `<sousDir>/backups/<YYYY-MM-DD>/<HHMM-SS>/<path relative to the project root>`. Every backup of
 * one run goes in one timestamp folder, taken in local time when the run makes its first backup.
 */

import fs from "node:fs";
import path from "node:path";
import type { Reporter } from "@sous-io/sous-plugin-api";

/** The folder backups of a file outside the project go under, inside the timestamp folder. */
export const OUTSIDE_PROJECT_DIR = "outside-project";

/**
 * The timestamp folder of a backup run, in local time: `<YYYY-MM-DD>/<HHMM-SS>`.
 *
 * ```ts
 * backupStamp(new Date(2026, 10, 15, 9, 12, 4));
 * // -> "2026-11-15/0912-04"
 * ```
 */
export function backupStamp(date: Date): string {
    const two = (value: number) => String(value).padStart(2, "0");
    const day = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;

    return `${day}/${two(date.getHours())}${two(date.getMinutes())}-${two(date.getSeconds())}`;
}

/**
 * Where a file's backup goes inside a timestamp folder: its path relative to the project root, or,
 * for a file outside the project, `outside-project/` followed by its absolute path without the
 * leading slash (on Windows, the drive letter without its colon).
 *
 * ```ts
 * backupRelativePath("/work/app/docs/CLAUDE.md", "/work/app");     // -> "docs/CLAUDE.md"
 * backupRelativePath("/home/me/.claude/CLAUDE.md", "/work/app");   // -> "outside-project/home/me/.claude/CLAUDE.md"
 * ```
 */
export function backupRelativePath(file: string, projectRoot: string | undefined): string {
    const resolved = path.resolve(file);

    if (projectRoot !== undefined) {
        const relative = path.relative(path.resolve(projectRoot), resolved);

        if (relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
            return relative;
        }
    }

    const { root } = path.parse(resolved);
    const drive = root.replace(/[:\\/]/g, "");

    return path.join(OUTSIDE_PROJECT_DIR, drive, resolved.slice(root.length));
}

/**
 * Picks the timestamp folder of each run. A run is named by a key (the chain's id); the folder is
 * taken from the clock at the run's first backup and kept for the rest of the run, so one build
 * puts all its backups in one folder. Shared by every config of one engine, so a run that rebuilds
 * its config part way keeps its folder.
 */
export class BackupClock {
    private run: unknown;
    private stamp: string | undefined;

    constructor(private readonly now: () => Date = () => new Date()) {}

    /** The timestamp folder of a run: `2026-11-15/0912-04`. */
    folder(run: unknown): string {
        if (this.stamp === undefined || run !== this.run) {
            this.run = run;
            this.stamp = backupStamp(this.now());
        }

        return this.stamp;
    }
}

/**
 * Reports a backup as an operation, before the line that says the file was written or removed.
 *
 * ```ts
 * reportBackup(reporter, "/work/app/CLAUDE.md", "/work/app/.sous/backups/2026-11-15/0912-04/CLAUDE.md", false);
 * // backed-up: /work/app/CLAUDE.md (backed up to /work/app/.sous/backups/2026-11-15/0912-04/CLAUDE.md)
 * ```
 */
export function reportBackup(reporter: Pick<Reporter, "operation">, file: string, backup: string, dryRun: boolean): void {
    reporter.operation(dryRun ? "would-back-up" : "backed-up", file, { note: `${dryRun ? "would back up" : "backed up"} to ${backup}` });
}

/** Where backups go, and how they are made. */
export class Backups {
    /**
     * @param dir - The backups directory: `<sousDir>/backups`.
     * @param projectRoot - Paths inside it are kept relative to it; others go under `outside-project/`.
     */
    constructor(
        readonly dir: string,
        readonly projectRoot: string | undefined,
        private readonly clock: BackupClock = new BackupClock(),
    ) {}

    /**
     * Where a file's backup would go in this run, writing nothing. A backup already there (the same
     * file backed up twice in one second) is never overwritten: a `.1`, `.2`, ... is added instead.
     */
    plan(file: string, run?: unknown): string {
        const base = path.join(this.dir, ...this.clock.folder(run).split("/"), backupRelativePath(file, this.projectRoot));
        let candidate = base;

        for (let count = 1; fs.existsSync(candidate); count += 1) {
            candidate = `${base}.${count}`;
        }

        return candidate;
    }

    /** Copies a file to its backup; returns where it went. */
    copy(file: string, run?: unknown): string {
        const backup = this.plan(file, run);

        fs.mkdirSync(path.dirname(backup), { recursive: true });
        fs.copyFileSync(file, backup);

        return backup;
    }
}
