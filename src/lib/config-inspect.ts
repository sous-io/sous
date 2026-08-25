import { styleText } from "node:util";
import { ConfigError } from "./errors.js";

/**
 * Shared helpers for the `xcv config *` inspection commands: dot-path lookup
 * with `[n]` array indexing, colorized pretty-JSON rendering, and value
 * truncation for the `--layers` provenance view.
 */

/** Sentinel returned by lookupPath when a path segment does not exist. */
export const NOT_FOUND = Symbol("sous.config.path.not-found");

/**
 * Splits a dot-path with optional `[n]` array indices into ordered segments.
 * `compilation.targets[0].entryPoint` → `["compilation", "targets", 0, "entryPoint"]`.
 * Numeric-looking bracket segments become numbers; everything else is a string key.
 *
 * @throws ConfigError on a malformed path (empty, unbalanced brackets, etc.).
 */
export function parsePath(path: string): (string | number)[] {
  const trimmed = path.trim();
  if (trimmed === "") {
    throw new ConfigError("Empty config path. Provide a dot-path like 'compilation.targets[0].entryPoint'.");
  }

  const segments: (string | number)[] = [];
  // Consume, in order: bare keys, `[n]` array indices, and `.` separators
  // between them. Any character that fits none of these (e.g. `a..b`, `a[]`,
  // `a[x]`) leaves a gap the scanner reports as malformed.
  const tokenRe = /([^.[\]]+)|\[(\d+)\]|(\.)/g;
  let lastIndex = 0;
  let expectKey = false; // a `.` was just consumed, so a key must follow
  let match: RegExpExecArray | null;

  while ((match = tokenRe.exec(trimmed)) !== null) {
    if (match.index !== lastIndex) {
      throw new ConfigError(`Malformed config path near '${trimmed.slice(lastIndex)}' in '${path}'.`);
    }
    if (match[1] !== undefined) {
      segments.push(match[1]);
      expectKey = false;
    } else if (match[2] !== undefined) {
      if (expectKey) {
        throw new ConfigError(`Malformed config path near '${trimmed.slice(match.index)}' in '${path}'.`);
      }
      segments.push(Number(match[2]));
    } else {
      // A `.` separator: a key must follow it, and one may not lead the path or
      // directly follow another `.` (i.e. `.a`, `a..b` are malformed).
      if (expectKey || segments.length === 0) {
        throw new ConfigError(`Malformed config path near '${trimmed.slice(match.index)}' in '${path}'.`);
      }
      expectKey = true;
    }
    lastIndex = tokenRe.lastIndex;
  }

  if (lastIndex !== trimmed.length || expectKey) {
    throw new ConfigError(`Malformed config path near '${trimmed.slice(lastIndex) || "end of path"}' in '${path}'.`);
  }

  return segments;
}

/**
 * Walks `root` following `segments`, returning the value found or NOT_FOUND when
 * any segment is missing (or the path descends into a non-indexable value).
 */
export function lookupPath(root: unknown, segments: (string | number)[]): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== "object") {
      return NOT_FOUND;
    }
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment < 0 || segment >= current.length) {
        return NOT_FOUND;
      }
      current = current[segment];
    } else {
      // Use hasOwnProperty, NOT the `in` operator: `in` walks the prototype
      // chain, so inherited Object.prototype members (`constructor`, `toString`,
      // `hasOwnProperty`, `__proto__`, …) would falsely "resolve" and print
      // garbage instead of NOT_FOUND.
      if (!Object.prototype.hasOwnProperty.call(current, segment)) {
        return NOT_FOUND;
      }
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}

/** True for JSON scalar values (string, finite/any number, boolean, null). */
export function isScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/**
 * Colorizes an already-serialized pretty-JSON string using node:util styleText:
 * object keys cyan, string values green, numbers yellow, booleans/null magenta.
 * Operates purely on JSON token syntax, so it never mangles structure.
 *
 * Callers should only invoke this when writing to a TTY; piped output must stay
 * plain so it parses as JSON.
 */
export function colorizeJson(json: string): string {
  const tokenRe = /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b/g;
  return json.replace(tokenRe, (match, offset: number, whole: string) => {
    if (match[0] === '"') {
      const rest = whole.slice(offset + match.length);
      // A string immediately followed by a colon is an object key.
      return /^\s*:/.test(rest)
        ? styleText("cyan", match)
        : styleText("green", match);
    }
    if (match === "true" || match === "false" || match === "null") {
      return styleText("magenta", match);
    }
    return styleText("yellow", match);
  });
}

/**
 * Renders a value as pretty JSON (2-space), colorized when `useColor` is true.
 */
export function renderJson(value: unknown, useColor: boolean): string {
  const json = JSON.stringify(value, null, 2);
  return useColor ? colorizeJson(json) : json;
}

/**
 * JSON-encodes a value on a single line and truncates it to `max` characters
 * (with an ellipsis) for the compact `--layers` provenance lines.
 */
export function truncateJson(value: unknown, max = 80): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return "undefined";
  return encoded.length > max ? `${encoded.slice(0, max - 1)}…` : encoded;
}
