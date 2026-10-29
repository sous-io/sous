/**
 * A `ConfigBuilder` over a config that is already built, so `memories.selection` can call a
 * memory target's `filter()` after the build the same way the contributor calls it during one.
 * Changes go to a private copy and are thrown away; nothing reaches the built config.
 */

import { createDocument } from "@sous-io/documents";
import type { BuiltConfig, ConfigBuilder, DocumentNode, EntityKind, EntityType, ServiceContext } from "@sous-io/plugin-api";
import { SousError } from "@sous-io/plugin-api";

/** A builder that reads `config` and keeps every change to itself. */
export function builderOver(config: BuiltConfig, ctx: ServiceContext, contributorId: string): ConfigBuilder {
    const document = createDocument(config.value());
    const node = (input: Parameters<ConfigBuilder["atPath"]>[0]) => document.atPath(input) as unknown as DocumentNode;

    return {
        root: () => document.root() as unknown as DocumentNode,
        atPath: node,
        entities: <K extends EntityKind>(kind: K) => ctx.entities.list(kind),
        entity: <K extends EntityKind>(kind: K, id: string) => ctx.entities.get(kind, id),
        addEntity() {
            throw new SousError("A memory target's filter cannot add entities after the config is built.");
        },
        previousPatches: () => undefined,
        apply() {
            // The copy is thrown away, so there is nothing to apply to.
        },
        options: <T>() => {
            const options = config.get<Record<string, T>>(["plugins", "options"]);

            return options?.[ctx.plugin];
        },
        log() {
            // After the build there is no contributor to report for.
        },
        contributor: { id: contributorId, plugin: ctx.plugin, stage: 0, pass: 0, run: 0 },
        project: ctx.project,
        env: ctx.env,
    } satisfies ConfigBuilder & { entities<K extends EntityKind>(kind: K): EntityType<K>[] };
}
