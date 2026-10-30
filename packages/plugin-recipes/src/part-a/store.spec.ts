import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSousErrorOfKind } from "@sous-io/plugin-api";
import type { ContentHash, StoreEntry } from "@sous-io/plugin-formats/types";
import { afterEach, describe, expect, it } from "vitest";
import type { StoreKey } from "../types.js";
import { formatStoreKey, RecipeStore, STORE_ENTRY_FILENAME, storeKeyOf } from "./store.js";

const dirs: string[] = [];

function tmp(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sous-store-"));

    dirs.push(dir);

    return dir;
}

function write(root: string, relative: string, contents: string): void {
    const target = path.join(root, relative);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
}

/** A stand-in for `formats.recipe-hash`: names and contents, bytewise, the marker left out. */
async function hashDirectory(directory: string): Promise<ContentHash> {
    const hash = createHash("sha256");
    const walk = (dir: string, prefix: string): void => {
        for (const name of fs.readdirSync(dir).sort()) {
            const full = path.join(dir, name);
            const relative = prefix === "" ? name : `${prefix}/${name}`;
            const stat = fs.lstatSync(full);

            if (name === STORE_ENTRY_FILENAME || stat.isSymbolicLink()) {
                continue;
            }

            if (stat.isDirectory()) {
                walk(full, relative);
            } else {
                hash.update(relative).update("\0").update(fs.readFileSync(full)).update("\0");
            }
        }
    };

    walk(directory, "");

    return `sha256-${hash.digest("hex")}`;
}

function makeStore(): { store: RecipeStore; warnings: string[]; root: string } {
    const root = path.join(tmp(), "cache");
    const warnings: string[] = [];
    const store = new RecipeStore({
        root,
        hashDirectory,
        hashesEqual: (left, right) => left.toLowerCase() === right.toLowerCase(),
        parseEntry: (value) => {
            if (typeof value !== "object" || value === null || (value as { formatVersion?: unknown }).formatVersion !== 1) {
                throw new Error("not a store entry");
            }

            return value as StoreEntry;
        },
        stringifyEntry: (entry) => `${JSON.stringify(entry, null, 2)}\n`,
        warn: (message) => warnings.push(message),
    });

    return { store, warnings, root };
}

function makeSource(contents = "alpha"): string {
    const dir = tmp();

    write(dir, "SKILL.md", contents);
    write(dir, "references/detail.md", "detail");

    return dir;
}

const key: StoreKey = { identity: "github.com/sous-io/sous-recipes", namespace: "workflow", name: "task-files", version: "1.2.0" };

afterEach(() => {
    while (dirs.length > 0) {
        fs.rmSync(dirs.pop()!, { recursive: true, force: true });
    }
});

