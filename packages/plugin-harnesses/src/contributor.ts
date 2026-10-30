/**
 * The `harnesses.tools` contributor: adds a `harness` entity for each tool written under
 * `tools` that no plugin already provides, so such a tool launches with no plugin at all.
 */

import type { ConfigBuilder, ContributorDefinition } from "@sous-io/plugin-api";
import { TOOLS_KEY } from "./settings.js";
import { toolHarness } from "./tool.js";

/** The contributor's id. */
export const TOOLS_CONTRIBUTOR = "harnesses.tools";

/** Adds the missing entities. Reading each entity records it, so a harness added later re-runs this. */
export function contributeToolHarnesses(config: ConfigBuilder): void {
    const tools = config.atPath(TOOLS_KEY).get();

    if (!tools || typeof tools !== "object" || Array.isArray(tools)) {
        return;
    }

    for (const id of Object.keys(tools)) {
        if (config.entity("harness", id) === undefined) {
            config.addEntity("harness", toolHarness(id));
        }
    }
}

/** The contributor. It runs after other plugins, which add their harnesses first. */
export const toolsContributor: ContributorDefinition = {
    id: TOOLS_CONTRIBUTOR,
    after: ["*"],
    contribute: contributeToolHarnesses,
};
