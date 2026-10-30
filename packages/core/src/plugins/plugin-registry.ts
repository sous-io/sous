import { type PluginDefinition, PluginError } from "@sous-io/plugin-api";
import { CORE_PLUGIN } from "../util/names.js";

/** One loaded plugin. Its code stays in memory for the life of the process. */
export interface PluginRecord {
    readonly name: string;
    readonly version: string | undefined;
    readonly definition: PluginDefinition;
    readonly builtIn: boolean;
    /** The specifier it was loaded under, when it came from `plugins.load`. */
    readonly specifier: string | undefined;
    /** The plugin that brought it in with `sous.plugins.add`, if any. */
    readonly loadedBy: string | undefined;
    /** Its place in plugin order. */
    readonly index: number;
    /** Plugins it brought in as its own dependencies. */
    readonly children: string[];
    /** What it registered, for `plugins show`. */
    readonly registrations: Array<{ kind: string; name: string }>;
}

/** How a plugin source becomes a definition, and what to do when one is new. */
export interface LoadHooks {
    /** Turns a specifier into a plugin definition. */
    resolve(specifier: string): Promise<PluginDefinition>;
    /** Runs a newly loaded plugin's `register()`. */
    register(record: PluginRecord): Promise<void>;
}

/**
 * Every plugin loaded in this process, in plugin order. A plugin is loaded and
 * registered once; whether it is active is decided per config build.
 */
export class PluginRegistry {
    private readonly records = new Map<string, PluginRecord>();
    private readonly specifiers = new Map<string, string>();
    private readonly pending = new Map<string, Promise<PluginRecord>>();
    private readonly duplicateWarnings: string[] = [];

    /** A loaded plugin, by name. */
    get(name: string): PluginRecord | undefined {
        return this.records.get(name);
    }

    /** The plugin loaded under a specifier, if any. */
    bySpecifier(specifier: string): PluginRecord | undefined {
        const name = this.specifiers.get(specifier);

        return name === undefined ? undefined : this.records.get(name);
    }

    /** Every loaded plugin, in plugin order. */
    list(): PluginRecord[] {
        return [...this.records.values()];
    }

    /** A plugin's place in plugin order: core first, then plugins as they loaded. */
    index(name: string): number {
        if (name === CORE_PLUGIN) {
            return -1;
        }

        return this.records.get(name)?.index ?? Number.MAX_SAFE_INTEGER;
    }

    /** Warnings about two modules with one plugin name, since the last call. */
    takeDuplicateWarnings(): string[] {
        return this.duplicateWarnings.splice(0);
    }

    /**
     * Loads a plugin from a definition or a specifier, and registers it once. Loading one already
     * loaded returns the loaded one; a second module with an already loaded name is ignored, with a
     * warning.
     */
    async load(
        source: PluginDefinition | string,
        options: { builtIn: boolean; loadedBy: string | undefined; specifier?: string },
        hooks: LoadHooks,
    ): Promise<PluginRecord> {
        if (typeof source === "string") {
            const known = this.bySpecifier(source) ?? this.records.get(source);

            if (known) {
                return known;
            }

            let loading = this.pending.get(source);

            if (!loading) {
                loading = hooks.resolve(source).then((definition) => this.addDefinition(definition, source, options, hooks));
                this.pending.set(source, loading);
            }

            try {
                return await loading;
            } finally {
                this.pending.delete(source);
            }
        }

        return this.addDefinition(source, options.specifier, options, hooks);
    }

    private async addDefinition(
        definition: PluginDefinition,
        specifier: string | undefined,
        options: { builtIn: boolean; loadedBy: string | undefined },
        hooks: LoadHooks,
    ): Promise<PluginRecord> {
        checkDefinition(definition, specifier);

        const existing = this.records.get(definition.name);

        if (existing) {
            if (existing.definition !== definition) {
                const where = specifier ? ` (from "${specifier}")` : "";

                this.duplicateWarnings.push(
                    `Two modules are named ${definition.name}${where}; the one loaded first is used.`,
                );
            }

            if (specifier) {
                this.specifiers.set(specifier, existing.name);
            }

            return existing;
        }

        const record: PluginRecord = {
            name: definition.name,
            version: definition.version,
            definition,
            builtIn: options.builtIn,
            specifier,
            loadedBy: options.loadedBy,
            index: this.records.size,
            children: [],
            registrations: [],
        };

        this.records.set(record.name, record);

        if (specifier) {
            this.specifiers.set(specifier, record.name);
        }

        await hooks.register(record);

        return record;
    }
}

/** Takes the plugin definition out of an imported module: its default export, or `plugin`. */
export function definitionFromModule(module: unknown, specifier: string): PluginDefinition {
    const candidate = (module as { default?: unknown; plugin?: unknown } | null) ?? {};
    const definition = isDefinition(candidate) ? candidate : (candidate.default ?? candidate.plugin);

    if (!isDefinition(definition)) {
        throw new PluginError(specifier, `"${specifier}" does not export a sous plugin.`, {
            details: ["A plugin module's default export is the object definePlugin() returns."],
        });
    }

    return definition;
}

function isDefinition(value: unknown): value is PluginDefinition {
    const definition = value as Partial<PluginDefinition> | null;

    return typeof definition?.name === "string" && typeof definition.register === "function";
}

function checkDefinition(definition: PluginDefinition, specifier: string | undefined): void {
    if (!isDefinition(definition)) {
        const what = specifier ? `"${specifier}"` : "A built-in plugin";

        throw new PluginError(specifier ?? "(unnamed)", `${what} is not a sous plugin: it needs a name and a register function.`);
    }
}
