import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BuildResult, BuildWatchResult } from "../src/types.js";
import type { SignalSource } from "../src/watch/intent.js";
import type { WatchSession } from "../src/watch/session.js";
import type { WatcherFactory } from "../src/watch/watcher.js";
import { harness, plugin, target, type World } from "./helpers.js";
import { ManualTimers } from "./timers.js";

/** One started fake watcher. */
interface FakeWatcher {
    paths: readonly string[];
    emit(event: string, file: string): void;
    closed: boolean;
}

/** Everything a watch test drives. */
function watchRig() {
    const watchers: FakeWatcher[] = [];
    const timers = new ManualTimers();
    const emitter = new EventEmitter();
    const sessions: WatchSession[] = [];
    const createWatcher: WatcherFactory = async (paths, _options, onEvent) => {
        const watcher: FakeWatcher = { paths, emit: onEvent, closed: false };

        watchers.push(watcher);

        return {
            close: async () => {
                watcher.closed = true;
            },
        };
    };
    const signals: SignalSource = {
        on: (signal, listener) => void emitter.on(signal, listener),
        off: (signal, listener) => void emitter.off(signal, listener),
    };

    return {
        watchers,
        timers,
        emitter,
        sessions,
        options: { createWatcher, signals, timers, onWatchSession: (session: WatchSession) => void sessions.push(session) },
        /** The watcher running now. */
        current: () => watchers.at(-1)!,
    };
}

const sources = (world: World, root: string) => {
    world.config = {
        compilation: { targets: [target({ entryPoint: path.join(root, "prompts", "AGENTS.md") }), target({ entryGlob: "${projectRoot}/skills/**/*.md" })] },
        watch: { paths: ["${projectRoot}/extra"], pollSeconds: 0 },
    };
};

/** Starts `build.watch` on a harness and waits for its first watcher. */
async function startWatch(input: Record<string, unknown> = {}, setUp?: (world: World, root: string) => void) {
    const rig = watchRig();
    let root = "";
    const h = await harness({
        plugin: rig.options,
        world: (world) => {
            root = path.dirname(path.dirname(world.statePath));
            (setUp ?? sources)(world, root);
        },
    });
    const done = h.engine.submit({ intent: "build.watch", input }, { reporter: h.reporter }) as Promise<BuildWatchResult>;

    await vi.waitFor(() => expect(rig.sessions).toHaveLength(1));

    return { ...rig, h, root, done, session: rig.sessions[0]! };
}

