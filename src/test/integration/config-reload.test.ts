import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import chokidar from "chokidar";
import { WatchService, type WatchEvent } from "../../lib/watch-service.js";

/**
 * Integration tests for the WatchService + BuildService composition around
 * "full rebuild on config change" behaviour.
 *
 * Chokidar is mocked with an EventEmitter + fake timers so we can test the
 * full rebuild signal path without real filesystem events or real wait times.
 * This mirrors the pattern established in src/test/watch/watch-service.test.ts.
 */

// Holds the most-recently created mock watcher. Replaced on every chokidar.watch() call.
let mockWatcher: EventEmitter & { close: () => Promise<void> };

vi.mock("chokidar", () => ({
  default: {
    watch: vi.fn(() => {
      mockWatcher = Object.assign(new EventEmitter(), {
        close: vi.fn().mockResolvedValue(undefined),
      });
      return mockWatcher;
    }),
  },
}));

describe("WatchService + BuildService", () => {
  describe("full rebuild on config change", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.mocked(chokidar.watch).mockClear();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    /**
     * When a path listed in `fullRebuildPaths` receives a change event,
     * WatchService must fire `onChange` with `{ type: "full", filePath }` after
     * the debounce window closes.
     *
     * Example:
     *   fullRebuildPaths: ["/config/sous.config.js"]
     *   emit('all', 'change', '/config/sous.config.js')
     *   → advance 350 ms
     *   → onChange({ type: "full", filePath: "/config/sous.config.js" })
     *
     * This is the signal that build.ts uses to stop the current watcher,
     * reload settings, and start a fresh watcher with updated config.
     */
    it("should fire a full rebuild event when a fullRebuildPaths config file changes", async () => {
      const onChange = vi.fn().mockResolvedValue(undefined);

      new WatchService().watch(
        { files: [], globs: [], fullRebuildPaths: ["/config/sous.config.js"] },
        onChange
      );

      mockWatcher.emit("all", "change", "/config/sous.config.js");

      // Still within the debounce window — callback must not have fired yet
      expect(onChange).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(350);

      expect(onChange).toHaveBeenCalledOnce();
      expect(onChange).toHaveBeenCalledWith<[WatchEvent]>({
        type: "full",
        reason: "/config/sous.config.js",
        filePath: "/config/sous.config.js",
      });
    });

    /**
     * The build.ts watch loop stops the current WatchHandle and creates a new
     * one after a full-rebuild event (so the new watcher uses reloaded settings).
     * Calling `handle.stop()` must close the underlying chokidar instance, and a
     * subsequent `WatchService.watch()` call must open a fresh chokidar watcher.
     *
     * Example:
     *   handle1 = service.watch(config, onChange)   → chokidar.watch call #1
     *   await handle1.stop()                         → mockWatcher.close() called once
     *   handle2 = service.watch(config, onChange)   → chokidar.watch call #2
     *   → chokidar.watch called exactly twice total
     *   → close() called exactly once (only by handle1.stop())
     */
    it("should allow stopping a watcher and starting a new one independently", async () => {
      const onChange = vi.fn().mockResolvedValue(undefined);
      const service = new WatchService();
      const watchConfig = { files: ["/project/AGENTS.md"], globs: [] };

      const handle1 = service.watch(watchConfig, onChange);

      // Capture a reference to the first mock watcher before handle2 replaces it
      const firstWatcher = mockWatcher;

      await handle1.stop();

      expect(firstWatcher.close).toHaveBeenCalledOnce();

      // Start a second watcher — should succeed independently of the first
      const handle2 = service.watch(watchConfig, onChange);

      expect(vi.mocked(chokidar.watch)).toHaveBeenCalledTimes(2);

      // Second watcher's close must not have been called yet
      expect(mockWatcher.close).not.toHaveBeenCalled();

      // Cleanup: stop the second handle
      await handle2.stop();
    });

    /**
     * When `fullRebuildPaths` contains a directory path, any file change event
     * whose path starts with that directory should also fire a full rebuild
     * event — directory prefix matching.
     *
     * Example:
     *   fullRebuildPaths: ["/sous/src/templating"]
     *   emit('all', 'change', '/sous/src/templating/filters/my-filter.ts')
     *   → advance 350 ms
     *   → onChange({ type: "full", ... })
     *
     * This supports watching an entire directory (e.g. the LiquidJS templating
     * dir) so that any change within it triggers a full rebuild.
     */
    it("should fire a full rebuild event for a file nested inside a fullRebuildPaths directory", async () => {
      const onChange = vi.fn().mockResolvedValue(undefined);

      new WatchService().watch(
        { files: [], globs: [], fullRebuildPaths: ["/sous/src/templating"] },
        onChange
      );

      mockWatcher.emit("all", "change", "/sous/src/templating/filters/my-filter.ts");

      expect(onChange).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(350);

      expect(onChange).toHaveBeenCalledOnce();
      const evt = onChange.mock.calls[0][0] as WatchEvent;
      expect(evt.type).toBe("full");
      expect(evt.filePath).toBe("/sous/src/templating/filters/my-filter.ts");
    });
  });
});
