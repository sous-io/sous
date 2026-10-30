import { describe, expect, it } from "vitest";
import { ConfigError, LoopError, type PatchSet } from "@sous-io/plugin-api";
import { deserializePatchSet, parsePatchFile, serializePatchSet } from "@sous-io/documents";
import { contributorsPlugin, keysPlugin, makeEngine, plugin, userKeys } from "./helpers.js";

describe("the config loop", () => {
    /**
     * A contributor is given the config made from every other contributor's latest patch, never its
     * own, and may read its own previous patch set.
     *
     * a sets x=1; b reads x and sets y=x+1; a sees only y, never its own x.
     */
    it("should give each contributor the others' latest patches without its own", async () => {
        const seenByA: unknown[] = [];
        const previous: Array<PatchSet | undefined> = [];
        const { engine } = makeEngine([
            keysPlugin("x", "y"),
            contributorsPlugin("p", [
                {
                    id: "a",
                    contribute(config) {
                        seenByA.push(config.root().get());
                        previous.push(config.previousPatches());
                        config.atPath("x").set(1);
                    },
                },
                {
                    id: "b",
                    contribute(config) {
                        config.atPath("y").set((config.atPath("x").valueOr(0) as number) + 1);
                    },
                },
            ]),
        ]);

        const built = await engine.buildConfig();

        expect(userKeys(built.value())).toEqual({ x: 1, y: 2 });
        expect(seenByA[0]).toEqual({});
        expect(previous[0]).toBeUndefined();
    });

    /**
     * Patches are applied from an empty config on every pass, each contributor's latest once, so an
     * append is never doubled however often the contributor re-runs.
     */
    it("should never double an append when a contributor re-runs", async () => {
        let runs = 0;
        const { engine } = makeEngine([
            keysPlugin("list", "flag"),
            contributorsPlugin("p", [
                {
                    id: "a-appender",
                    contribute(config) {
                        runs += 1;
                        config.atPath("flag").get();
                        config.atPath("list").append("item");
                    },
                },
                { id: "b-flagger", contribute: (config) => config.atPath("flag").set(true) },
            ]),
        ]);

        const built = await engine.buildConfig();

        expect(runs).toBe(2);
        expect(built.get("list")).toEqual(["item"]);
        // Patches apply in the sorted order; a re-run does not move a contributor.
        expect(built.contributions().map((c) => c.contributor)).toEqual(["a-appender", "b-flagger"]);
    });

    /**
     * A contributor re-runs only when a key it read has changed since its last run; the others keep
     * their stored patches.
     */
    it("should re-run a contributor only when a key it read changed", async () => {
        const runs: Record<string, number> = { reader: 0, other: 0 };
        const { engine } = makeEngine([
            keysPlugin("a", "b", "c"),
            contributorsPlugin("p", [
                {
                    id: "1-reader",
                    contribute(config) {
                        runs.reader += 1;
                        config.atPath("b").get();
                        config.atPath("c").set("from reader");
                    },
                },
                {
                    id: "2-other",
                    contribute(config) {
                        runs.other += 1;
                        config.atPath("a").get();
                        config.atPath("b").set("from other");
                    },
                },
            ]),
        ]);

        const built = await engine.buildConfig();

        expect(runs).toEqual({ reader: 2, other: 1 });
        expect(built.passes).toBe(2);
    });

    /**
     * A config whose contributors read nothing that later changes settles after one pass that does
     * work.
     */
    it("should settle in one working pass when nothing read changes", async () => {
        const { engine } = makeEngine([
            keysPlugin("a", "b"),
            contributorsPlugin("p", [
                { id: "a", contribute: (config) => config.atPath("a").set(1) },
                { id: "b", contribute: (config) => config.atPath("b").set(config.atPath("a").get()) },
            ]),
        ]);

        const built = await engine.buildConfig();

        expect(built.passes).toBe(1);
        expect(userKeys(built.value())).toEqual({ a: 1, b: 1 });
    });

    /**
     * `monitors` watches more than a contributor reads: a path, or an entity kind.
     */
    it("should re-run a contributor when something it monitors changes", async () => {
        let runs = 0;
        const { engine } = makeEngine([
            keysPlugin("watched", "out"),
            plugin("p", (sous) => {
                sous.entities.define("thing", { "~standard": { version: 1, vendor: "t", validate: (value) => ({ value }) } });
                sous.config.contribute({
                    id: "1-watcher",
                    monitors: ["watched", { entities: "thing" }],
                    contribute(config) {
                        runs += 1;
                        config.atPath("out").set(runs);
                    },
                });
                sous.config.contribute({ id: "2-writer", contribute: (config) => config.atPath("watched").set(true) });
                sous.config.contribute({ id: "3-adder", contribute: (config) => config.addEntity("thing", { id: "t1" }) });
            }),
        ]);

        const built = await engine.buildConfig();

        expect(runs).toBe(2);
        expect(built.get("out")).toBe(2);
    });

    /**
     * A contributor reading the entity list re-runs when the list changes; a contributor reading one
     * entity re-runs only when that entity changes, not when another id appears.
     */
    it("should re-run list readers on any change but narrow readers only for their own id", async () => {
        const runs = { list: 0, narrow: 0 };
        const { engine } = makeEngine([
            keysPlugin("count", "has"),
            plugin("p", (sous) => {
                sous.entities.define("skill-target", { "~standard": { version: 1, vendor: "t", validate: (value) => ({ value }) } });
                sous.entities.add("skill-target", { id: "claude-code" });
                sous.config.contribute({
                    id: "1-list",
                    contribute(config) {
                        runs.list += 1;
                        config.atPath("count").set(config.entities("skill-target").length);
                    },
                });
                sous.config.contribute({
                    id: "1-narrow",
                    contribute(config) {
                        runs.narrow += 1;
                        config.atPath("has").set(config.entity("skill-target", "claude-code") !== undefined);
                    },
                });
                sous.config.contribute({ id: "2-adder", contribute: (config) => config.addEntity("skill-target", { id: "codex" }) });
            }),
        ]);

        const built = await engine.buildConfig();

        expect(built.get("count")).toBe(2);
        expect(built.get("has")).toBe(true);
        expect(runs).toEqual({ list: 2, narrow: 1 });
        expect(built.entities.list("skill-target").map((e) => e.id)).toEqual(["claude-code", "codex"]);
    });

    /**
     * An entity that keeps its id but changes its data re-runs its readers, list and narrow alike;
     * functions are not compared.
     */
    it("should re-run entity readers when an entity with the same id changes", async () => {
        const runs = { list: 0, narrow: 0 };
        const { engine } = makeEngine([
            keysPlugin("dir", "dirs", "mode"),
            plugin("p", (sous) => {
                sous.entities.define("skill-target", { "~standard": { version: 1, vendor: "t", validate: (value) => ({ value }) } });
                sous.config.contribute({
                    id: "1-list",
                    contribute(config) {
                        runs.list += 1;
                        config.atPath("dirs").set(config.entities("skill-target").map((target) => (target as unknown as { dir: string }).dir));
                    },
                });
                sous.config.contribute({
                    id: "1-narrow",
                    contribute(config) {
                        runs.narrow += 1;
                        config.atPath("dir").set((config.entity("skill-target", "codex") as unknown as { dir?: string } | undefined)?.dir ?? "none");
                    },
                });
                sous.config.contribute({
                    id: "2-adder",
                    contribute(config) {
                        const mode = config.atPath("mode").valueOr("plain");

                        // A new function each run: never counted as a change on its own.
                        config.addEntity("skill-target", { id: "codex", dir: `.codex-${mode}`, run: () => mode });
                    },
                });
                sous.config.contribute({ id: "3-mode", contribute: (config) => config.atPath("mode").set("fancy") });
            }),
        ]);

        const built = await engine.buildConfig();

        expect(built.get("dir")).toBe(".codex-fancy");
        expect(built.get("dirs")).toEqual([".codex-fancy"]);
        expect(runs).toEqual({ list: 3, narrow: 3 });
    });

    /**
     * A contributor that applies data with one merge at the root reads the whole tree, so any change by
     * anyone re-runs it; with a higher apply order, as the user's files have, its patch applies
     * after the plugin's, so it wins.
     */
    it("should re-run a root merge after any change and apply it last", async () => {
        let runs = 0;
        const { engine } = makeEngine([
            keysPlugin("a", "b"),
            contributorsPlugin("p", [
                {
                    id: "1-file",
                    applyOrder: 90000,
                    contribute(config) {
                        runs += 1;
                        config.root().merge({ a: "user", b: "file" });
                    },
                },
                // Reads what the file sets, so it re-runs in pass 2 and changes `a` again.
                { id: "2-plugin", contribute: (config) => config.atPath("a").set(`plugin-${config.atPath("b").valueOr("none")}`) },
            ]),
        ]);

        const built = await engine.buildConfig();

        expect(built.get("a")).toBe("user");
        expect(runs).toBe(2);
    });

    /**
     * The the example: a recipe plugin turns source comments on; the project's sous.config.js
     * turns them off. The user's file re-runs after the plugin's change, so the result is false; in a
     * project whose files don't set it, it is true.
     */
    it("should let the user's file win over a plugin's value", async () => {
        const acme = contributorsPlugin("sous-plugin-acme-standards", [
            {
                id: "acme",
                contribute: (config) => config.atPath("compilation.includeSourceComments").setValue(true),
            },
        ]);
        const userFile = contributorsPlugin("plugin-config-files", [
            {
                id: "config-files.main",
                contribute: (config) => config.root().merge({ compilation: { includeSourceComments: false } }),
            },
        ]);

        const withFile = await makeEngine([keysPlugin("compilation"), userFile, acme]).engine.buildConfig();
        const withoutFile = await makeEngine([keysPlugin("compilation"), acme]).engine.buildConfig();

        expect(withFile.get("compilation.includeSourceComments")).toBe(false);
        expect(withoutFile.get("compilation.includeSourceComments")).toBe(true);
    });

    /**
     * The the example: the sous.config.* contributor comes first, and each conf.d contributor
     * names the file before it, so files apply in file order, merged key by key: 610's override
     * changes one field and every 510 field survives.
     */
    it("should apply conf.d files in file order, key by key (the example)", async () => {
        const files: Array<{ name: string; data: Record<string, unknown> }> = [
            {
                name: "500-repos.jsonc",
                data: { repos: { "github.com/sous-io/sous-recipes": { trusted: true } } },
            },
            {
                name: "510-subscriptions.jsonc",
                data: {
                    subscriptions: {
                        "tool-usage/automated-browser-tasks": {
                            range: "^2.1.0",
                            prerelease: false,
                            alwaysPull: true,
                            addedAt: "2026-10-12T14:03:00Z",
                            addedBy: "user",
                        },
                    },
                },
            },
            {
                name: "610-mac.jsonc",
                data: { subscriptions: { "tool-usage/automated-browser-tasks": { enabled: false, alwaysPull: false } } },
            },
        ];
        const order: string[] = [];
        const confd = plugin("plugin-confd", (sous) => {
            let previous = "config-files.main";

            for (const file of files) {
                const id = `confd/${file.name}`;

                sous.config.contribute({
                    id,
                    after: [previous],
                    contribute: (config) => {
                        order.push(id);
                        config.root().merge(file.data);
                    },
                });
                previous = id;
            }
        });
        const main = contributorsPlugin("plugin-config-files", [
            {
                id: "config-files.main",
                contribute: (config) => {
                    order.push("config-files.main");
                    config.root().merge({ _vars: { machineRole: "laptop" } });
                },
            },
        ]);
        const { engine } = makeEngine([keysPlugin("repos", "subscriptions", "_vars"), confd, main]);

        const built = await engine.buildConfig();

        expect(order.slice(0, 4)).toEqual([
            "config-files.main",
            "confd/500-repos.jsonc",
            "confd/510-subscriptions.jsonc",
            "confd/610-mac.jsonc",
        ]);
        expect(built.get(["subscriptions", "tool-usage/automated-browser-tasks"])).toEqual({
            range: "^2.1.0",
            prerelease: false,
            alwaysPull: false,
            addedAt: "2026-10-12T14:03:00Z",
            addedBy: "user",
            enabled: false,
        });
        expect(built.contributions().map((c) => c.contributor)).toEqual([
            "config-files.main",
            "confd/500-repos.jsonc",
            "confd/510-subscriptions.jsonc",
            "confd/610-mac.jsonc",
        ]);
    });

    /**
     * The the example: a contributor reads its own key's value (default from its schema at
     * check time) and appends a compilation target; the schema fills the defaults.
     */
    it("should run a contributor that reads its own key", async () => {
        const { jsonSchema } = await import("@sous-io/plugin-api");
        const diagrams = plugin("sous-plugin-diagrams", (sous) => {
            sous.entities.add("config-key", {
                id: "diagrams",
                schema: jsonSchema({
                    type: "object",
                    properties: {
                        enabled: { type: "boolean", default: true },
                        sourceGlob: { type: "string", default: "docs/**/*.mmd" },
                    },
                }),
            });
            sous.config.contribute({
                id: "diagrams",
                contribute(config) {
                    if (config.atPath("diagrams.enabled").valueOr(true)) {
                        config.atPath("compilation.targets").appendValue({
                            id: "diagrams",
                            entryGlob: "${diagrams.sourceGlob}",
                            outputs: [{ destinationDir: "${projectRoot}/docs/diagrams" }],
                        });
                    }
                },
            });
        });
        const { engine } = makeEngine([keysPlugin("compilation"), diagrams]);

        const built = await engine.buildConfig();

        expect(built.get("diagrams")).toEqual({ enabled: true, sourceGlob: "docs/**/*.mmd" });
        expect(built.get("compilation.targets")).toEqual([
            { id: "diagrams", entryGlob: "${diagrams.sourceGlob}", outputs: [{ destinationDir: "${projectRoot}/docs/diagrams" }] },
        ]);
    });

    /**
     * The the example of plugins loading inside the loop: a recipes-like contributor adds a
     * plugin to plugins.load; it loads after the pass and adds a skill-target; the skills contributor
     * re-runs in pass 2 because the skill-target list it read changed.
     */
    it("should load a listed plugin after the pass and re-run readers of its entities", async () => {
        const skillsRuns: string[][] = [];
        const codex = plugin("sous-plugin-codex", (sous) => {
            sous.entities.add("skill-target", { id: "codex" });
        });
        const skills = plugin("plugin-skills", (sous) => {
            sous.entities.define("skill-target", { "~standard": { version: 1, vendor: "t", validate: (value) => ({ value }) } });
            sous.entities.add("skill-target", { id: "claude-code" });
            sous.config.contribute({
                id: "skills",
                contribute(config) {
                    const ids = config.entities("skill-target").map((target) => target.id);

                    skillsRuns.push(ids);

                    for (const id of ids) {
                        config.atPath("compilation.targets").append({ id: `skills-${id}` });
                    }
                },
            });
        });
        const recipes = contributorsPlugin("plugin-recipes", [
            { id: "plugin-recipes", contribute: (config) => config.atPath("plugins.load").append("sous-plugin-codex") },
        ]);
        const { engine } = makeEngine([keysPlugin("compilation"), recipes, skills], {
            importModule: async () => ({ default: codex }),
            cwd: "/nonexistent-dir-for-test",
        });

        const built = await engine.buildConfig();

        expect(skillsRuns).toEqual([["claude-code"], ["claude-code", "codex"]]);
        expect(built.get("compilation.targets")).toEqual([{ id: "skills-claude-code" }, { id: "skills-codex" }]);
        expect(built.passes).toBe(2);
    });

    /**
     * Contributors may apply raw patches, as patch files hold them, and a contributor's patch set
     * serializes to JSON and back.
     */
    it("should apply raw patches and round-trip a contributor's patch set through JSON", async () => {
        const { engine } = makeEngine([
            keysPlugin("compilation", "tools", "_vars"),
            contributorsPlugin("p", [
                {
                    id: "1-base",
                    contribute: (config) => config.root().merge({ compilation: { overwriteUntracked: true }, tools: { codex: {} } }),
                },
                {
                    id: "2-patch-file",
                    after: ["1-base"],
                    contribute: (config) =>
                        config.apply({
                            name: "720-my-special-thing.patch.json",
                            patches: [
                                { op: "setKey", path: "compilation", key: "overwriteUntracked", value: false },
                                { op: "deleteKey", path: "tools", key: "codex" },
                            ],
                        }),
                },
                {
                    id: "3-one",
                    contribute: (config) => config.apply([{ op: "setKey", path: "_vars", key: "machineRole", value: "laptop" }]),
                },
            ]),
        ]);

        const built = await engine.buildConfig();
        const contribution = built.contributions().find((c) => c.contributor === "2-patch-file")!;

        expect(userKeys(built.value())).toEqual({ compilation: { overwriteUntracked: false }, tools: {}, _vars: { machineRole: "laptop" } });
        expect(deserializePatchSet(serializePatchSet(contribution.patches))).toEqual(contribution.patches);
    });

    /**
     * layers() lists every change to a path in order, with its contributor and the helper patch sets
     * around each primitive.
     */
    it("should list each layer of a value with its helper and primitive", async () => {
        const { engine } = makeEngine([
            keysPlugin("compilation"),
            contributorsPlugin("p", [
                {
                    id: "1-targets",
                    contribute: (config) => {
                        config.atPath("compilation.targets").append({ id: "keep" });
                        config.atPath("compilation.targets").append({ id: "diagrams" });
                    },
                },
                {
                    id: "2-no-diagrams",
                    contribute: (config) =>
                        config.atPath("compilation.targets").removeWhere((target) => target.id === "diagrams"),
                },
            ]),
        ]);

        const built = await engine.buildConfig();
        const layers = built.layers("compilation.targets");

        expect(layers.map((layer) => [layer.contributor, layer.patch.op, layer.helpers])).toEqual([
            ["1-targets", "insertAt", []],
            ["1-targets", "insertAt", []],
            ["2-no-diagrams", "removeIndex", ["removeWhere"]],
        ]);
        expect(built.get("compilation.targets")).toEqual([{ id: "keep" }]);
        expect(built.layers("compilation.targets[1]").map((layer) => layer.patch.op)).toContain("removeIndex");
    });

    /**
     * Entities a contributor adds are part of its patch: a re-run replaces them.
     */
    it("should replace a contributor's entities when it re-runs", async () => {
        const { engine } = makeEngine([
            keysPlugin("n"),
            plugin("p", (sous) => {
                sous.entities.define("thing", { "~standard": { version: 1, vendor: "t", validate: (value) => ({ value }) } });
                sous.config.contribute({
                    id: "1-adder",
                    contribute: (config) => {
                        const n = config.atPath("n").valueOr(0);

                        config.addEntity("thing", { id: `thing-${n}` });
                    },
                });
                sous.config.contribute({ id: "2-setter", contribute: (config) => config.atPath("n").set(2) });
            }),
        ]);

        const built = await engine.buildConfig();

        expect(built.entities.list("thing").map((thing) => thing.id)).toEqual(["thing-2"]);
        expect(built.entities.describe("thing")[0]).toMatchObject({ plugin: "p", contributor: "1-adder" });
    });

    /**
     * A contributor that throws stops the build with a ConfigError naming it and its plugin.
     */
    it("should fail the build with a ConfigError naming a contributor that throws", async () => {
        const { engine } = makeEngine([
            contributorsPlugin("sous-plugin-bad", [
                {
                    id: "bad",
                    contribute() {
                        throw new Error("boom");
                    },
                },
            ]),
        ]);

        await expect(engine.buildConfig()).rejects.toThrow(ConfigError);
        await expect(engine.buildConfig()).rejects.toThrow('The contributor "bad" (sous-plugin-bad) failed: boom');
    });

    /**
     * Two contributors that keep undoing each other never settle; the error names the value that kept
     * changing, who read it and wrote it, and the values it alternated between.
     */
    it("should stop with a LoopError naming the values that kept changing", async () => {
        const { engine } = makeEngine([
            keysPlugin("flip"),
            contributorsPlugin("p", [
                {
                    id: "flipper",
                    contribute: (config) => config.atPath("flip").set(!config.atPath("other").valueOr(false)),
                },
                {
                    id: "other-flipper",
                    contribute: (config) => config.atPath("other").set(config.atPath("flip").valueOr(false)),
                },
            ]),
            keysPlugin("other"),
        ]);

        const error = await engine.buildConfig().catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(LoopError);
        expect((error as LoopError).limit).toBe("configPasses");
        expect((error as LoopError).message).toBe("The config did not settle in 10 passes of config stage 0.");
        expect((error as LoopError).details.join("\n")).toMatch(/kept changing \(read by .*\); it alternated between (true|false), (true|false)/);
    });

    /**
     * The number of passes a stage may take comes from limits.configPasses.
     */
    it("should take the pass limit from limits.configPasses", async () => {
        const { engine } = makeEngine([
            keysPlugin("counter"),
            contributorsPlugin("p", [
                { id: "0-limits", contribute: (config) => config.atPath("limits.configPasses").set(3) },
                {
                    id: "1-counter",
                    contribute: (config) => config.atPath("counter").set((config.atPath("counter2").valueOr(0) as number) + 1),
                },
                {
                    id: "2-counter",
                    contribute: (config) => config.atPath("counter2").set((config.atPath("counter").valueOr(0) as number) + 1),
                },
            ]),
            keysPlugin("counter2"),
        ]);

        await expect(engine.buildConfig()).rejects.toThrow("The config did not settle in 3 passes of config stage 0.");
    });

    /**
     * A patch that cannot be applied is skipped and reported as a warning naming its contributor.
     */
    it("should report a patch that could not be applied as a warning", async () => {
        const { engine, reporter } = makeEngine([
            keysPlugin("list"),
            contributorsPlugin("p", [{ id: "remover", contribute: (config) => config.atPath("list").removeAt(7) }]),
        ]);

        await engine.buildConfig();

        expect(reporter.at("warning").join("\n")).toContain('The contributor "remover" made a change that could not be applied');
    });

    /**
     * Reading sous.entities directly while the config is built warns, since the contributor would not
     * re-run when they change.
     */
    it("should note, at the debug level, when a contributor reads sous.entities directly", async () => {
        const { engine, reporter } = makeEngine([
            plugin("p", (sous) => {
                sous.config.contribute({ id: "sneaky", contribute: () => void sous.entities.list("config-key") });
            }),
        ]);

        await engine.buildConfig();

        expect(reporter.at("warning").join("\n")).not.toContain("sous.entities");
        expect(reporter.at("debug").join("\n")).toContain('The contributor "sneaky" read sous.entities directly');
    });

    /**
     * Contributor logs go through the engine's reporter, prefixed with the contributor id, and
     * the builder exposes the project, the environment and its own plugin options.
     */
    it("should give a contributor its info, options, project and environment", async () => {
        const seen: unknown[] = [];
        const project = { root: "/p", sousDir: "/p/.sous", configPath: undefined, confDir: "/p/.sous/conf.d" };
        const { engine, reporter } = makeEngine(
            [
                contributorsPlugin("opt-plugin", [
                    { id: "0-options", contribute: (config) => config.atPath(["plugins", "options", "opt-plugin"]).set({ model: "opus" }) },
                ]),
                contributorsPlugin("reader", [
                    {
                        id: "1-reader",
                        contribute: (config) => {
                            seen.push(config.contributor.id, config.contributor.plugin, config.contributor.stage, config.project, config.env.HOME);
                            config.log("info", "hello");
                        },
                    },
                ]),
                plugin("opt-plugin-reader", () => {}),
            ],
            { project, env: { HOME: "/home/x" } },
        );

        await engine.buildConfig();

        expect(seen).toEqual(["1-reader", "reader", 0, project, "/home/x"]);
        expect(reporter.at("info")).toContain("1-reader: hello");

        const optionsSeen: unknown[] = [];
        const second = makeEngine([
            contributorsPlugin("opt-plugin", [
                { id: "0-options", contribute: (config) => config.atPath(["plugins", "options", "opt-plugin"]).set({ model: "opus" }) },
                { id: "1-reads-own", contribute: (config) => void optionsSeen.push(config.options()) },
            ]),
        ]);

        await second.engine.buildConfig();
        expect(optionsSeen.at(-1)).toEqual({ model: "opus" });
    });
    /**
     * Every change goes through the builder and is recorded as primitives, in one patch set named
     * for the contributor; a helper's primitives are grouped under its name, and removeWhere removes
     * from the highest index down. The builder has no setDefault.
     */
    it("should record changes as primitives in a patch set named for the contributor", async () => {
        let hasSetDefault: boolean | undefined;
        const { engine } = makeEngine([
            keysPlugin("compilation"),
            contributorsPlugin("p", [
                {
                    id: "1-targets",
                    contribute: (config) =>
                        config.atPath("compilation.targets").set([{ id: "diagrams" }, { id: "a" }, { id: "diagrams" }, { id: "b" }, { id: "diagrams" }]),
                },
                {
                    id: "2-confd/620-no-diagrams.js",
                    contribute: (config) => {
                        hasSetDefault = "setDefault" in config.atPath("compilation") || "setDefault" in config;
                        config.atPath("compilation.targets").removeWhere((target) => target.id === "diagrams");
                    },
                },
            ]),
        ]);

        const built = await engine.buildConfig();
        const patches = built.contributions().find((c) => c.contributor === "2-confd/620-no-diagrams.js")!.patches;

        expect(hasSetDefault).toBe(false);
        expect(patches).toEqual({
            name: "2-confd/620-no-diagrams.js",
            patches: [
                {
                    name: "removeWhere",
                    path: "compilation.targets",
                    patches: [
                        { op: "removeIndex", path: "compilation.targets", index: 4 },
                        { op: "removeIndex", path: "compilation.targets", index: 2 },
                        { op: "removeIndex", path: "compilation.targets", index: 0 },
                    ],
                },
            ],
        });
        expect(built.get("compilation.targets")).toEqual([{ id: "a" }, { id: "b" }]);
    });

    /**
     * Patch files (a .patch.json with one patch, one with a single $patches key, and a .patch.jsonl
     * with one patch per line) are contributors whose operations come from the file.
     */
    it("should apply the three patch-file forms through the builder", async () => {
        const files = [
            ["720-my-special-thing.patch.json", "json", `{
    "$patches": [
        { "op": "setKey", "path": "compilation", "key": "overwriteUntracked", "value": false },
        { "op": "deleteKey", "path": "tools", "key": "codex" }
    ]
}`],
            ["721-my-list-of-things.patch.jsonl", "jsonl", `// .sous/conf.d/721-my-list-of-things.patch.jsonl
{"op": "insertAt", "path": "compilation.targets", "index": 0, "value": {"id": "first", "entryPoint": "a.tpl.md"}}
{"op": "setKey", "path": "_vars", "key": "machineRole", "value": "laptop"}`],
            ["722-one-thing.patch.json", "json", `{ "op": "setKey", "path": "_vars", "key": "editor", "value": "vim" }`],
        ] as const;
        let previous = "700-base";
        const contributors = [
            {
                id: "700-base",
                contribute: (config: import("@sous-io/plugin-api").ConfigBuilder) =>
                    config.root().merge({ compilation: { overwriteUntracked: true, targets: [{ id: "second" }] }, tools: { codex: {}, claude: {} } }),
            },
            ...files.map(([name, kind, text]) => {
                const after = [previous];

                previous = name;

                return { id: name, after, contribute: (config: import("@sous-io/plugin-api").ConfigBuilder) => config.apply(parsePatchFile(text, kind, name)) };
            }),
        ];
        const { engine } = makeEngine([keysPlugin("compilation", "tools", "_vars"), contributorsPlugin("plugin-confd", contributors)]);

        const built = await engine.buildConfig();

        expect(userKeys(built.value())).toEqual({
            compilation: { overwriteUntracked: false, targets: [{ id: "first", entryPoint: "a.tpl.md" }, { id: "second" }] },
            tools: { claude: {} },
            _vars: { machineRole: "laptop", editor: "vim" },
        });
    });
});
