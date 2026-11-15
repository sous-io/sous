/**
 * Writing outputs: creating, updating, leaving unchanged files alone, taking over files sous did
 * not write unless `overwriteUntracked` is false, and removing only tracked, unprotected files
 * (today's `StateService.deleteTrackedFiles`).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackupClock, Backups } from "./backups.js";
import { loadState, StateStore } from "./state.js";
import { WriterService } from "./writer.js";

let dir: string;
let store: StateStore;

beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sous-writer-")));
    store = new StateStore(path.join(dir, ".sous", "sous.state.json"));
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

function writer(options: { overwriteUntracked?: boolean; protectedRoots?: string[]; backups?: Backups } = {}): WriterService {
    return new WriterService(store, {
        overwriteUntracked: options.overwriteUntracked ?? true,
        protectedRoots: options.protectedRoots ?? [],
        ...(options.backups ? { backups: options.backups } : {}),
    });
}

/** Backups under `<dir>/.sous/backups`, every run at 2026-11-15 09:12:04. */
function fixedBackups(): Backups {
    return new Backups(path.join(dir, ".sous", "backups"), dir, new BackupClock(() => new Date(2026, 10, 15, 9, 12, 4)));
}

/** Where a file directly under `dir` is backed up by `fixedBackups()`. */
const backupOf = (name: string) => path.join(dir, ".sous", "backups", "2026-11-15", "0912-04", name);

describe("WriterService.write()", () => {
    /** A new file is created with its directories, and recorded with where it came from. */
    it("should create a file and record it with its target and origin", async () => {
        const file = path.join(dir, "out", "a.md");
        const written = await writer().write(file, "hello", { source: "src.md", sourceHash: "abc", target: "t", origin: { plugin: "p" } });

        expect(written).toEqual({ file, action: "created", bytes: 5, target: "t", origin: { plugin: "p" } });
        expect(fs.readFileSync(file, "utf8")).toBe("hello");
        expect(store.entry(file)).toMatchObject({ dest: file, srcHash: "abc", size: 5, target: "t", origin: { plugin: "p" } });
        expect(store.current().dirs).toEqual([path.join(dir, "out")]);
    });

    /** The same content again is left alone; new content updates the file; `force` writes anyway. */
    it("should report unchanged, updated and forced writes", async () => {
        const file = path.join(dir, "a.md");
        const w = writer();

        await w.write(file, "one", { source: "s" });

        expect((await w.write(file, "one", { source: "s" })).action).toBe("unchanged");
        expect((await w.write(file, "two", { source: "s" })).action).toBe("updated");
        expect((await w.write(file, "two", { source: "s", force: true })).action).toBe("updated");
        expect(fs.readFileSync(file, "utf8")).toBe("two");
    });

    /** A dry run writes nothing and says what it would do. */
    it("should write nothing on a dry run", async () => {
        const file = path.join(dir, "a.md");
        const w = writer();

        expect((await w.write(file, "x", { source: "s", dryRun: true })).action).toBe("would-create");
        expect(fs.existsSync(file)).toBe(false);

        await w.write(file, "x", { source: "s" });

        expect((await w.write(file, "y", { source: "s", dryRun: true })).action).toBe("would-update");
        expect((await w.write(file, "x", { source: "s", dryRun: true })).action).toBe("unchanged");
    });

    /** By default a file sous did not write is overwritten and taken over. */
    it("should overwrite a file it did not write and take it over by default", async () => {
        const file = path.join(dir, "CLAUDE.md");

        fs.writeFileSync(file, "the user's own");

        const written = await writer().write(file, "compiled", { source: "s" });

        expect(written.action).toBe("updated");
        expect(fs.readFileSync(file, "utf8")).toBe("compiled");
        expect(store.entry(file)).toBeDefined();
    });

    /** With `overwriteUntracked: false`, such a file is left as it is and not taken over. */
    it("should leave a file it did not write alone when overwriteUntracked is false", async () => {
        const file = path.join(dir, "CLAUDE.md");

        fs.writeFileSync(file, "the user's own");

        const w = writer({ overwriteUntracked: false });

        expect((await w.write(file, "compiled", { source: "s" })).action).toBe("skipped-untracked");
        expect((await w.write(file, "the user's own", { source: "s" })).action).toBe("skipped-untracked");
        expect(fs.readFileSync(file, "utf8")).toBe("the user's own");
        expect(store.entry(file)).toBeUndefined();
    });

    /** A file sous wrote is still updated with `overwriteUntracked: false`. */
    it("should still update its own files when overwriteUntracked is false", async () => {
        const file = path.join(dir, "a.md");

        await writer().write(file, "one", { source: "s" });

        expect((await writer({ overwriteUntracked: false }).write(file, "two", { source: "s" })).action).toBe("updated");
    });

    /** A `.sh` output is made executable; a given mode is applied. */
    it("should make .sh files executable and apply a given mode", async () => {
        const script = path.join(dir, "run.sh");
        const other = path.join(dir, "data.txt");

        await writer().write(script, "echo", { source: "s" });
        await writer().write(other, "x", { source: "s", mode: 0o600 });

        expect(fs.statSync(script).mode & 0o777).toBe(0o755);
        expect(fs.statSync(other).mode & 0o777).toBe(0o600);
    });
});

