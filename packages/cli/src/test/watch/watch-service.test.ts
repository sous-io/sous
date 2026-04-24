import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import chokidar from "chokidar";
import { WatchService, type WatchEvent } from "../../lib/watch-service.js";

/**
 * Chokidar relies on kernel-level fs.watch() and cannot be used with memfs.
 * Instead, we mock chokidar.watch() to return a real EventEmitter, then emit
 * file events manually. Combined with fake timers, this lets us test all
 * WatchService behaviour (debounce, filtering, glob matching) without real
 * files or real wait times.
 */

// Holds the EventEmitter created by the mocked chokidar.watch() call.
// Tests emit events on this object to simulate filesystem changes.
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

describe("WatchService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("watch()", () => {
    /**
     * watch() should fire a partial rebuild event with the changed file path
     * after the debounce period (300 ms) has elapsed since the last file event.
     *
     * emit('all', 'change', '/project/AGENTS.md')
     * → advance 350 ms
     * → onChange({ type: "partial", filePath: '/project/AGENTS.md' }) called once
     */
    it("should call onChange with a partial event after the debounce period when a watched file changes", async () => {
      const onChange = vi.fn().mockResolvedValue(undefined);
      new WatchService().watch({ files: ["/project/AGENTS.md"], globs: [] }, onChange);

      mockWatcher.emit("all", "change", "/project/AGENTS.md");

      expect(onChange).not.toHaveBeenCalled(); // still within debounce window

      await vi.advanceTimersByTimeAsync(350);

      expect(onChange).toHaveBeenCalledOnce();
      expect(onChange).toHaveBeenCalledWith<[WatchEvent]>({
        type: "partial",
        filePath: "/project/AGENTS.md",
      });
    });

    /**
     * watch() should debounce rapid successive changes to the same file,
     * coalescing them into a single onChange call after the window closes.
     *
     * emit × 3 over 200 ms → advance 350 ms → onChange called exactly once
     */
    it("should debounce rapid successive changes into a single callback", async () => {
      const onChange = vi.fn().mockResolvedValue(undefined);
      new WatchService().watch({ files: ["/project/AGENTS.md"], globs: [] }, onChange);

      mockWatcher.emit("all", "change", "/project/AGENTS.md");
      await vi.advanceTimersByTimeAsync(100);
      mockWatcher.emit("all", "change", "/project/AGENTS.md");
      await vi.advanceTimersByTimeAsync(100);
      mockWatcher.emit("all", "change", "/project/AGENTS.md");

      expect(onChange).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(350);

      expect(onChange).toHaveBeenCalledOnce();
    });

    /**
     * watch() should ignore change events for files that are not in the
     * watch config (neither an exact file match nor a glob match).
     *
     * emit('all', 'change', '/project/OTHER.md')
     * → onChange never called
     */
    it("should not call onChange for a file not in the watch config", async () => {
      const onChange = vi.fn().mockResolvedValue(undefined);
      new WatchService().watch({ files: ["/project/AGENTS.md"], globs: [] }, onChange);

      mockWatcher.emit("all", "change", "/project/OTHER.md");
      await vi.advanceTimersByTimeAsync(350);

      expect(onChange).not.toHaveBeenCalled();
    });

    /**
     * watch() should fire a partial rebuild event for a file whose path matches
     * a configured glob pattern, even if not listed explicitly in `files`.
     *
     * glob: "/project/skills/**\/*.md"
     * emit('all', 'change', '/project/skills/foo/bar.md')
     * → onChange({ type: "partial", filePath: '/project/skills/foo/bar.md' })
     */
    it("should call onChange with a partial event for a file matching a glob pattern", async () => {
      const onChange = vi.fn().mockResolvedValue(undefined);
      new WatchService().watch(
        { files: [], globs: ["/project/skills/**/*.md"] },
        onChange
      );

      mockWatcher.emit("all", "change", "/project/skills/foo/bar.md");
      await vi.advanceTimersByTimeAsync(350);

      expect(onChange).toHaveBeenCalledOnce();
      expect(onChange).toHaveBeenCalledWith<[WatchEvent]>({
        type: "partial",
        filePath: "/project/skills/foo/bar.md",
      });
    });

    /**
     * watch() should ignore non-change events (e.g. 'ready') and
     * only react to 'add', 'change', and 'unlink'.
     *
     * emit('all', 'ready', '/project/AGENTS.md')
     * → onChange never called
     */
    it("should ignore non-change event types", async () => {
      const onChange = vi.fn().mockResolvedValue(undefined);
      new WatchService().watch({ files: ["/project/AGENTS.md"], globs: [] }, onChange);

      mockWatcher.emit("all", "ready", "/project/AGENTS.md");
      await vi.advanceTimersByTimeAsync(350);

      expect(onChange).not.toHaveBeenCalled();
    });

    /**
     * watch() should fire a partial event when a watched file is deleted
     * ('unlink'), since a deletion may require a rebuild.
     *
     * emit('all', 'unlink', '/project/AGENTS.md')
     * → onChange({ type: "partial", filePath: '/project/AGENTS.md' })
     */
    it("should call onChange when a watched file is unlinked", async () => {
      const onChange = vi.fn().mockResolvedValue(undefined);
      new WatchService().watch({ files: ["/project/AGENTS.md"], globs: [] }, onChange);

      mockWatcher.emit("all", "unlink", "/project/AGENTS.md");
      await vi.advanceTimersByTimeAsync(350);

      expect(onChange).toHaveBeenCalledOnce();
      expect(onChange).toHaveBeenCalledWith<[WatchEvent]>({
        type: "partial",
        filePath: "/project/AGENTS.md",
      });
    });

    /**
     * watch() should fire a partial event when a new file is added ('add')
     * at a watched path, so newly-created source files trigger a rebuild.
     *
     * emit('all', 'add', '/project/AGENTS.md')
     * → onChange({ type: "partial", filePath: '/project/AGENTS.md' })
     */
    it("should call onChange when a watched file is added", async () => {
      const onChange = vi.fn().mockResolvedValue(undefined);
      new WatchService().watch({ files: ["/project/AGENTS.md"], globs: [] }, onChange);

      mockWatcher.emit("all", "add", "/project/AGENTS.md");
      await vi.advanceTimersByTimeAsync(350);

      expect(onChange).toHaveBeenCalledOnce();
      expect(onChange).toHaveBeenCalledWith<[WatchEvent]>({
        type: "partial",
        filePath: "/project/AGENTS.md",
      });
    });

    /**
     * watch() should NOT fire for a file inside a glob base dir that does not
     * match the full glob pattern.
     *
     * glob: "/project/skills/**\/*.md"
     * emit('all', 'change', '/project/skills/foo.txt')  ← .txt not .md
     * → onChange never called
     */
    it("should not call onChange for a file in the glob base dir that does not match the glob pattern", async () => {
      const onChange = vi.fn().mockResolvedValue(undefined);
      new WatchService().watch(
        { files: [], globs: ["/project/skills/**/*.md"] },
        onChange
      );

      mockWatcher.emit("all", "change", "/project/skills/foo.txt");
      await vi.advanceTimersByTimeAsync(350);

      expect(onChange).not.toHaveBeenCalled();
    });

    /**
     * When multiple distinct watched files change within the debounce window,
     * onChange fires exactly once — with the most-recently changed file's event.
     *
     * emit file A → advance 100 ms → emit file B → advance 350 ms
     * → onChange called once with { type: "partial", filePath: file B }
     */
    it("should call onChange once with the most-recent event when multiple files change within the debounce window", async () => {
      const onChange = vi.fn().mockResolvedValue(undefined);
      new WatchService().watch(
        { files: ["/project/AGENTS.md", "/project/CLAUDE.md"], globs: [] },
        onChange
      );

      mockWatcher.emit("all", "change", "/project/AGENTS.md");
      await vi.advanceTimersByTimeAsync(100);
      mockWatcher.emit("all", "change", "/project/CLAUDE.md");

      expect(onChange).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(350);

      expect(onChange).toHaveBeenCalledOnce();
      expect(onChange).toHaveBeenCalledWith<[WatchEvent]>({
        type: "partial",
        filePath: "/project/CLAUDE.md",
      });
    });

    /**
     * A change to a path in fullRebuildPaths should fire a full rebuild event,
     * not a partial one. This is used for config files and the templating dir.
     *
     * fullRebuildPaths: ["/config/sous.config.js"]
     * emit('all', 'change', '/config/sous.config.js')
     * → onChange({ type: "full", filePath: '/config/sous.config.js', reason: ... })
     */
    it("should call onChange with a full event when a fullRebuildPath changes", async () => {
      const onChange = vi.fn().mockResolvedValue(undefined);
      new WatchService().watch(
        { files: [], globs: [], fullRebuildPaths: ["/config/sous.config.js"] },
        onChange
      );

      mockWatcher.emit("all", "change", "/config/sous.config.js");
      await vi.advanceTimersByTimeAsync(350);

      expect(onChange).toHaveBeenCalledOnce();
      const evt = onChange.mock.calls[0][0] as WatchEvent;
      expect(evt.type).toBe("full");
      expect(evt.filePath).toBe("/config/sous.config.js");
    });

    /**
     * A change to a file nested inside a fullRebuildPath directory should
     * also fire a full rebuild event (directory prefix match).
     *
     * fullRebuildPaths: ["/sous/src/templating"]
     * emit('all', 'change', '/sous/src/templating/filters/bullet-list.ts')
     * → onChange({ type: "full", ... })
     */
    it("should call onChange with a full event for a file nested inside a fullRebuildPath directory", async () => {
      const onChange = vi.fn().mockResolvedValue(undefined);
      new WatchService().watch(
        { files: [], globs: [], fullRebuildPaths: ["/sous/src/templating"] },
        onChange
      );

      mockWatcher.emit("all", "change", "/sous/src/templating/filters/bullet-list.ts");
      await vi.advanceTimersByTimeAsync(350);

      expect(onChange).toHaveBeenCalledOnce();
      const evt = onChange.mock.calls[0][0] as WatchEvent;
      expect(evt.type).toBe("full");
    });

    /**
     * watch() should return a WatchHandle with a stop() method that closes
     * the underlying chokidar watcher.
     *
     * const handle = new WatchService().watch(...)
     * await handle.stop()
     * → watcher.close() was called
     */
    it("should return a handle whose stop() closes the chokidar watcher", async () => {
      const onChange = vi.fn().mockResolvedValue(undefined);
      const handle = new WatchService().watch(
        { files: ["/project/AGENTS.md"], globs: [] },
        onChange
      );

      await handle.stop();

      expect(mockWatcher.close).toHaveBeenCalledOnce();
    });

    /**
     * chokidar.watch() should be called with an `ignored` option matching
     * /sous\.state\.json$/ so that Sous state files never trigger rebuilds.
     *
     * new WatchService().watch(...)
     * → chokidar.watch called with options.ignored = /sous\.state\.json$/
     */
    it("should pass the correct ignored pattern to chokidar.watch()", () => {
      const onChange = vi.fn().mockResolvedValue(undefined);
      new WatchService().watch({ files: ["/project/AGENTS.md"], globs: [] }, onChange);

      const watchSpy = vi.mocked(chokidar.watch);
      const lastCall = watchSpy.mock.lastCall!;
      const [, options] = lastCall;
      expect(options?.ignored).toEqual(/sous\.state\.json$/);
    });
  });
});
