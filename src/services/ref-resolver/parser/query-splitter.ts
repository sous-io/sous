/**
 * Reads the `?name=value&name=value` at the end of a ref.
 */

import { makeInjectable } from "../injectable.js";
import { BaseRefSplitter, type PartialRef } from "./partial-ref.js";

/** A URL that names its scheme, such as `https://` or `github://`. */
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** One pair of a query: a percent-encoded name, `=`, and a percent-encoded value. */
const PAIR = /^([A-Za-z0-9\-._~%+!*'(),:@/$]+)=([A-Za-z0-9\-._~%+!*'(),:@/$]*)$/;

/**
 * The decoded pairs of a query, or undefined when it is not a valid
 * percent-encoded query string.
 *
 * decodeQuery("a=1&b=two%20words"); // -> { a: "1", b: "two words" }
 * decodeQuery("a=%zz"); // -> undefined
 *
 * @param query - The text after the `?`.
 */
export function decodeQuery(query: string): Record<string, string> | undefined {
  if (query.length === 0) return undefined;
  const vars: Record<string, string> = {};
  for (const pair of query.split("&")) {
    const match = PAIR.exec(pair);
    if (match === null) return undefined;
    try {
      vars[decodeURIComponent(match[1]!.replace(/\+/g, " "))] = decodeURIComponent(
        match[2]!.replace(/\+/g, " ")
      );
    } catch {
      return undefined;
    }
  }
  return vars;
}

/**
 * Takes a valid, percent-encoded query off the end of the text and keeps its
 * pairs. A string that starts with a URL scheme is left alone, because a URL's
 * query belongs to the URL. When the text before the `?` could also be a glob
 * path holding a `?` and an `=`, both readings are kept.
 */
export class QuerySplitter extends BaseRefSplitter {
  readonly order = 100;

  protected read(state: PartialRef): PartialRef[] {
    if (SCHEME.test(state.rest)) return [state];
    const mark = state.rest.lastIndexOf("?");
    if (mark <= 0) return [state];

    const vars = decodeQuery(state.rest.slice(mark + 1));
    if (vars === undefined) return [state];

    return [{ ...state, rest: state.rest.slice(0, mark), vars: { ...state.vars, ...vars } }, state];
  }
}

makeInjectable(QuerySplitter);
