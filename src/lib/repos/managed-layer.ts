/**
 * The managed config layers.
 *
 * Three files in a project's `conf.d/` directory are written by sous rather
 * than by a person: `500-repos.jsonc`, which holds the repositories the project
 * trusts, `510-subscriptions.jsonc`, which holds what it subscribes to, and
 * `520-var-mappings.jsonc` (written from `vars/mappings.ts`), which holds
 * variable mapping records. All three sit in the 5xx band reserved for
 * machine-written layers, so a user's own primary config and non-5xx layers are
 * never touched.
 *
 * They are `.jsonc`, not `.json`, so they can carry real comments: each one
 * opens with a header saying what it holds and who writes it. Sous edits them
 * BY KEY, through `jsonc-parser`, which rewrites only the bytes of the entry it
 * is changing. A comment somebody adds beside an entry, the order they put the
 * keys in, and the way they formatted the file all survive a sous edit.
 *
 * A layer that still exists under its old `.json` name is read as a fallback
 * and migrates on the next write: the `.jsonc` file is written and the `.json`
 * one is removed, so a project never ends up with both (two layers with the
 * same baseName are a hard config error).
 */

import fs from "node:fs";
import path from "node:path";
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser";
import { CONFD_DIR_NAME } from "../config-discovery.js";
import { ConfigError } from "../errors.js";
import { stableJsonStringify } from "./formats/common.js";

/** The machine-written layer holding the repositories a project trusts. */
export const REPOS_LAYER_FILENAME = "500-repos.jsonc";

/** The machine-written layer holding a project's subscriptions. */
export const SUBSCRIPTIONS_LAYER_FILENAME = "510-subscriptions.jsonc";

/**
 * The policy every managed layer states in its own header: sous edits it by
 * key, and a person may edit it too.
 */
export const MANAGED_LAYER_COMMENT =
  "This file is managed by sous. Sous edits these files by key; you may edit them " +
  "too, and your comments, key order and formatting are kept.";

/** The closing lines of every managed layer header, describing the format. */
const MANAGED_LAYER_FORMAT_NOTE = [
  "It is JSON with comments (.jsonc): line comments, block comments and trailing",
  "commas are all allowed here.",
];

/** What each managed layer holds, and which commands write it. */
const MANAGED_LAYER_DESCRIPTIONS: Record<string, string[]> = {
  [REPOS_LAYER_FILENAME]: [
    "It records the repositories this project trusts. The 'sous repo add' and",
    "'sous repo remove' commands write the entries under 'repos'.",
  ],
  [SUBSCRIPTIONS_LAYER_FILENAME]: [
    "It records what this project subscribes to. The 'sous subscribe' and",
    "'sous unsubscribe' commands write the entries under 'subscriptions'.",
  ],
};