describe("build.watch (C13)", () => {
    /**
     * Watch mode watches the targets' sources, `watch.paths`, the config and `conf.d`, and records
     * its PID.
     *
     * build.watch; // -> watcher on [<root>/prompts/AGENTS.md, <root>/skills, <config>, <conf.d>, <root>/extra]
     */
    it("should watch the sources, the config and watch.paths, and write the PID file", async () => {
        const { current, root, h, session, done } = await startWatch();

        expect(current().paths).toEqual([
            path.join(root, "prompts", "AGENTS.md"),
            path.join(root, "skills"),
            h.project.configPath,
            h.project.confDir,
            path.join(root, "extra"),
        ]);
        expect(readFileSync(path.join(h.project.sousDir, "sous.pid"), "utf8")).toBe(String(process.pid));

        await session.stop();
        expect(await done).toEqual({ builds: 0, failed: 0, stoppedBy: "closed" });
        expect(existsSync(path.join(h.project.sousDir, "sous.pid"))).toBe(false);
    });

    /**
     * A source change submits a partial `build` chain after the debounce, and fires
     * `build.files-changed`.
     *
     * change <root>/prompts/AGENTS.md; // -> compiler.compile { changedFiles: [that file] }
     */
    it("should submit a partial build for a changed source", async () => {
        const { current, timers, root, h, session, done } = await startWatch({ strict: true });
        const file = path.join(root, "prompts", "AGENTS.md");

        current().emit("change", file);
        current().emit("change", path.join(root, "skills", "a", "SKILL.md"));
        timers.fire();

        await vi.waitFor(() => expect(h.world.compileCalls).toHaveLength(1));
        expect(h.world.compileCalls[0]).toEqual({ strict: true, changedFiles: [file, path.join(root, "skills", "a", "SKILL.md")] });
        expect(h.world.resolveCalls).toEqual([]);
        expect(h.reporter.at("notice").join("\n")).toContain(`Change detected: ${file}`);

        await session.stop();
        expect((await done).builds).toBe(1);
    });

    /**
     * A config change is a full rebuild: the watcher stops, the config is rebuilt before the build
     * chain, and the watcher restarts on the new config.
     *
     * change <conf.d>/610-mac.jsonc; // -> new config build, full build, a second watcher
     */
    it("should rebuild the config and restart the watcher on a config change", async () => {
        const { current, watchers, timers, h, session, done } = await startWatch();
        const before = h.engine.config.buildNumber;

        current().emit("add", path.join(h.project.confDir, "610-mac.jsonc"));
        timers.fire();

        await vi.waitFor(() => expect(watchers).toHaveLength(2));
        expect(watchers[0]!.closed).toBe(true);
        expect(h.engine.config.buildNumber).toBeGreaterThan(before);
        expect(h.world.compileCalls).toEqual([{}]);
        expect(h.reporter.at("notice").join("\n")).toContain("Config changed (");

        await session.stop();
        await done;
    });

    /**
     * A failing build is counted and reported; the watch keeps going.
     *
     * compile throws; // -> "Rebuild failed: ..."; result.failed 1
     */
    it("should keep watching after a build fails", async () => {
        const { current, timers, root, h, session, done } = await startWatch();

        h.world.compileResult = () => {
            throw new Error("template exploded");
        };
        current().emit("change", path.join(root, "prompts", "AGENTS.md"));
        timers.fire();

        await vi.waitFor(() => expect(h.reporter.at("error").join("\n")).toContain("Rebuild failed: template exploded"));

        await session.stop();
        expect(await done).toMatchObject({ builds: 1, failed: 1 });
    });

    /**
     * SIGINT or SIGTERM stops the watcher and removes the PID file.
     *
     * process emits SIGTERM; // -> { stoppedBy: "signal" }
     */
    it("should stop on a signal", async () => {
        const { emitter, current, h, done } = await startWatch();

        emitter.emit("SIGTERM");
        expect(await done).toMatchObject({ stoppedBy: "signal" });
        expect(current().closed).toBe(true);
        expect(existsSync(path.join(h.project.sousDir, "sous.pid"))).toBe(false);
        await h.engine.whenBackgroundIntentsReturn();
    });

    /**
     * Polling upstream runs `build.prepare`; when it moves a pin, a full rebuild follows.
     *
     * poll() with an always-pull repository moved to 1.2.0; // -> a full build chain
     */
    it("should rebuild when polling upstream moves a pin", async () => {
        const { h, session, done } = await startWatch({ pollSeconds: 60 }, (world, root) => {
            sources(world, root);
            world.config = { ...world.config, subscriptions: { acme: {} }, repos: { acme: { url: "x", alwaysPull: true } } };
            world.lockfile = { formatVersion: 1, repos: {}, recipes: { "acme/jira": { repo: "acme", version: "1.0.0", hash: "h", requestedBy: ["project"], kind: "subscribes" } } } as never;
            world.published = { "acme/jira": { repo: "acme", namespace: "acme", version: "1.2.0" } };
        });

        expect(session.pollSeconds()).toBe(60);
        await session.poll();

        await vi.waitFor(() => expect(h.world.compileCalls).toHaveLength(1));
        expect(h.reporter.at("notice").join("\n")).toContain("A newer recipe version arrived upstream.\n  acme/jira moved from 1.0.0 to 1.2.0.");

        await session.stop();
        await done;
    });

    /**
     * `compile --watch` submits `compile` chains, and never polls.
     *
     * build.watch { compileOnly: true }; // -> compile chains, pollSeconds 0
     */
    it("should submit compile chains when compileOnly", async () => {
        const { current, timers, root, h, session, done } = await startWatch({ compileOnly: true, pollSeconds: 30 });

        expect(session.pollSeconds()).toBe(0);
        current().emit("change", path.join(root, "prompts", "AGENTS.md"));
        timers.fire();

        await vi.waitFor(() => expect(h.world.compileCalls).toHaveLength(1));
        expect(h.world.pruneCalls).toEqual([]);

        await session.stop();
        await done;
    });
});

describe("build --watch", () => {
    /**
     * `build --watch` builds once, then starts `build.watch` in the background; the build's
     * result comes back at once with `watching: true`.
     *
     * sous build --watch; // -> { ok: true, watching: true }, then a watcher
     */
    it("should build, then start watch mode in the background", async () => {
        const rig = watchRig();
        const h = await harness({ plugin: rig.options, world: (world) => sources(world, path.dirname(path.dirname(world.statePath))) });
        const result = await h.run<BuildResult>("build", { watch: true, noPrune: true });

        expect(result).toMatchObject({ ok: true, watching: true });
        await vi.waitFor(() => expect(rig.sessions).toHaveLength(1));

        await rig.sessions[0]!.stop();
        await h.engine.whenBackgroundIntentsReturn();
    });

    /**
     * A second watcher on the same project fails, naming the one running.
     *
     * build.watch while another live PID is recorded; // -> "A watcher is already running..."
     */
    it("should refuse a second watcher", async () => {
        const rig = watchRig();
        const h = await harness({ plugin: { ...rig.options, isProcessAlive: () => true }, extra: [plugin("noop", () => {})] });

        h.engine.config.services.get("build.pid").write(4242);
        await expect(h.engine.submit({ intent: "build.watch", input: {} })).rejects.toThrow(/already running .*\(PID 4242\)/u);
    });
});
