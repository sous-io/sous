import { describe, expect, it } from "vitest";
import { ConfigError, LoopError, type PatchSet } from "@sous-io/plugin-api";
import { deserializePatchSet, serializePatchSet } from "@sous-io/documents";
import { contributorsPlugin, keysPlugin, makeEngine, plugin, userKeys } from "./helpers.js";

describe("the config loop", () => {
    /**
     * A contributor is given the config made from every other contributor's latest patch, never its
     * own, and may read its own previous patch set (S2, "The Builder", rule 3; C2).
     *
     * a sets x=1; b reads x and sets y=x+1; a sees only y, never its own x.
     */
    it("should give each contributor the others' latest patches without its own (C2)", async () => {
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
     * append is never doubled however often the contributor re-runs (S2, "The Loop", rule 2).
     */
    it("should never double an append when a contributor re-runs (S2 rule 2)", async () => {
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
        expect(built.contributions().map((c) => c.contributor)).toEqual(["b-flagger", "a-appender"]);
    });

    /**
     * A contributor re-runs only when a key it read has changed since its last run; the others keep
     * their stored patches (S2, rule 4).
     */
    it("should re-run a contributor only when a key it read changed (S2 rule 4)", async () => {
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
     * work (S2, "Speed").
     */
    it("should settle in one working pass when nothing read changes (S2 Speed)", async () => {
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
     * `monitors` watches more than a contributor reads: a path, or an entity kind (C70).
     */
    it("should re-run a contributor when something it monitors changes (C70)", async () => {
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
     * entity re-runs only when that entity changes, not when another id appears (S2, rule 4).
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
     * A contributor that applies data with one merge at the root reads the whole tree, so any change by
     * anyone re-runs it, and its patch lands on top (C66, C70).
     */
    it("should re-run a root merge after any change and land it on top (C66)", async () => {
        let runs = 0;
        const { engine } = makeEngine([
            keysPlugin("a", "b"),
            contributorsPlugin("p", [
                {
                    id: "1-file",
                    contribute(config) {
                        runs += 1;
                        config.root().merge({ a: "user" });
                    },
                },
                { id: "2-plugin", contribute: (config) => config.atPath("a").set("plugin") },
            ]),
        ]);

        const built = await engine.buildConfig();

        expect(built.get("a")).toBe("user");
        expect(runs).toBe(2);
    });

    /**
     * The S2 worked example: a recipe plugin turns source comments on; the project's sous.config.js
     * turns them off. The user's file re-runs after the plugin's change, so the result is false; in a
     * project whose files don't set it, it is true (C74).
     */
    it("should let the user's file win over a plugin's value (S2 acme example, C74)", async () => {
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
     * The S2 conf.d example: the sous.config.* contributor comes first, and each conf.d contributor
     * names the file before it, so files apply in file order, merged key by key: 610's override
     * changes one field and every 510 field survives.
     */
    it("should apply conf.d files in file order, key by key (S2 conf.d example)", async () => {
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
     * The S2 diagrams example: a contributor reads its own key's value (default from its schema at
     * check time) and appends a compilation target; the schema fills the defaults (C1, C4, C71).
     */
    it("should run the S2 diagrams plugin (C1, C4, C71)", async () => {
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
     * The S2 worked example of plugins loading inside the loop: a recipes-like contributor adds a
     * plugin to plugins.load; it loads after the pass and adds a skill-target; the skills contributor
     * re-runs in pass 2 because the skill-target list it read changed (C5).
     */
    it("should load a listed plugin after the pass and re-run readers of its entities (S2 codex example, C5)", async () => {
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
     * Contributors may apply raw patches, as patch files hold them (C77), and a contributor's patch set
     * serializes to JSON and back (C76).
     */
    it("should apply raw patches and round-trip a contributor's patch set through JSON (C76, C77)", async () => {
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
     * around each primitive (C53, C78).
     */
    it("should list each layer of a value with its helper and primitive (C53, C78)", async () => {
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
     * Entities a contributor adds are part of its patch: a re-run replaces them (C33).
     */
    it("should replace a contributor's entities when it re-runs (C33)", async () => {
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
     * changing, who read it and wrote it, and the values it alternated between (S2, rule 7).
     */
    it("should stop with a LoopError naming the values that kept changing (S2 rule 7)", async () => {
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
     * The number of passes a stage may take comes from limits.configPasses (C51).
     */
    it("should take the pass limit from limits.configPasses (C51)", async () => {
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
     * A patch that cannot be applied is skipped and reported as a warning naming its contributor (L6).
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
     * re-run when they change (S2, "The Builder", rule 6).
     */
    it("should warn when a contributor reads sous.entities directly", async () => {
        const { engine, reporter } = makeEngine([
            plugin("p", (sous) => {
                sous.config.contribute({ id: "sneaky", contribute: () => void sous.entities.list("config-key") });
            }),
        ]);

        await engine.buildConfig();

        expect(reporter.at("warning").join("\n")).toContain('The contributor "sneaky" read sous.entities directly');
    });

    /**
     * Contributor logs go through the engine's reporter, prefixed with the contributor id (L3), and
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
});