/** Wraps a sentence into `//` comment lines of at most `width` characters. */
function commentLines(text: string, width = 78): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    if (current.length === 0) {
      current = word;
    } else if (`${current} ${word}`.length + 3 <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/**
 * The header comment block a managed layer opens with. It states the policy,
 * says what the file holds, and names the format.
 *
 * @param fileName - The layer's file name, which selects the description.
 * @param description - Lines describing the file, for a layer this module does
 *   not know about (the variable mapping layer passes its own).
 */
export function managedLayerHeader(fileName: string, description?: string[]): string {
  const what = description ?? MANAGED_LAYER_DESCRIPTIONS[fileName] ?? [];
  const blocks = [commentLines(MANAGED_LAYER_COMMENT), what, MANAGED_LAYER_FORMAT_NOTE].filter(
    (block) => block.length > 0
  );

  return (
    blocks
      .map((block) => block.map((line) => `// ${line}`.trimEnd()).join("\n"))
      .join("\n//\n") + "\n"
  );
}

/** Where a managed layer lives, and how it is written. */
export type ManagedLayerOptions = {
  /**
   * The `conf.d/` directory to use instead of `<sousDir>/conf.d`. Set it from
   * the discovered config context, so `--sous-confd` and `SOUS_CONFD` are
   * respected.
   */
  confDir?: string;
  /**
   * The header comment block a newly created layer opens with, for a layer this
   * module has no description for. Defaults to the header for `fileName`.
   */
  header?: string;
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
 * @param fileName - The layer's file name, such as `500-repos.jsonc`.
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
 * The path the same layer had before managed layers became `.jsonc`, or
 * undefined when the name is not a `.jsonc` one. Read as a fallback, and
 * removed by the first write that migrates the layer.
 *
 * @param sousDir - The project's `.sous/` directory.
 * @param fileName - The layer's file name.
 * @param options - An explicit `conf.d/` directory, when there is one.
 */
export function legacyManagedLayerPath(
  sousDir: string,
  fileName: string,
  options: ManagedLayerOptions = {}
): string | undefined {
  if (!fileName.endsWith(".jsonc")) return undefined;
  return path.join(managedLayerDir(sousDir, options), `${fileName.slice(0, -1)}`);
}

/** True when the path exists and is a regular file. */
function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * The managed layer file that actually exists: the `.jsonc` one, or the old
 * `.json` one when only that is there. Undefined when the layer has never been
 * written.
 */
function existingManagedLayerPath(
  sousDir: string,
  fileName: string,
  options: ManagedLayerOptions
): string | undefined {
  const current = managedLayerPath(sousDir, fileName, options);
  if (isFile(current)) return current;

  const legacy = legacyManagedLayerPath(sousDir, fileName, options);
  if (legacy !== undefined && isFile(legacy)) return legacy;

  return undefined;
}

/** Parses a managed layer's text, allowing comments and trailing commas. */
function parseManagedLayerText(text: string, filePath: string): unknown {
  const errors: ParseError[] = [];
  const value = parseJsonc(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  if (errors.length > 0) {
    throw new ConfigError(
      `Sous could not read its own config layer at ${filePath}.\n` +
        `  The file is not valid JSON with comments.\n` +
        `  Sous writes this file itself. Restoring it from version control, or deleting ` +
        `it and adding the entries again, both fix this.`
    );
  }

  return value;
}

/**
 * Reads a managed layer, returning an empty object when the file does not exist
 * yet. A file that does not parse is an error naming it, because sous wrote it
 * and is about to edit it: silently discarding somebody's edits would be worse
 * than stopping.
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
  const filePath = existingManagedLayerPath(sousDir, fileName, options);
  if (filePath === undefined) return {};

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

  const parsed = parseManagedLayerText(text, filePath);

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(
      `The config layer at ${filePath} is not a JSON object.\n` +
        `  Sous writes this file itself; it always holds one object.`
    );
  }

  return parsed as Record<string, unknown>;
}

/**
 * Writes a layer's text to its `.jsonc` path and removes the old `.json` name
 * when there was one, so a migrated layer never exists twice. The file is
 * staged under a temporary name in the same directory and renamed into place,
 * so a reader never sees a half-written layer.
 */
function writeLayerText(
  sousDir: string,
  fileName: string,
  body: string,
  options: ManagedLayerOptions
): string {
  const directory = managedLayerDir(sousDir, options);
  const filePath = path.join(directory, fileName);

  fs.mkdirSync(directory, { recursive: true });

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

  const legacy = legacyManagedLayerPath(sousDir, fileName, options);
  if (legacy !== undefined && legacy !== filePath) fs.rmSync(legacy, { force: true });

  return filePath;
}

/**
 * Writes a managed layer, replacing whatever was there: the header comment,
 * then the content as sorted JSON. Use `updateManagedLayer` for an ordinary
 * change; this is for creating a layer from nothing, or for replacing one whose
 * whole content sous is generating.
 *
 * The header comment is added for you; there is no need to pass one.
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
  const header = options.header ?? managedLayerHeader(fileName);
  return writeLayerText(sousDir, fileName, header + stableJsonStringify(content), options);
}

/** One key-path edit to a managed layer. `undefined` removes the key. */
export type ManagedLayerEdit = {
  /** The key path to change, such as `["repos", "team-recipes"]`. */
  path: (string | number)[];
  /** The value to write there, or undefined to remove the key. */
  value: unknown | undefined;
};

/**
 * Applies key-path edits to a managed layer, rewriting only the bytes of the
 * entries that change. Comments, key order and formatting elsewhere in the file
 * are left exactly as they were, which is what lets a person keep notes beside
 * the entries sous manages.
 *
 * A layer that does not exist yet is created with its header comment and an
 * empty object, and the edits are applied to that. A layer still under its old
 * `.json` name is edited and written back as `.jsonc`, and the `.json` file is
 * removed.
 *
 * New keys are inserted in sorted position, so a layer sous has written from
 * the start stays in a stable order and its diffs stay small.
 *
 * @param sousDir - The project's `.sous/` directory.
 * @param fileName - The layer's file name.
 * @param edits - The key paths to set, or to remove by passing undefined.
 * @param options - An explicit `conf.d/` directory, and a header for a layer
 *   this module has no description for.
 * @returns The path of the layer file that was written.
 */
export function updateManagedLayer(
  sousDir: string,
  fileName: string,
  edits: ManagedLayerEdit[],
  options: ManagedLayerOptions = {}
): string {
  const existing = existingManagedLayerPath(sousDir, fileName, options);

  let text: string;
  if (existing === undefined) {
    text = (options.header ?? managedLayerHeader(fileName)) + "{}\n";
  } else {
    try {
      text = fs.readFileSync(existing, "utf8");
    } catch (error) {
      throw new ConfigError(
        `Sous could not read its own config layer at ${existing}.\n` +
          `  ${(error as Error).message}`
      );
    }
    // Refuse to edit a file that does not parse, rather than writing over it.
    parseManagedLayerText(text, existing);
  }

  for (const edit of edits) {
    const last = edit.path[edit.path.length - 1];
    const changes = modify(text, edit.path, edit.value, {
      formattingOptions: { tabSize: 2, insertSpaces: true, eol: "\n" },
      getInsertionIndex:
        typeof last === "string"
          ? (properties) => properties.filter((name) => name < last).length
          : undefined,
    });
    text = applyEdits(text, changes);
  }

  if (!text.endsWith("\n")) text += "\n";

  return writeLayerText(sousDir, fileName, text, options);
}

/**
 * Removes a managed layer entirely, which is what emptying one comes down to: a
 * layer holding nothing but its own header comment is noise in a project. The
 * old `.json` name is removed too, so a migration in progress leaves nothing
 * behind.
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
  const legacy = legacyManagedLayerPath(sousDir, fileName, options);
  if (legacy !== undefined) fs.rmSync(legacy, { force: true });
}
