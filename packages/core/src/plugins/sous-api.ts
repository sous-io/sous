import type {
    ContributorDefinition,
    EngineHandle,
    EntityKind,
    EntityKindOptions,
    EntityRegistry as EntityRegistryApi,
    EntityType,
    Environment,
    EventPattern,
    FrontEndDefinition,
    IntentDefinition,
    IntentRegistry as IntentRegistryApi,
    IntentWrapper,
    Listener,
    ListenerOptions,
    PluginDefinition,
    ProjectInfo,
    Reporter,
    ServiceFactory,
    ServiceOptions,
    ServiceRegistry as ServiceRegistryApi,
    ServiceWrapper,
    Sous,
    SousSchema,
} from "@sous-io/plugin-api";
import type { EntitySnapshot } from "../entities/entity-registry.js";
import type { PluginRecord } from "./plugin-registry.js";

/** What the `sous` object of a plugin needs from the engine. */
export interface SousApiHost {
    readonly handle: EngineHandle;
    readonly project: ProjectInfo | undefined;
    readonly env: Environment;
    readonly reporter: Reporter;
    addContributor(definition: ContributorDefinition, record: PluginRecord): void;
    addIntent(definition: IntentDefinition, record: PluginRecord): void;
    wrapIntent(intent: string, wrapper: IntentWrapper, record: PluginRecord): void;
    addService(name: string, factory: ServiceFactory<unknown>, options: ServiceOptions, replaces: boolean, record: PluginRecord): void;
    wrapService(name: string, wrapper: ServiceWrapper<unknown>, record: PluginRecord): void;
    getService(name: string): unknown;
    hasService(name: string): boolean;
    defineEntityKind(kind: string, schema: SousSchema, options: EntityKindOptions, record: PluginRecord): void;
    addEntity(kind: string, entry: unknown, record: PluginRecord): void;
    /** The entities plugins read directly; warns when a contributor reads them (S2, rule 6). */
    entitiesForDirectRead(record: PluginRecord): EntitySnapshot;
    addPlugin(source: PluginDefinition | string, record: PluginRecord): Promise<void>;
    addFrontEnd(definition: FrontEndDefinition, record: PluginRecord): void;
    listen(pattern: EventPattern, listener: Listener<never>, options: ListenerOptions & { once?: boolean }, record: PluginRecord): void;
    unlisten(pattern: EventPattern, listener: Listener<never>): void;
    emit(name: string, payload: unknown, record: PluginRecord): Promise<unknown>;
}

/**
 * The `sous` object a plugin's `register()` receives: the engine, scoped to that plugin, so every
 * registration is recorded with it (S1, "Visibility").
 */
export function createSousApi(host: SousApiHost, record: PluginRecord): Sous {
    const note = (kind: string, name: string): void => {
        record.registrations.push({ kind, name });
    };

    const intents: IntentRegistryApi = {
        add(definition) {
            host.addIntent(definition as IntentDefinition, record);
            note("intent", definition.intent);
        },
        wrap(intent, wrapper) {
            host.wrapIntent(intent, wrapper as IntentWrapper, record);
            note("intent wrapper", intent);
        },
    };

    const services: ServiceRegistryApi = {
        add(name, factory, options = {}) {
            host.addService(name, factory as ServiceFactory<unknown>, options, false, record);
            note("service", name);
        },
        replace(name, factory, options = {}) {
            host.addService(name, factory as ServiceFactory<unknown>, options, true, record);
            note("service replacement", name);
        },
        wrap(name, wrapper) {
            host.wrapService(name, wrapper as ServiceWrapper<unknown>, record);
            note("service wrapper", name);
        },
        get: ((name: string) => host.getService(name)) as ServiceRegistryApi["get"],
        has: (name) => host.hasService(name),
    };

    const entities: EntityRegistryApi = {
        define(kind, schema, options = {}) {
            host.defineEntityKind(kind, schema, options, record);
            note("entity kind", kind);
        },
        add<K extends EntityKind>(kind: K, entry: EntityType<K>) {
            host.addEntity(kind, entry, record);
            note("entity", `${kind}: ${(entry as { id?: string }).id}`);
        },
        get: (kind, id) => host.entitiesForDirectRead(record).get(kind, id),
        list: (kind) => host.entitiesForDirectRead(record).list(kind),
        has: (kind, id) => host.entitiesForDirectRead(record).has(kind, id),
        describe: (kind) => host.entitiesForDirectRead(record).describe(kind),
        kinds: () => host.entitiesForDirectRead(record).kinds(),
    };

    return {
        plugin: { name: record.name, version: record.version },
        get project() {
            return host.project;
        },
        env: host.env,
        // Read live: the front end swaps the engine's reporter in after the plugins register.
        get reporter() {
            return host.reporter;
        },
        engine: host.handle,
        config: {
            contribute(definition) {
                host.addContributor(definition, record);
                note("contributor", definition.id);
            },
        },
        intents,
        services,
        entities,
        plugins: {
            async add(source) {
                await host.addPlugin(source, record);
            },
        },
        frontEnds: {
            add(definition) {
                host.addFrontEnd(definition, record);
                note("front end", definition.id);
            },
        },
        on(pattern, listener, options = {}) {
            host.listen(pattern, listener as Listener<never>, options, record);
            note("listener", String(pattern));
        },
        once(pattern, listener, options = {}) {
            host.listen(pattern, listener as Listener<never>, { ...options, once: true }, record);
            note("listener", String(pattern));
        },
        off(pattern, listener) {
            host.unlisten(pattern, listener);
        },
        emit: ((name: string, payload?: unknown) => host.emit(name, payload, record)) as Sous["emit"],
    };
}
