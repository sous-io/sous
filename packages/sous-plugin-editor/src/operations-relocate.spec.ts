import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDocument, type JsonObject } from "@sous-io/sous-lib-documents";
import type { ConfigBuilder } from "@sous-io/sous-plugin-api";
import { apply, makeTmpDir, read, write, type TestEntry } from "../test/helpers.js";
import { editor } from "./chain.js";
import { chainParams, OPERATIONS, resolveOperation } from "./operations.js";

let tmp: { path: string; cleanup(): void };

beforeEach(() => {
    tmp = makeTmpDir();
});

afterEach(() => {
    tmp.cleanup();
});

/**
 * Writes `text` to `file`, applies the entries through `editor.apply`'s code, then applies nothing
 * (every entry no longer declared), so each test can check the edit and its rollback.
 */
async function roundTrip(file: string, text: string, ...entries: JsonObject[]) {
    write(tmp.path, file, text);

    const declared: TestEntry[] = entries.map((entry) => ({ entry: { file, ...entry } }));
    const applied = await apply(tmp.path, declared);
    const after = read(tmp.path, file);
    const again = await apply(tmp.path, declared);
    const afterAgain = read(tmp.path, file);

    await apply(tmp.path, []);

    return { after, afterAgain, again, undone: read(tmp.path, file), applied };
}

/** The entries a chain records, from a stand-in config builder. */
function recorded(contribute: (config: ConfigBuilder) => void): JsonObject[] {
    const config = createDocument({});

    contribute(config as unknown as ConfigBuilder);

    return (config.value() as { editor: { edits: JsonObject[] } }).editor.edits;
}

/** Applies what a chain recorded, for a file it names. */
async function applyRecorded(entries: JsonObject[]) {
    return apply(tmp.path, entries.map((entry) => ({ entry })));
}

const ENV_JSONC = `{
    // Settings for the demo.
    "env": {
        "OLD_DIR": "/tmp/a", // where it goes
        "MODE": "strict"
    },
    "other": {
        "KEEP": 1
    }
}
`;

const ENV_YAML = `# Settings for the demo.
env:
  OLD_DIR: /tmp/a # where it goes
  MODE: strict
other:
  KEEP: 1
`;

