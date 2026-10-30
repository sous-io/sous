import {
    ConflictError,
    type IntentDefinition,
    type IntentHandler,
    type IntentInfo,
    type IntentWrapper,
    SousError,
} from "@sous-io/plugin-api";

/** One registered intent. */
export interface IntentEntry extends IntentInfo {
    readonly seq: number;
}

/** One registered wrapper. */
export interface IntentWrapperEntry {
    readonly intent: string;
    readonly wrapper: IntentWrapper;
    readonly plugin: string;
    readonly seq: number;
}

/** What the config picks: `intents.replace."<intent>": "<plugin>"`. */
export type IntentPicks = Readonly<Record<string, string>>;

/**
 * Every intent and wrapper plugins registered. Which one runs depends on the plugins
 * active in the config, and on what `intents.replace` picks when two plugins add one name.
 */
export class IntentRegistry {
    private readonly entries: IntentEntry[] = [];
    private readonly wrappers: IntentWrapperEntry[] = [];
    private readonly handlers = new WeakMap<IntentDefinition, Promise<IntentHandler>>();
    private seq = 0;

    constructor(private readonly pluginIndex: (plugin: string) => number) {}

    /** Adds an intent. */
    add(definition: IntentDefinition, plugin: string): void {
        if (typeof definition?.intent !== "string" || definition.intent === "") {
            throw new SousError(`${plugin} added an intent without a name.`);
        }

        if (!definition.handle === !definition.load) {
            throw new SousError(`${plugin}'s intent "${definition.intent}" needs exactly one of handle and load.`);
        }

        this.entries.push({ definition, plugin, seq: this.seq++ });
    }

    /** Adds a wrapper. */
    wrap(intent: string, wrapper: IntentWrapper, plugin: string): void {
        this.wrappers.push({ intent, wrapper, plugin, seq: this.seq++ });
    }

    /** Every active intent, one per name, in plugin order. Throws on unresolved conflicts. */
    list(isActive: (plugin: string) => boolean, picks: IntentPicks): IntentEntry[] {
        const names = [...new Set(this.entries.filter((entry) => isActive(entry.plugin)).map((entry) => entry.definition.intent))];

        return names
            .map((name) => this.resolve(name, isActive, picks)!.entry)
            .sort((a, b) => this.pluginIndex(a.plugin) - this.pluginIndex(b.plugin) || a.seq - b.seq);
    }

    /**
     * The intent that runs for a name. When two active plugins add it, the config picks one
     * (`intents.replace`), and the choice comes with a warning; otherwise it is a `ConflictError`.
     */
    resolve(
        name: string,
        isActive: (plugin: string) => boolean,
        picks: IntentPicks,
    ): { entry: IntentEntry; warning?: string } | undefined {
        const candidates = this.entries.filter((entry) => entry.definition.intent === name && isActive(entry.plugin));

        if (candidates.length === 0) {
            return undefined;
        }

        const plugins = [...new Set(candidates.map((entry) => entry.plugin))];

        if (plugins.length === 1) {
            return { entry: candidates[candidates.length - 1]! };
        }

        const picked = picks[name];
        const chosen = candidates.filter((entry) => entry.plugin === picked).at(-1);

        if (!chosen) {
            throw new ConflictError(name, plugins, `Two plugins add the intent "${name}": ${plugins.join(" and ")}.`, {
                details: [`Choose one in the config:  intents.replace."${name}": "${plugins[0]}"`],
            });
        }

        const ignored = plugins.filter((plugin) => plugin !== chosen.plugin).join(" and ");

        return {
            entry: chosen,
            warning: `intents.replace picks ${chosen.plugin} for "${name}". ${ignored}'s intent is ignored, and may not work as expected.`,
        };
    }

    /** The names of every intent registered, active or not. */
    allNames(): string[] {
        return [...new Set(this.entries.map((entry) => entry.definition.intent))];
    }

    /** The wrappers of an intent from active plugins, in plugin order. */
    wrappersFor(name: string, isActive: (plugin: string) => boolean): IntentWrapperEntry[] {
        return this.wrappers
            .filter((entry) => entry.intent === name && isActive(entry.plugin))
            .sort((a, b) => this.pluginIndex(a.plugin) - this.pluginIndex(b.plugin) || a.seq - b.seq);
    }

    /** The handler of an intent, importing it the first time when it is given as `load`. */
    handlerOf(definition: IntentDefinition): Promise<IntentHandler> {
        let handler = this.handlers.get(definition);

        if (!handler) {
            handler = definition.handle
                ? Promise.resolve(definition.handle as IntentHandler)
                : definition.load!().then((loaded) => toHandler(definition.intent, loaded));
            this.handlers.set(definition, handler);
        }

        return handler;
    }
}

function toHandler(intent: string, loaded: unknown): IntentHandler {
    if (typeof loaded === "function") {
        return loaded as IntentHandler;
    }

    const module = loaded as { default?: unknown; handle?: unknown } | null;
    const handler = module?.handle ?? module?.default;

    if (typeof handler !== "function") {
        throw new SousError(`The handler module of "${intent}" exports no handler (default or handle).`);
    }

    return handler as IntentHandler;
}
