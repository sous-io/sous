import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import chokidar from "chokidar";
import { WatchService } from "../../lib/watch-service.js";
import { startConfigReloadWatch } from "../../lib/watch-loop.js";
import { ConfigError } from "../../lib/errors.js";
import type { WatchConfig } from "../../lib/settings.js";

/**
 * Tests the watch wiring that `compile --watch` delegates to.
 *
 * `compile.ts` cannot be unit-tested through its `run()` method: in watch mode
 * it ends in `await new Promise(() => {})` and never returns, and building a
 * command instance would require full BaseCommand discovery + settings load.
 * Instead we exercise the exact seam it wires into — `startConfigReloadWatch`
 * from watch-loop.ts — driving it through a REAL WatchService whose chokidar is
 * mocked (the repo convention in watch-service.test.ts). The callbacks passed
 * here mirror compile.ts's wiring: `rebuild(changedFile?)` recompiles, and
 * `reloadConfig()` re-runs discovery + settings load.
 *
 * Regression focus: the pre-fix compile.ts logged the WatchEvent OBJECT
 * (rendering "[object Object]") and treated full-rebuild events like partials.
 * These tests pin the corrected behaviour: partial events log the changed file
 * PATH and recompile; full events refresh discovery + reload; a ConfigError
 * during reload is reported without wedging the watcher.
 */

// Holds the EventEmitter created by the most recent mocked chokidar.watch()
// call. On a config reload the watcher is stopped and restarted, so this is
// reassigned; tests emit on the current value after advancing timers.
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

/** Collects everything written via console.log (the `log()` helper). */
function collectLog(logSpy: ReturnType<typeof vi.spyOn>): string {
  return logSpy.mock.calls.map(call => String(call[0])).join("\n");
}