describe("copy", () => {
    /**
     * The value at `path` is written at `to`; the source stays, and removing the entry deletes the
     * copy, giving the original text back byte for byte.
     *
     * copy: { path: env.OLD_DIR, to: other.DIR }   // other gets "DIR": "/tmp/a"
     */
    it("should copy a value in JSONC and undo it byte for byte", async () => {
        const { after, afterAgain, undone, applied } = await roundTrip("s.jsonc", ENV_JSONC, { copy: { path: "env.OLD_DIR", to: "other.DIR" } });

        expect(after).toBe(`{
    // Settings for the demo.
    "env": {
        "OLD_DIR": "/tmp/a", // where it goes
        "MODE": "strict"
    },
    "other": {
        "KEEP": 1,
        "DIR": "/tmp/a"
    }
}
`);
        expect(afterAgain).toBe(after);
        expect(applied.reporter.at("warning")).toEqual([]);
        expect(undone).toBe(ENV_JSONC);
    });

    /**
     * The same in YAML, copying a whole object.
     *
     * copy: { path: env, to: other.ENV }
     */
    it("should copy an object in YAML and undo it byte for byte", async () => {
        const { after, undone } = await roundTrip("s.yaml", ENV_YAML, { copy: { path: "env", to: "other.ENV" } });

        expect(after).toBe(`# Settings for the demo.
env:
  OLD_DIR: /tmp/a # where it goes
  MODE: strict
other:
  KEEP: 1
  ENV:
    OLD_DIR: /tmp/a
    MODE: strict
`);
        expect(undone).toBe(ENV_YAML);
    });

    /**
     * In a Markdown file, the frontmatter is edited and the body kept byte for byte.
     */
    it("should copy a value in Markdown frontmatter", async () => {
        const text = "---\nmodel: opus # the big one\n---\n# Reviewer\n\nmodel: not this\n";
        const { after, undone } = await roundTrip("agent.md", text, { copy: { path: "model", to: "fallbackModel" } });

        expect(after).toBe("---\nmodel: opus # the big one\nfallbackModel: opus\n---\n# Reviewer\n\nmodel: not this\n");
        expect(undone).toBe(text);
    });

    /**
     * A value already at `to` is replaced, and a rollback puts it back.
     */
    it("should replace the value at the destination and restore it on rollback", async () => {
        const { after, undone } = await roundTrip("s.yaml", ENV_YAML, { copy: { path: "env.MODE", to: "other.KEEP" } });

        expect(after).toBe(ENV_YAML.replace("KEEP: 1", "KEEP: strict"));
        expect(undone).toBe(ENV_YAML);
    });

    /**
     * With `ifMissing: true`, a destination that has a value keeps it; a missing one is filled.
     */
    it("should only fill a missing destination with ifMissing", async () => {
        const kept = await roundTrip("s.yaml", ENV_YAML, { copy: { path: "env.MODE", to: "other.KEEP", ifMissing: true } });

        expect(kept.after).toBe(ENV_YAML);

        const filled = await roundTrip("s.yaml", ENV_YAML, { copy: { path: "env.MODE", to: "other.MODE", ifMissing: true } });

        expect(filled.after).toBe(ENV_YAML.replace("  KEEP: 1\n", "  KEEP: 1\n  MODE: strict\n"));
        expect(filled.undone).toBe(ENV_YAML);
    });

    /**
     * Nothing at `path`: nothing is copied, nothing is said, and no assertion fails.
     */
    it("should do nothing when the source is missing", async () => {
        const { after, applied } = await roundTrip("s.jsonc", ENV_JSONC, { copy: { path: "env.NOPE", to: "other.DIR" } });

        expect(after).toBe(ENV_JSONC);
        expect(applied.reporter.at("warning")).toEqual([]);
        expect(applied.result.assertions.every((assertion) => assertion.passed)).toBe(true);
    });

    /**
     * A later build copies the source's new value; the rollback still goes back to before Sous
     * first acted.
     */
    it("should follow a changed source and still roll back to the original", async () => {
        const entry: TestEntry = { entry: { file: "s.yaml", copy: { path: "env.MODE", to: "other.MODE" } } };

        write(tmp.path, "s.yaml", ENV_YAML);
        await apply(tmp.path, [entry]);
        write(tmp.path, "s.yaml", read(tmp.path, "s.yaml")!.replace("MODE: strict\nother", "MODE: loose\nother"));
        await apply(tmp.path, [entry]);

        expect(read(tmp.path, "s.yaml")).toContain("  KEEP: 1\n  MODE: loose\n");

        await apply(tmp.path, []);

        expect(read(tmp.path, "s.yaml")).toBe(ENV_YAML.replace("MODE: strict\nother", "MODE: loose\nother"));
    });

    /**
     * A `to` naming a list item replaces that item; one past the end of the list is skipped with
     * a warning (adding to a list is `ensureIncludes`'s job).
     */
    it("should replace a list item, and skip an item that is not there", async () => {
        const text = "first: lint\nsteps:\n  - build\n  - test\n";
        const replaced = await roundTrip("s.yaml", text, { copy: { path: "first", to: "steps[1]" } });

        expect(replaced.after).toBe("first: lint\nsteps:\n  - build\n  - lint\n");
        expect(replaced.undone).toBe(text);

        const skipped = await roundTrip("s.yaml", text, { copy: { path: "first", to: "steps[5]" } });

        expect(skipped.after).toBe(text);
        expect(skipped.applied.reporter.at("warning").join("\n")).toMatch(/no item 5 there to replace/);
    });

    /**
     * `to` is required, is not the root, and may not overlap `path`.
     */
    it("should refuse a missing or overlapping destination", () => {
        expect(() => resolveOperation("copy", { path: "a" })).toThrow(/needs 'to'/);
        expect(() => resolveOperation("copy", { path: "a", to: "" })).toThrow(/needs 'to'/);
        expect(() => resolveOperation("copy", { to: "b" })).toThrow(/needs the 'path'/);
        expect(() => resolveOperation("copy", { path: "a", to: "a.b" })).toThrow(/overlap/);
        expect(() => resolveOperation("copy", { path: "a.b", to: "a" })).toThrow(/overlap/);
        expect(() => resolveOperation("copy", { path: "a", to: "b", ifMissing: "yes" })).toThrow(/true or false/);
        expect(resolveOperation("copy", { path: "a", to: "b" }).definition.order).toBe(20);
        expect(OPERATIONS.get("copy")!.assertions({ to: "b" }, "a")).toEqual([]);
    });

    /**
     * The chain records the same entry: `settings.at("env.MODE").copy("other.MODE")`.
     */
    it("should be recorded by the chain and applied", async () => {
        write(tmp.path, "s.yaml", ENV_YAML);

        const entries = recorded((config) => {
            editor(config).file("s.yaml").at("env.MODE").copy("other.MODE", { ifMissing: true });
        });

        expect(entries).toEqual([{ file: "s.yaml", copy: { path: "env.MODE", to: "other.MODE", ifMissing: true } }]);
        expect(chainParams("copy", ["b"])).toEqual({ to: "b" });

        await applyRecorded(entries);

        expect(read(tmp.path, "s.yaml")).toBe(ENV_YAML.replace("  KEEP: 1\n", "  KEEP: 1\n  MODE: strict\n"));
    });
});

