/**
 * A line-preserving editor for `.sous/.env` and `.sous/.env.local`.
 *
 * These files belong to the user: they are hand-written, commented, ordered
 * deliberately, and (for `.env`) committed. So sous edits them the way a
 * careful person would. The file is parsed into a line model, exactly one line
 * is rewritten or appended, and every other byte comes back out unchanged:
 * comments, blank lines, ordering, quoting style and the `export ` prefix all
 * survive.
 *
 * Comments are OUTPUT ONLY. sous writes a short generated header above each
 * entry it appends, explaining where the value came from, and never reads a
 * comment back or tries to keep one up to date. The header says as much, so
 * nobody wonders whether editing it will confuse the tool.
 *
 * The parser here recognizes the same syntax `env-local.ts` reads, since these
 * two modules are the write and read halves of one small format.
 */

import fs from "node:fs";
import path from "node:path";

/** The key syntax accepted on an assignment line, matching the env file parser. */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** One line of an env file, classified. */
export type EnvFileLine =
  /** An empty or whitespace-only line. */
  | { kind: "blank"; text: string }
  /** A whole-line comment. */
  | { kind: "comment"; text: string }
  /** A `KEY=value` assignment, with everything needed to rewrite just the value. */
  | {
      kind: "assignment";
      text: string;
      /** Leading whitespace, preserved on rewrite. */
      indent: string;
      /** True when the line carried an `export ` prefix. */
      exported: boolean;
      /** The variable's name. */
      key: string;
      /** The value as written, before unquoting. */
      rawValue: string;
      /** A trailing ` # comment`, when the line had one, including its spacing. */
      inlineComment: string;
    }
  /** Anything else: kept verbatim, never interpreted. */
  | { kind: "other"; text: string };

/** A parsed env file: its lines, and how to put them back together. */
export interface EnvFileModel {
  /** Every line, in order. */
  lines: EnvFileLine[];
  /** The line ending the file uses. */
  eol: "\n" | "\r\n";
  /** True when the file ended with a newline (or is empty and will). */
  trailingNewline: boolean;
}

/**
 * Splits an assignment line's right-hand side into the value and any trailing
 * comment. Quoted values are scanned to their closing quote first, so a `#`
 * inside quotes is part of the value.
 */