describe("compile --watch wiring (startConfigReloadWatch)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    // Reset call-count accumulation across tests (repo convention).
    vi.mocked(chokidar.watch).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * A change to a watched source file fires a PARTIAL event, which must:
   * - call rebuild(changedFilePath) (a recompile), and
   * - log the changed file PATH, never the string "[object Object]".
   * reloadConfig must NOT run for a partial.
   */
  it("recompiles and logs the changed path (not [object Object]) on a partial event", async () => {
    const rebuild = vi.fn().mockResolvedValue(undefined);
    const reloadConfig = vi.fn().mockResolvedValue(undefined);
    const watchConfig: WatchConfig = { files: ["/project/AGENTS.md"], globs: [] };

    startConfigReloadWatch({
      watchService: new WatchService(),
      buildWatchConfig: () => watchConfig,
      rebuild,
      reloadConfig,
    });

    mockWatcher.emit("all", "change", "/project/AGENTS.md");
    await vi.advanceTimersByTimeAsync(350);

    expect(rebuild).toHaveBeenCalledOnce();
    expect(rebuild).toHaveBeenCalledWith("/project/AGENTS.md");
    expect(reloadConfig).not.toHaveBeenCalled();

    const logged = collectLog(logSpy);
    expect(logged).toContain("/project/AGENTS.md");
    expect(logged).not.toContain("[object Object]");
  });

  /**
   * A change to a fullRebuildPath (the config file / conf.d dir) fires a FULL
   * event, which must refresh discovery + reload settings BEFORE rebuilding,
   * and rebuild with no changedFile argument (a full recompile).
   */
  it("refreshes discovery and reloads settings before a full recompile on a full event", async () => {
    const callOrder: string[] = [];
    const rebuild = vi.fn(async (changedFile?: string) => {
      callOrder.push(changedFile === undefined ? "rebuild()" : `rebuild(${changedFile})`);
    });
    const reloadConfig = vi.fn(async () => {
      callOrder.push("reloadConfig");
    });
    const watchConfig: WatchConfig = {
      files: [],
      globs: [],
      fullRebuildPaths: ["/config/sous.config.js"],
    };

    startConfigReloadWatch({
      watchService: new WatchService(),
      buildWatchConfig: () => watchConfig,
      rebuild,
      reloadConfig,
    });

    mockWatcher.emit("all", "change", "/config/sous.config.js");
    await vi.advanceTimersByTimeAsync(350);

    expect(reloadConfig).toHaveBeenCalledOnce();
    expect(rebuild).toHaveBeenCalledOnce();
    // Full recompile: rebuild invoked with no changed-file argument.
    expect(rebuild).toHaveBeenCalledWith();
    // Reload must happen before the recompile.
    expect(callOrder).toEqual(["reloadConfig", "rebuild()"]);

    const logged = collectLog(logSpy);
    expect(logged).toContain("/config/sous.config.js");
    expect(logged).not.toContain("[object Object]");
  });

  /**
   * The watcher must be restarted after a full-rebuild reload, so that config
   * edits keep being observed. Restart == chokidar.watch called a second time.
   */
  it("restarts the watcher after a successful full-event reload", async () => {
    const rebuild = vi.fn().mockResolvedValue(undefined);
    const reloadConfig = vi.fn().mockResolvedValue(undefined);
    const watchConfig: WatchConfig = {
      files: ["/project/AGENTS.md"],
      globs: [],
      fullRebuildPaths: ["/config/sous.config.js"],
    };

    startConfigReloadWatch({
      watchService: new WatchService(),
      buildWatchConfig: () => watchConfig,
      rebuild,
      reloadConfig,
    });

    expect(chokidar.watch).toHaveBeenCalledTimes(1);

    mockWatcher.emit("all", "change", "/config/sous.config.js");
    await vi.advanceTimersByTimeAsync(350);

    // Old watcher closed, a fresh one started.
    expect(chokidar.watch).toHaveBeenCalledTimes(2);

    // The fresh watcher still services partial events.
    rebuild.mockClear();
    mockWatcher.emit("all", "change", "/project/AGENTS.md");
    await vi.advanceTimersByTimeAsync(350);

    expect(rebuild).toHaveBeenCalledOnce();
    expect(rebuild).toHaveBeenCalledWith("/project/AGENTS.md");
  });

  /**
   * A ConfigError thrown during reload (bad JSON/JS, colliding conf.d
   * baseNames, etc.) must be caught and reported, the last-good config kept
   * (no recompile), and the watcher restarted so the next edit can recover —
   * the session must not wedge.
   */
  it("reports a ConfigError during reload without wedging the watcher", async () => {
    const rebuild = vi.fn().mockResolvedValue(undefined);
    const reloadConfig = vi
      .fn()
      .mockRejectedValueOnce(new ConfigError("duplicate conf.d baseName: 10-foo"));
    const watchConfig: WatchConfig = {
      files: ["/project/AGENTS.md"],
      globs: [],
      fullRebuildPaths: ["/config/sous.config.js"],
    };

    startConfigReloadWatch({
      watchService: new WatchService(),
      buildWatchConfig: () => watchConfig,
      rebuild,
      reloadConfig,
    });

    mockWatcher.emit("all", "change", "/config/sous.config.js");
    await vi.advanceTimersByTimeAsync(350);

    expect(reloadConfig).toHaveBeenCalledOnce();
    // Reload failed → no recompile with the broken config.
    expect(rebuild).not.toHaveBeenCalled();

    const logged = collectLog(logSpy);
    expect(logged).toContain("Config reload failed");
    expect(logged).toContain("duplicate conf.d baseName: 10-foo");
    expect(logged).not.toContain("[object Object]");

    // Watcher restarted despite the failure (not wedged).
    expect(chokidar.watch).toHaveBeenCalledTimes(2);

    // And the restarted watcher recovers: a later partial event recompiles.
    mockWatcher.emit("all", "change", "/project/AGENTS.md");
    await vi.advanceTimersByTimeAsync(350);

    expect(rebuild).toHaveBeenCalledOnce();
    expect(rebuild).toHaveBeenCalledWith("/project/AGENTS.md");
  });
});
