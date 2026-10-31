import type { ProjectInfo } from "./context.js";
import type { PluginDefinition } from "./plugin.js";
import type { EntityKind, EntityType } from "./registry.js";
import type { SousSchema } from "./schema.js";

/** Options for defining an entity kind. */
export interface EntityKindOptions {
    /** What the kind is, for `plugins show`. */
    description?: string;
}

/**
 * One entity, with where it came from.
 *
 * The engine compares entities by id, source and a hash of their fields that are not functions,
 * so a contributor that read an entity re-runs when it appears, disappears or its data changes.
 */
export interface EntityRecord<E = unknown> {
    readonly kind: string;
    readonly id: string;
    readonly entry: E;
    /** The plugin that added it. */
    readonly plugin: string;
    /** The contributor that added it, when the config created it. */
    readonly contributor?: string;
}

/** Reading entities, after the config is built. */
export interface EntityReader {
    /** One entity, or `undefined`. */
    get<K extends EntityKind>(kind: K, id: string): EntityType<K> | undefined;
    /** Every entity of a kind, in the order they were added. */
    list<K extends EntityKind>(kind: K): EntityType<K>[];
    /** Whether an entity exists. */
    has(kind: string, id: string): boolean;
    /** Every entity of a kind, with where each came from. */
    describe<K extends EntityKind>(kind: K): EntityRecord<EntityType<K>>[];
    /** Every kind defined so far. */
    kinds(): string[];
}

/** A `config-key` entity: a key the config may hold, with its schema and defaults. */
export interface ConfigKeyEntity {
    /** The key, as a path: `diagrams`, or `tools.claude` for a key inside another plugin's. */
    id: string;
    /** Checks the value and fills in its defaults when the finished config is checked. */
    schema: SousSchema;
    /** What the key is for. */
    description?: string;
}

/** What a plugin locator is told. */
export interface PluginLocateContext {
    readonly project: ProjectInfo | undefined;
}

/**
 * A `plugin-locator` entity: turns a specifier from `plugins.load` into a module to import, such as
 * a recipe's downloaded bundle, or a Yarn Plug'n'Play location. Locators are asked in plugin order;
 * the first answer wins, and when none answers, Node's own resolution from the project is used.
 */
export interface PluginLocatorEntity {
    id: string;
    /** A path or URL to import, a plugin definition, or `undefined` to pass. */
    locate(
        specifier: string,
        context: PluginLocateContext,
    ): string | URL | PluginDefinition | undefined | Promise<string | URL | PluginDefinition | undefined>;
}
