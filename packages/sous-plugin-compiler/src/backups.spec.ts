/**
 * Where backups go: the timestamp folder of a run, a file's path inside it, one folder per run,
 * and never overwriting a backup already there.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTmpDir, type TmpDir } from "../test/tmp.js";
import { BackupClock, backupRelativePath, Backups, backupStamp } from "./backups.js";

let tmp: TmpDir;

beforeEach(() => {
    tmp = makeTmpDir("sous-backups-");
});

afterEach(() => {
    tmp.cleanup();
});

describe("backupStamp()", () => {
    /**
     * backupStamp should name the timestamp folder of a run in local time, as
     * `<YYYY-MM-DD>/<HHMM-SS>`, every part padded to two digits.
     *
     * backupStamp(new Date(2026, 10, 15, 9, 12, 4));
     * // -> "2026-11-15/0912-04"
     */
    it("should name the folder by local date, then hours and minutes, then seconds", () => {
        expect(backupStamp(new Date(2026, 10, 15, 9, 12, 4))).toBe("2026-11-15/0912-04");
        expect(backupStamp(new Date(2027, 0, 2, 23, 5, 59))).toBe("2027-01-02/2305-59");
    });
});

describe("backupRelativePath()", () => {
    /**
     * backupRelativePath should keep a file inside the project at its path relative to the
     * project root.
     *
     * backupRelativePath("/work/app/docs/CLAUDE.md", "/work/app");
     * // -> "docs/CLAUDE.md"
     */
    it("should keep a file inside the project relative to the project root", () => {
        const root = path.join(tmp.path, "app");

        expect(backupRelativePath(path.join(root, "docs", "CLAUDE.md"), root)).toBe(path.join("docs", "CLAUDE.md"));
    });

    /**
     * backupRelativePath should put a file outside the project under `outside-project/`,
     * followed by its absolute path without the leading slash, so it cannot collide with a file
     * inside the project.
     *
     * backupRelativePath("/home/me/.claude/CLAUDE.md", "/work/app");
     * // -> "outside-project/home/me/.claude/CLAUDE.md"
     */
    it("should put a file outside the project under outside-project/ by its absolute path", () => {
        const root = path.join(tmp.path, "app");
        const outside = path.join(tmp.path, "home", ".claude", "CLAUDE.md");
        const { root: fsRoot } = path.parse(outside);
        const expected = path.join("outside-project", fsRoot.replace(/[:\\/]/g, ""), outside.slice(fsRoot.length));

        expect(backupRelativePath(outside, root)).toBe(expected);
        expect(backupRelativePath(outside, undefined)).toBe(expected);
    });
});

describe("BackupClock", () => {
    /**
     * A BackupClock should give every backup of one run the same folder, taken when the run
     * makes its first backup, and a new run a new folder.
     *
     * clock.folder(1); // -> "2026-11-15/0912-04"
     * clock.folder(1); // -> "2026-11-15/0912-04" (a second later, same run)
     * clock.folder(2); // -> "2026-11-15/0912-06"
     */
    it("should keep one folder for a run and start a new one for the next run", () => {
        let seconds = 4;
        const clock = new BackupClock(() => new Date(2026, 10, 15, 9, 12, seconds++));

        expect(clock.folder(1)).toBe("2026-11-15/0912-04");
        expect(clock.folder(1)).toBe("2026-11-15/0912-04");
        expect(clock.folder(2)).toBe("2026-11-15/0912-05");
    });
});

describe("Backups", () => {
    /**
     * Backups.copy should copy a file to
     * `<backups dir>/<YYYY-MM-DD>/<HHMM-SS>/<path relative to the project root>` and return where.
     *
     * backups.copy("/work/app/CLAUDE.md");
     * // -> "/work/app/.sous/backups/2026-11-15/0912-04/CLAUDE.md"
     */
    it("should copy a file into the run's timestamp folder at its project-relative path", () => {
        const root = tmp.path;
        const file = path.join(root, "docs", "CLAUDE.md");
        const backups = new Backups(path.join(root, ".sous", "backups"), root, new BackupClock(() => new Date(2026, 10, 15, 9, 12, 4)));

        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "the user's own");

        const backup = backups.copy(file, 1);

        expect(backup).toBe(path.join(root, ".sous", "backups", "2026-11-15", "0912-04", "docs", "CLAUDE.md"));
        expect(fs.readFileSync(backup, "utf8")).toBe("the user's own");
    });

    /**
     * Backups.plan should say where a backup would go without writing anything; a backup already
     * there (the same file backed up twice in one second) is never overwritten, a `.1` is added.
     *
     * backups.plan("/work/app/CLAUDE.md"); // -> ".../0912-04/CLAUDE.md", nothing written
     * backups.copy("/work/app/CLAUDE.md"); // twice -> ".../CLAUDE.md", then ".../CLAUDE.md.1"
     */
    it("should plan without writing and never overwrite an earlier backup", () => {
        const root = tmp.path;
        const file = path.join(root, "CLAUDE.md");
        const dir = path.join(root, ".sous", "backups");
        const backups = new Backups(dir, root, new BackupClock(() => new Date(2026, 10, 15, 9, 12, 4)));

        fs.writeFileSync(file, "first");

        const planned = backups.plan(file, 1);

        expect(planned).toBe(path.join(dir, "2026-11-15", "0912-04", "CLAUDE.md"));
        expect(fs.existsSync(dir)).toBe(false);
        expect(backups.copy(file, 1)).toBe(planned);

        fs.writeFileSync(file, "second");

        expect(backups.copy(file, 1)).toBe(`${planned}.1`);
        expect(fs.readFileSync(planned, "utf8")).toBe("first");
        expect(fs.readFileSync(`${planned}.1`, "utf8")).toBe("second");
    });
});
