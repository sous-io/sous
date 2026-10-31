import { describe, expect, it } from "vitest";
import type { BuildPrepareResult } from "../src/types.js";
import { isLocked } from "../src/prepare.js";
import { harness, locked, plugin } from "./helpers.js";

describe("build.prepare", () => {
    /**
     * A switched-on subscription the lockfile does not pin yet is locked, keeping every pin there
     * is, and the config is marked changed so the next chain sees it.
     *
     * subscriptions: { acme: {} }, lockfile empty; // -> locked.added [acme/jira 1.0.0]
     */
    it("should lock a new subscription and mark the config changed", async () => {
        const h = await harness({
            world: (world) => {
                world.config = { subscriptions: { acme: {} } };
                world.published = { "acme/jira": { repo: "acme", namespace: "acme", version: "1.0.0" } };
            },
        });
        const before = h.engine.config.buildNumber;
        const result = await h.run<BuildPrepareResult>("build.prepare", { offline: true });

        expect(result.locked.added).toEqual([{ key: "acme/jira", to: "1.0.0" }]);
        expect(h.world.lockfile.recipes["acme/jira"]?.version).toBe("1.0.0");
        expect(h.world.resolveCalls[0]).toEqual({ keep: {} });

        await h.run("build.prepare", { offline: true });
        expect(h.engine.config.buildNumber).toBeGreaterThan(before);
    });

    /**
     * A switched-off subscription is not locked, and a locked one is not resolved again.
     *
     * subscriptions: { off: { enabled: false }, acme: {} } with acme/jira pinned; // -> no resolve
     */
    it("should leave switched-off and already locked subscriptions alone", async () => {
        const h = await harness({
            world: (world) => {
                world.config = { subscriptions: { off: { enabled: false }, acme: {} } };
                world.lockfile = { formatVersion: 1, repos: {}, recipes: { "acme/jira": locked("1.0.0") } } as never;
            },
        });
        const result = await h.run<BuildPrepareResult>("build.prepare", { offline: true });

        expect(result.locked.unchanged).toBe(true);
        expect(h.world.resolveCalls).toEqual([]);
        expect(h.world.lockWrites).toEqual([]);
    });

    /**
     * What the store is missing is restored; skipped recipes and unanswered variables are listed;
     * active core recipes count as seeded; `build.prepared` fires with the result.
     *
     * build.prepare; // -> { restored: ["acme/jira"], skipped: [...], seeded: ["core/sous"] }
     */
    it("should restore, list skipped recipes and fire build.prepared", async () => {
        const events: unknown[] = [];
        const h = await harness({
            world: (world) => {
                world.lockfile = { formatVersion: 1, repos: {}, recipes: { "acme/jira": locked("1.0.0") } } as never;
                world.restoreReport = { restored: ["acme/jira"], alreadyPresent: [], failed: [] };
                world.skipped = [{ key: "acme/off", reason: "subscription-disabled", message: "" }];
                world.active = [{ id: "core/sous", source: "core" } as never, { id: "acme/jira", source: "store" } as never];
            },
            extra: [plugin("listener", (sous) => sous.on("build.prepared", (event) => void events.push(event.payload)))],
        });
        const result = await h.run<BuildPrepareResult>("build.prepare", { offline: true });

        expect(events).toEqual([result]);
        expect(result.restored.restored).toEqual(["acme/jira"]);
        expect(result.skipped.map((skipped) => skipped.key)).toEqual(["acme/off"]);
        expect(result.seeded).toEqual(["core/sous"]);
        expect(h.world.restoreCalls).toEqual([{}]);
        expect(h.world.indexCalls).toBe(0);
    });

    /**
     * Upstream: a newer in-range version is reported, not installed, unless the repository or the
     * subscription prefers newer versions, which moves the pin and restores it.
     *
     * acme/jira pinned 1.0.0, 1.2.0 published; // -> newer [{ from: "1.0.0", to: "1.2.0" }]
     * with repos.acme.alwaysPull;              // -> locked.updated, restore { keys: ["acme/jira"] }
     */
    it("should report newer versions, and move the ones that prefer them", async () => {
        const setUp = (alwaysPull: boolean) =>
            harness({
                world: (world) => {
                    world.config = { subscriptions: { acme: {} }, repos: { acme: { url: "https://x", alwaysPull } } };
                    world.lockfile = { formatVersion: 1, repos: {}, recipes: { "acme/jira": locked("1.0.0") } } as never;
                    world.published = { "acme/jira": { repo: "acme", namespace: "acme", version: "1.2.0" } };
                    world.indexes = { indexes: [{ repo: "acme", source: "network" } as never], failed: [] };
                },
            });

        const reported = await setUp(false);
        const report = await reported.run<BuildPrepareResult>("build.prepare");

        expect(report.newer).toEqual([{ key: "acme/jira", from: "1.0.0", to: "1.2.0" }]);
        expect(report.checkedUpstream).toBe(true);
        expect(report.locked.unchanged).toBe(true);

        const moving = await setUp(true);
        const moved = await moving.run<BuildPrepareResult>("build.prepare");

        expect(moved.newer).toEqual([]);
        expect(moved.locked.updated).toEqual([{ key: "acme/jira", from: "1.0.0", to: "1.2.0" }]);
        expect(moving.world.restoreCalls).toEqual([{}, { keys: ["acme/jira"] }]);
    });

    /**
     * A repository that could not be read is a warning, never a failure.
     *
     * getAll -> failed [{ repo: "acme" }]; // -> warning "Sous could not check the repository 'acme'..."
     */
    it("should warn about an upstream check that failed and go on", async () => {
        const h = await harness({
            world: (world) => {
                world.lockfile = { formatVersion: 1, repos: {}, recipes: { "acme/jira": locked("1.0.0") } } as never;
                world.indexes = { indexes: [], failed: [{ repo: "acme", attempts: [{ strategy: "http", reason: "403" }], fixes: [] }] };
            },
        });
        const result = await h.run<BuildPrepareResult>("build.prepare");

        expect(result.checkedUpstream).toBe(false);
        expect(h.reporter.at("warning").join("\n")).toContain("Sous could not check the repository 'acme' for a newer version");
    });
});

describe("isLocked()", () => {
    const lockfile = (recipes: Record<string, ReturnType<typeof locked>>) => ({ formatVersion: 1, repos: {}, recipes }) as never;

    /**
     * A recipe subscription is locked when its key is pinned for the project within range; a
     * namespace when every pin under it is.
     *
     * isLocked("acme/jira", { range: "^1" }, { "acme/jira": 1.4.0 }); // -> true
     */
    it("should check the pin, its holder and its range", () => {
        expect(isLocked("acme/jira", {}, lockfile({ "acme/jira": locked("1.4.0") }))).toBe(true);
        expect(isLocked("acme/jira", { range: "^2" }, lockfile({ "acme/jira": locked("1.4.0") }))).toBe(false);
        expect(isLocked("acme", { range: "^1" }, lockfile({ "acme/jira": locked("1.4.0"), "acme/x": locked("1.0.0") }))).toBe(true);
        expect(isLocked("acme", {}, lockfile({ "other/x": locked("1.0.0") }))).toBe(false);
        expect(isLocked("acme/jira", {}, lockfile({ "acme/jira": { ...locked("1.0.0"), requestedBy: ["acme/base"] } }))).toBe(false);
    });
});
