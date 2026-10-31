import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createEngine, DEFAULT_LIMITS } from "../src/index.js";
import { contributorsPlugin, keysPlugin, makeEngine, nothing, plugin, valued } from "./helpers.js";

describe("the engine handle", () => {
    /**
     * Plugins and front ends see the engine through its handle: the latest config, the app, the
     * intents, timings, the reporter, submit, what-if builds, the plugins and background waiting
     *.
     */
    it("should expose the engine to plugins and front ends", async () => {
        let handleSeen: import("@sous-io/plugin-api").EngineHandle | undefined;
        const { engine } = makeEngine(
            [
                plugin("plugin-cli", (sous) => {
                    handleSeen = sous.engine;
                    sous.intents.add({ intent: "version", summary: "Print the version", handle: (_input, ctx) => valued(ctx.engine.app.version) });
                    sous.frontEnds.add({
                        id: "cli",
                        async start(engine, argv) {
                            const result = await engine.submit({ intent: argv[0]! });

                            engine.reporter.notice(`result ${String(result.toPlain().value)}`);
                        },
                    });
                }),
            ],
            { app: { name: "sous", version: "1.0.0" } },
        );

        expect(engine.config.buildNumber).toBe(0);
        expect(engine.config.entities.list("config-key").map((key) => key.id)).toEqual(["plugins", "services", "intents", "budgets", "limits"]);

        await engine.buildConfig();
        await engine.frontEnd("cli").start(["version"]);

        const handle = handleSeen!;

        expect(handle).toBe(engine.handle);
        expect(handle.config).toBe(engine.config);
        expect(handle.intents.list().map((info) => [info.definition.intent, info.plugin])).toEqual([["version", "plugin-cli"]]);
        expect(engine.intentCatalog.get("version")?.definition.summary).toBe("Print the version");
        expect((await handle.submit({ intent: "version" })).toPlain()).toEqual({ value: "1.0.0" });
        expect(handle.timings.get("intent:version")?.count).toBe(2);
        expect(handle.plugins().map((info) => info.name)).toEqual(["plugin-cli"]);
        await expect(handle.whenBackgroundIntentsReturn()).resolves.toBeUndefined();
        expect(engine.frontEnd("cli").plugin).toBe("plugin-cli");
    });

    /**
     * The intent list is empty, not an error, while an unresolved intent conflict exists.
     */
    it("should list no intents while two plugins claim one", () => {
        const engine = createEngine({});

        expect(engine.handle.intents.list()).toEqual([]);
        expect(engine.handle.intents.get("x")).toBeUndefined();
    });

    /**
     * sous.services reaches the current config's services after the build; sous.plugins.add takes a
     * specifier too.
     */
    it("should reach services and load plugins by specifier from plugin code", async () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), "sous-core-handle-"));

        writeFileSync(
            path.join(dir, "child.mjs"),
            `export default { name: "child-plugin", register(sous) { sous.config.contribute({ id: "child", contribute: (c) => c.atPath("x").set("child") }); } };\n`,
        );

        try {
            let getService: (() => unknown) | undefined;
            const { engine } = makeEngine(
                [
                    keysPlugin("x"),
                    plugin("parent", async (sous) => {
                        await sous.plugins.add("./child.mjs");
                        sous.services.add("parent.svc", () => "svc");
                        getService = () => [sous.services.get("parent.svc"), sous.services.has("parent.svc")];
                    }),
                ],
                { cwd: dir },
            );
            const built = await engine.buildConfig();

            expect(built.get("x")).toBe("child");
            expect(getService!()).toEqual(["svc", true]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    /**
     * An intent that changes the config run from a background intent marks the config for a rebuild
     * before the next chain, as does ctx.configChanged outside a chain.
     */
    it("should rebuild after a config change outside any chain", async () => {
        let value = 1;
        let changeOutside: (() => Promise<unknown>) | undefined;
        const { engine } = makeEngine([
            keysPlugin("value"),
            plugin("p", (sous) => {
                sous.config.contribute({ id: "v", contribute: (config) => config.atPath("value").set(value) });
                sous.intents.add({ intent: "p.serve", background: true, handle: async () => valued("served") });
                sous.intents.add({ intent: "p.write", background: true, changesConfig: true, handle: () => ((value = 2), nothing()) });
                sous.intents.add({ intent: "p.read", handle: (_input, ctx) => valued(ctx.config.get("value")) });
                sous.on("p.outside", (_event, ctx) => {
                    value = 3;
                    ctx.configChanged();
                });
                changeOutside = () => sous.emit("p.outside", {});
            }),
        ]);

        await engine.buildConfig();

        expect((await engine.submit({ intent: "p.serve" })).toPlain()).toEqual({ value: "served" });
        await engine.submit({ intent: "p.write" });
        expect((await engine.submit({ intent: "p.read" })).toPlain()).toEqual({ value: 2 });
        await changeOutside!();
        expect((await engine.submit({ intent: "p.read" })).toPlain()).toEqual({ value: 3 });
    });

    /**
     * The default limits are the default table: 10, 5, 32, 2 and 5, with 10 config passes.
     */
    it("should start from the default limits table", () => {
        expect(DEFAULT_LIMITS).toEqual({
            configPasses: 10,
            rebuildsChanging: 10,
            rebuildsRepeating: 5,
            runDepth: 32,
            sameIntentDepth: 2,
            eventDepth: 5,
        });
    });

    /**
     * A contributor's id is unique; contributors need an id, a contribute function and a numeric stage.
     */
    it("should refuse duplicate and malformed contributors", async () => {
        const build = (definition: object) =>
            makeEngine([plugin("p", (sous) => sous.config.contribute(definition as never))]).engine.buildConfig();

        await expect(
            makeEngine([contributorsPlugin("a", [{ id: "same", contribute() {} }]), contributorsPlugin("b", [{ id: "same", contribute() {} }])]).engine.buildConfig(),
        ).rejects.toThrow('Two contributors are named "same": one from a, one from b.');
        await expect(build({ contribute() {} })).rejects.toThrow("p added a contributor without an id.");
        await expect(build({ id: "x" })).rejects.toThrow("p's contributor \"x\" has no contribute function.");
        await expect(build({ id: "x", stage: Number.NaN, contribute() {} })).rejects.toThrow("declares a stage that is not a number");
    });
});
