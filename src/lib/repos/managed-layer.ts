/**
 * The managed config layers.
 *
 * Two files in a project's `conf.d/` directory are written by sous rather than
 * by a person: `500-repos.json`, which holds the repositories the project
 * trusts, and `510-subscriptions.json`, which holds what it subscribes to. Both
 * sit in the 5xx band reserved for machine-written layers, so a user's own
 * primary config and non-5xx layers are never touched.
 *
 * Each file is replaced WHOLESALE. The config kernel deep-merges layers, and
 * its array rule is concatenation with no de-duplication, so a machine-written
 * layer only ever holds maps keyed by name; rewriting the whole file is the one
 * way to make a removal actually remove something.
 *
 * JSON has no comment syntax, so each file carries a `$comment` key saying what
 * wrote it. The sous config schema accepts and ignores it, exactly as it does
 * `$schema`.
 */

import fs from "node:fs";
import path from "node:path";
import { CONFD_DIR_NAME } from "../config-discovery.js";
import { ConfigError } from "../errors.js";
import { stableJsonStringify } from "./formats/common.js";

/** The machine-written layer holding the repositories a project trusts. */
export const REPOS_LAYER_FILENAME = "500-repos.json";

/** The machine-written layer holding a project's subscriptions. */
export const SUBSCRIPTIONS_LAYER_FILENAME = "510-subscriptions.json";

/** The note written into every managed layer, in place of a comment. */
export const MANAGED_LAYER_COMMENT =
  "This file is written by sous. It is replaced in full whenever it changes, so " +
  "hand-written edits are lost. Repositories and subscriptions can be changed with " +
  "the 'sous repo' and 'sous subscribe' commands, or written by hand in your primary " +
  "config, which sous never edits.";

/** Where a managed layer lives, and how it is written. */
export type ManagedLayerOptions = {
  /**
   * The `conf.d/` directory to use instead of `<sousDir>/conf.d`. Set it from
   * the discovered config context, so `--sous-confd` and `SOUS_CONFD` are
   * respected.
   */
  confDir?: string;
};

/**
 * The directory a managed layer is written into.
 *
 * @param sousDir - The project's `.sous/` directory.
 * @param options - An explicit `conf.d/` directory, when there is one.
 */
export function managedLayerDir(sousDir: string, options: ManagedLayerOptions = {}): string {
  return options.confDir ?? path.join(sousDir, CONFD_DIR_NAME);
}

/**
 * The full path of a managed layer.
 *
 * @param sousDir - The project's `.sous/` directory.
 * @param fileName - The layer's file name, such as `500-repos.json`.
 * @param options - An explicit `conf.d/` directory, when there is one.
 */
export function managedLayerPath(
  sousDir: string,
  fileName: string,
  options: ManagedLayerOptions = {}
): string {
  return path.join(managedLayerDir(sousDir, options), fileName);
}

/**
 * Reads a managed layer, returning an empty object when the file does not exist
 * yet. A file that is not readable JSON is an error naming it, because sous
 * wrote it and is about to overwrite it: silently discarding somebody's edits
 * would be worse than stopping.
 *
 * @param sousDir - The project's `.sous/` directory.
 * @param fileName - The layer's file name.
 * @param options - An explicit `conf.d/` directory, when there is one.
 */
export function readManagedLayer(
  sousDir: string,
  fileName: string,
  options: ManagedLayerOptions = {}
): Record<string, unknown> {
  const filePath = managedLayerPath(sousDir, fileName, options);

  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new ConfigError(
      `Sous could not read its own config layer at ${filePath}.\n` +
        `  ${(error as Error).message}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(
      `Sous could not read its own config layer at ${filePath} as JSON.\n` +
        `  ${(error as Error).message}\n` +
        `  Sous writes this file itself and replaces it in full. Restoring it from ` +
        `version control, or deleting it and adding the repositories again, both fix this.`
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(
      `The config layer at ${filePath} is not a JSON object.\n` +
        `  Sous writes this file itself; it always holds one object.`
    );
  }

  return parsed as Record<string, unknown>;
}

/**
 * Writes a managed layer, replacing whatever was there. The file is written to
 * a temporary name in the same directory and renamed into place, so a reader
 * never sees a half-written layer, and its keys are sorted so the diff is
 * minimal.
 *
 * The `$comment` key is added for you; there is no need to pass one.
 *
 * @param sousDir - The project's `.sous/` directory.
 * @param fileName - The layer's file name.
 * @param content - The layer's whole content.
 * @param options - An explicit `conf.d/` directory, when there is one.
 */
export function writeManagedLayer(
  sousDir: string,
  fileName: string,
  content: Record<string, unknown>,
  options: ManagedLayerOptions = {}
): string {
  const directory = managedLayerDir(sousDir, options);
  const filePath = path.join(directory, fileName);

  fs.mkdirSync(directory, { recursive: true });

  const body = stableJsonStringify({ $comment: MANAGED_LAYER_COMMENT, ...content });
  const temporary = path.join(directory, `.${fileName}.tmp-${process.pid}`);
  try {
    fs.writeFileSync(temporary, body, "utf8");
    fs.renameSync(temporary, filePath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw new ConfigError(
      `Sous could not write its config layer at ${filePath}.\n  ${(error as Error).message}`
    );
  }

  return filePath;
}

/**
 * Removes a managed layer entirely, which is what emptying one comes down to: a
 * layer holding nothing but its own comment is noise in a project.
 *
 * @param sousDir - The project's `.sous/` directory.
 * @param fileName - The layer's file name.
 * @param options - An explicit `conf.d/` directory, when there is one.
 */
export function removeManagedLayer(
  sousDir: string,
  fileName: string,
  options: ManagedLayerOptions = {}
): void {
  fs.rmSync(managedLayerPath(sousDir, fileName, options), { force: true });
}
