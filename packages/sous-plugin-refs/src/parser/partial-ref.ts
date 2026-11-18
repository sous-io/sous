/**
 * Helpers for `ref-splitter` entities: leaving a finished reading alone, and finishing one.
 */

import type { ServiceContext } from "@sous-io/plugin-api";
import type { PartialRef, RefSplitterEntity, SousRef } from "../types.js";

/** A URL that names its scheme, such as `https://` or `github://`. */
export const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** The `scp`-style SSH form, as in `git@github.com:owner/name.git`. */
export const SCP = /^[^@\s/:]+@([^@\s/:]+):(.+)$/s;

/**
 * A splitter that leaves a finished reading alone, so `read` only says how it reads text that is
 * still unread.
 *
 * ```ts
 * const shout = splitter("shout", 45, (state) =>
 *     state.rest === "SHOUT" ? [finishRef(state, { kind: "envVar", name: "SHOUT" })] : [state],
 * );
 * ```
 */
export function splitter(
    id: string,
    order: number,
    read: (state: PartialRef, ctx: ServiceContext) => PartialRef[],
): RefSplitterEntity {
    return {
        id,
        order,
        split: (state, ctx) => (state.ref !== undefined ? [state] : read(state, ctx)),
    };
}

/** The state with a finished ref in it, carrying the query values read so far. */
export function finishRef(state: PartialRef, ref: SousRef): PartialRef {
    const withVars: SousRef = state.vars === undefined ? ref : ({ ...ref, vars: state.vars } as SousRef);

    return { ...state, rest: "", ref: withVars };
}
