import { describe, expect, it } from "vitest";
import type { Contribution } from "@sous-io/sous-plugin-api";
import { declarerLabel, entryIdentity, listOwners, normalizeEntry } from "./entries.js";

describe("normalizeEntry()", () => {
    /**
     * Several operation keys run in their defined order, whatever order they are written in; the
     * entry's settings take their defaults (once off, rollback on, backupBeforeChange off,
     * backupOnRemoval on).
     *
     * { file, sort, ensureIncludes, set }  -> steps: set, ensureIncludes, sort
     */
    it("should order operation keys by their definitions and fill the defaults", () => {
        const entry = normalizeEntry({
            file: ".claude/settings.json",
            sort: { path: "permissions.allow" },
            ensureIncludes: { path: "permissions.allow", items: ["a"] },
            set: { path: "env.MODE", value: "strict" },
        });

        expect(entry.steps.map((step) => step.definition.name)).toEqual(["set", "ensureIncludes", "sort"]);
        expect(entry.settings).toEqual({ once: false, rollback: true, backupBeforeChange: false, backupOnRemoval: true });
    });

    /**
     * An `operations` list keeps its order and may repeat an operation.
     */
    it("should keep the order of an operations list", () => {
        const entry = normalizeEntry({
            file: "a.json",
            operations: [{ sort: {} }, { ensureIncludes: { items: ["x"] } }, { ensureIncludes: { items: ["y"] } }],
        });

        expect(entry.steps.map((step) => step.definition.name)).toEqual(["sort", "ensureIncludes", "ensureIncludes"]);
    });

    /**
     * Wrong entries are refused with a sentence naming the problem: an unknown key, no file,
     * operation keys beside an operations list, `except` with `kinds`, an unknown check.
     */
    it("should refuse wrong entries", () => {
        expect(() => normalizeEntry({ file: "a.json", id: "x", set: { value: 1 } })).toThrow(/'id' is not an operation/);
        expect(() => normalizeEntry({ set: { value: 1 } })).toThrow(/needs a 'file'/);
        expect(() => normalizeEntry({ file: "a.json", sort: {}, operations: [] })).toThrow(/not both/);
        expect(() => normalizeEntry({ file: "a.json", silence: { kinds: ["sorted"], except: ["unique"] } })).toThrow(/except/);
        expect(() => normalizeEntry({ file: "a.json", assert: { isGood: true } })).toThrow(/no check named 'isGood'/);
        expect(() => normalizeEntry({ file: "a.json" })).toThrow(/needs an operation/);
        expect(() => normalizeEntry({ ensureDirectoryExists: { paths: ["a"] } })).not.toThrow();
    });

    /**
     * An `assert` object with several checks is one assertion per check, level error by default.
     */
    it("should split an assert object into one assertion per check", () => {
        const entry = normalizeEntry({ file: "a.json", assert: { path: "l", includes: "x", sorted: true, level: "warn", message: "m" } });

        expect(entry.asserts).toEqual([
            { path: "l", check: "includes", arg: "x", not: false, level: "warn", message: "m" },
            { path: "l", check: "sorted", arg: true, not: false, level: "warn", message: "m" },
        ]);
    });
});

describe("entryIdentity()", () => {
    /**
     * Identity is who declared it plus what it says: the same entry from another declarer, or
     * with another value, is another identity.
     */
    it("should differ by declarer and by what the entry says", () => {
        const steps = normalizeEntry({ file: "a.json", set: { path: "a", value: 1 } }).steps;
        const other = normalizeEntry({ file: "a.json", set: { path: "a", value: 2 } }).steps;

        expect(entryIdentity("x", "a.json", steps)).toBe(entryIdentity("x", "a.json", steps));
        expect(entryIdentity("x", "a.json", steps)).not.toBe(entryIdentity("y", "a.json", steps));
        expect(entryIdentity("x", "a.json", steps)).not.toBe(entryIdentity("x", "a.json", other));
        expect(entryIdentity("x", "a.json", steps, 0)).not.toBe(entryIdentity("x", "a.json", steps, 1));
    });
});

describe("listOwners()", () => {
    const contribution = (plugin: string, patches: unknown[]): Contribution =>
        ({ plugin, contributor: `${plugin}/c`, stage: 0, applyOrder: 2000, actualApplyOrder: 2000, runs: 1, patches: { name: "c", patches } }) as never;

    /**
     * Replaying every contributor's primitives tells who added each item of the list, including a
     * config file that set the whole `editor` key.
     */
    it("should name the contributor that added each item", () => {
        const owners = listOwners(
            [
                contribution("@sous-io/sous-plugin-recipes", [{ op: "insertAt", path: "editor.edits", index: "end", value: {} }]),
                contribution("acme", [{ op: "insertAt", path: "editor.edits", index: "end", value: {} }]),
                contribution("@sous-io/sous-plugin-config-files", [{ op: "insertAt", path: "editor.edits", index: "end", value: {} }]),
            ],
            "editor.edits",
            3,
        );

        expect(owners?.map((owner) => declarerLabel(owner, undefined))).toEqual(["@sous-io/sous-plugin-recipes", "acme", "project"]);
        expect(declarerLabel(owners?.[0], "voltagrid/session-harness")).toBe("voltagrid/session-harness");

        const whole = listOwners([contribution("x", [{ op: "setKey", path: "", key: "editor", value: { edits: [{}, {}] } }])], "editor.edits", 2);

        expect(whole?.map((owner) => owner?.plugin)).toEqual(["x", "x"]);
        expect(listOwners([], "editor.edits", 1)).toBeUndefined();
    });
});
