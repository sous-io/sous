import path from "node:path";
import { describe, expect, it } from "vitest";
import type { WatchBatch } from "../src/types.js";
import type { WatcherFactory } from "../src/watch/watcher.js";
import { entry, harness, target } from "./helpers.js";
import { ManualTimers } from "./timers.js";

/** A fake file watcher and the timers, for one harness. */
function rig() {
    const timers = new ManualTimers();
    const started: Array<{ paths: readonly string[]; emit: (event: string, file: string) => void; closed: boolean; onError?: (error: unknown) => void }> = [];
    const createWatcher: WatcherFactory = async (paths, options, onEvent) => {
        const watcher = { paths, emit: onEvent, closed: false, ...(options.onError ? { onError: options.onError } : {}) };

        started.push(watcher);

        return {
            close: async () => {
                watcher.closed = true;
            },
        };
    };

    return { timers, started, options: { createWatcher, timers } };
}

/** A harness whose config has one source, one recipe target, one `watch.paths` entry and one recorded output. */
async function watcherHarness() {
    const r = rig();
    let root = "";
    const h = await harness({
        plugin: r.options,
        world: (world) => {
            root = path.dirname(path.dirname(world.statePath));
            world.config = {
                compilation: {
                    targets: [
                        target({ entryPoint: path.join(root, "prompts", "AGENTS.md") }),
                        target({ entryPoint: path.join(root, "store", "acme", "jira", "SKILL.md"), origin: { recipe: "acme/jira" } }),
                    ],
                },
                watch: { paths: ["${projectRoot}/extra"], debounceMs: 50 },
            };
            world.state.files = [entry(path.join(root, "AGENTS.md"))];
        },
    });

    return { ...r, h, root, service: h.engine.config.services.get("build.watcher") };
}

describe("build.watcher", () => {
    /**
     * By default the service watches the sources, the config, `conf.d` and `watch.paths`; with
     * `outputs`, `recipes` and `extra` it adds the recorded outputs, the recipe targets' sources and
     * the caller's paths.
     *
     * watch({ outputs: true, recipes: true, extra: ["partials"] }); // -> outputs and store files watched too
     */
    it("should watch the sources and config by default, and outputs, recipes and extra on request", async () => {
        const { service, started, root, h } = await watcherHarness();
        const plain = service.watch({}, () => {});

        await plain.ready;
        expect(started[0]!.paths).toEqual([path.join(root, "prompts", "AGENTS.md"), h.project.configPath, h.project.confDir, path.join(root, "extra")]);
        await plain.close();

        const full = service.watch({ outputs: true, recipes: true, extra: ["partials"] }, () => {});

        await full.ready;
        expect(full.watching).toMatchObject({
            files: [path.join(root, "prompts", "AGENTS.md"), path.join(root, "store", "acme", "jira", "SKILL.md")],
            extra: [path.join(root, "partials")],
            outputs: [path.join(root, "AGENTS.md")],
            ignored: [path.join(h.project.sousDir, "sous.pid"), h.world.statePath],
        });
        expect(started[1]!.paths).toContain(path.join(root, "AGENTS.md"));
        await full.close();
    });

    /**
     * Events become one debounced batch saying which paths were added, changed and removed, and
     * what kind of path each was. The state file never shows up.
     *
     * change a source, add a conf.d file, remove an output; fire(); // -> one batch, sources, config and outputs all true
     */
    it("should call back with each debounced batch", async () => {
        const { service, started, timers, root, h } = await watcherHarness();
        const batches: WatchBatch[] = [];
        const handle = service.watch({ outputs: true }, (batch) => batches.push(batch));

        await handle.ready;

        const watcher = started[0]!;

        watcher.emit("change", path.join(root, "prompts", "AGENTS.md"));
        watcher.emit("add", path.join(h.project.confDir, "610-mac.jsonc"));
        watcher.emit("unlink", path.join(root, "AGENTS.md"));
        watcher.emit("change", h.world.statePath);
        watcher.emit("change", path.join(root, "README.md"));
        timers.fire();

        expect(batches).toEqual([
            {
                files: [path.join(root, "prompts", "AGENTS.md"), path.join(h.project.confDir, "610-mac.jsonc"), path.join(root, "AGENTS.md")],
                changed: [path.join(root, "prompts", "AGENTS.md")],
                added: [path.join(h.project.confDir, "610-mac.jsonc")],
                removed: [path.join(root, "AGENTS.md")],
                sources: true,
                config: true,
                outputs: true,
            },
        ]);
        await handle.close();
    });

    /**
     * Aborting the signal closes the file watcher and drops what was pending; closing twice is
     * harmless.
     *
     * controller.abort(); // -> watcher closed, no batch
     */
    it("should close on abort and drop pending changes", async () => {
        const { service, started, timers, root } = await watcherHarness();
        const controller = new AbortController();
        const batches: WatchBatch[] = [];
        const handle = service.watch({ signal: controller.signal }, (batch) => batches.push(batch));

        await handle.ready;
        started[0]!.emit("change", path.join(root, "prompts", "AGENTS.md"));
        controller.abort();
        await handle.close();
        started[0]!.emit("change", path.join(root, "prompts", "AGENTS.md"));
        timers.fire();

        expect(started[0]!.closed).toBe(true);
        expect(batches).toEqual([]);
    });

    /**
     * File watcher errors go to `onError`; the service prints nothing (L3).
     *
     * watcher reports an error; // -> onError(error)
     */
    it("should pass file watcher errors to onError", async () => {
        const { service, started } = await watcherHarness();
        const errors: unknown[] = [];
        const handle = service.watch({ onError: (error) => errors.push(error) }, () => {});

        await handle.ready;
        started[0]!.onError?.(new Error("EMFILE"));
        expect(errors).toEqual([new Error("EMFILE")]);
        await handle.close();
    });
});
