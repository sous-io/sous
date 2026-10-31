import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { chokidarWatcher } from "../src/watch/watcher.js";

/** Ported from src/test/e2e/watch-loop.test.ts: the real chokidar, on real files. */
describe("chokidarWatcher", () => {
    /**
     * A real file modified on disk reaches `onEvent` as a change; after close(), nothing does.
     *
     * writeFileSync(file, "v2"); // -> onEvent("change", file)
     */
    it("should report a real change, and nothing after close", async () => {
        const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "sous-chokidar-")));
        const file = path.join(dir, "AGENTS.md");
        const events: Array<[string, string]> = [];

        writeFileSync(file, "v1");

        const handle = await chokidarWatcher([file], { ignored: () => false }, (event, changed) => events.push([event, changed]));

        await new Promise((resolve) => setTimeout(resolve, 300));
        writeFileSync(file, "v2");
        await vi.waitFor(() => expect(events).toContainEqual(["change", file]), { timeout: 5000 });

        await handle.close();
        events.length = 0;
        writeFileSync(file, "v3");
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(events).toEqual([]);
    }, 10_000);
});
