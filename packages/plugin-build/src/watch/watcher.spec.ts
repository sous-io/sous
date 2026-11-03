import path from "node:path";
import { describe, expect, it } from "vitest";
import type { HostGlobs } from "@sous-io/plugin-host/types";
import { classifyChange, pathsToWatch } from "./paths.js";
import { ChangeBatcher } from "./watcher.js";
import type { WatchBatch, WatchedPaths } from "../types.js";
import { ManualTimers } from "../../test/timers.js";

const globs = {
    isMatch: (file: string, pattern: string | readonly string[]) => [pattern].flat().some((one) => path.matchesGlob(file, one)),
    staticBase: (pattern: string) => pattern.slice(0, pattern.indexOf("*")).replace(/\/$/u, ""),
    toPosix: (value: string) => value,
} as unknown as HostGlobs;

const set: WatchedPaths = {
    files: ["/project/AGENTS.md"],
    globs: ["/project/skills/**/*.md"],
    config: ["/project/.sous/sous.config.ts", "/project/.sous/conf.d"],
    extra: ["/project/partials"],
    outputs: ["/project/CLAUDE.md"],
    ignored: ["/project/.sous/.state.json"],
};

/** A batch with the defaults filled in. */
function batchOf(fields: Partial<WatchBatch>): WatchBatch {
    return { files: [], changed: [], added: [], removed: [], sources: false, config: false, outputs: false, ...fields };
}

function batcher() {
    const timers = new ManualTimers();
    const batches: WatchBatch[] = [];

    return { batches, timers, batcher: new ChangeBatcher(set, globs, 200, (batch) => batches.push(batch), timers) };
}

/** Ported from src/test/watch/watch-service.test.ts. */
describe("ChangeBatcher", () => {
    /**
     * A change to a watched source is a source batch, handed over when the debounce window closes.
     *
     * handle("change", "/project/AGENTS.md"); fire(); // -> [{ files: ["/project/AGENTS.md"], changed: [...], sources: true }]
     */
    it("should hand a source batch over after the debounce window", () => {
        const { batches, timers, batcher: b } = batcher();

        b.handle("change", "/project/AGENTS.md");
        expect(batches).toEqual([]);
        timers.fire();
        expect(batches).toEqual([batchOf({ files: ["/project/AGENTS.md"], changed: ["/project/AGENTS.md"], sources: true })]);
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
        expect(batches).toEqual([
            batchOf({
                files: ["/project/AGENTS.md", "/project/skills/a/SKILL.md"],
                changed: ["/project/AGENTS.md"],
                added: ["/project/skills/a/SKILL.md"],
                sources: true,
            }),
        ]);
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
     * A change to the config file, or to a file inside a config directory, marks the batch config.
     *
     * handle("add", "/project/.sous/conf.d/610-mac.jsonc"); // -> { config: true }
     */
    it("should mark the batch config for a config path or a file inside one", () => {
        const { batches, timers, batcher: b } = batcher();

        b.handle("change", "/project/AGENTS.md");
        b.handle("add", "/project/.sous/conf.d/610-mac.jsonc");
        timers.fire();
        expect(batches).toEqual([
            batchOf({
                files: ["/project/AGENTS.md", "/project/.sous/conf.d/610-mac.jsonc"],
                changed: ["/project/AGENTS.md"],
                added: ["/project/.sous/conf.d/610-mac.jsonc"],
                sources: true,
                config: true,
            }),
        ]);
    });

    /**
     * Outputs and extra paths are reported with their own flags.
     *
     * handle("unlink", "/project/CLAUDE.md"); handle("change", "/project/partials/a.md"); // -> { outputs: true, sources: true }
     */
    it("should report outputs and extra paths", () => {
        const { batches, timers, batcher: b } = batcher();

        b.handle("unlink", "/project/CLAUDE.md");
        timers.fire();
        b.handle("change", "/project/partials/a.md");
        timers.fire();
        expect(batches).toEqual([
            batchOf({ files: ["/project/CLAUDE.md"], removed: ["/project/CLAUDE.md"], outputs: true }),
            batchOf({ files: ["/project/partials/a.md"], changed: ["/project/partials/a.md"], sources: true }),
        ]);
    });

    /**
     * Added then changed stays added; removed then added again is changed.
     *
     * add, change a.md; unlink, add b.md; // -> added [a.md], changed [b.md]
     */
    it("should merge several events on one path", () => {
        const { batches, timers, batcher: b } = batcher();

        b.handle("add", "/project/skills/a.md");
        b.handle("change", "/project/skills/a.md");
        b.handle("unlink", "/project/AGENTS.md");
        b.handle("add", "/project/AGENTS.md");
        timers.fire();
        expect(batches[0]).toMatchObject({ added: ["/project/skills/a.md"], changed: ["/project/AGENTS.md"], removed: [] });
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
     * Config paths win over sources, and sources over outputs.
     *
     * classifyChange("/project/.sous/sous.config.ts", set, globs); // -> "config"
     */
    it("should classify each change", () => {
        expect(classifyChange("/project/.sous/sous.config.ts", set, globs)).toBe("config");
        expect(classifyChange("/project/skills/x/y.md", set, globs)).toBe("source");
        expect(classifyChange("/project/partials/deep/z.md", set, globs)).toBe("source");
        expect(classifyChange("/project/CLAUDE.md", set, globs)).toBe("output");
        expect(classifyChange("/project/README.md", set, globs)).toBe("ignored");
        expect(classifyChange("/project/.sous/conf.dx", set, globs)).toBe("ignored");
    });

    /**
     * The watcher is given files, each glob's static base, the config paths, the extra paths and the outputs.
     *
     * pathsToWatch(set, globs); // -> ["/project/AGENTS.md", "/project/skills", ...]
     */
    it("should watch globs by their static base", () => {
        expect(pathsToWatch(set, globs)).toEqual([
            "/project/AGENTS.md",
            "/project/skills",
            "/project/.sous/sous.config.ts",
            "/project/.sous/conf.d",
            "/project/partials",
            "/project/CLAUDE.md",
        ]);
    });
});
