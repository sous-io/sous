/**
 * The shapes the parser works with: a reading in progress, and the splitter
 * that advances it.
 */

import type { RepoRef, SousRef } from "../types.js";

/**
 * A reading in progress. A splitter takes some of `rest` and records what it
 * found beside it; a reading is finished when `ref` is set and `rest` is empty.
 */
export type PartialRef = {
  /** The whole input, trimmed. Never changes. */
  input: string;
  /** The text no splitter has read yet. */
  rest: string;
  /** The `?name=value` pairs read so far. */
  vars?: Record<string, string>;
  /** The version range read so far. */
  range?: string;
  /** The repository qualifier read so far. */
  repo?: RepoRef;
  /** The finished ref, once a splitter has made one. */
  ref?: SousRef;
  /**
   * Why a splitter turned the text down, shared by every reading of one input.
   * The parser quotes these when nothing reads, and says nothing of them
   * otherwise.
   */
  problems: string[];
};

/**
 * One step of the parser. A splitter reads whatever part of `rest` it
 * recognizes (the front or the end) and returns EVERY way to read it, as
 * partial refs of its own. A splitter that does not recognize anything returns
 * the state unchanged, and one that could also leave the text for a later
 * splitter returns the state among its readings. A splitter never looks at
 * where the ref was written.
 */
export interface RefSplitter {
  /** Where this splitter runs among the others: lowest first. */
  readonly order: number;
  /**
   * Advances one reading.
   *
   * @param state - The reading so far.
   * @returns Every reading that can follow it.
   */
  split(state: PartialRef): PartialRef[];
}

/**
 * A splitter that leaves a finished reading alone, so each subclass only says
 * how it reads text that is still unread.
 */
export abstract class BaseRefSplitter implements RefSplitter {
  abstract readonly order: number;

  split(state: PartialRef): PartialRef[] {
    if (state.ref !== undefined) return [state];
    return this.read(state);
  }

  /**
   * Reads an unfinished reading.
   *
   * @param state - A reading with no finished ref.
   */
  protected abstract read(state: PartialRef): PartialRef[];
}

/**
 * The state with a finished ref in it, carrying the query values and, for the
 * kinds that take one, the version range.
 *
 * @param state - The reading so far.
 * @param ref - The finished ref.
 */
export function finishRef(state: PartialRef, ref: SousRef): PartialRef {
  const withVars: SousRef =
    state.vars === undefined ? ref : ({ ...ref, vars: state.vars } as SousRef);
  return { ...state, rest: "", ref: withVars };
}