describe("move", () => {
    /**
     * Within one object, a move is a rename: the key keeps its place, its value's text and the
     * comment on its line.
     *
     * move: { path: env.OLD_DIR, to: env.DIR }
     */
    it("should rename within one object, keeping the text and comment, in JSONC and YAML", async () => {
        const jsonc = await roundTrip("s.jsonc", ENV_JSONC, { move: { path: "env.OLD_DIR", to: "env.DIR" } });

        expect(jsonc.after).toBe(ENV_JSONC.replace('"OLD_DIR"', '"DIR"'));
        expect(jsonc.afterAgain).toBe(jsonc.after);
        expect(jsonc.undone).toBe(ENV_JSONC);

        const yaml = await roundTrip("s.yaml", ENV_YAML, { move: { path: "env.OLD_DIR", to: "env.DIR" } });

        expect(yaml.after).toBe(ENV_YAML.replace("OLD_DIR:", "DIR:"));
        expect(yaml.undone).toBe(ENV_YAML);
    });

    /**
     * To another object, the value is written at `to` and taken away from `path`; a rollback
     * puts it back in its old place.
     *
     * move: { path: env.MODE, to: other.MODE }
     */
    it("should move a value to another object and put it back in its place", async () => {
        const text = '{\n    "env": {\n        "MODE": "strict",\n        "DIR": "/tmp/a"\n    },\n    "other": {}\n}\n';
        const jsonc = await roundTrip("s.jsonc", text, { move: { path: "env.MODE", to: "other.MODE" } });

        expect(jsonc.after).toBe('{\n    "env": {\n        "DIR": "/tmp/a"\n    },\n    "other": {\n        "MODE": "strict"\n    }\n}\n');
        expect(jsonc.afterAgain).toBe(jsonc.after);
        expect(jsonc.undone).toBe(text);

        const yaml = "env:\n  A: 1\n  MODE: strict # kept\n  DIR: /tmp/a\nother:\n  KEEP: 1\n";
        const moved = await roundTrip("s.yaml", yaml, { move: { path: "env.MODE", to: "other.MODE" } });

        expect(moved.after).toBe("env:\n  A: 1\n  DIR: /tmp/a\nother:\n  KEEP: 1\n  MODE: strict\n");
        // The comment on the moved key's line does not travel to another object (the library
        // keeps a key's text only within its own object); every other byte comes back.
        expect(moved.undone).toBe("env:\n  A: 1\n  MODE: strict\n  DIR: /tmp/a\nother:\n  KEEP: 1\n");
    });

    /**
     * A value can be moved into a list item's place, replacing the item; a rollback puts both back.
     */
    it("should move a value over a list item and put both back", async () => {
        const text = "tools:\n  - read\n  - write\nprimary: bash\n";
        const { after, undone } = await roundTrip("s.yaml", text, { move: { path: "primary", to: "tools[1]" } });

        expect(after).toBe("tools:\n  - read\n  - bash\n");
        expect(undone).toBe(text);
    });

    /**
     * A value already at `to` is replaced; with `ifMissing: true` it is kept, and nothing moves.
     */
    it("should replace the destination, or with ifMissing leave both alone", async () => {
        const replaced = await roundTrip("s.yaml", ENV_YAML, { move: { path: "env.MODE", to: "other.KEEP" } });

        expect(replaced.after).toBe("# Settings for the demo.\nenv:\n  OLD_DIR: /tmp/a # where it goes\nother:\n  KEEP: strict\n");
        expect(replaced.undone).toBe(ENV_YAML);

        const renamedOver = await roundTrip("s.jsonc", ENV_JSONC, { move: { path: "env.OLD_DIR", to: "env.MODE" } });

        expect(renamedOver.after).toBe(ENV_JSONC.replace('"OLD_DIR": "/tmp/a",', '"MODE": "/tmp/a"').replace('\n        "MODE": "strict"', ""));
        expect(renamedOver.undone).toBe(ENV_JSONC);

        const kept = await roundTrip("s.yaml", ENV_YAML, { move: { path: "env.MODE", to: "other.KEEP", ifMissing: true } });

        expect(kept.after).toBe(ENV_YAML);
        expect(kept.applied.result.assertions.filter((assertion) => !assertion.passed)).toEqual([]);
    });

    /**
     * Nothing at `path`: nothing moves, and the automatic assertion (`path` does not exist) holds.
     */
    it("should do nothing when the source is missing", async () => {
        const { after, applied } = await roundTrip("s.jsonc", ENV_JSONC, { move: { path: "env.NOPE", to: "other.NOPE" } });

        expect(after).toBe(ENV_JSONC);
        expect(applied.result.assertions).toEqual([
            expect.objectContaining({ path: "env.NOPE", check: "exists", automatic: true, passed: true }),
        ]);
    });

    /**
     * The automatic assertion catches a later edit that puts the old key back.
     */
    it("should warn when a later edit brings the source back", async () => {
        write(tmp.path, "s.yaml", ENV_YAML);

        const { result } = await apply(tmp.path, [
            { entry: { file: "s.yaml", move: { path: "env.MODE", to: "other.MODE" } } },
            { entry: { file: "s.yaml", set: { path: "env.MODE", value: "loose" } }, by: "someone-else" },
        ]);

        expect(result.assertions.find((assertion) => assertion.check === "exists" && assertion.path === "env.MODE")?.passed).toBe(false);
    });

    /**
     * `to` is required and may not overlap `path`; an item moved within its own list is a job for
     * `moveItem`.
     */
    it("should refuse a missing or overlapping destination", () => {
        expect(() => resolveOperation("move", { path: "a" })).toThrow(/needs 'to'/);
        expect(() => resolveOperation("move", { path: "a", to: "a.b" })).toThrow(/overlap/);
        expect(() => resolveOperation("move", { path: "list[0]", to: "other" })).toThrow(/moveItem/);
        expect(OPERATIONS.get("move")!.assertions({ to: "b" }, "a")).toEqual([{ check: "exists", arg: false, path: "a" }]);
        expect(OPERATIONS.get("move")!.assertions({ to: "b", ifMissing: true }, "a")).toEqual([]);
    });

    /**
     * The chain records the same entry: `settings.at("env.OLD_DIR").move("env.DIR")`.
     */
    it("should be recorded by the chain and applied", async () => {
        write(tmp.path, "s.yaml", ENV_YAML);

        const entries = recorded((config) => {
            editor(config).file("s.yaml").at("env.OLD_DIR").move("env.DIR");
        });

        expect(entries).toEqual([{ file: "s.yaml", move: { path: "env.OLD_DIR", to: "env.DIR" } }]);

        await applyRecorded(entries);

        expect(read(tmp.path, "s.yaml")).toBe(ENV_YAML.replace("OLD_DIR:", "DIR:"));
    });
});

