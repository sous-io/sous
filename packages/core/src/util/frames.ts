import { stableKey } from "./stable.js";

/**
 * The path of calls that led somewhere: every `ctx.run` and every event passes through the engine,
 * so a loop report can show the whole path.
 */
export interface Frame {
    readonly kind: "intent" | "event" | "listener" | "chain";
    /** The intent or event name, or the listening plugin. */
    readonly name: string;
    /** For intents: the input, as a stable key, to find a call with the same input. */
    readonly inputKey?: string;
    readonly parent: Frame | undefined;
}

/** A new frame on top of a parent. */
export function pushFrame(parent: Frame | undefined, kind: Frame["kind"], name: string, input?: unknown): Frame {
    return kind === "intent"
        ? { kind, name, inputKey: stableKey(input), parent }
        : { kind, name, parent };
}

/** The frames from the outermost to this one. */
export function framePath(frame: Frame | undefined): Frame[] {
    const path: Frame[] = [];

    for (let current = frame; current; current = current.parent) {
        path.unshift(current);
    }

    return path;
}

/** How many frames of a kind are in the path, optionally with one name and input. */
export function countFrames(frame: Frame | undefined, kind: Frame["kind"], name?: string, inputKey?: string): number {
    let count = 0;

    for (let current = frame; current; current = current.parent) {
        if (current.kind !== kind) {
            continue;
        }

        if (name !== undefined && current.name !== name) {
            continue;
        }

        if (inputKey !== undefined && current.inputKey !== inputKey) {
            continue;
        }

        count += 1;
    }

    return count;
}

/**
 * The path as one line: `config.built → sous-plugin-foo listener → intent "subscription.enable" ({"enabled":true})`.
 */
export function describeFramePath(frame: Frame | undefined): string {
    return framePath(frame)
        .map((item) => {
            switch (item.kind) {
                case "intent":
                    return item.inputKey && item.inputKey !== "{}" && item.inputKey !== "undefined"
                        ? `intent "${item.name}" (${item.inputKey})`
                        : `intent "${item.name}"`;
                case "listener":
                    return `${item.name} listener`;
                case "chain":
                    return `chain ${item.name}`;
                default:
                    return item.name;
            }
        })
        .join(" → ");
}
