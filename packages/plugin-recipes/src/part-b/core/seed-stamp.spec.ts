import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StoreEntry } from "@sous-io/plugin-formats/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STORE_ENTRY_FILENAME } from "../../part-a/store.js";
import type { StoreKey } from "../../types.js";
import { createSeedStamp, fingerprintOf, SEED_STAMP_FILENAME, type SeedStamp } from "./seed-stamp.js";

const KEY: StoreKey = { identity: "github.com/sous-io/sous-recipes", namespace: "core", name: "sous-skills", version: "1.0.0" };

let root: string;
let entryDir: string;
let stamp: SeedStamp;

/** A marker as the store writes it. */
function entry(hash: string): StoreEntry {
    return { formatVersion: 1, repo: KEY.identity, namespace: KEY.namespace, name: KEY.name, version: KEY.version, hash, fetchedAt: "", lastAccessAt: "", sizeBytes: 0 } as StoreEntry;
}

function writeMarker(hash: string): void {
    fs.writeFileSync(path.join(entryDir, STORE_ENTRY_FILENAME), JSON.stringify(entry(hash)), "utf8");
}

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sous-seed-stamp-"));
    entryDir = path.join(root, "entry");
    fs.mkdirSync(path.join(entryDir, "skills"), { recursive: true });
    fs.writeFileSync(path.join(entryDir, "sous.recipe.yaml"), "name: sous-skills\n", "utf8");
    fs.writeFileSync(path.join(entryDir, "skills", "a.md"), "# a\n", "utf8");
    writeMarker("sha256-aaa");
    stamp = createSeedStamp({ storeRoot: root, entryDir: () => entryDir });
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("createSeedStamp()", () => {
    /** With nothing recorded, the full check has to run. */
    it("should know nothing before a full check was recorded", () => {
        expect(stamp.read(KEY)).toBeUndefined();
    });

    /** After a full check, an untouched entry is taken as checked, marker and all. */
    it("should hand back an untouched entry after a full check", () => {
        stamp.write(KEY, entry("sha256-aaa"));

        expect(fs.existsSync(path.join(root, SEED_STAMP_FILENAME))).toBe(true);
        expect(stamp.read(KEY)?.hash).toBe("sha256-aaa");
    });

    /** The marker records when the entry was last read; rewriting it changes nothing. */
    it("should ignore a rewritten marker that keeps its hash", () => {
        stamp.write(KEY, entry("sha256-aaa"));
        fs.writeFileSync(path.join(entryDir, STORE_ENTRY_FILENAME), JSON.stringify({ ...entry("sha256-aaa"), lastAccessAt: "2026-10-29T00:00:00.000Z" }), "utf8");

        expect(stamp.read(KEY)?.hash).toBe("sha256-aaa");
    });

    /** A changed, added or removed file sends sous back to the full check, which heals the copy. */
    it("should refuse an entry whose files changed", () => {
        stamp.write(KEY, entry("sha256-aaa"));
        fs.writeFileSync(path.join(entryDir, "skills", "a.md"), "# a, edited\n", "utf8");
        expect(stamp.read(KEY)).toBeUndefined();

        stamp.write(KEY, entry("sha256-aaa"));
        fs.writeFileSync(path.join(entryDir, "skills", "b.md"), "# b\n", "utf8");
        expect(stamp.read(KEY)).toBeUndefined();
    });

    /** Another hash in the marker, another version, or a damaged stamp: all mean "check in full". */
    it("should refuse another hash, another key and a damaged stamp", () => {
        stamp.write(KEY, entry("sha256-aaa"));
        writeMarker("sha256-bbb");
        expect(stamp.read(KEY)).toBeUndefined();

        writeMarker("sha256-aaa");
        expect(stamp.read({ ...KEY, version: "2.0.0" })).toBeUndefined();

        fs.writeFileSync(path.join(root, SEED_STAMP_FILENAME), "{ not json", "utf8");
        expect(stamp.read(KEY)).toBeUndefined();
    });
});

describe("fingerprintOf()", () => {
    /** The same files give the same fingerprint; the marker is left out. */
    it("should not depend on the marker", () => {
        const before = fingerprintOf(entryDir);

        writeMarker("sha256-other");

        expect(fingerprintOf(entryDir)).toBe(before);
    });
});
