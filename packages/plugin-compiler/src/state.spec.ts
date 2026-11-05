/**
 * The state file, ported from today's `src/lib/state.spec.ts`: hashing, reading, saving, protected
 * paths, and the store a config's state service and writer share.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyState, hashContent, isProtectedPath, loadState, matchesFilter, readState, saveState, StateService, StateStore } from "./state.js";
import type { StateFile, StateFileEntry } from "./types.js";

let dir: string;

beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sous-state-")));
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

function entry(dest: string, extra: Partial<StateFileEntry> = {}): StateFileEntry {
    return { dest, srcHash: "s", destHash: "d", size: 1, builtAt: "2026-01-01T00:00:00.000Z", ...extra };
}

describe("hashContent()", () => {
    /** A SHA-256 digest, 64 hex characters, the same for the same input. */
    it("should return a consistent 64-character hex SHA-256 digest", () => {
        expect(hashContent("hello")).toMatch(/^[0-9a-f]{64}$/);
        expect(hashContent("hello")).toBe(hashContent("hello"));
        expect(hashContent("hello")).not.toBe(hashContent("world"));
    });
});

describe("loadState()", () => {
    /** A missing file reads as an empty state, never an error. */
    it("should return an empty state when the file does not exist", () => {
        expect(loadState(path.join(dir, "missing.json"))).toEqual(emptyState());
    });

    /** A valid file reads as it was written. */
    it("should return the parsed state when the file is valid JSON", () => {
        const file = path.join(dir, "state.json");
        const state = { lastBuild: "2026-01-01", resolvedVars: { a: "1" }, dirs: ["/x"], files: [entry("/x/a.md")] };

        fs.writeFileSync(file, JSON.stringify(state));

        expect(loadState(file)).toEqual(state);
    });

    /** A file that is not JSON reads as an empty state. */
    it("should return an empty state when the file holds invalid JSON", () => {
        const file = path.join(dir, "state.json");

        fs.writeFileSync(file, "{ not json");

        expect(loadState(file)).toEqual(emptyState());
    });
});

describe("saveState()", () => {
    /** Formatted JSON, with its directory made when missing. */
    it("should write formatted JSON and create parent directories", () => {
        const file = path.join(dir, "deep", "nested", "state.json");

        saveState(file, emptyState());

        expect(fs.readFileSync(file, "utf8")).toBe(JSON.stringify(emptyState(), null, 2));
    });

    /**
     * With a `projectRoot`, paths inside the project are written relative to it, and paths outside
     * it stay absolute.
     *
     * saveState(file, { projectRoot: "/p", files: ["/p/AGENTS.md", "/home/me/x.md"] });
     * // -> "AGENTS.md", "/home/me/x.md"
     */
    it("should write paths inside the project relative to it", () => {
        const file = path.join(dir, "state.json");
        const root = path.join(dir, "p");
        const outside = path.join(dir, "user", "x.md");

        saveState(file, { ...emptyState(), projectRoot: root, dirs: [path.join(root, "skills")], files: [entry(path.join(root, "AGENTS.md")), entry(outside)] });

        const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as StateFile;

        expect(onDisk.projectRoot).toBe(root);
        expect(onDisk.dirs).toEqual(["skills"]);
        expect(onDisk.files.map((e) => e.dest)).toEqual(["AGENTS.md", outside]);
    });
});

describe("readState()", () => {
    /**
     * Paths are read for the project at `projectRoot`: a relative path is the project's, read
     * against the root; an absolute path inside the root is the project's; an absolute path
     * outside it is the project's only when the file names this project, else it is foreign.
     *
     * // copied from /old: { projectRoot: "/old", files: ["AGENTS.md", "/home/me/x.md"] }
     * readState(file, "/new");
     * // -> state.files: ["/new/AGENTS.md"], foreign: ["/home/me/x.md"]
     */
    it("should read relative paths against the project and keep another project's outside paths apart", () => {
        const file = path.join(dir, "state.json");
        const root = path.join(dir, "new");
        const outside = path.join(dir, "user", "x.md");

        fs.writeFileSync(
            file,
            JSON.stringify({ ...emptyState(), projectRoot: path.join(dir, "old"), dirs: ["skills", path.join(dir, "user")], files: [entry("AGENTS.md"), entry(outside)] }),
        );

        const read = readState(file, root);

        expect(read.state.projectRoot).toBe(root);
        expect(read.state.files.map((e) => e.dest)).toEqual([path.join(root, "AGENTS.md")]);
        expect(read.state.dirs).toEqual([path.join(root, "skills")]);
        expect(read.foreign.map((e) => e.dest)).toEqual([outside]);
    });

    /**
     * An older state file (every path absolute, no `projectRoot`) still reads: its paths inside the
     * project are the project's, and those outside it are foreign, since nothing shows they were
     * written for this project.
     */
    it("should read an older absolute-path state file, keeping outside paths apart", () => {
        const file = path.join(dir, "state.json");
        const root = path.join(dir, "b");
        const inside = path.join(root, "AGENTS.md");
        const otherProject = path.join(dir, "a", "AGENTS.md");

        fs.writeFileSync(file, JSON.stringify({ ...emptyState(), files: [entry(inside), entry(otherProject)] }));

        const read = readState(file, root);

        expect(read.state.files.map((e) => e.dest)).toEqual([inside]);
        expect(read.foreign.map((e) => e.dest)).toEqual([otherProject]);
    });

    /** A file that names this project keeps its outside paths as the project's own. */
    it("should keep outside paths of a state file written for this project", () => {
        const file = path.join(dir, "state.json");
        const root = path.join(dir, "p");
        const outside = path.join(dir, "user", "x.md");

        fs.writeFileSync(file, JSON.stringify({ ...emptyState(), projectRoot: root, files: [entry(outside)] }));

        const read = readState(file, root);

        expect(read.state.files.map((e) => e.dest)).toEqual([outside]);
        expect(read.foreign).toEqual([]);
    });
});

