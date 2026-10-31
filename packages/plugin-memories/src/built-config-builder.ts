/**
 * A `ConfigBuilder` over a config that is already built, so `memories.selection` can call a
 * memory target's `filter()` after the build the same way the contributor calls it during one.
 * Changes go to a private copy and are thrown away; nothing reaches the built config.
 */

import { createDocument } from "@sous-io/documents";
import {
    nullReporter,
    Reporting,
    SousError,
    type BuiltConfig,
    type ConfigBuilder,
    type ContributorInfo,
    type DocumentNode,
    type EntityKind,
    type EntityType,
    type Environment,
    type PathInput,
    type ProjectInfo,
    type Reporter,
    type ServiceContext,
} from "@sous-io/plugin-api";

/** The builder `builderOver` returns. After the build there is no contributor to report for, so it reports nowhere. */
class BuiltConfigBuilder extends Reporting(Object) implements ConfigBuilder {
    readonly contributor: ContributorInfo;
    readonly project: ProjectInfo | undefined;
    readonly env: Environment;

    private readonly document: ReturnType<typeof createDocument>;

    constructor(
        private readonly config: BuiltConfig,
        private readonly ctx: ServiceContext,
        contributorId: string,
    ) {
        super();
        this.document = createDocument(config.value());
        this.contributor = { id: contributorId, plugin: ctx.plugin, stage: 0, pass: 0, run: 0 };
        this.project = ctx.project;
        this.env = ctx.env;
    }

    protected get reporter(): Reporter {
        return nullReporter;
    }

    log(): void {
        // After the build there is no contributor to report for.
    }

    root(): DocumentNode {
        return this.document.root() as unknown as DocumentNode;
    }

    atPath(input: PathInput): DocumentNode {
        return this.document.atPath(input) as unknown as DocumentNode;
    }

    entities<K extends EntityKind>(kind: K): EntityType<K>[] {
        return this.ctx.entities.list(kind);
    }

    entity<K extends EntityKind>(kind: K, id: string): EntityType<K> | undefined {
        return this.ctx.entities.get(kind, id);
    }

    addEntity(): void {
        throw new SousError("A memory target's filter cannot add entities after the config is built.");
    }

    previousPatches(): undefined {
        return undefined;
    }

    apply(): void {
        // The copy is thrown away, so there is nothing to apply to.
    }

    options<T>(): T | undefined {
        const options = this.config.get<Record<string, T>>(["plugins", "options"]);

        return options?.[this.ctx.plugin];
    }
}

/** A builder that reads `config` and keeps every change to itself. */
export function builderOver(config: BuiltConfig, ctx: ServiceContext, contributorId: string): ConfigBuilder {
    return new BuiltConfigBuilder(config, ctx, contributorId);
}
