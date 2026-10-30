import type { ContributorDefinition } from "./config.js";
import type { Environment, EngineHandle, ProjectInfo } from "./context.js";
import type { EntityKindOptions, EntityReader } from "./entities.js";
import type { EventFor, EventForPattern, EventPattern, EventPayload, Listener, ListenerOptions } from "./events.js";
import type { IntentDefinition, IntentWrapper, IntentInputOf } from "./intents.js";
import type { EntityKind, EntityType, IntentResult, ServiceName, ServiceType } from "./registry.js";
import type { Reporter } from "./reporter.js";
import type { SousSchema } from "./schema.js";
import type { ServiceFactory, ServiceOptions, ServiceReader, ServiceWrapper } from "./services.js";

/**
 * A plugin: a module that registers contributors, intents, listeners, services and entities. Its module's default export is the definition.
 */
export interface PluginDefinition {
    /** The package name: `sous-plugin-diagrams`, `@sous-io/plugin-skills`. */
    name: string;
    /** Its version, checked against other plugins' `dependsOn`. */
    version?: string;
    /** One sentence saying what it adds. */
    description?: string;
    /** Plugins this one needs, with semver ranges. Sous stops before any intent runs when one is missing. */
    dependsOn?: Readonly<Record<string, string>>;
    /** The default `before` of every contributor it adds. */
    before?: readonly string[];
    /** The default `after` of every contributor it adds. */
    after?: readonly string[];
    /**
     * Service and intent names this plugin's contract declares for other plugins to implement
     * (`compiler.namespace-resolver`). Another plugin registering one is expected, so sous does not
     * warn that it starts with this plugin's prefix.
     */
    implementable?: readonly string[];
    /** Runs once, when the plugin loads during config building. */
    register(sous: Sous): void | Promise<void>;
}

/**
 * Declares a plugin. It only gives the definition its type.
 *
 * ```ts
 * export default definePlugin({
 *     name: "sous-plugin-diagrams",
 *     version: "1.0.0",
 *     dependsOn: { "@sous-io/plugin-skills": "^1.0.0" },
 *
 *     register(sous) {
 *         sous.intents.add({ intent: "diagrams.render", handle: async () => ({ rendered: 0 }) });
 *     },
 * });
 * ```
 */
export function definePlugin<const T extends PluginDefinition>(definition: T): T {
    return definition;
}

/** A front end: the CLI, the MCP server, a web GUI. */
export interface FrontEndDefinition {
    /** `cli`, `mcp`, `web`. */
    id: string;
    /** Takes over after the config is built: turns its input into submitted chains. */
    start(engine: EngineHandle, argv: readonly string[]): void | Promise<void>;
}

/** `sous.intents`. */
export interface IntentRegistry {
    /** Adds an intent. Two plugins adding one name is an error naming both, unless `intents.replace` picks one. */
    add<const N extends string, S extends SousSchema = SousSchema>(definition: IntentDefinition<N, S>): void;
    /** Wraps an intent's handler. */
    wrap<N extends string>(intent: N, wrapper: IntentWrapper<IntentInputOf<N, unknown>, IntentResult<N>>): void;
}

/** `sous.services`. */
export interface ServiceRegistry extends ServiceReader {
    /** Adds a service with a lifetime. */
    add<N extends ServiceName>(name: N, factory: ServiceFactory<ServiceType<N>>, options?: ServiceOptions): void;
    /** Wraps a service. Wrappers stack in plugin order. */
    wrap<N extends ServiceName>(name: N, wrapper: ServiceWrapper<ServiceType<N>>): void;
    /**
     * Replaces a service. Two plugins replacing one is an error, unless the config picks one
     * (`services.replace."<name>": "<plugin>"`); sous then warns on every run.
     */
    replace<N extends ServiceName>(name: N, factory: ServiceFactory<ServiceType<N>>, options?: ServiceOptions): void;
}

/** `sous.entities`. */
export interface EntityRegistry extends EntityReader {
    /** Defines a kind, with the schema every entry is checked against. */
    define(kind: string, schema: SousSchema, options?: EntityKindOptions): void;
    /**
     * Adds an entity whose existence does not depend on the config.
 *
 * An entity's methods must not use `this`: the engine stores a copy of each entry (its schema
 * check and its method timing make one), so `this` is not the object the plugin made. Close over
 * what a method needs instead:
 *
 * ```ts
 * const root = ".codex";
 *
 * sous.entities.add("skill-target", {
 *     id: "codex",
 *     directory: () => root,          // not `() => this.root`
 * });
 * ```
     */
    add<K extends EntityKind>(kind: K, entry: EntityType<K>): void;
}

/**
 * What `register(sous)` receives: everything a plugin uses, scoped to that plugin, so every
 * registration is recorded with it.
 */
export interface Sous {
    /** The plugin registering. */
    readonly plugin: { readonly name: string; readonly version: string | undefined };
    readonly project: ProjectInfo | undefined;
    readonly env: Environment;
    /** The engine's reporter, for messages outside any chain. */
    readonly reporter: Reporter;
    /** The engine, as front ends and background intents use it. */
    readonly engine: EngineHandle;

    readonly config: {
        /** Adds a contributor. */
        contribute(definition: ContributorDefinition): void;
    };
    readonly intents: IntentRegistry;
    readonly services: ServiceRegistry;
    readonly entities: EntityRegistry;
    readonly plugins: {
        /** Brings in another plugin as this one's own dependency; users may still disable it by name. */
        add(plugin: PluginDefinition | string): Promise<void>;
    };
    readonly frontEnds: {
        /** Adds a front end. */
        add(definition: FrontEndDefinition): void;
    };

    /** Listens for an event by name, wildcard or regular expression. */
    on<const P extends EventPattern>(pattern: P, listener: Listener<EventForPattern<P>>, options?: ListenerOptions): void;
    /** Listens once, then removes itself. */
    once<const P extends EventPattern>(pattern: P, listener: Listener<EventForPattern<P>>, options?: ListenerOptions): void;
    /** Removes a listener added with the same pattern. */
    off(pattern: EventPattern, listener: Listener<never>): void;
    /** Fires an event and waits for every listener. */
    emit<N extends string>(name: N, payload?: EventPayload<N>): Promise<EventFor<N>>;
}
