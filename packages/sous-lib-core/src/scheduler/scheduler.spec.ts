import { describe, expect, it } from "vitest";
import { Scheduler } from "./scheduler.js";

describe("Scheduler", () => {
    /**
     * It reports whether it is idle and whether a rebuild is due, and rebuilds before the next chain
     * after a chain changed the config.
     */
    it("should track idleness and rebuild before the next chain", async () => {
        const log: string[] = [];
        const scheduler = new Scheduler(async () => void log.push("rebuild"));

        expect(scheduler.idle).toBe(true);
        expect(scheduler.needsRebuild).toBe(false);

        const first = scheduler.enqueue(false, async (markChanged) => {
            log.push("first");
            markChanged();

            return 1;
        });

        expect(scheduler.idle).toBe(false);
        expect(await first).toBe(1);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(scheduler.needsRebuild).toBe(true);
        expect(await scheduler.enqueue(true, async () => (log.push("second"), 2))).toBe(2);
        expect(log).toEqual(["first", "rebuild", "second"]);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(scheduler.idle).toBe(true);
        await expect(scheduler.enqueue(false, async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    });

    /**
     * A chain marked dirty while parallel chains still run waits for them before the rebuild.
     */
    it("should wait for running chains before rebuilding", async () => {
        const log: string[] = [];
        const scheduler = new Scheduler(async () => void log.push("rebuild"));
        let release!: () => void;
        const slow = scheduler.enqueue(true, () => new Promise<void>((resolve) => (release = resolve)).then(() => void log.push("slow")));

        await new Promise((resolve) => setTimeout(resolve, 1));
        scheduler.markDirty();

        const next = scheduler.enqueue(false, async () => void log.push("next"));

        await new Promise((resolve) => setTimeout(resolve, 1));
        expect(log).toEqual([]);
        release();
        await Promise.all([slow, next]);
        expect(log).toEqual(["slow", "rebuild", "next"]);
    });
});
