/**
 * The managed `conf.d/5xx` files, edited surgically. Ported from the old managed-layer spec
 * (src/lib/repos/managed-layer.spec.ts), on real temporary directories, since the point is what
 * ends up on disk.
 */

import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "@sous-io/documents";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTmpDir, type TmpDir } from "../test/helpers.js";
import { ConfdManagedImpl, MANAGED_FILE_COMMENT, managedHeader } from "./managed.js";

const REPOS = "500-repos.jsonc";
const SUBSCRIPTIONS = "510-subscriptions.jsonc";

let tmp: TmpDir;
let confDir: string;
let managed: ConfdManagedImpl;

beforeEach(() => {
    tmp = makeTmpDir("sous-managed-");
    confDir = path.join(tmp.path, ".sous", "conf.d");
    managed = new ConfdManagedImpl({ confDir, ensureDirectory: async (directory) => void fs.mkdirSync(directory, { recursive: true }) });
});

afterEach(() => {
    tmp.cleanup();
});

/** The file's text on disk. */
function text(name = REPOS): string {
    return fs.readFileSync(path.join(confDir, name), "utf8");
}

/** Writes a file directly, bypassing the code under test. */
function seed(name: string, content: string): string {
    fs.mkdirSync(confDir, { recursive: true });

    const full = path.join(confDir, name);

    fs.writeFileSync(full, content, "utf8");

    return full;
}

