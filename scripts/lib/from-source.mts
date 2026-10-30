/**
 * Lets a repository script import the workspace packages straight from their
 * TypeScript source, with no build first.
 *
 * Each package's `exports` has a `source` condition pointing at `src/index.ts`
 * beside the `default` one pointing at the built `dist/`. Node picks the
 * `source` entry only when it runs with `--conditions=source`, and without it
 * the scripts would need every package built. So a script calls this first:
 * when the flag is missing, the script runs again in a child Node process that
 * has it, with the same arguments, and this process exits with the child's
 * code. When the flag is there, it does nothing.
 *
 * Because static imports are resolved before any code runs, a script that
 * calls this must load the workspace packages with `await import(...)` after
 * the call, never with an `import` statement at the top.
 *
 *     import { runFromSource } from "./lib/from-source.mts";
 *
 *     runFromSource(import.meta.url);
 *
 *     const { hashDirectory } = await import("../packages/plugin-formats/src/index.js");
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** The Node flag that makes package `exports` resolve to TypeScript source. */
const SOURCE_FLAG = "--conditions=source";

/** Whether this process already resolves the `source` condition. */
function hasSourceCondition(): boolean {
  const flags = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? "").split(/\s+/)];

  return flags.some(
    (flag, index) =>
      flag === SOURCE_FLAG ||
      flag === "-C=source" ||
      ((flag === "--conditions" || flag === "-C") && flags[index + 1] === "source")
  );
}

/**
 * Re-runs the calling script with `--conditions=source` unless this process
 * already has it. Returns only when the flag is in place.
 *
 * @param scriptUrl - The calling script's `import.meta.url`.
 */
export function runFromSource(scriptUrl: string): void {
  if (hasSourceCondition()) return;

  // execArgv carries tsx's own loader flags, so the child runs TypeScript too.
  const child = spawnSync(
    process.execPath,
    [...process.execArgv, SOURCE_FLAG, fileURLToPath(scriptUrl), ...process.argv.slice(2)],
    { stdio: "inherit" }
  );

  if (child.error !== undefined) {
    console.error(`Could not start Node again with ${SOURCE_FLAG}: ${child.error.message}`);
    process.exit(1);
  }
  process.exit(child.status ?? 1);
}
