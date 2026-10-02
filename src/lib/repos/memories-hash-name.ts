/**
 * The built-in `#memories` view: every memory an active recipe publishes, at
 * `#memories/<namespace>/<recipe>/<path>`. See `recipe-memories.ts` for what is
 * listed and in which order.
 */

import { makeInjectable } from "../../services/ref-resolver/injectable.js";
import type { HashName, HashViewContext, ViewFile } from "../../services/ref-resolver/hash-names.js";
import { listMemories } from "./recipe-memories.js";

/** The `#memories` view. */
export class MemoriesHashName implements HashName {
  readonly name = "memories";
  readonly registeredBy = "sous";
  readonly description =
    "the memories of every active recipe, listed in dependency order as #memories/<namespace>/<recipe>/<path>.";

  bases(): string[] {
    return [];
  }

  view(context: HashViewContext): ViewFile[] {
    const memories = context.settings.recipes?.memories;
    return listMemories({
      sousDir: context.sousDir,
      ...(context.env === undefined ? {} : { env: context.env }),
      first: memories?.first,
      exclude: memories?.exclude,
    }).map((memory) => ({ path: memory.path, file: memory.file }));
  }
}

makeInjectable(MemoriesHashName);
