import type { EventPattern, ListenerOptions } from "@sous-io/plugin-api";
import { matchesWildcard } from "../util/names.js";
import type { BaseEvent } from "./event-objects.js";

/** A listener function as the bus stores it. */
export type StoredListenerFn = (event: BaseEvent, ...rest: never[]) => unknown;

/** One registered listener. */
export interface ListenerEntry {
    readonly pattern: EventPattern;
    readonly fn: StoredListenerFn;
    readonly plugin: string;
    readonly priority: number;
    readonly once: boolean;
    /** Registration order, across the whole engine. */
    readonly seq: number;
}

/**
 * Holds every listener and finds, for an event name, the listeners that match it, in order:
 * priority (higher first), then plugin order, then the order they were added (S1, "Events").
 *
 * Running listeners is the engine's job; the bus only stores and orders them.
 */
export class EventBus {
    private readonly listeners: ListenerEntry[] = [];
    private readonly cache = new Map<string, ListenerEntry[]>();
    private seq = 0;

    constructor(private readonly pluginIndex: (plugin: string) => number) {}

    /** Adds a listener. */
    add(pattern: EventPattern, fn: StoredListenerFn, plugin: string, options: ListenerOptions & { once?: boolean } = {}): void {
        this.listeners.push({
            pattern,
            fn,
            plugin,
            priority: options.priority ?? 0,
            once: options.once ?? false,
            seq: this.seq++,
        });
        this.cache.clear();
    }

    /** Removes a listener added with the same pattern and function. Returns whether one was removed. */
    remove(pattern: EventPattern, fn: unknown): boolean {
        const index = this.listeners.findIndex((entry) => entry.fn === fn && samePattern(entry.pattern, pattern));

        if (index === -1) {
            return false;
        }

        this.listeners.splice(index, 1);
        this.cache.clear();

        return true;
    }

    /** Removes one exact entry (used for `once`). */
    removeEntry(entry: ListenerEntry): void {
        const index = this.listeners.indexOf(entry);

        if (index !== -1) {
            this.listeners.splice(index, 1);
            this.cache.clear();
        }
    }

    /** The listeners for an event name, in the order they run. */
    matching(name: string): readonly ListenerEntry[] {
        let found = this.cache.get(name);

        if (!found) {
            found = this.listeners
                .filter((entry) => matchesPattern(entry.pattern, name))
                .sort((a, b) => b.priority - a.priority || this.pluginIndex(a.plugin) - this.pluginIndex(b.plugin) || a.seq - b.seq);
            this.cache.set(name, found);
        }

        return found;
    }

    /** Every listener, for `plugins show`. */
    all(): readonly ListenerEntry[] {
        return this.listeners;
    }
}

/** Whether a pattern matches an event name. */
export function matchesPattern(pattern: EventPattern, name: string): boolean {
    if (typeof pattern === "string") {
        return matchesWildcard(pattern, name);
    }

    pattern.lastIndex = 0;

    return pattern.test(name);
}

function samePattern(a: EventPattern, b: EventPattern): boolean {
    if (typeof a === "string" || typeof b === "string") {
        return a === b;
    }

    return a.source === b.source && a.flags === b.flags;
}
