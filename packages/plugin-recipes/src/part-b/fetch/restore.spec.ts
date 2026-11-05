import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nullReporter } from "@sous-io/plugin-api";
import { indexFileFormat } from "@sous-io/plugin-formats";
import type { IndexFile } from "@sous-io/plugin-formats/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RecipesStore, RepositoryHostContext, RepositoryHostEntity } from "../../types.js";
import { IndexCacheCore } from "../index-cache/index-cache.js";
import { IndexReadError } from "../index-cache/read-chain.js";
import { ensureInStore, type RestoreTarget } from "./restore.js";

const URL = "https://github.com/sous-io/sous-recipes";
const IDENTITY = "github.com/sous-io/sous-recipes";
const HASH = `sha256-${"a".repeat(64)}` as const;

/** The index a fresh SOUS_HOME is seeded with: only the core recipe, and no sidecar. */
const seeded: IndexFile = {
    formatVersion: 1,
    name: "sous-recipes",
    generatedAt: "2026-10-01T00:00:00.000Z",
    generator: "1.0.16",
    namespaces: { core: {} },
    recipes: { "core/sous": { path: "recipes/core/sous", versions: { "1.0.16": { hash: HASH, tag: "core/sous@1.0.16", prerelease: false } } } },
};

/** A host whose every read fails to connect, as with no network. */
const offlineHost: RepositoryHostEntity = {
    id: "github",
    features: [],
    matches: (url: string) => url.startsWith("https://github.com/"),
    canonicalize: () => ({ host: "github.com", owner: "sous-io", name: "sous-recipes", httpsUrl: URL, sshUrl: "git@github.com:sous-io/sous-recipes.git" }),
    readLocation: () => [],
    formatLocator: () => "",
    fetchRecipeTree: async () => {},
    readStrategies: [
        { id: "http", label: "HTTP without token", read: async () => ({ ok: false, reason: "could not connect: Sous could not reach https://raw.githubusercontent.com/x: getaddrinfo ENOTFOUND raw.githubusercontent.com." }) },
        { id: "git", label: "git", read: async () => ({ ok: false, reason: "Could not resolve host: github.com" }) },
    ],
} as unknown as RepositoryHostEntity;

/** A store holding nothing. */
function emptyStore(root: string): RecipesStore {
    return { root, entryDir: () => path.join(root, "entry"), get: async () => undefined } as unknown as RecipesStore;
}

let dir: string;
let core: IndexCacheCore;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-"));
    core = new IndexCacheCore({
        directory: path.join(dir, "_indexes"),
        strategiesFile: path.join(dir, "read-strategies.json"),
        parser: indexFileFormat,
        hosts: () => [offlineHost],
        hostContext: () => ({ reporter: nullReporter }) as unknown as RepositoryHostContext,
    });
    // Seeded as a fresh SOUS_HOME is: the index file, no sidecar.
    core.writeIndex(IDENTITY, seeded);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("ensureInStore()", () => {
    /**
     * Offline with only the seeded index, a pinned version the seed does not list is reported as
     * the index read that failed, not as a version the repository does not offer (#204 bug 19).
     *
     * ensureInStore(core/sous-skills@0.2.33) // offline
     * // -> throws IndexReadError: "could not read github.com/sous-io/sous-recipes. ... could not connect ..."
     */
    it("should report the failed index read, not a missing version, when the index could not be read", async () => {
        const target: RestoreTarget = {
            key: "core/sous-skills",
            entry: { repo: "sous-recipes", version: "0.2.33", hash: HASH, requestedBy: ["project"], kind: "subscribes" },
            repo: "sous-recipes",
            url: URL,
            identity: IDENTITY,
        };
        const error = await ensureInStore(target, { store: emptyStore(path.join(dir, "store")), cache: core, hosts: [offlineHost], context: { reporter: nullReporter } as unknown as RepositoryHostContext }).then(
            () => expect.unreachable() as never,
            (caught: Error) => caught,
        );

        expect(error.message).not.toContain("does not offer it");
        expect(error).toBeInstanceOf(IndexReadError);
        expect(error.message).toContain("could not read github.com/sous-io/sous-recipes.");
        expect(error.message).toContain("getaddrinfo ENOTFOUND raw.githubusercontent.com");
    });
});
