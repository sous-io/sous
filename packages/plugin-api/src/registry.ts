import type { ConfigKeyEntity, PluginLocatorEntity } from "./entities.js";
import type { ConfigBuiltPayload } from "./events.js";

/**
 * The interfaces plugins add their own types to, through TypeScript declaration merging. At run time everything is looked up by its string name; these only
 * give the names their types.
 *
 * ```ts
 * declare module "@sous-io/plugin-api" {
 *     interface SousServices {
 *         "diagrams.renderer": Renderer;
 *     }
 *
 *     interface SousIntents {
 *         "diagrams.render": { input: { only?: string }; result: { rendered: number } };
 *     }
 *
 *     interface SousEvents {
 *         "diagrams.rendered": { files: RenderResult[] };
 *     }
 *
 *     interface SousEntities {
 *         "harness": HarnessEntity;
 *     }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SousServices {}

/** Each intent's input and result: `"name": { input: ...; result: ... }`. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SousIntents {}

/** Each custom event's payload: `"diagrams.rendered": { files: RenderResult[] }`. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SousEvents {}

/** Each entity kind's entry type: `"harness": HarnessEntity`. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SousEntities {}

/**
 * The type of each top-level config key, for `ctx.config.get("diagrams")`. Optional: a key with no
 * entry here reads as `unknown`. (Added beside the four interfaces core names; it follows the same
 * pattern for the keys plugins add as `config-key` entities.)
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SousConfig {}

/** The entity kinds core itself defines. */
export interface CoreEntities {
    /** A key the config may hold, with its schema. */
    "config-key": ConfigKeyEntity;
    /** A way to find a plugin's module from the specifier in `plugins.load`. */
    "plugin-locator": PluginLocatorEntity;
}

/** The events core itself fires. */
export interface CoreEvents {
    /** Fired once each time the config has been built (never for "what if" builds). */
    "config.built": ConfigBuiltPayload;
}

/** A name any of these registries accepts: a known one, or any string. */
export type AnyName<Known> = (Known & string) | (string & {});

/** Every known service name, plus any string. */
export type ServiceName = AnyName<keyof SousServices>;

/** The type of a service, or `unknown` when nothing declares it. */
export type ServiceType<N extends string> = N extends keyof SousServices ? SousServices[N] : unknown;

/** Every known intent name, plus any string. */
export type IntentName = AnyName<keyof SousIntents>;

/** The input type an intent declared, or `unknown`. */
export type IntentInput<N extends string> = N extends keyof SousIntents
    ? SousIntents[N] extends { input: infer I }
        ? I
        : unknown
    : unknown;

/** The result type an intent declared, or `unknown`. */
export type IntentResult<N extends string> = N extends keyof SousIntents
    ? SousIntents[N] extends { result: infer R }
        ? R
        : unknown
    : unknown;

/** Every entity kind, core's and the plugins'. */
export type AllEntities = CoreEntities & SousEntities;

/** Every known entity kind, plus any string. */
export type EntityKind = AnyName<keyof AllEntities>;

/** What every entity has. */
export interface EntityBase {
    /** Unique within its kind. */
    id: string;
}

/** The entry type of an entity kind, or {@link EntityBase} when nothing declares it. */
export type EntityType<K extends string> = K extends keyof AllEntities ? AllEntities[K] : EntityBase & Record<string, unknown>;

/** The type of a top-level config key, or `unknown`. */
export type ConfigKeyType<K extends string> = K extends keyof SousConfig ? SousConfig[K] : unknown;
