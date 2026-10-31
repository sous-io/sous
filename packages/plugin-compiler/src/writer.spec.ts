/**
 * Writing outputs: creating, updating, leaving unchanged files alone, taking over files sous did
 * not write unless `overwriteUntracked` is false, and removing only tracked, unprotected files
 * (today's `StateService.deleteTrackedFiles`).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

function writer(options: { overwriteUntracked?: boolean; protectedRoots?: string[] } = {}): WriterService {
    return new WriterService(store, { overwriteUntracked: options.overwriteUntracked ?? true, protectedRoots: options.protectedRoots ?? [] });
}

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