describe("isProtectedPath()", () => {
    /** Nothing is protected without roots; a path inside a root is; a sibling with a longer name is not. */
    it("should recognise paths inside a protected root only", () => {
        expect(isProtectedPath("/a/b", [])).toBe(false);
        expect(isProtectedPath("/home/me/.sous/cache/r/x.md", ["/home/me/.sous/cache"])).toBe(true);
        expect(isProtectedPath("/home/me/.sous/cache", ["/home/me/.sous/cache/"])).toBe(true);
        expect(isProtectedPath("/home/me/.sous/cache-old/x.md", ["/home/me/.sous/cache"])).toBe(false);
    });
});

describe("StateStore", () => {
    /** Writes and removals lay over what is saved until they are committed. */
    it("should lay this run's writes and removals over the saved state", () => {
        const file = path.join(dir, "state.json");
        const kept = path.join(dir, "kept.md");
        const dropped = path.join(dir, "dropped.md");

        saveState(file, { ...emptyState(), files: [entry(kept), entry(dropped)] });

        const store = new StateStore(file);

        store.record(entry(path.join(dir, "new.md")));
        store.forget(dropped);

        expect(store.current().files.map((e) => e.dest)).toEqual([path.join(dir, "new.md"), kept]);
        expect(store.entry(dropped)).toBeUndefined();
        expect(store.pending()).toBe(true);
    });

    /**
     * A commit keeps this run's entries and earlier entries whose files still exist, and drops
     * directories and entries that are gone.
     */
    it("should carry forward existing files and drop missing ones on commit", () => {
        const file = path.join(dir, "state.json");
        const existing = path.join(dir, "existing.md");
        const gone = path.join(dir, "gone.md");
        const fresh = path.join(dir, "fresh.md");

        fs.writeFileSync(existing, "x");
        fs.writeFileSync(fresh, "y");
        saveState(file, { ...emptyState(), dirs: [dir, path.join(dir, "missing-dir")], files: [entry(existing), entry(gone)] });

        const store = new StateStore(file);

        store.record(entry(fresh));

        const saved = store.commit();

        expect(saved.files.map((e) => e.dest)).toEqual([fresh, existing]);
        expect(saved.dirs).toEqual([dir]);
        expect(saved.lastBuild).not.toBe("");
        expect(loadState(file)).toEqual(saved);
        expect(store.pending()).toBe(false);
    });

    /** A dry-run commit saves nothing. */
    it("should save nothing on a dry-run commit", () => {
        const file = path.join(dir, "state.json");
        const store = new StateStore(file);

        store.record(entry(path.join(dir, "a.md")));
        store.commit({ dryRun: true });

        expect(fs.existsSync(file)).toBe(false);
    });

    /**
     * A foreign file (outside the project, recorded for another project) is not one of the
     * project's files, so nothing removes it; a build may still overwrite it (`entry` finds it),
     * and a commit forgets it unless the build wrote it again.
     */
    it("should keep another project's outside files out of its entries and forget them on commit", () => {
        const file = path.join(dir, "state.json");
        const root = path.join(dir, "b");
        const foreign = path.join(dir, "user", "x.md");

        fs.mkdirSync(path.dirname(foreign), { recursive: true });
        fs.writeFileSync(foreign, "x");
        fs.writeFileSync(file, JSON.stringify({ ...emptyState(), projectRoot: path.join(dir, "a"), files: [entry(foreign)] }));

        const store = new StateStore(file, root);

        expect(store.current().files).toEqual([]);
        expect(store.entry(foreign)?.dest).toBe(foreign);

        const saved = store.commit();

        expect(saved.files).toEqual([]);
        expect(saved.projectRoot).toBe(root);
        expect(store.entry(foreign)).toBeUndefined();
    });

    /** Deleting the store removes the state file. */
    it("should delete the state file", () => {
        const file = path.join(dir, "state.json");

        saveState(file, emptyState());

        expect(new StateStore(file).delete()).toBe(true);
        expect(fs.existsSync(file)).toBe(false);
    });
});

describe("StateService", () => {
    /** `filesFrom` selects by repository, recipe, plugin and target; every field given must match. */
    it("should select entries by where they came from", () => {
        const file = path.join(dir, "state.json");
        const a = entry("/p/a.md", { target: "skills/a", origin: { plugin: "skills", recipe: "ns/a", repository: "team" } });
        const b = entry("/p/b.md", { target: "skills/b", origin: { plugin: "skills", recipe: "ns/b", repository: "other" } });
        const c = entry("/p/c.md", { target: "0" });

        saveState(file, { ...emptyState(), files: [a, b, c] });

        const state = new StateService(new StateStore(file));

        expect(state.path()).toBe(file);
        expect(state.filesFrom({ repository: "team" })).toEqual([a]);
        expect(state.filesFrom({ plugin: "skills" })).toEqual([a, b]);
        expect(state.filesFrom({ plugin: "skills", recipe: "ns/b" })).toEqual([b]);
        expect(state.filesFrom({ target: "0" })).toEqual([c]);
        expect(state.filesFrom({})).toEqual([a, b, c]);
        expect(state.isTracked("/p/a.md")).toBe(true);
        expect(state.isTracked("/p/z.md")).toBe(false);
        expect(matchesFilter(c, { recipe: "ns/a" })).toBe(false);
    });
});
