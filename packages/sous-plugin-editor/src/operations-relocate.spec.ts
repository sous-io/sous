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
