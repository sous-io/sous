import type { Timers } from "../src/watch/watcher.js";

/** Timers that fire only when told. */
export class ManualTimers implements Timers {
    private next = 0;
    readonly pending = new Map<number, () => void>();

    setTimeout(callback: () => void): unknown {
        const id = ++this.next;

        this.pending.set(id, callback);

        return id;
    }

    clearTimeout(handle: unknown): void {
        this.pending.delete(handle as number);
    }

    /** Fires everything pending. */
    fire(): void {
        const callbacks = [...this.pending.values()];

        this.pending.clear();
        callbacks.forEach((callback) => callback());
    }
}