function splitValueAndComment(raw: string): { rawValue: string; inlineComment: string } {
  const leadingSpaces = raw.length - raw.trimStart().length;
  const body = raw.trimStart();

  const quote = body.startsWith('"') ? '"' : body.startsWith("'") ? "'" : undefined;
  if (quote !== undefined) {
    for (let i = 1; i < body.length; i++) {
      if (body[i] === "\\") {
        i++;
        continue;
      }
      if (body[i] === quote) {
        return {
          rawValue: raw.slice(0, leadingSpaces + i + 1),
          inlineComment: raw.slice(leadingSpaces + i + 1),
        };
      }
    }
    return { rawValue: raw, inlineComment: "" };
  }

  const commentAt = body.search(/\s#/);
  if (commentAt === -1) return { rawValue: raw, inlineComment: "" };

  // Walk back over every space before the comment, so the gap belongs to the
  // comment and survives a rewrite of the value.
  let start = leadingSpaces + commentAt;
  while (start > 0 && /\s/.test(raw[start - 1]!)) start--;
  return { rawValue: raw.slice(0, start), inlineComment: raw.slice(start) };
}

/**
 * Parses env file text into a line model. Nothing is dropped: a line the
 * parser does not recognize is kept verbatim as an `other` line.
 *
 * @param content - The file's contents.
 */
export function parseEnvFile(content: string): EnvFileModel {
  const eol: "\n" | "\r\n" = content.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = content.length === 0 || content.endsWith("\n");
  const body = content.endsWith("\r\n")
    ? content.slice(0, -2)
    : content.endsWith("\n")
      ? content.slice(0, -1)
      : content;
  const rawLines = content.length === 0 ? [] : body.split(/\r?\n/);

  const lines: EnvFileLine[] = rawLines.map((text) => {
    if (text.trim() === "") return { kind: "blank", text };
    if (text.trimStart().startsWith("#")) return { kind: "comment", text };

    const indent = text.slice(0, text.length - text.trimStart().length);
    const withoutIndent = text.slice(indent.length);
    const exported = withoutIndent.startsWith("export ");
    const assignment = exported ? withoutIndent.slice(7).trimStart() : withoutIndent;

    const equals = assignment.indexOf("=");
    if (equals <= 0) return { kind: "other", text };

    const key = assignment.slice(0, equals).trim();
    if (!KEY_PATTERN.test(key)) return { kind: "other", text };

    const { rawValue, inlineComment } = splitValueAndComment(assignment.slice(equals + 1));
    return { kind: "assignment", text, indent, exported, key, rawValue, inlineComment };
  });

  return { lines, eol, trailingNewline };
}

/**
 * Renders a line model back to text.
 *
 * @param model - The model to render.
 */
export function renderEnvFile(model: EnvFileModel): string {
  if (model.lines.length === 0) return "";
  const body = model.lines.map((line) => line.text).join(model.eol);
  return model.trailingNewline ? body + model.eol : body;
}

/**
 * Quotes a value if it needs quoting so the env file parser reads back exactly
 * what was written. An ordinary word is left bare, which keeps the file
 * readable.
 *
 * @param value - The value to write.
 */
export function quoteEnvValue(value: string): string {
  const needsQuotes =
    value.length === 0 ||
    /[\s#"'\\]/.test(value) ||
    value.startsWith("'") ||
    value.startsWith('"');

  if (!needsQuotes) return value;

  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/** Options for `setEntry`. */
export interface SetEntryOptions {
  /**
   * Comment lines written above the entry when it is APPENDED. An existing
   * entry keeps whatever comment is already above it, because sous only ever
   * rewrites the value line. Lines may be passed with or without their leading
   * `#`.
   */
  header?: string | string[];
}

/** Turns header text into `#`-prefixed comment lines. */
function headerLines(header: string | string[]): string[] {
  const source = Array.isArray(header) ? header : header.split("\n");
  return source.map((line) => {
    const trimmed = line.trimEnd();
    if (trimmed.length === 0) return "#";
    return trimmed.startsWith("#") ? trimmed : `# ${trimmed}`;
  });
}

/**
 * Sets one variable in a line model, in place.
 *
 * An existing assignment is rewritten where it stands, keeping its indentation,
 * its `export ` prefix and any trailing comment. When the key appears more than
 * once, the LAST one is rewritten, because that is the one the parser honors.
 * A key that is not there yet is appended at the end of the file, under its
 * generated header comment.
 *
 * @param model - The model to edit.
 * @param key - The variable's name.
 * @param value - The value to store, quoted as needed.
 * @param options - Header comment for a newly appended entry.
 * @returns Whether the entry was updated in place or appended.
 */
export function setEntry(
  model: EnvFileModel,
  key: string,
  value: string,
  options: SetEntryOptions = {}
): "updated" | "appended" {
  const quoted = quoteEnvValue(value);

  for (let i = model.lines.length - 1; i >= 0; i--) {
    const line = model.lines[i]!;
    if (line.kind !== "assignment" || line.key !== key) continue;

    const prefix = line.exported ? "export " : "";
    const text = `${line.indent}${prefix}${key}=${quoted}${line.inlineComment}`;
    model.lines[i] = { ...line, text, rawValue: quoted };
    return "updated";
  }

  // Appending: separate the new entry from whatever came before with one blank
  // line, unless the file is empty or already ends with one.
  const last = model.lines[model.lines.length - 1];
  if (last !== undefined && last.kind !== "blank") {
    model.lines.push({ kind: "blank", text: "" });
  }

  if (options.header !== undefined) {
    for (const text of headerLines(options.header)) {
      model.lines.push({ kind: "comment", text });
    }
  }

  model.lines.push({
    kind: "assignment",
    text: `${key}=${quoted}`,
    indent: "",
    exported: false,
    key,
    rawValue: quoted,
    inlineComment: "",
  });
  model.trailingNewline = true;
  return "appended";
}

/**
 * Removes every assignment of one variable from a line model, leaving comments
 * and blank lines alone (sous does not read comments, so it does not presume to
 * know which ones belonged to the entry).
 *
 * @param model - The model to edit.
 * @param key - The variable's name.
 * @returns How many assignment lines were removed.
 */
export function removeEntry(model: EnvFileModel, key: string): number {
  const before = model.lines.length;
  model.lines = model.lines.filter(
    (line) => !(line.kind === "assignment" && line.key === key)
  );
  return before - model.lines.length;
}

/**
 * Reads an env file into a line model, returning an empty model when the file
 * does not exist yet.
 *
 * @param filePath - Absolute path to the env file.
 */
export function readEnvFile(filePath: string): EnvFileModel {
  if (!fs.existsSync(filePath)) return { lines: [], eol: "\n", trailingNewline: true };
  return parseEnvFile(fs.readFileSync(filePath, "utf8"));
}

/**
 * Writes a line model back to disk atomically: the new contents go to a
 * temporary file in the same directory and are renamed over the original, so an
 * interrupted write can never leave a half-written env file behind.
 *
 * A file that does not exist yet is created readable and writable by its owner
 * only, since `.env.local` holds secrets; an existing file keeps its mode.
 *
 * @param filePath - Absolute path to the env file.
 * @param model - The model to write.
 */
export function writeEnvFile(filePath: string, model: EnvFileModel): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });

  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.sous-${process.pid}-${Date.now()}.tmp`
  );

  let mode = 0o600;
  try {
    mode = fs.statSync(filePath).mode & 0o777;
  } catch {
    // No existing file, so the restrictive default stands.
  }

  fs.writeFileSync(temporary, renderEnvFile(model), { encoding: "utf8", mode });
  fs.renameSync(temporary, filePath);
}

/**
 * Reads, edits and rewrites one env file in a single call: the usual way to
 * store an answer.
 *
 * @param filePath - Absolute path to the env file.
 * @param key - The variable's name.
 * @param value - The value to store.
 * @param options - Header comment for a newly appended entry.
 * @returns Whether the entry was updated in place or appended.
 */
export function updateEnvFile(
  filePath: string,
  key: string,
  value: string,
  options: SetEntryOptions = {}
): "updated" | "appended" {
  const model = readEnvFile(filePath);
  const outcome = setEntry(model, key, value, options);
  writeEnvFile(filePath, model);
  return outcome;
}
