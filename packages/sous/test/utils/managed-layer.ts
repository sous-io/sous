import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "@sous-io/documents";

/** The managed layer that holds the repositories a project trusts. */
export const REPOS_LAYER_FILENAME = "500-repos.jsonc";

/** The managed layer that holds what a project subscribes to. */
export const SUBSCRIPTIONS_LAYER_FILENAME = "510-subscriptions.jsonc";

/**
 * Reads one of the layers sous writes into `.sous/conf.d/`, or `{}` when it is missing. The old
 * `.json` name is read when the `.jsonc` one is not there.
 */
export function readManagedLayer(sousDir: string, fileName: string): Record<string, unknown> {
    const current = path.join(sousDir, "conf.d", fileName);
    const legacy = current.replace(/\.jsonc$/, ".json");
    const file = fs.existsSync(current) ? current : fs.existsSync(legacy) ? legacy : undefined;

    if (file === undefined) {
        return {};
    }

    return parseDocument(fs.readFileSync(file, "utf8"), "jsonc").value() as Record<string, unknown>;
}
