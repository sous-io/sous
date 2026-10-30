import { type ContributorDefinition, SousError } from "@sous-io/plugin-api";

/** A contributor, with the plugin that added it and its resolved order declarations. */
export interface ContributorEntry {
    readonly id: string;
    readonly plugin: string;
    readonly definition: ContributorDefinition;
    /** The stage it declares, before any shift. */
    readonly declaredStage: number;
    readonly before: readonly string[];
    readonly after: readonly string[];
    /** True for the extra contributors of a "what if" build. */
    readonly extra: boolean;
}

/** Every contributor plugins added. */
export class ContributorRegistry {
    private readonly entries = new Map<string, ContributorEntry>();

    /** Adds a contributor. Its `before` and `after` default to its plugin's. */
    add(definition: ContributorDefinition, plugin: string, defaults: { before?: readonly string[]; after?: readonly string[] }): void {
        const existing = this.entries.get(definition.id);

        if (existing) {
            throw new SousError(
                `Two contributors are named "${definition.id}": one from ${existing.plugin}, one from ${plugin}.`,
            );
        }

        this.entries.set(definition.id, toEntry(definition, plugin, defaults, false));
    }

    /** Every contributor of an active plugin. */
    active(isActive: (plugin: string) => boolean): ContributorEntry[] {
        return [...this.entries.values()].filter((entry) => isActive(entry.plugin));
    }

    /** The number of contributors ever added. */
    get size(): number {
        return this.entries.size;
    }
}

/** Builds the entry of a contributor. */
export function toEntry(
    definition: ContributorDefinition,
    plugin: string,
    defaults: { before?: readonly string[]; after?: readonly string[] },
    extra: boolean,
): ContributorEntry {
    if (typeof definition?.id !== "string" || definition.id === "") {
        throw new SousError(`${plugin} added a contributor without an id.`);
    }

    if (typeof definition.contribute !== "function") {
        throw new SousError(`${plugin}'s contributor "${definition.id}" has no contribute function.`);
    }

    const stage = definition.stage ?? 0;

    if (!Number.isFinite(stage)) {
        throw new SousError(`${plugin}'s contributor "${definition.id}" declares a stage that is not a number.`);
    }

    return {
        id: definition.id,
        plugin,
        definition,
        declaredStage: stage,
        before: definition.before ?? defaults.before ?? [],
        after: definition.after ?? defaults.after ?? [],
        extra,
    };
}
