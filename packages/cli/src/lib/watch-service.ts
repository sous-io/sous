import chokidar from "chokidar";
import { minimatch } from "minimatch";
import path from "node:path";
import type { WatchConfig } from "./settings.js";
import { log } from "../utils/formatting.js";

/** Milliseconds to wait after a change before triggering a rebuild. */
const DEBOUNCE_MS = 300;

/** A partial rebuild triggered by a change to a specific source file. */
export type PartialRebuildEvent = {
  type: "partial";
  filePath: string;
};

/** A full rebuild triggered by a change to a high-impact path (config, templating, etc.). */
export type FullRebuildEvent = {
  type: "full";
  reason: string;
  filePath: string;
};

export type WatchEvent = PartialRebuildEvent | FullRebuildEvent;

/** A handle returned by WatchService.watch() that allows the caller to stop the watcher. */
export type WatchHandle = {
  stop(): Promise<void>;
};

/**
 * Extracts the longest leading non-glob segment of a pattern as a watchable
 * directory path. Chokidar v5 does not accept glob patterns directly.
 *
 * Examples:
 *   "/foo/bar/**\/*"   → "/foo/bar"
 *   "/foo/bar/*.md"   → "/foo/bar"
 */
function globBaseDir(pattern: string): string {
  const starIndex = pattern.indexOf("*");
  if (starIndex === -1) return path.dirname(pattern);
  const prefix = pattern.slice(0, starIndex);
  return prefix.endsWith("/") || prefix.endsWith(path.sep)
    ? prefix.slice(0, -1)
    : path.dirname(prefix);
}

/**
 * Watches exact files, glob-backed directories, and full-rebuild paths,
 * calling the provided callback (debounced) when a relevant change is detected.
 *
 * - Changes to `files` or `globs` entries fire a partial rebuild event.
 * - Changes to `fullRebuildPaths` entries fire a full rebuild event.
 *
 * Returns a WatchHandle with a `stop()` method to close the watcher.
 */
export class WatchService {
  watch(config: WatchConfig, onChange: (event: WatchEvent) => Promise<void>): WatchHandle {
    const { files, globs, fullRebuildPaths = [] } = config;
    const globBaseDirs = globs.map(globBaseDir);
    const watchPaths = [...new Set([...files, ...globBaseDirs, ...fullRebuildPaths])];

    const watcher = chokidar.watch(watchPaths, {
      ignoreInitial: true,
      persistent: true,
      ignored: /sous\.state\.json$/,
    });

    let debounceTimer: NodeJS.Timeout | null = null;
    let pendingEvent: WatchEvent | null = null;

    const schedule = (event: WatchEvent) => {
      pendingEvent = event;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        debounceTimer = null;
        const evt = pendingEvent!;
        pendingEvent = null;
        try {
          await onChange(evt);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log(`  Watch error: ${message}`);
        }
      }, DEBOUNCE_MS);
    };

    watcher.on("all", (event, filePath) => {
      if (!["add", "change", "unlink"].includes(event)) return;

      // Full-rebuild paths take priority
      const isFullRebuildPath = fullRebuildPaths.some(p =>
        filePath === p || filePath.startsWith(p + path.sep) || filePath.startsWith(p + "/")
      );

      if (isFullRebuildPath) {
        schedule({ type: "full", reason: filePath, filePath });
        return;
      }

      const isExactFile = files.includes(filePath);
      const matchesGlob = globs.some(g => minimatch(filePath, g));

      if (isExactFile || matchesGlob) {
        schedule({ type: "partial", filePath });
      }
    });

    const totalPatterns = files.length + globs.length + fullRebuildPaths.length;
    log(`\nWatching ${totalPatterns} pattern(s) for changes...\n`);

    return {
      stop: () => watcher.close(),
    };
  }
}
