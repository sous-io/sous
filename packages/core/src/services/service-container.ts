import {
    type BuiltConfig,
    type Environment,
    type EntityReader,
    NotFoundError,
    type ProjectInfo,
    type ServiceContext,
    type ServiceReader,
    SousError,
} from "@sous-io/plugin-api";
import type { Timer } from "../timing/timer.js";
import type { ServicePicks, ServiceRegistry, ServiceProvider } from "./service-registry.js";
import { timeService } from "./timed.js";

/** What every container of one engine shares. */
export interface ServiceHost {
    readonly registry: ServiceRegistry;
    readonly timer: Timer;
    /** Singletons, shared by every config: one per service and providing plugin. */
    readonly singletons: Map<string, unknown>;
    readonly project: ProjectInfo | undefined;
    readonly env: Environment;
    /** The engine's working directory. */
    readonly cwd: string;
    /** Whether the real config is being built right now. */
    building(): boolean;
}

/** What one container is for: a built config. */
export interface ServiceScope {
    readonly config: BuiltConfig & { readonly isActive: (plugin: string) => boolean; readonly servicePicks: ServicePicks };
    readonly entities: EntityReader;
}

/**
 * The services of one built config: `config` services are made once for it,
 * `singleton` ones once for the process, `factory` ones on every get. Every object is made on first
 * use, wrapped by every active wrapper in plugin order, and has its method calls timed.
 */
export class ServiceContainer implements ServiceReader {
    private readonly perConfig = new Map<string, unknown>();
    private readonly creating = new Set<string>();

    constructor(
        private readonly host: ServiceHost,
        private readonly scope: ServiceScope,
    ) {}

    has(name: string): boolean {
        return this.host.registry.has(name, this.scope.config.isActive);
    }

    get<N extends string>(name: N): never {
        const choice = this.host.registry.choose(name, this.scope.config.isActive, this.scope.config.servicePicks);

        if (!choice) {
            throw new NotFoundError("service", name);
        }

        const { provider } = choice;

        switch (provider.lifetime) {
            case "singleton": {
                const key = `${name}\u0000${provider.plugin}`;

                if (!this.host.singletons.has(key)) {
                    this.host.singletons.set(key, this.create(provider));
                }

                return this.host.singletons.get(key) as never;
            }
            case "config": {
                this.refuseWhileBuilding(provider);

                if (!this.perConfig.has(name)) {
                    this.perConfig.set(name, this.create(provider));
                }

                return this.perConfig.get(name) as never;
            }
            case "factory":
                this.refuseWhileBuilding(provider);

                return this.create(provider) as never;
        }
    }

    private refuseWhileBuilding(provider: ServiceProvider): void {
        if (this.host.building()) {
            throw new SousError(
                `The service "${provider.name}" lives per config build (${provider.lifetime}), so it cannot be used while the config is being built.`,
                { details: ["Only singleton services can be used by contributors."] },
            );
        }
    }

    private create(provider: ServiceProvider): unknown {
        if (this.creating.has(provider.name)) {
            throw new SousError(`The service "${provider.name}" needs itself to be made (a cycle of services).`, {
                details: [[...this.creating, provider.name].join(" → ")],
            });
        }

        this.creating.add(provider.name);

        try {
            const context = (plugin: string): ServiceContext => ({
                plugin,
                config: this.scope.config,
                services: this,
                entities: this.scope.entities,
                project: this.host.project,
                env: this.host.env,
                cwd: this.host.cwd,
            });

            let instance = this.host.timer.measure("service.create", provider.name, provider.plugin, () =>
                provider.factory(this.scope.config, context(provider.plugin)),
            );

            for (const entry of this.host.registry.wrappersFor(provider.name, this.scope.config.isActive)) {
                instance = entry.wrapper(instance, context(entry.plugin));
            }

            return timeService(instance, provider.name, provider.plugin, this.host.timer);
        } finally {
            this.creating.delete(provider.name);
        }
    }
}
