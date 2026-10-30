import type { Environment, ProjectInfo } from "./context.js";
import type { EntityReader } from "./entities.js";
import type { JsonObject, JsonValue, Patch, PatchSet, PathInput } from "./json.js";
import type { DocumentNode } from "./node.js";
import type { ConfigKeyType, EntityKind, EntityType } from "./registry.js";
import type { LogLevel } from "./reporter.js";
import type { ServiceReader } from "./services.js";

/** Reading a built config. Values are plain JSON, frozen. */
export interface ConfigReader {
    /** The value at a path, or `undefined`. */
    get<K extends string>(path: K): ConfigKeyType<K> | undefined;
    get<T = JsonValue>(path: PathInput): T | undefined;
    /** Whether a value exists at a path. */
    has(path: PathInput): boolean;
    /** The whole config. */
    value(): Readonly<JsonObject>;
}

/** One primitive change to a value, and who made it. */
export interface ConfigLayer {
    /** The contributor that made it. */
    readonly contributor: string;
    /** The plugin the contributor belongs to. */
    readonly plugin: string;
    readonly patch: Patch;
    /** The patch sets around it, outermost first, after the contributor's own: `["removeWhere"]`. */
    readonly helpers: readonly string[];
}

/** One contributor's part in a build. */
export interface Contribution {
    readonly contributor: string;
    readonly plugin: string;
    readonly stage: number;
    /** Its latest patch set. */
    readonly patches: PatchSet;
    /** How many times it ran in this build. */
    readonly runs: number;
}

/** A config the engine built: the values, and the entities and services that belong to it. */
export interface BuiltConfig extends ConfigReader {
    /** Counts builds in this process, "what if" builds included. */
    readonly buildNumber: number;
    /** True for a "what if" build, which never replaces the real config. */
    readonly whatIf: boolean;
    /** Passes the build took, over every stage, counting only passes in which something ran. */
    readonly passes: number;
    /** A hash of the values and the entities (ids, sources and data), to tell configs apart. */
    readonly hash: string;
    /** The entities of this build. */
    readonly entities: EntityReader;
    /** The services of this build: `config` services belong to it. */
    readonly services: ServiceReader;
    /** Every change to a path, or anything inside it or around it, in the order it was applied. */
    layers(path: PathInput): ConfigLayer[];
    /** Every contributor's part, in the order their patches apply: the sorted order, earlier stages first. */
    contributions(): Contribution[];
}

/** Watching more than a contributor reads: a path, or an entity kind. */
export type Monitor = PathInput | { entities: string };

/** Who is running, as the builder tells a contributor. */
export interface ContributorInfo {
    readonly id: string;
    readonly plugin: string;
    /** The stage it runs in, after any shift. */
    readonly stage: number;
    /** The pass of the current stage, from 1. */
    readonly pass: number;
    /** How many times it has run in this build, this run included. */
    readonly run: number;
}

/**
 * What a contributor is given. It shows the config made from every other
 * contributor's latest patches, without this contributor's own; every read is recorded, and every
 * change becomes this run's patch set.
 */
export interface ConfigBuilder {
    /** The root, to merge a whole config file: `config.root().merge(data)`. Reading it monitors everything. */
    root(): DocumentNode;
    /** A node at a path. */
    atPath(path: PathInput): DocumentNode;
    /** Every entity of a kind. Recorded as a read of the list. */
    entities<K extends EntityKind>(kind: K): EntityType<K>[];
    /** One entity. Recorded as a read of that entity alone. */
    entity<K extends EntityKind>(kind: K, id: string): EntityType<K> | undefined;
    /**
     * Adds an entity the config creates. It is part of this run's patch, so a re-run replaces it.
     * Its methods must not use `this` (see `sous.entities.add`).
     */
    addEntity<K extends EntityKind>(kind: K, entry: EntityType<K>): void;
    /** This contributor's patch set from its previous run, if it ran before. */
    previousPatches(): PatchSet | undefined;
    /** Applies raw patches, as written in a patch file. */
    apply(patches: Patch | PatchSet | readonly Patch[]): void;
    /** This plugin's own options from `plugins.options`. Recorded as a read. */
    options<T = JsonObject>(): T | undefined;
    /** Reports a message through the engine's reporter (contributors never print). */
    log(level: LogLevel, message: string): void;
    /** Who is running. */
    readonly contributor: ContributorInfo;
    readonly project: ProjectInfo | undefined;
    readonly env: Environment;
}

/**
 * A contributor: anything that adds to the config.
 *
 * ```ts
 * sous.config.contribute({
 *     id: "diagrams",
 *     after: ["@sous-io/plugin-skills"],
 *
 *     contribute(config) {
 *         if (config.atPath("diagrams.enabled").valueOr(true)) {
 *             config.atPath("compilation.targets").appendValue({ id: "diagrams" });
 *         }
 *     },
 * });
 * ```
 */
export interface ContributorDefinition {
    /** Unique in the engine: `diagrams`, `confd/610-mac.jsonc`, `claude-code/defaults`. */
    id: string;
    /** Its config stage; stages run lowest first. Default `0`, shifted for plugins loaded during a stage. */
    stage?: number;
    /** Plugins, contributor ids or wildcards this one runs before. Default: its plugin's `before`. */
    before?: readonly string[];
    /** Plugins, contributor ids or wildcards this one runs after. Default: its plugin's `after`. */
    after?: readonly string[];
    /** More to watch than it reads; a change to any re-runs it. */
    monitors?: readonly Monitor[];
    /** Builds this contributor's patch. Must give the same result for the same input. */
    contribute(config: ConfigBuilder): void | Promise<void>;
}

/** Options for building a config. */
export interface BuildOptions {
    /** More contributors for this build only ("what if" builds). */
    extraContributors?: readonly ContributorDefinition[];
}
