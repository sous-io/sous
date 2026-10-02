/**
 * Names, glob patterns and how a written name is compared with a known one.
 *
 * Every name or path part of a ref may be a glob pattern (`*`, `**`, `?`,
 * `[..]`, `{a,b}`), matched with minimatch. Plain names are compared as
 * strings. Either way the exact spelling is tried first and ignoring case is
 * the fallback, so the caller can tell which one matched.
 */

import { minimatch } from "minimatch";

/** A name as the parser accepts it: kebab-case, in any case. */
export const NAME_ANY_CASE = /^[a-z][a-z0-9-]*$/i;

/** A name as it is stored: lowercase kebab-case. */
export const NAME_STORED = /^[a-z][a-z0-9-]*$/;

/** A variable name, as a recipe's author writes it: camelCase. */
export const VARIABLE_NAME = /^[a-z][a-zA-Z0-9]*$/;

/** An environment variable name: whatever a shell accepts. */
export const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The characters a glob pattern is made of. */
const GLOB_CHARS = /[*?[\]{}]/;

/** The characters a glob pattern standing for a name may use. */
const GLOB_NAME = /^[A-Za-z0-9_\-.*?[\]{},!^]+$/;

/** True when a string holds glob syntax. */
export function hasGlob(text: string): boolean {
  return GLOB_CHARS.test(text);
}

/** True when a string is a glob pattern that could stand for a name. */
export function isGlobName(text: string): boolean {
  return hasGlob(text) && GLOB_NAME.test(text);
}

/**
 * Splits text at `/`, except inside braces, so `{a/b,c}` stays whole.
 *
 * splitSegments("a/{b/c,d}/e"); // -> ["a", "{b/c,d}", "e"]
 *
 * @param text - The text to split.
 */
export function splitSegments(text: string): string[] {
  const segments: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of text) {
    if (character === "{") depth += 1;
    if (character === "}" && depth > 0) depth -= 1;
    if (character === "/" && depth === 0) {
      segments.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  segments.push(current);
  return segments;
}

/** How a written name matched a known one. */
export type NameMatch = "exact" | "folded" | undefined;

/**
 * Whether a written name (or glob pattern) matches a known one: exactly, only
 * ignoring case, or not at all.
 *
 * matchName("Workflow", "workflow"); // -> "folded"
 * matchName("work*", "workflow"); // -> "exact"
 *
 * @param written - The name or pattern as written.
 * @param known - The name as it is spelled where it is published.
 */
export function matchName(written: string, known: string): NameMatch {
  if (hasGlob(written)) {
    if (minimatch(known, written, { dot: true })) return "exact";
    return minimatch(known, written, { dot: true, nocase: true }) ? "folded" : undefined;
  }
  if (written === known) return "exact";
  return written.toLowerCase() === known.toLowerCase() ? "folded" : undefined;
}

/**
 * The names that match a written one: those spelled exactly as written, or,
 * when there is none, those that differ only in case.
 *
 * matchNames("Workflow", ["workflow", "tooling"]); // -> ["workflow"]
 * matchNames("workflow", ["workflow", "Workflow"]); // -> ["workflow"]
 *
 * @param written - The name as written.
 * @param names - The names it could mean.
 */
export function matchNames(written: string, names: Iterable<string>): string[] {
  const all = [...names];
  const exact = all.filter((name) => matchName(written, name) === "exact");
  if (exact.length > 0) return exact;
  return all.filter((name) => matchName(written, name) === "folded");
}

/**
 * Orders two strings by their UTF-8 bytes, so the order is the same on every
 * machine whatever its locale.
 *
 * ["b", "B", "a"].sort(compareBytewise); // -> ["B", "a", "b"]
 *
 * @param left - The first string.
 * @param right - The second string.
 */
export function compareBytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
