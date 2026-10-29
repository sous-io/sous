import type { BuiltConfig, ConfigReader } from "./config.js";
import type { Environment, ProjectInfo } from "./context.js";
import type { EntityReader } from "./entities.js";
import type { ServiceName, ServiceType } from "./registry.js";

/**
 * How long one service object lives (S1, "Services"):
 * - `singleton`: one for the whole process, for services that never look at the config;
 * - `config`: one per config build, shared by every chain using that config;
 * - `factory`: a new one on every get.
 */
export type ServiceLifetime = "singleton" | "config" | "factory";

/** What a service factory and a service wrapper get besides the config. */
export interface ServiceContext {
    /** The plugin whose factory or wrapper this is. */
    readonly plugin: string;
    /** The config this object is made for. A singleton gets the config of its first use. */
    readonly config: BuiltConfig;
    /** Other services, for the same config. */
    readonly services: ServiceReader;
    readonly entities: EntityReader;
    readonly project: ProjectInfo | undefined;
    readonly env: Environment;
}

/** Makes a service object. */
export type ServiceFactory<T> = (config: ConfigReader, ctx: ServiceContext) => T;

/** Wraps a service object. Wrappers stack in plugin order, the last plugin's outermost. */
export type ServiceWrapper<T> = (inner: T, ctx: ServiceContext) => T;

/** Options for adding or replacing a service. */
export interface ServiceOptions {
    /** Default `config`. */
    lifetime?: ServiceLifetime;
}

/** Reading services. */
export interface ServiceReader {
    /** The service, created on first use. Throws `NotFoundError` when no plugin provides it. */
    get<N extends ServiceName>(name: N): ServiceType<N>;
    /** Whether an active plugin provides it. */
    has(name: string): boolean;
}