const HOOKS_JSONC = `{
    "hooks": [
        { "id": "lint", "run": "pnpm lint" }, // first
        { "id": "test", "run": "pnpm test" }
    ]
}
`;

const HOOKS_YAML = `hooks:
  - id: lint # first
    run: pnpm lint
  - id: test
    run: pnpm test
`;

describe("insertBeforeWhere and insertAfterWhere", () => {
    /**
     * The item goes just before the first item matching `where`; a rollback removes it.
     *
     * insertBeforeWhere: { path: hooks, where: { id: test }, item: { id: types } }
     */
    it("should insert before the matching item in JSONC and YAML, and undo it byte for byte", async () => {
        const item = { id: "types", run: "tsc" };
        const jsonc = await roundTrip("s.jsonc", HOOKS_JSONC, { insertBeforeWhere: { path: "hooks", where: { id: "test" }, item } });

        expect(jsonc.after).toBe(`{
    "hooks": [
        { "id": "lint", "run": "pnpm lint" }, // first
        { "id": "types", "run": "tsc" },
        { "id": "test", "run": "pnpm test" }
    ]
}
`);
        expect(jsonc.undone).toBe(HOOKS_JSONC);

        const yaml = await roundTrip("s.yaml", HOOKS_YAML, { insertBeforeWhere: { path: "hooks", where: { id: "test" }, item } });

        expect(yaml.after).toBe(`hooks:
  - id: lint # first
    run: pnpm lint
  - id: types
    run: tsc
  - id: test
    run: pnpm test
`);
        expect(yaml.undone).toBe(HOOKS_YAML);
    });

    /**
     * `insertAfterWhere` puts the items just after the matching item, in the order given.
     */
    it("should insert several items after the matching item", async () => {
        const items = [{ id: "a" }, { id: "b" }];
        const { after, undone } = await roundTrip("s.yaml", HOOKS_YAML, { insertAfterWhere: { path: "hooks", where: { id: "lint" }, items } });

        expect(after).toBe(`hooks:
  - id: lint # first
    run: pnpm lint
  - id: a
  - id: b
  - id: test
    run: pnpm test
`);
        expect(undone).toBe(HOOKS_YAML);

        const md = "---\ntags:\n  - name: x\n  - name: y\n---\nBody\n";
        const frontmatter = await roundTrip("a.md", md, { insertAfterWhere: { path: "tags", where: { name: "x" }, item: { name: "n" } } });

        expect(frontmatter.after).toBe("---\ntags:\n  - name: x\n  - name: n\n  - name: y\n---\nBody\n");
        expect(frontmatter.undone).toBe(md);
    });

    /**
     * No item matches: the items go at the end, as `insertBefore` and `ensureLine` do with an
     * anchor that is not found.
     */
    it("should add at the end when nothing matches", async () => {
        const { after, undone } = await roundTrip("s.yaml", HOOKS_YAML, { insertBeforeWhere: { path: "hooks", where: { id: "nope" }, item: { id: "x" } } });

        expect(after).toBe(`${HOOKS_YAML}  - id: x\n`);
        expect(undone).toBe(HOOKS_YAML);
    });

    /**
     * An action: the item is added even when it is already there, and only once per declaration,
     * however many builds run.
     */
    it("should add an item already there, once per declaration", async () => {
        const { after, afterAgain, undone } = await roundTrip("s.yaml", HOOKS_YAML, {
            insertAfterWhere: { path: "hooks", where: { id: "test" }, item: { id: "lint" } },
        });

        expect(after).toBe(`${HOOKS_YAML}  - id: lint\n`);
        expect(afterAgain).toBe(after);
        expect(undone).toBe(HOOKS_YAML);
    });

    /**
     * A missing list is created, and removed again by the rollback; a value that is not a list is
     * skipped with a warning.
     */
    it("should create a missing list and refuse a value that is not one", async () => {
        const created = await roundTrip("s.jsonc", '{\n    "a": 1\n}\n', { insertBeforeWhere: { path: "hooks", where: { id: "x" }, item: "h" } });

        expect(created.after).toBe('{\n    "a": 1,\n    "hooks": ["h"]\n}\n');
        expect(created.undone).toBe('{\n    "a": 1\n}\n');

        const refused = await roundTrip("s.jsonc", '{\n    "hooks": "no"\n}\n', { insertAfterWhere: { path: "hooks", where: { id: "x" }, item: "h" } });

        expect(refused.after).toBe('{\n    "hooks": "no"\n}\n');
        expect(refused.applied.reporter.at("warning").join("\n")).toMatch(/needs a list at hooks/);
    });

    /**
     * Parameters: `where` must be an object, and an item is required. The automatic assertion is
     * that the list includes each item.
     */
    it("should check its parameters and imply includes", () => {
        expect(() => resolveOperation("insertBeforeWhere", { path: "a", where: "x", item: 1 })).toThrow(/object of fields/);
        expect(() => resolveOperation("insertAfterWhere", { path: "a", where: { id: 1 } })).toThrow(/needs 'items'/);
        expect(resolveOperation("insertAfterWhere", { path: "a", where: { id: 1 }, item: 2 }).params).toEqual({ path: "a", where: { id: 1 }, items: [2] });
        expect(OPERATIONS.get("insertBeforeWhere")!.action).toBe(true);
        expect(OPERATIONS.get("insertBeforeWhere")!.assertions({ items: [1, 2] }, "a")).toEqual([
            { check: "includes", arg: 1, path: "a" },
            { check: "includes", arg: 2, path: "a" },
        ]);
    });

    /**
     * The chain: `settings.at("hooks").insertAfterWhere({ id: "lint" }, { id: "fmt" })`.
     */
    it("should be recorded by the chain and applied", async () => {
        write(tmp.path, "s.yaml", HOOKS_YAML);

        const entries = recorded((config) => {
            const hooks = editor(config).file("s.yaml").at("hooks");

            hooks.insertAfterWhere({ id: "lint" }, { id: "fmt" });
            hooks.insertBeforeWhere({ id: "lint" }, { id: "first" });
        });

        expect(entries).toEqual([
            { file: "s.yaml", insertAfterWhere: { path: "hooks", where: { id: "lint" }, item: { id: "fmt" } } },
            { file: "s.yaml", insertBeforeWhere: { path: "hooks", where: { id: "lint" }, item: { id: "first" } } },
        ]);

        await applyRecorded(entries);

        expect(read(tmp.path, "s.yaml")).toBe(`hooks:
  - id: first
  - id: lint # first
    run: pnpm lint
  - id: fmt
  - id: test
    run: pnpm test
`);
    });
});