describe("WriterService.remove()", () => {
    /** Tracked files are removed, then the directories sous created that are left empty. */
    it("should delete tracked files and the directories they emptied", async () => {
        const w = writer();
        const file = path.join(dir, "a", "b", "x.md");

        await w.write(file, "x", { source: "s" });
        await w.commit();

        const result = await w.remove([file]);

        expect(result.removed).toEqual([file]);
        expect(result.dirsRemoved).toEqual([path.join(dir, "a", "b"), path.join(dir, "a")]);
        expect(fs.existsSync(path.join(dir, "a"))).toBe(false);

        await w.commit();

        expect(loadState(store.file).files).toEqual([]);
    });

    /** Nothing inside a protected root is removed, whatever the state file says; nor an untracked file. */
    it("should never delete anything inside a protected root or untracked", async () => {
        const protectedDir = path.join(dir, "store");
        const w = writer({ protectedRoots: [protectedDir] });
        const inside = path.join(protectedDir, "x.md");
        const untracked = path.join(dir, "mine.md");

        fs.mkdirSync(protectedDir);
        fs.writeFileSync(inside, "x");
        fs.writeFileSync(untracked, "x");
        store.record({ dest: inside, srcHash: "", destHash: "", size: 1, builtAt: "" });

        const result = await w.remove([inside, untracked]);

        expect(result.removed).toEqual([]);
        expect(fs.existsSync(inside)).toBe(true);
        expect(fs.existsSync(untracked)).toBe(true);
    });

    /** A dry run lists what it would remove and removes nothing. */
    it("should remove nothing on a dry run", async () => {
        const w = writer();
        const file = path.join(dir, "x.md");

        await w.write(file, "x", { source: "s" });

        expect((await w.remove([file], { dryRun: true })).removed).toEqual([file]);
        expect(fs.existsSync(file)).toBe(true);
    });
});

