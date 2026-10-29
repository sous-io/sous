/** One chain waiting to run, or running. */
interface QueuedChain {
    readonly parallel: boolean;
    /** Runs the chain; resolves with whether it changed the config. Never rejects. */
    start(): Promise<boolean>;
    /** Fails the chain without running it. */
    fail(error: unknown): void;
}

/**
 * Runs chains (S1, "Chains and the Scheduler"):
 *
 * 1. in series by default: each one finishes before the next starts;
 * 2. chains declared parallel may run together;
 * 3. when a series chain is waiting, no new chain starts until it has run (the queue is first in,
 *    first out), so a stream of parallel chains never holds it back;
 * 4. after a series chain that changed the config, the config is rebuilt before the next chain
 *    starts. A running chain keeps the config it started with.
 */
export class Scheduler {
    private readonly queue: QueuedChain[] = [];
    private readonly running = new Set<QueuedChain>();
    private dirty = false;
    private rebuilding = false;

    /** @param rebuild Rebuilds the config; called only while no chain runs. */
    constructor(private readonly rebuild: () => Promise<void>) {}

    /** Whether nothing is running, waiting or rebuilding. */
    get idle(): boolean {
        return this.queue.length === 0 && this.running.size === 0 && !this.rebuilding;
    }

    /** Whether the config must be rebuilt before the next chain starts. */
    get needsRebuild(): boolean {
        return this.dirty;
    }

    /** Says the config must be rebuilt before the next chain starts. */
    markDirty(): void {
        this.dirty = true;
    }

    /**
     * Queues a chain. `run` starts when the chain's turn comes, and calls `markChanged` when the chain
     * changed the config. The returned promise settles with `run`'s result.
     */
    enqueue<T>(parallel: boolean, run: (markChanged: () => void) => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.queue.push({
                parallel,
                async start() {
                    let changed = false;

                    try {
                        resolve(await run(() => (changed = true)));
                    } catch (error) {
                        reject(error);
                    }

                    return changed;
                },
                fail: reject,
            });
            this.pump();
        });
    }

    private pump(): void {
        while (this.queue.length > 0 && !this.rebuilding) {
            if (this.dirty) {
                if (this.running.size === 0) {
                    this.startRebuild();
                }

                return;
            }

            const head = this.queue[0]!;
            const seriesRunning = [...this.running].some((chain) => !chain.parallel);

            if (seriesRunning || (!head.parallel && this.running.size > 0)) {
                return;
            }

            this.queue.shift();
            this.running.add(head);
            void head.start().then((changed) => {
                this.running.delete(head);

                if (changed) {
                    this.dirty = true;
                }

                this.pump();
            });
        }
    }

    private startRebuild(): void {
        this.rebuilding = true;
        this.dirty = false;

        this.rebuild().then(
            () => {
                this.rebuilding = false;
                this.pump();
            },
            (error: unknown) => {
                // The chain waiting for the rebuild fails with its error; later chains try again.
                this.rebuilding = false;
                this.dirty = true;
                this.queue.shift()?.fail(error);
                this.pump();
            },
        );
    }
}
