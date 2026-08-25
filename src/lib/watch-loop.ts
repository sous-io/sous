import path from "node:path";
import {
  CLI_ROOT,
  resolveRootScope,
  resolveWatchConfig,
  type ConfigContext,
  type Settings,
  type WatchConfig,
} from "./settings.js";
import type { WatchHandle, WatchService } from "./watch-service.js";
import { log } from "../utils/formatting.js";

/**
 * Builds a WatchConfig from current settings, injecting the primary config
 * file, the conf.d/ drop-in DIRECTORY, and the templating directory into
 * fullRebuildPaths. Watching the conf.d directory (not each layer file) covers
 * layer files appearing, changing, or disappearing at runtime, since
 * full-rebuild matching is exact-or-directory-prefix.
 *
 * Shared by `build --watch` and `compile --watch` so both react to config and
 * template edits identically.
 */
export function buildReloadWatchConfig(
  settings: Settings,
  configContext: ConfigContext
): WatchConfig {
  const rootScope = resolveRootScope(settings, configContext);
  const config = resolveWatchConfig(settings, rootScope);
  const reloadPaths = [
    configContext.configPath,
    configContext.confDir,
    path.join(CLI_ROOT, "src", "templating"),
  ].filter((p): p is string => typeof p === "string");
  config.fullRebuildPaths = [...(config.fullRebuildPaths ?? []), ...reloadPaths];
  return config;
}

/** Options for {@link startConfigReloadWatch}. */
export type ConfigReloadWatchOptions = {
  /** The watcher factory used to (re)start chokidar. */
  watchService: WatchService;
  /**
   * Produces a fresh WatchConfig from the CURRENT settings each time a watcher
   * is (re)started; typically `() => buildReloadWatchConfig(this.settings, this.configContext)`.
   */
  buildWatchConfig: () => WatchConfig;
  /**
   * Performs the actual work (build/compile) using the command's CURRENT
   * settings. Called for partial rebuilds (with the changed file) and, after a
   * successful reload, for full rebuilds (no argument). Owns its own
   * heading/footer output.
   */
  rebuild: (changedFile?: string) => Promise<void>;
  /**
   * Re-runs discovery + settings load and commits the result onto the command,
   * but only if it loads cleanly (last-good semantics). Throws on failure.
   */
  reloadConfig: () => Promise<void>;
};

/** The running watch loop; exposes the live handle and a manual full-rebuild trigger. */
export type ConfigReloadWatchController = {
  /** Mutable reference to the live watcher handle (swapped on every restart). */
  handle: { current: WatchHandle | null };
  /** Triggers a full rebuild immediately, bypassing the debounce (e.g. a keypress). */
  triggerFullRebuild: (reason: string) => Promise<void>;
};

/**
 * Runs the shared watch loop used by `build --watch` and `compile --watch`.
 *
 * - Partial events (a watched source file changed) call `rebuild(filePath)`.
 * - Full events (config file, conf.d directory, or templating dir changed) stop
 *   the watcher, reload settings via `reloadConfig`, rebuild, and restart the
 *   watcher. A failed reload is reported without wedging the session: the
 *   last-good config stays in place and the watcher restarts so the next edit
 *   can recover.
 *
 * A single `isRebuilding` guard serialises overlapping triggers.
 */
export function startConfigReloadWatch(
  options: ConfigReloadWatchOptions
): ConfigReloadWatchController {
  const { watchService, buildWatchConfig, rebuild, reloadConfig } = options;

  let isRebuilding = false;
  const handle: { current: WatchHandle | null } = { current: null };

  const startWatcher = () => {
    const watchConfig = buildWatchConfig();
    handle.current = watchService.watch(watchConfig, async (event) => {
      if (event.type === "partial") {
        if (isRebuilding) return;
        isRebuilding = true;
        log(`\nChange detected: ${event.filePath}`);
        await rebuild(event.filePath);
        isRebuilding = false;
      } else {
        // Full rebuild: stop current watcher, reload settings, restart
        if (isRebuilding) return;
        isRebuilding = true;
        log(`\nConfig changed (${event.filePath}), reloading settings and restarting watcher...`);
        await handle.current!.stop();

        try {
          // Re-run discovery: conf.d layer files can appear or disappear while
          // watching, so the ordered layer list must be rebuilt (and the
          // duplicate-baseName check re-run) before reloading settings. Only
          // committed by reloadConfig once it loads cleanly.
          await reloadConfig();
          await rebuild();
        } catch (error) {
          // A broken config edit (bad JSON/JS, colliding conf.d baseNames,
          // configure() throw, etc.) must not wedge the session: report it,
          // keep the last-good config, and fall through to restart the watcher
          // so the next edit can recover.
          log(
            `\nConfig reload failed; keeping the last-good config. Fix the config and save again to retry.\n  ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        } finally {
          isRebuilding = false;
          startWatcher();
        }
      }
    });
  };

  startWatcher();

  const triggerFullRebuild = async (reason: string) => {
    if (isRebuilding) return;
    isRebuilding = true;
    log(`\n${reason}`);
    await rebuild();
    isRebuilding = false;
  };

  return { handle, triggerFullRebuild };
}