const LIST_JSONC = `{
    "allow": [
        "Read",
        "Bash(git:*)", // git only
        "Write",
        "Edit"
    ]
}
`;

const LIST_YAML = `allow:
  - Read
  - Bash(git:*) # git only
  - Write
  - Edit
`;

describe("moveItem", () => {
    /**
     * The item moves with its own text and the comment on its line, and a rollback puts it back.
     *
     * moveItem: { path: allow, item: "Bash(git:*)", position: first }
     */
    it("should move an item first with its comment in JSONC and YAML, and undo it byte for byte", async () => {
        const jsonc = await roundTrip("s.jsonc", LIST_JSONC, { moveItem: { path: "allow", item: "Bash(git:*)", position: "first" } });

        expect(jsonc.after).toBe(`{
    "allow": [
        "Bash(git:*)", // git only
        "Read",
        "Write",
        "Edit"
    ]
}
`);
        expect(jsonc.afterAgain).toBe(jsonc.after);
        expect(jsonc.undone).toBe(LIST_JSONC);

        const yaml = await roundTrip("s.yaml", LIST_YAML, { moveItem: { path: "allow", item: "Bash(git:*)", position: "first" } });

        expect(yaml.after).toBe("allow:\n  - Bash(git:*) # git only\n  - Read\n  - Write\n  - Edit\n");
        expect(yaml.undone).toBe(LIST_YAML);
    });

    /**
     * Every place: last, an index (counted without the item), before and after an item, and
     * before and after the first item matching some fields.
     */
    it("should move to last, an index, and before or after another item", async () => {
        const cases: Array<[JsonObject["position"], string]> = [
            ["last", "allow:\n  - Read\n  - Write\n  - Edit\n  - Bash(git:*) # git only\n"],
            [2, "allow:\n  - Read\n  - Write\n  - Bash(git:*) # git only\n  - Edit\n"],
            [99, "allow:\n  - Read\n  - Write\n  - Edit\n  - Bash(git:*) # git only\n"],
            [{ before: "Edit" }, "allow:\n  - Read\n  - Write\n  - Bash(git:*) # git only\n  - Edit\n"],
            [{ after: "Edit" }, "allow:\n  - Read\n  - Write\n  - Edit\n  - Bash(git:*) # git only\n"],
        ];

        for (const [position, expected] of cases) {
            const { after, undone } = await roundTrip("s.yaml", LIST_YAML, { moveItem: { path: "allow", item: "Bash(git:*)", position } });

            expect(after, JSON.stringify(position)).toBe(expected);
            expect(undone, JSON.stringify(position)).toBe(LIST_YAML);
        }

        const people = "people:\n  - id: 1\n    name: ann\n  - id: 2\n    name: bob\n  - id: 3\n    name: cy\n";
        const byFields = await roundTrip("p.yaml", people, { moveItem: { path: "people", where: { name: "cy" }, position: { beforeWhere: { id: 1 } } } });

        expect(byFields.after).toBe("people:\n  - id: 3\n    name: cy\n  - id: 1\n    name: ann\n  - id: 2\n    name: bob\n");
        expect(byFields.undone).toBe(people);

        const afterWhere = await roundTrip("p.yaml", people, { moveItemWhere: { path: "people", where: { id: 1 }, position: { afterWhere: { id: 2 } } } });

        expect(afterWhere.after).toBe("people:\n  - id: 2\n    name: bob\n  - id: 1\n    name: ann\n  - id: 3\n    name: cy\n");
        expect(afterWhere.undone).toBe(people);
    });

    /**
     * Nothing to move: the item is not in the list, the item to put it beside is not, the list is
     * missing, or the item is already in place. The file is left as it is, without a warning.
     */
    it("should do nothing when the item or the anchor is not found, or it is already in place", async () => {
        const entries: JsonObject[] = [
            { moveItem: { path: "allow", item: "Nope", position: "first" } },
            { moveItem: { path: "allow", item: "Write", position: { before: "Nope" } } },
            { moveItem: { path: "allow", where: { id: 1 }, position: "first" } },
            { moveItem: { path: "missing", item: "x", position: "first" } },
            { moveItem: { path: "allow", item: "Read", position: "first" } },
            { moveItem: { path: "allow", item: "Write", position: { after: "Bash(git:*)" } } },
        ];

        for (const entry of entries) {
            const { after, applied } = await roundTrip("s.yaml", LIST_YAML, entry);

            expect(after, JSON.stringify(entry)).toBe(LIST_YAML);
            expect(applied.reporter.at("warning"), JSON.stringify(entry)).toEqual([]);
        }
    });

    /**
     * A value that is not a list is skipped with a warning.
     */
    it("should skip a value that is not a list", async () => {
        const { after, applied } = await roundTrip("s.yaml", "allow: Read\n", { moveItem: { path: "allow", item: "Read", position: "last" } });

        expect(after).toBe("allow: Read\n");
        expect(applied.reporter.at("warning").join("\n")).toMatch(/needs a list at allow/);
    });

    /**
     * A later build that finds the item already in place changes nothing, and the rollback still
     * goes back to where it was before Sous first moved it.
     */
    it("should roll back to the original place after several builds", async () => {
        const entry: TestEntry = { entry: { file: "s.jsonc", moveItem: { path: "allow", item: "Edit", position: "first" } } };

        write(tmp.path, "s.jsonc", LIST_JSONC);
        await apply(tmp.path, [entry]);
        await apply(tmp.path, [entry]);

        const third = await apply(tmp.path, [entry]);

        expect(third.result.files).toEqual([{ file: "s.jsonc", action: "unchanged" }]);

        await apply(tmp.path, []);

        expect(read(tmp.path, "s.jsonc")).toBe(LIST_JSONC);
    });

    /**
     * Parameters: exactly one of `item` and `where`, and a `position` it understands.
     * `moveItemWhere` is `moveItem` with `where`.
     */
    it("should check its parameters", () => {
        expect(() => resolveOperation("moveItem", { path: "a", position: "first" })).toThrow(/exactly one of 'item'/);
        expect(() => resolveOperation("moveItem", { path: "a", item: 1, where: { id: 1 }, position: "first" })).toThrow(/exactly one of 'item'/);
        expect(() => resolveOperation("moveItem", { path: "a", item: 1 })).toThrow(/needs 'position'/);
        expect(() => resolveOperation("moveItem", { path: "a", item: 1, position: "middle" })).toThrow(/'position' must be/);
        expect(() => resolveOperation("moveItem", { path: "a", item: 1, position: { line: 2 } })).toThrow(/'position' must be/);
        expect(() => resolveOperation("moveItem", { path: "a", item: 1, position: { beforeWhere: "x" } })).toThrow(/object of fields/);

        const resolved = resolveOperation("moveItemWhere", { path: "a", where: { id: 1 }, position: "last" });

        expect(resolved.definition.name).toBe("moveItem");
        expect(resolved.params).toEqual({ path: "a", where: { id: 1 }, position: "last" });
        expect(() => resolveOperation("moveItemWhere", { path: "a", item: 1, position: "last" })).toThrow(/no parameter 'item'/);
        expect(OPERATIONS.get("moveItem")!.order).toBe(95);
        expect(OPERATIONS.get("moveItem")!.assertions({ item: 1, position: "first" }, "a")).toEqual([]);
    });

    /**
     * The chain: `settings.at("allow").moveItem("Edit", "first")` and
     * `.moveItemWhere({ id: 3 }, { after: ... })`.
     */
    it("should be recorded by the chain and applied", async () => {
        write(tmp.path, "s.yaml", LIST_YAML);

        const entries = recorded((config) => {
            const allow = editor(config).file("s.yaml").at("allow");

            allow.moveItem("Edit", "first");
            allow.moveItem("Read", { after: "Write" });
        });

        expect(entries).toEqual([
            { file: "s.yaml", moveItem: { path: "allow", item: "Edit", position: "first" } },
            { file: "s.yaml", moveItem: { path: "allow", item: "Read", position: { after: "Write" } } },
        ]);
        expect(chainParams("moveItemWhere", [{ id: 3 }, "last"])).toEqual({ where: { id: 3 }, position: "last" });

        await applyRecorded(entries);

        expect(read(tmp.path, "s.yaml")).toBe("allow:\n  - Edit\n  - Bash(git:*) # git only\n  - Write\n  - Read\n");
    });
});
