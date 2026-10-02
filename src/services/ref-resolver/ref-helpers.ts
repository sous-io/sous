/**
 * Helpers around the resolver, for callers that have no container: the ones
 * that need a resolver use the shared one, and the ones that only work on refs
 * need none.
 */

import { sharedRefResolver } from "./container.js";
import { RefResolveResult } from "./ref-resolve-result.js";
import type { RefInString } from "./ref-resolver-service.js";
import { RefSource } from "./source.js";
import type { RefKind, SousRef } from "./types.js";

/**
 * True when the text is a ref the place allows. A caller that finds text that
 * looks like a ref but is not (an include line, say) treats it as an error.
 *
 * @param input - The ref exactly as it was written.
 * @param from - Where it was written.
 */
export function isValidRef(input: string, from: RefSource = RefSource.CommandLine): boolean {
  return sharedRefResolver().isValidRef(input, from);
}

/**
 * Every valid ref in a longer text, with the punctuation around each word taken off.
 *
 * @param text - The text to search.
 * @param from - Where the text was written.
 */
export function getRefsInString(text: string, from: RefSource = RefSource.CommandLine): RefInString[] {
  return sharedRefResolver().getRefsInString(text, from);
}

/**
 * The best ref of a result, or the first reading of a string the place allows.
 *
 * @param source - A resolve result, or a written ref.
 * @param from - Where a written ref was written.
 * @returns The ref, or undefined when a result holds none.
 */
export function getFirstRef(
  source: RefResolveResult | string,
  from: RefSource = RefSource.CommandLine
): SousRef | undefined {
  return typeof source === "string" ? sharedRefResolver().parse(source, from).first() : source.first();
}

/**
 * Keeps the refs a caller can use: those of the given kinds, or those a
 * predicate accepts.
 *
 * pruneRefs(result.refs, ["namespace", "recipe"]);
 *
 * @param refs - The refs to narrow.
 * @param keep - The kinds to keep, or a test.
 */
export function pruneRefs(
  refs: readonly SousRef[],
  keep: readonly RefKind[] | ((ref: SousRef) => boolean)
): SousRef[] {
  return refs.filter((ref) => (typeof keep === "function" ? keep(ref) : keep.includes(ref.kind)));
}