describe("WriterService backups", () => {
    /**
     * Overwriting a file sous did not write should first copy it to the run's backup folder, and
     * say where in the result.
     *
     * write("CLAUDE.md", "compiled") over the user's own CLAUDE.md
     * // -> { action: "updated", backup: ".sous/backups/2026-11-15/0912-04/CLAUDE.md" }
     */
    it("should back up a file it did not write before overwriting it", async () => {
        const file = path.join(dir, "CLAUDE.md");

        fs.writeFileSync(file, "the user's own");

        const written = await writer({ backups: fixedBackups() }).write(file, "compiled", { source: "s" });

        expect(written).toMatchObject({ action: "updated", backup: backupOf("CLAUDE.md") });
        expect(fs.readFileSync(backupOf("CLAUDE.md"), "utf8")).toBe("the user's own");
        expect(fs.readFileSync(file, "utf8")).toBe("compiled");
    });

    /**
     * Overwriting an output edited by hand since sous wrote it (its hash no longer matches the
     * recorded destHash) should back up the edited copy first.
     *
     * write("a.md", "one"); edit a.md by hand; write("a.md", "two")
     * // -> the hand-edited copy is in the backup folder
     */
    it("should back up a tracked output edited by hand before overwriting it", async () => {
        const file = path.join(dir, "a.md");
        const w = writer({ backups: fixedBackups() });

        await w.write(file, "one", { source: "s" });
        fs.writeFileSync(file, "one, edited by hand");

        const written = await w.write(file, "two", { source: "s" });

        expect(written.backup).toBe(backupOf("a.md"));
        expect(fs.readFileSync(backupOf("a.md"), "utf8")).toBe("one, edited by hand");
        expect(fs.readFileSync(file, "utf8")).toBe("two");
    });

    /**
     * Content sous produced, and content already identical to what is being written, should not
     * be backed up: nothing would be lost.
     *
     * write("a.md", "one"); write("a.md", "two")        // its own content: no backup
     * user's "same" file; write("b.md", "same", force)  // identical: no backup
     */
    it("should not back up its own unchanged output or content identical to the new content", async () => {
        const own = path.join(dir, "a.md");
        const identical = path.join(dir, "b.md");
        const w = writer({ backups: fixedBackups() });

        await w.write(own, "one", { source: "s" });
        fs.writeFileSync(identical, "same");

        expect((await w.write(own, "two", { source: "s" })).backup).toBeUndefined();
        expect((await w.write(own, "two", { source: "s", force: true })).backup).toBeUndefined();
        expect((await w.write(identical, "same", { source: "s", force: true })).backup).toBeUndefined();
        expect(fs.existsSync(path.join(dir, ".sous", "backups"))).toBe(false);
    });

    /**
     * A dry run should say where a backup would go and write nothing: neither the backup nor the
     * output.
     *
     * write("CLAUDE.md", "compiled", { dryRun: true }) over the user's own CLAUDE.md
     * // -> { action: "would-update", backup: ".../CLAUDE.md" }, nothing on disk changed
     */
    it("should plan the backup and write nothing on a dry run", async () => {
        const file = path.join(dir, "CLAUDE.md");

        fs.writeFileSync(file, "the user's own");

        const written = await writer({ backups: fixedBackups() }).write(file, "compiled", { source: "s", dryRun: true });

        expect(written).toMatchObject({ action: "would-update", backup: backupOf("CLAUDE.md") });
        expect(fs.existsSync(path.join(dir, ".sous", "backups"))).toBe(false);
        expect(fs.readFileSync(file, "utf8")).toBe("the user's own");
    });

    /**
     * With overwriteUntracked false, a file sous did not write should be skipped as before, and
     * since it is not touched, not backed up.
     */
    it("should not back up a file it skips because overwriteUntracked is false", async () => {
        const file = path.join(dir, "CLAUDE.md");

        fs.writeFileSync(file, "the user's own");

        const written = await writer({ overwriteUntracked: false, backups: fixedBackups() }).write(file, "compiled", { source: "s" });

        expect(written.action).toBe("skipped-untracked");
        expect(written.backup).toBeUndefined();
        expect(fs.existsSync(path.join(dir, ".sous", "backups"))).toBe(false);
    });

    /**
     * Removing an output edited by hand should back it up first; an output still as sous wrote it
     * is removed without a backup. A dry run lists the backup it would make and writes nothing.
     *
     * remove(["edited.md", "own.md"])
     * // -> { removed: [edited, own], backedUp: [{ file: edited, backup: ".../edited.md" }] }
     */
    it("should back up a hand-edited output before removing it, and only that one", async () => {
        const edited = path.join(dir, "edited.md");
        const own = path.join(dir, "own.md");
        const w = writer({ backups: fixedBackups() });

        await w.write(edited, "x", { source: "s" });
        await w.write(own, "y", { source: "s" });
        fs.writeFileSync(edited, "x, edited by hand");

        const planned = await w.remove([edited, own], { dryRun: true });

        expect(planned.backedUp).toEqual([{ file: edited, backup: backupOf("edited.md") }]);
        expect(fs.existsSync(path.join(dir, ".sous", "backups"))).toBe(false);

        const result = await w.remove([edited, own]);

        expect(result.removed).toEqual([edited, own]);
        expect(result.backedUp).toEqual([{ file: edited, backup: backupOf("edited.md") }]);
        expect(fs.readFileSync(backupOf("edited.md"), "utf8")).toBe("x, edited by hand");
        expect(fs.existsSync(edited)).toBe(false);
        expect(fs.existsSync(backupOf("own.md"))).toBe(false);
    });

    /**
     * Without a `backups` setting, backups should go in a `backups` directory beside the state
     * file, at the path relative to the state's project.
     *
     * new StateStore("/p/.sous/sous.state.json", "/p") -> "/p/.sous/backups/<date>/<time>/CLAUDE.md"
     */
    it("should default to a backups directory beside the state file", async () => {
        store = new StateStore(path.join(dir, ".sous", "sous.state.json"), dir);

        const file = path.join(dir, "CLAUDE.md");

        fs.writeFileSync(file, "the user's own");

        const written = await writer().write(file, "compiled", { source: "s" });
        const relative = path.relative(path.join(dir, ".sous", "backups"), written.backup!);

        expect(relative).toMatch(/^\d{4}-\d{2}-\d{2}[\\/]\d{4}-\d{2}[\\/]CLAUDE\.md$/);
        expect(fs.readFileSync(written.backup!, "utf8")).toBe("the user's own");
    });
});
