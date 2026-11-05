/**
 * Downloading a pinned recipe into the store: the work directories an interrupted download left
 * behind are swept first (gh-204, bug 32).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RecipesStore, RepositoryHostContext, RepositoryHostEntity } from "../../types.js";
import type { IndexCacheCore } from "../index-cache/index-cache.js";
import { ensureInStore } from "./restore.js";

let root: string;

beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sous-restore-spec-")));
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

/** Makes a directory under the store root whose modification time is `ageMs` in the past. */
function leftover(name: string, ageMs: number): string {
    const dir = path.join(root, name);

    fs.mkdirSync(path.join(dir, ".sous-fetch-abc", "checkout-0"), { recursive: true });

    const when = new Date(Date.now() - ageMs);

    for (const at of [path.join(dir, ".sous-fetch-abc", "checkout-0"), path.join(dir, ".sous-fetch-abc"), dir]) {
        fs.utimesSync(at, when, when);
    }

    return dir;
}

describe("ensureInStore()", () => {
    /**
     * Before downloading, it removes the `.sous-restore-*` work directories an interrupted download
     * (Ctrl-C) left in the store root more than an hour ago, with the `.sous-fetch-*` directories
     * inside them. A younger one may belong to a build running now, so it stays.
     *
     * // <store>/.sous-restore-old (2 hours old), <store>/.sous-restore-new (1 minute old)
     * await ensureInStore(target, deps);
     * // -> .sous-restore-old is gone, .sous-restore-new stays
     */
    it("should remove work directories an interrupted download left more than an hour ago", async () => {
        const old = leftover(".sous-restore-old", 2 * 60 * 60 * 1000);
        const fresh = leftover(".sous-restore-new", 60 * 1000);
        const store = {
            root,
            entryDir: () => path.join(root, "github.com", "acme", "recipes", "ns", "r", "1.0.0"),
            get: async () => undefined,
            put: async () => ({ version: "1.0.0" }),
        } as unknown as RecipesStore;
        const cache = {
            get: async () => ({
                source: "network",
                index: { recipes: { "ns/r": { path: "recipes/ns/r", versions: { "1.0.0": { tag: "ns/r@1.0.0" } } } } },
            }),
        } as unknown as IndexCacheCore;
        const host = {
            id: "fake",
            matches: () => true,
            canonicalize: (url: string) => url,
            fetchRecipeTree: async (_repo: unknown, _path: string, _tag: string, destination: string) => {
                fs.mkdirSync(destination, { recursive: true });
            },
        } as unknown as RepositoryHostEntity;

        await ensureInStore(
            { key: "ns/r", entry: { version: "1.0.0", hash: "sha256-x" } as never, repo: "acme", url: "https://github.com/acme/recipes", identity: "github.com/acme/recipes" },
            { store, cache, hosts: [host], context: {} as RepositoryHostContext },
        );

        expect(fs.existsSync(old)).toBe(false);
        expect(fs.existsSync(fresh)).toBe(true);
    });
});
