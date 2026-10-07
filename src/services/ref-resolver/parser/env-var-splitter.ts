/**
 * Reads an environment variable name.
 */

import { makeInjectable } from "../injectable.js";
import { ENV_VAR_NAME } from "../glob.js";
import { BaseRefSplitter, finishRef, type PartialRef } from "./partial-ref.js";

/**
 * Any text that is a legal environment variable name (a letter or underscore,
 * then letters, digits or underscores) is also read as one, whole: `_` is both
 * the delimiter and an identifier character, so a name is never split into the
 * scopes that might have produced it. The text stays unread for the other
 * splitters too, because `workflow` is a namespace as well.
 */
export class EnvVarSplitter extends BaseRefSplitter {
  readonly order = 600;

  protected read(state: PartialRef): PartialRef[] {
    if (state.repo !== undefined || state.range !== undefined || !ENV_VAR_NAME.test(state.rest)) {
      return [state];
    }
    return [state, finishRef(state, { kind: "envVar", name: state.rest })];
  }
}

makeInjectable(EnvVarSplitter);
