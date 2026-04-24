import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { WatchService, type WatchEvent } from "../../lib/watch-service.js";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";

/**
 * End-to-end tests for WatchService.watch() using real chokidar and real files.
 *
 * These tests intentionally use real timers and real OS-level file events —
 * no mocks. They are slow (~1–2 s per test) and are excluded from the default
 * `npm test` run. Run them explicitly with `npm run test:e2e`.
 */

/**
 * Polls the predicate every 50 ms until it returns true or the timeout elapses.
 * Throws if the timeout is reached before the condition is satisfied.
 */
async function waitFor(fn: () => boolean, timeout = 5000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("Timeout waiting for condition");
    await new Promise(r => setTimeout(r, 50));
  }
}

describe("WatchService (e2e)", () => {
  let tmp: TmpDir | null = null;
  let handle: Awaited<ReturnType<InstanceType<typeof WatchService>["watch"]>> | null = null;

  afterEach(async () => {
    if (handle) {
      await handle.stop();
      handle = null;
    }
    if (tmp) {
      tmp.cleanup();
      tmp = null;
    }
    vi.restoreAllMocks();
  });

  /**
   * A 'change' event on a file listed in WatchConfig.files should call onChange
   * exactly once with a partial rebuild event after the 300 ms debounce period.
   *
   * Example:
   *   filePath = "<tmpdir>/source.md"
   *   write "# Hello" → start watcher → write "# Updated"
   *   → onChange({ type: "partial", filePath }) called once
   */
  it("should fire a partial event via onChange after a real file is modified on disk", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    tmp = makeTmpDir("sous-e2e-");
    const filePath = path.join(tmp.path, "source.md");
    fs.writeFileSync(filePath, "# Hello\n", "utf8");

    const events: WatchEvent[] = [];
    const onChange = async (event: WatchEvent) => {
      events.push(event);
    };

    handle = new WatchService().watch({ files: [filePath], globs: [] }, onChange);

    // Give chokidar time to set up its OS-level watches before we modify the file.
    await new Promise(r => setTimeout(r, 200));

    fs.writeFileSync(filePath, "# Updated\n", "utf8");

    // Wait up to 5 s for the debounced callback to fire (debounce is 300 ms;
    // we budget an extra 500 ms for OS event latency, totalling ~800 ms typical).
    await waitFor(() => events.length > 0, 5000);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual<WatchEvent>({ type: "partial", filePath });
  });

  /**
   * Calling handle.stop() before a file is modified should prevent onChange
   * from being called, because the underlying chokidar watcher is closed.
   *
   * Example:
   *   start watcher → stop() immediately → write "# Updated"
   *   → wait 800 ms → onChange never called
   */
  it("should not call onChange after handle.stop() is called before the file changes", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    tmp = makeTmpDir("sous-e2e-");
    const filePath = path.join(tmp.path, "source.md");
    fs.writeFileSync(filePath, "# Hello\n", "utf8");

    const events: WatchEvent[] = [];
    const onChange = async (event: WatchEvent) => {
      events.push(event);
    };

    handle = new WatchService().watch({ files: [filePath], globs: [] }, onChange);

    // Give chokidar time to initialise before stopping.
    await new Promise(r => setTimeout(r, 200));

    await handle.stop();
    // Null out so afterEach does not double-stop.
    handle = null;

    fs.writeFileSync(filePath, "# Updated\n", "utf8");

    // Wait well past the debounce window to confirm silence.
    await new Promise(r => setTimeout(r, 800));

    expect(events).toHaveLength(0);
  });
});
