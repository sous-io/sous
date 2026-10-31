/**
 * The `memories.selection` service: which memories go where, after the config is built. It
 * gives the same answers the `memories.targets` contributor worked from.
 */

import type { ConfigReader, ServiceContext } from "@sous-io/plugin-api";
import { NotFoundError } from "@sous-io/plugin-api";
import { builderOver } from "./built-config-builder.js";
import { selectMemories, type MemoryGlobs, type MemoryRecipe, type MemorySelectionResult } from "./listing.js";
import { memoriesForTarget, TARGETS_CONTRIBUTOR } from "./targets.js";
import type { MemoriesSelection, MemoriesSettings, Memory } from "./types.js";

/** `memories.selection`, for one built config. */
export class MemoriesSelectionService implements MemoriesSelection {
    private result: MemorySelectionResult | undefined;

    constructor(
        private readonly config: ConfigReader,
        private readonly ctx: ServiceContext,
    ) {}

    selected(): Memory[] {
        return [...this.select().selected];
    }

    forTarget(targetId: string): Memory[] {
        const target = this.ctx.entities.get("memory-target", targetId);

        if (!target) {
            throw new NotFoundError("memory-target", targetId, `No memory target "${targetId}" exists.`);
        }

        const builder = builderOver(this.ctx.config, this.ctx, TARGETS_CONTRIBUTOR);

        return memoriesForTarget(target, this.select().selected, builder);
    }

    excluded(): Array<{ readonly memory: Memory; readonly by: string }> {
        return [...this.select().excluded];
    }

    private select(): MemorySelectionResult {
        this.result ??= selectMemories({
            recipes: this.ctx.entities.list("active-recipe") as MemoryRecipe[],
            settings: this.config.get<Partial<MemoriesSettings>>(["recipes", "memories"]),
            globs: this.ctx.services.get("host.globs") as MemoryGlobs,
        });

        return this.result;
    }
}