describe("confd.managed", () => {
    /** A file never written reads as missing. */
    it("should read a missing file as undefined", async () => {
        expect(await managed.read(REPOS)).toBeUndefined();
        expect(managed.path(REPOS)).toBe(path.join(confDir, REPOS));
    });

    /** The header is a real comment stating the policy. */
    it("should open managed files with a comment stating the policy", () => {
        expect(managedHeader(REPOS, [])).toContain("// This file is managed by sous");
        expect(MANAGED_FILE_COMMENT).toContain("you may edit them");
        expect(managed.header("599-mine.jsonc", ["It holds my plugin's things."])).toContain("// It holds my plugin's things.");
    });

    /** A header names only commands sous has. */
    it("should name only commands sous really has", () => {
        const repos = managedHeader(REPOS, []);

        expect(repos).toContain("'sous repo add'");
        expect(repos).toContain("'sous repo remove'");

        const subscriptions = managedHeader(SUBSCRIPTIONS, []);

        expect(subscriptions).toContain("'sous subscription add'");
        expect(subscriptions).toContain("'sous subscription remove'");
        expect(subscriptions).not.toContain("'sous subscribe'");
    });

    /** set() on a missing file creates conf.d and the file, with its header. */
    it("should create a new file with its header and the requested entry", async () => {
        const result = await managed.set(REPOS, 'repos."team-recipes"', { url: "https://github.com/team/recipes" });

        expect(result).toMatchObject({ file: path.join(confDir, REPOS), created: true, changed: true });
        expect(result.patches).toEqual({
            name: 'set repos."team-recipes"',
            patches: [{ op: "setKey", path: "repos", key: "team-recipes", value: { url: "https://github.com/team/recipes" } }],
        });
        expect(text().startsWith("// This file is managed by sous")).toBe(true);
        expect(text().endsWith("\n")).toBe(true);
        expect(parseDocument(text(), "jsonc").value()).toEqual({ repos: { "team-recipes": { url: "https://github.com/team/recipes" } } });
        expect(await managed.read(REPOS)).toEqual({ repos: { "team-recipes": { url: "https://github.com/team/recipes" } } });
    });

    /** An edit rewrites only the entry it changes: comments and key order survive. */
    it("should keep a user's comment and key order across an edit", async () => {
        seed(
            REPOS,
            [
                "// managed by sous",
                "{",
                '  "repos": {',
                "    // ours, do not remove",
                '    "zebra": { "url": "https://github.com/team/zebra" },',
                '    "alpha": { "url": "https://github.com/team/alpha" }',
                "  }",
                "}",
                "",
            ].join("\n"),
        );

        await managed.set(REPOS, "repos.zebra.alwaysPull", true);

        expect(text()).toContain("// managed by sous");
        expect(text()).toContain("// ours, do not remove");
        expect(text().indexOf('"zebra"')).toBeLessThan(text().indexOf('"alpha"'));
        expect(await managed.read(REPOS)).toEqual({
            repos: {
                zebra: { url: "https://github.com/team/zebra", alwaysPull: true },
                alpha: { url: "https://github.com/team/alpha" },
            },
        });
    });

    /** delete() removes one key and leaves the rest. */
    it("should remove a key", async () => {
        await managed.set(REPOS, "repos.one", { url: "https://github.com/a/one" });
        await managed.set(REPOS, "repos.two", { url: "https://github.com/a/two" });

        const result = await managed.delete(REPOS, "repos.one");

        expect(result.changed).toBe(true);
        expect(Object.keys((await managed.read(REPOS))!.repos as object)).toEqual(["two"]);
    });

    /** Removing a key from a file that was never written is already done; no file appears. */
    it("should treat removing a key from a missing file as done", async () => {
        const result = await managed.delete(REPOS, "repos.one");

        expect(result).toMatchObject({ created: false, changed: false });
        expect(fs.existsSync(path.join(confDir, REPOS))).toBe(false);
    });

    /** The same when the block the key lives in is missing. */
    it("should treat removing a key with no containing block as done", async () => {
        seed(REPOS, `${managedHeader(REPOS, [])}{}\n`);

        expect(await managed.delete(REPOS, "repos.one")).toMatchObject({ changed: false });
        expect(await managed.read(REPOS)).toEqual({});
    });

    /** A file still under its old .json name is read, and moves to .jsonc on the next write. */
    it("should migrate a .json file to .jsonc on the next write", async () => {
        const legacy = seed("500-repos.json", JSON.stringify({ repos: { one: { url: "https://github.com/a/one" } } }, null, 2));

        expect(await managed.read(REPOS)).toEqual({ repos: { one: { url: "https://github.com/a/one" } } });

        await managed.set(REPOS, "repos.two", { url: "https://github.com/a/two" });

        expect(fs.existsSync(legacy)).toBe(false);
        expect(fs.readdirSync(confDir)).toEqual([REPOS]);
        expect(await managed.read(REPOS)).toEqual({
            repos: { one: { url: "https://github.com/a/one" }, two: { url: "https://github.com/a/two" } },
        });
    });

    /** edit() with replace() writes the whole content: what is gone from it is gone from the file. */
    it("should replace the file in full through edit()", async () => {
        await managed.edit(REPOS, (root) => root.replace({ repos: { one: { url: "a" }, two: { url: "b" } } }));
        await managed.edit(REPOS, (root) => root.replace({ repos: { two: { url: "b" } } }));

        expect(Object.keys((await managed.read(REPOS))!.repos as object)).toEqual(["two"]);
        expect(text().startsWith("// This file is managed by sous")).toBe(true);
    });

    /** No temporary file is left behind. */
    it("should leave no temporary file behind", async () => {
        await managed.edit(REPOS, (root) => root.atPath("repos").set({}));

        expect(fs.readdirSync(confDir)).toEqual([REPOS]);
    });

    /** Comments and trailing commas are part of the format. */
    it("should read a file with comments and trailing commas", async () => {
        seed(REPOS, ["// a note", "{", '  "repos": {', '    "one": { "url": "https://github.com/a/one" },', "  },", "}", ""].join("\n"));

        expect(await managed.read(REPOS)).toEqual({ repos: { one: { url: "https://github.com/a/one" } } });
    });

    /** A damaged file is an error naming it, never a silent overwrite. */
    it("should raise a ConfigError when the file does not parse", async () => {
        seed(REPOS, "{ not json");

        await expect(managed.read(REPOS)).rejects.toThrow(/could not read its own config file/);
        await expect(managed.set(REPOS, "repos.a", {})).rejects.toThrow(/could not read its own config file/);
        expect(text()).toBe("{ not json");
    });

    /** A dry run computes the new text and writes nothing. */
    it("should write nothing on a dry run", async () => {
        const result = await managed.set(SUBSCRIPTIONS, 'subscriptions."workflow/x".enabled', false, { dryRun: true, description: ["Mine."] });

        expect(result.changed).toBe(true);
        expect(result.text).toContain("// Mine.");
        expect(result.text).toContain('"enabled": false');
        expect(fs.existsSync(confDir)).toBe(false);
    });

    /**
     * `sous subscription disable <ref>` overwrites the user's condition; adding another
     * subscription keeps the user's lines as they are (S2's ruling).
     */
    it("should overwrite only the key it is asked to, keeping the user's other lines", async () => {
        seed(
            SUBSCRIPTIONS,
            [
                "{",
                '    "subscriptions": {',
                '        "a/one": { "enabled": { "$if": "host.platform == \'darwin\'" } } // mine',
                "    }",
                "}",
                "",
            ].join("\n"),
        );

        await managed.set(SUBSCRIPTIONS, 'subscriptions."a/two"', { range: "^1.0.0" });
        expect(text(SUBSCRIPTIONS)).toContain('"a/one": { "enabled": { "$if": "host.platform == \'darwin\'" } }, // mine');

        await managed.set(SUBSCRIPTIONS, 'subscriptions."a/one".enabled', false);
        expect(text(SUBSCRIPTIONS)).toContain("// mine");
        expect((await managed.read(SUBSCRIPTIONS))!.subscriptions).toEqual({ "a/one": { enabled: false }, "a/two": { range: "^1.0.0" } });
    });

    /** Outside a project there is no conf.d. */
    it("should refuse outside a project", () => {
        expect(() => new ConfdManagedImpl({ confDir: undefined, ensureDirectory: async () => {} }).path(REPOS)).toThrow(/no sous project/);
    });
});