describe("RecipeStore", () => {
    /** An entry lives at `<root>/<identity segments>/<namespace>/<name>/<version>`. */
    it("should lay an entry out under its repository identity", () => {
        const { store, root } = makeStore();

        expect(store.entryDir(key)).toBe(path.join(root, "github.com", "sous-io", "sous-recipes", "workflow", "task-files", "1.2.0"));
    });

    /** A key part that could escape the root is refused. */
    it("should refuse an unsafe key", () => {
        const { store } = makeStore();

        expect(() => store.entryDir({ ...key, namespace: ".." })).toThrow(/not a usable directory name/);
        expect(() => store.entryDir({ ...key, identity: "nohost" })).toThrow(/not a repository identity/);
    });

    /** `put` copies the files, writes a marker, and `get` verifies and returns them. */
    it("should put and get an entry", async () => {
        const { store } = makeStore();
        const source = makeSource();
        const entry = await store.put(key, source);

        expect(entry).toMatchObject({ repo: key.identity, namespace: "workflow", name: "task-files", version: "1.2.0", sizeBytes: 11 });
        expect(entry.hash).toBe(await hashDirectory(source));

        const hit = await store.get(key);

        expect(hit?.dir).toBe(store.entryDir(key));
        expect(fs.readFileSync(path.join(hit!.dir, "SKILL.md"), "utf8")).toBe("alpha");
        expect(await store.has(key)).toBe(true);
    });

    /** `.git` and symbolic links never reach the store. */
    it("should skip .git and links", async () => {
        const { store } = makeStore();
        const source = makeSource();

        write(source, ".git/HEAD", "ref");
        write(source, "docs/a.md", "beta");
        // A junction on Windows, where a file symlink needs elevated rights; the type is ignored elsewhere.
        fs.symlinkSync(path.join(source, "docs"), path.join(source, "link"), "junction");
        await store.put(key, source);

        expect(fs.existsSync(path.join(store.entryDir(key), ".git"))).toBe(false);
        expect(fs.existsSync(path.join(store.entryDir(key), "link"))).toBe(false);
        expect(fs.existsSync(path.join(store.entryDir(key), "docs", "a.md"))).toBe(true);
    });

    /** A hash that does not match the pin writes nothing. */
    it("should refuse content that does not match the pinned hash", async () => {
        const { store } = makeStore();

        await expect(store.put(key, makeSource(), "sha256-0000")).rejects.toSatisfy((error: unknown) => isSousErrorOfKind(error, "config"));
        expect(await store.has(key)).toBe(false);
    });

    /** A published version never changes, so different content for a stored version is refused. */
    it("should refuse to overwrite a version with different content", async () => {
        const { store } = makeStore();

        await store.put(key, makeSource("one"));
        await expect(store.put(key, makeSource("two"))).rejects.toThrow(/different content/);
        await expect(store.put(key, makeSource("one"))).resolves.toMatchObject({ version: "1.2.0" });
    });

    /** An entry whose files changed on disk is removed and reported, so it is fetched again. */
    it("should heal a damaged entry", async () => {
        const { store, warnings } = makeStore();

        await store.put(key, makeSource());
        fs.writeFileSync(path.join(store.entryDir(key), "SKILL.md"), "tampered");

        expect(await store.get(key)).toBeUndefined();
        expect(warnings[0]).toMatch(/did not match its recorded content hash/);
        expect(fs.existsSync(store.entryDir(key))).toBe(false);
    });

    /** An unreadable marker counts as absent, with a warning. */
    it("should treat an unreadable marker as absent", async () => {
        const { store, warnings } = makeStore();

        await store.put(key, makeSource());
        fs.writeFileSync(path.join(store.entryDir(key), STORE_ENTRY_FILENAME), "{nope");

        expect(await store.has(key)).toBe(false);
        expect(warnings[0]).toMatch(/could not be read/);
    });

    /** `remove` deletes the entry and the empty directories above it, keeping the root. */
    it("should remove an entry and prune empty parents", async () => {
        const { store, root } = makeStore();

        await store.put(key, makeSource());
        await store.remove(key);

        expect(fs.existsSync(path.join(root, "github.com"))).toBe(false);
        expect(fs.existsSync(root)).toBe(true);
    });

    /** `list` finds entries at any depth and skips the index cache. */
    it("should list every entry", async () => {
        const { store, root } = makeStore();
        const other: StoreKey = { identity: "gitlab.com/acme/platform/recipes", namespace: "a", name: "b", version: "0.1.0" };

        await store.put(key, makeSource());
        await store.put(other, makeSource());
        write(root, "_indexes/x/.sous.entry.json", JSON.stringify({ formatVersion: 1 }));

        const listed = (await store.list()).map((entry) => formatStoreKey(storeKeyOf(entry))).sort();

        expect(listed).toEqual([formatStoreKey(key), formatStoreKey(other)].sort());
    });

    /** `gc` evicts the least recently used first, never a kept key, and reports a dry run without removing. */
    it("should collect least recently used entries past the cap", async () => {
        const { store } = makeStore();
        const older: StoreKey = { ...key, version: "1.0.0" };
        const kept: StoreKey = { ...key, version: "0.9.0" };

        for (const [index, item] of [kept, older, key].entries()) {
            await store.put(item, makeSource());

            const marker = path.join(store.entryDir(item), STORE_ENTRY_FILENAME);
            const entry = JSON.parse(fs.readFileSync(marker, "utf8")) as StoreEntry;

            fs.writeFileSync(marker, JSON.stringify({ ...entry, lastAccessAt: `2026-01-0${index + 1}T00:00:00.000Z` }));
        }

        const dry = await store.gc({ maxBytes: 22, keep: [kept], dryRun: true });

        expect(dry.dryRun).toBe(true);
        expect(dry.evicted.map((entry) => entry.version)).toEqual(["1.0.0"]);
        expect(await store.has(older)).toBe(true);

        const report = await store.gc({ maxBytes: 22, keep: [kept] });

        expect(report.bytesBefore).toBe(33);
        expect(report.bytesAfter).toBe(22);
        expect(await store.has(older)).toBe(false);
        expect(await store.has(kept)).toBe(true);
    });
});
