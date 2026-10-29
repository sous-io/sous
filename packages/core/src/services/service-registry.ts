import { ConflictError, type ServiceFactory, type ServiceLifetime, type ServiceWrapper } from "@sous-io/plugin-api";

/** One way to make a service: an `add` or a `replace`. */
export interface ServiceProvider {
    readonly name: string;
    readonly factory: ServiceFactory<unknown>;
    readonly lifetime: ServiceLifetime;
    readonly plugin: string;
    readonly replaces: boolean;
}

/** One wrapper of a service. */
export interface ServiceWrapperEntry {
    readonly name: string;
    readonly wrapper: ServiceWrapper<unknown>;
    readonly plugin: string;
    readonly seq: number;
}

/** What the config picks: `services.replace."<name>": "<plugin>"`. */
export type ServicePicks = Readonly<Record<string, string>>;

/** The provider chosen for a service, and any warning the choice needs. */
export interface ServiceChoice {
    readonly provider: ServiceProvider;
    /** Set when the config picked among several; sous warns on every run (S1). */
    readonly warning?: string;
}

/**
 * Every service, wrapper and replacement plugins registered (S1, "Services"). Which one is used
 * depends on the plugins active in a config, and on what its `services.replace` picks.
 */
export class ServiceRegistry {
    private readonly providers = new Map<string, ServiceProvider[]>();
    private readonly wrappers: ServiceWrapperEntry[] = [];
    private seq = 0;

    constructor(private readonly pluginIndex: (plugin: string) => number) {}

    /** Adds a provider. */
    addProvider(provider: ServiceProvider): void {
        const list = this.providers.get(provider.name) ?? [];

        list.push(provider);
        this.providers.set(provider.name, list);
    }

    /** Adds a wrapper. */
    addWrapper(name: string, wrapper: ServiceWrapper<unknown>, plugin: string): void {
        this.wrappers.push({ name, wrapper, plugin, seq: this.seq++ });
    }

    /** Every service name with a provider. */
    names(): string[] {
        return [...this.providers.keys()];
    }

    /** Whether an active plugin provides a service. */
    has(name: string, isActive: (plugin: string) => boolean): boolean {
        return (this.providers.get(name) ?? []).some((provider) => isActive(provider.plugin));
    }

    /**
     * Chooses the provider of a service: a replacement over the original, and when two plugins
     * replace it (or two add it), the one the config picks. Throws a `ConflictError` naming both
     * when the config picks none. Returns `undefined` when no active plugin provides it.
     */
    choose(name: string, isActive: (plugin: string) => boolean, picks: ServicePicks): ServiceChoice | undefined {
        const active = (this.providers.get(name) ?? []).filter((provider) => isActive(provider.plugin));
        const replacements = active.filter((provider) => provider.replaces);
        const candidates = replacements.length > 0 ? replacements : active;

        if (candidates.length === 0) {
            return undefined;
        }

        const plugins = unique(candidates.map((provider) => provider.plugin));

        if (plugins.length === 1) {
            return { provider: candidates[candidates.length - 1]! };
        }

        const picked = picks[name];
        const chosen = picked === undefined ? undefined : candidates.filter((provider) => provider.plugin === picked).at(-1);
        const verb = replacements.length > 0 ? "replace" : "add";

        if (!chosen) {
            const listed = plugins.join(" and ");

            throw new ConflictError(name, plugins, `Two plugins ${verb} "${name}": ${listed}.`, {
                details: [`Choose one in the config:  services.replace."${name}": "${plugins[0]}"`],
            });
        }

        const ignored = plugins.filter((plugin) => plugin !== chosen.plugin);
        const others = ignored.map((plugin) => `${plugin}'s`).join(" and ");

        return {
            provider: chosen,
            warning:
                `services.replace picks ${chosen.plugin} for "${name}". ` +
                `${others} ${verb === "replace" ? "replacement" : "service"} is ignored, ` +
                `and ${ignored.length === 1 ? "the plugin" : "those plugins"} may not work as expected.`,
        };
    }

    /** The wrappers of a service from active plugins, in plugin order. */
    wrappersFor(name: string, isActive: (plugin: string) => boolean): ServiceWrapperEntry[] {
        return this.wrappers
            .filter((entry) => entry.name === name && isActive(entry.plugin))
            .sort((a, b) => this.pluginIndex(a.plugin) - this.pluginIndex(b.plugin) || a.seq - b.seq);
    }
}

function unique<T>(items: T[]): T[] {
    return [...new Set(items)];
}
