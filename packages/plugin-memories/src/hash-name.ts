/**
 * The `#memories` view: every selected memory of the active recipes, at
 * `#memories/<namespace>/<recipe>/<name>`, in selection order.
 */

import type { HashNameEntity } from "@sous-io/plugin-refs/types";
import { viewPath } from "./listing.js";

/** The `hash-name` entity for `#memories`. */
export const memoriesHashName: HashNameEntity = {
    id: "memories",
    description:
        "the memories of every active recipe, listed in dependency order as #memories/<namespace>/<recipe>/<path>.",
    bases: () => [],
    view: (ctx) =>
        ctx.services
            .get("memories.selection")
            .selected()
            .map((memory) => ({ path: viewPath(memory), file: memory.path })),
};
