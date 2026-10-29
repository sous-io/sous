import path from "node:path";
import { describe, expect, it } from "vitest";
import type { HostGlobs } from "@sous-io/plugin-host/types";
import { classifyChange, pathsToWatch, type WatchSet } from "./paths.js";
import { type ChangeBatch, ChangeBatcher } from "./watcher.js";
import { ManualTimers } from "../../test/timers.js";

const globs = {
    isMatch: (file: string, pattern: string | readonly string[]) => [pattern].flat().some((one) => path.matchesGlob(file, one)),
    staticBase: (pattern: string) => pattern.slice(0, pattern.indexOf("*")).replace(/\/$/u, ""),
    toPosix: (value: string) => value,
} as unknown as HostGlobs;

const set: WatchSet = {
    files: ["/project/AGENTS.md"],
    globs: ["/project/skills/**/*.md"],
    fullRebuildPaths: ["/project/.sous/sous.config.ts", "/project/.sous/conf.d"],
    ignored: ["/project/.sous/.state.json"],
};

function batcher() {
    const timers = new ManualTimers();
    const batches: ChangeBatch[] = [];

    return { batches, timers, batcher: new ChangeBatcher(set, globs, 200, (batch) => batches.push(batch), timers) };
}

/** Ported from src/test/watch/watch-service.test.ts. */
describe("ChangeBatcher", () => {
    /**
     * A change to a watched file is a partial batch, handed over when the debounce window closes.
     *
     * handle("change", "/project/AGENTS.md"); fire(); // -> [{ files: ["/project/AGENTS.md"], full: false }]
     */
    it("should hand a partial batch over after the debounce window", () => {
        const { batches, timers, batcher: b } = batcher();

        b.handle("change", "/project/AGENTS.md");
        expect(batches).toEqual([]);
        timers.fire();
        expect(batches).toEqual([{ files: ["/project/AGENTS.md"], full: false }]);
    });

    /**
     * Rapid changes within the window become one batch, each file once.
     *
     * handle × 3; fire(); // -> one batch
     */
    it("should debounce rapid successive changes into a single batch", () => {
        const { batches, timers, batcher: b } = batcher();

        b.handle("change", "/project/AGENTS.md");
        b.handle("change", "/project/AGENTS.md");
        b.handle("add", "/project/skills/a/SKILL.md");
        expect(timers.pending.size).toBe(1);
        timers.fire();
        expect(batches).toEqual([{ files: ["/project/AGENTS.md", "/project/skills/a/SKILL.md"], full: false }]);
    });

    /**
     * Files outside the watch set, non-change events and ignored files start nothing.
     *
     * handle("change", "/project/other.md"); handle("addDir", ...); // -> no timer
     */
    it("should ignore unwatched files, non-change events and ignored files", () => {
        const { timers, batcher: b } = batcher();

        b.handle("change", "/project/other.md");
        b.handle("change", "/project/skills/a/notes.txt");
        b.handle("addDir", "/project/AGENTS.md");
        b.handle("change", "/project/.sous/.state.json");
        expect(timers.pending.size).toBe(0);
    });

    /**
     * Added and removed files count, like changed ones.
     *
     * handle("unlink", "/project/AGENTS.md"); // -> a batch
     */
    it("should react to added and unlinked files", () => {
        const { batches, timers, batcher: b } = batcher();

        b.handle("unlink", "/project/AGENTS.md");
        timers.fire();
        b.handle("add", "/project/skills/b/SKILL.md");
        timers.fire();
        expect(batches).toHaveLength(2);
    });

    /**
     * A change to the config file, or to a file inside a full-rebuild directory, makes the batch full.
     *
     * handle("change", "/project/.sous/conf.d/610-mac.jsonc"); // -> { full: true }
     */
    it("should make the batch full for a full-rebuild path or a file inside one", () => {
        const { batches, timers, batcher: b } = batcher();

        b.handle("change", "/project/AGENTS.md");
        b.handle("add", "/project/.sous/conf.d/610-mac.jsonc");
        timers.fire();
        expect(batches).toEqual([{ files: ["/project/AGENTS.md", "/project/.sous/conf.d/610-mac.jsonc"], full: true }]);
    });

    /**
     * cancel() drops what was collected.
     *
     * handle(...); cancel(); // -> no batch
     */
    it("should drop pending changes on cancel", () => {
        const { batches, timers, batcher: b } = batcher();

        b.handle("change", "/project/AGENTS.md");
        b.cancel();
        timers.fire();
        expect(batches).toEqual([]);
    });
});

describe("classifyChange() and pathsToWatch()", () => {
    /**
     * Full-rebuild paths win over source files.
     *
     * classifyChange("/project/.sous/sous.config.ts", set, globs); // -> "full"
     */
    it("should classify each change", () => {
        expect(classifyChange("/project/.sous/sous.config.ts", set, globs)).toBe("full");
        expect(classifyChange("/project/skills/x/y.md", set, globs)).toBe("partial");
        expect(classifyChange("/project/README.md", set, globs)).toBe("ignored");
        expect(classifyChange("/project/.sous/conf.dx", set, globs)).toBe("ignored");
    });

    /**
     * The watcher is given files, each glob's static base, and the full-rebuild paths.
     *
     * pathsToWatch(set, globs); // -> ["/project/AGENTS.md", "/project/skills", ...]
     */
    it("should watch globs by their static base", () => {
        expect(pathsToWatch(set, globs)).toEqual(["/project/AGENTS.md", "/project/skills", "/project/.sous/sous.config.ts", "/project/.sous/conf.d"]);
    });
});
