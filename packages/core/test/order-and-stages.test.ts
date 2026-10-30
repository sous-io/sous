import { describe, expect, it } from "vitest";
import { ConfigError, jsonSchema } from "@sous-io/plugin-api";
import { contributorsPlugin, keysPlugin, makeEngine, plugin, userKeys } from "./helpers.js";

describe("order and stages", () => {
    /**
     * Contributors run by apply order and then name, adjusted by before and after, which may name a
     * plugin, a contributor id or a wildcard; a plugin's declarations are the default for its
     * contributors, and a contributor's own replace them. Each `after` moves its contributor to one
     * past the one it follows, so claude-code/defaults (moved to 1) runs after zz-early (still 0).
     */
    it("should order contributors by name, before and after", async () => {
        const order: string[] = [];
        const record = (id: string) => () => void order.push(id);
        const { engine } = makeEngine([
            contributorsPlugin("@sous-io/plugin-skills", [{ id: "z-skills", contribute: record("z-skills") }]),
            contributorsPlugin(
                "plugin-claude-code",
                [
                    { id: "claude-code/defaults", contribute: record("claude-code/defaults") },
                    { id: "claude-code/late-fixups", after: ["confd/*"], contribute: record("claude-code/late-fixups") },
                ],
                { after: ["@sous-io/plugin-skills"] },
            ),
            contributorsPlugin("plugin-confd", [
                { id: "confd/500", contribute: record("confd/500") },
                { id: "confd/610", after: ["confd/500"], contribute: record("confd/610") },
            ]),
            contributorsPlugin("early", [{ id: "zz-early", before: ["confd/500"], contribute: record("zz-early") }]),
        ]);

        await engine.buildConfig();

        expect(order).toEqual(["z-skills", "zz-early", "claude-code/defaults", "confd/500", "confd/610", "claude-code/late-fixups"]);
    });

    /**
     * A bare `*` in `after` puts a contributor after every contributor that does not declare it
     * itself; among those that do, their own declarations decide. A contributor that names one of
     * them explicitly keeps its own declaration.
     */
    it("should put contributors declared after * last, in their own chain", async () => {
        const order: string[] = [];
        const record = (id: string) => () => void order.push(id);
        const { engine, reporter } = makeEngine([
            contributorsPlugin("plugin-confd", [
                { id: "confd/700", after: ["*", "confd/610"], contribute: record("confd/700") },
                { id: "confd/610", after: ["*", "config-files.main"], contribute: record("confd/610") },
            ]),
            contributorsPlugin("plugin-config-files", [{ id: "config-files.main", after: ["*"], contribute: record("config-files.main") }]),
            contributorsPlugin("plugin-x", [
                { id: "zzz-plugin", contribute: record("zzz-plugin") },
                { id: "late-fixups", after: ["confd/*"], contribute: record("late-fixups") },
            ]),
        ]);

        await engine.buildConfig();

        expect(order).toEqual(["zzz-plugin", "config-files.main", "confd/610", "confd/700", "late-fixups"]);
        expect(reporter.at("warning").join("\n")).not.toContain("cycle");
    });

    /**
     * `before: ["*"]` is the mirror image: before every contributor that does not declare it.
     */
    it("should put contributors declared before * first", async () => {
        const order: string[] = [];
        const record = (id: string) => () => void order.push(id);
        const { engine } = makeEngine([
            contributorsPlugin("p", [
                { id: "a", contribute: record("a") },
                { id: "z-first", before: ["*"], contribute: record("z-first") },
                { id: "y-first", before: ["*", "z-first"], contribute: record("y-first") },
            ]),
        ]);

        await engine.buildConfig();

        expect(order).toEqual(["y-first", "z-first", "a"]);
    });

    /**
     * The config-building spec's machineRole example, with stand-ins for the user's files (root
     * merges with the apply orders the file plugins give them: 90000 for sous.config.*, 90000 plus
     * the leading number for a conf.d file): 610 reads machineRole, which 700 sets. Patches apply
     * in that order and a re-run does not move a patch, so sous.config.* and 700 never trade
     * places and the build settles with 700's value.
     */
    it("should settle when a file reads a variable a later file sets (the machineRole example)", async () => {
        const { engine } = makeEngine([
            keysPlugin("_vars", "browser"),
            contributorsPlugin("files", [
                { id: "config-files.main", applyOrder: 90000, contribute: (config) => config.root().merge({ _vars: { machineRole: "laptop" } }) },
                {
                    id: "confd/610-browser",
                    applyOrder: 90610,
                    contribute(config) {
                        const role: unknown = config.atPath("_vars.machineRole").get();

                        config.root().merge({ browser: role === "laptop" ? "on" : "off" });
                    },
                },
                { id: "confd/700-ci", applyOrder: 90700, contribute: (config) => config.root().merge({ _vars: { machineRole: "ci" } }) },
            ]),
            contributorsPlugin("plugin-y", [{ id: "zzz-plugin", contribute: (config) => config.atPath("_vars.fromPlugin").setValue(true) }]),
        ]);

        const built = await engine.buildConfig();

        expect(built.get("_vars")).toEqual({ fromPlugin: true, machineRole: "ci" });
        expect(built.get("browser")).toBe("off");
        expect(built.contributions().map((c) => c.contributor)).toEqual(["zzz-plugin", "config-files.main", "confd/610-browser", "confd/700-ci"]);
    });

    /**
     * Declarations that form a cycle are broken by name order, and sous warns once naming them.
     */
    it("should warn about a cycle of before and after declarations", async () => {
        const order: string[] = [];
        const { engine, reporter } = makeEngine([
            contributorsPlugin("p", [
                { id: "a", after: ["b"], contribute: () => void order.push("a") },
                { id: "b", after: ["a"], contribute: () => void order.push("b") },
            ]),
        ]);

        await engine.buildConfig();

        expect(order).toEqual(["a", "b"]);
        expect(reporter.at("warning").join("\n")).toContain("form a cycle");
    });

    /**
     * When two contributors set one key, the one declared after wins, even when the earlier one re-runs
     * later in the build.
     */
    it("should keep a contributor declared after winning when the earlier one re-runs", async () => {
        const { engine } = makeEngine([
            keysPlugin("value", "trigger"),
            contributorsPlugin("p", [
                {
                    id: "1-early",
                    contribute: (config) => config.atPath("value").set(`early-${config.atPath("trigger").valueOr("none")}`),
                },
                { id: "2-late", after: ["1-early"], contribute: (config) => config.atPath("value").set("late") },
                { id: "3-trigger", contribute: (config) => config.atPath("trigger").set("set") },
            ]),
        ]);

        const built = await engine.buildConfig();

        expect(built.get("value")).toBe("late");
    });

    /**
     * Stages run lowest first; each settles before the next starts from its config, and a finished
     * stage never runs again.
     */
    it("should run a stage-7 contributor after stage 0 settles", async () => {
        const order: string[] = [];
        const { engine } = makeEngine([
            keysPlugin("compilation"),
            contributorsPlugin("p", [
                {
                    id: "team-policy",
                    stage: 7,
                    contribute(config) {
                        order.push(`team-policy saw ${String(config.atPath("compilation.overwriteUntracked").get())}`);
                        config.atPath("compilation.overwriteUntracked").setValue(false);
                    },
                },
                {
                    id: "zz-stage-0",
                    contribute(config) {
                        order.push("stage-0");
                        config.atPath("compilation.overwriteUntracked").set(true);
                    },
                },
            ]),
        ]);

        const built = await engine.buildConfig();

        expect(order).toEqual(["stage-0", "team-policy saw true"]);
        expect(built.get("compilation.overwriteUntracked")).toBe(false);
    });

    /**
     * Contributors of finished stages stay watched: when a later stage changes something one read,
     * sous logs at the debug level that it would have re-run, and why it did not.
     */
    it("should log a debug message for a finished-stage contributor that would have re-run", async () => {
        const { engine, reporter } = makeEngine([
            keysPlugin("recipes"),
            contributorsPlugin("p", [
                { id: "plugin-y", contribute: (config) => void config.atPath("recipes.skills.outputs").get() },
                {
                    id: "plugin-x",
                    stage: 7,
                    contribute: (config) => config.atPath("recipes.skills.outputs").set(["${projectRoot}/.codex/skills"]),
                },
            ]),
        ]);

        await engine.buildConfig();

        expect(reporter.at("debug")).toContain(
            "plugin-x, running in config stage 7, changed recipes.skills.outputs, which would have made plugin-y re-run, but plugin-y is in stage 0, so it didn't.",
        );
    });

    /**
     * A plugin loaded during stage N has its stages shifted by N, nesting, so nothing lands in a
     * finished stage.
     */
    it("should shift the stages of a plugin loaded during a stage", async () => {
        const seen: Array<[string, number]> = [];
        const late = contributorsPlugin("late-plugin", [
            { id: "late-0", contribute: (config) => void seen.push(["late-0", config.contributor.stage]) },
            {
                id: "late-2",
                stage: 2,
                contribute: (config) => {
                    seen.push(["late-2", config.contributor.stage]);
                    config.atPath("plugins.load").append("./nested.mjs");
                },
            },
        ]);
        const nested = contributorsPlugin("nested-plugin", [
            { id: "nested-1", stage: 1, contribute: (config) => void seen.push(["nested-1", config.contributor.stage]) },
        ]);
        const { engine } = makeEngine(
            [
                contributorsPlugin("loader", [
                    { id: "loader", stage: 3, contribute: (config) => config.atPath("plugins.load").append("./late.mjs") },
                ]),
            ],
            {
                cwd: "/nonexistent-for-test",
                importModule: async (url) => ({ default: url.includes("nested") ? nested : late }),
            },
        );

        await engine.buildConfig();

        expect(seen).toEqual([
            ["late-0", 3],
            ["late-2", 5],
            ["nested-1", 6],
        ]);
    });
});

describe("validation", () => {
    /**
     * The finished config is checked against every config-key entity, and their schema defaults are
     * filled in.
     */
    it("should fill in schema defaults for keys nobody set", async () => {
        const { engine } = makeEngine([
            plugin("p", (sous) => {
                sous.entities.add("config-key", {
                    id: "diagrams",
                    schema: jsonSchema({ type: "object", properties: { enabled: { type: "boolean", default: true } } }),
                });
                sous.entities.add("config-key", {
                    id: "required-thing",
                    schema: jsonSchema({ type: "object", required: ["name"], properties: { name: { type: "string" } } }),
                });
            }),
        ]);

        const built = await engine.buildConfig();

        expect(built.get("diagrams")).toEqual({ enabled: true });
        expect(built.has("required-thing")).toBe(false);
        expect(built.get("plugins")).toEqual({ discover: "dependencies", load: [], disabled: [], options: {} });
    });

    /**
     * An unknown top-level key, or a value against its schema, fails the build, naming the key and the
     * contributor that set it.
     */
    it("should reject unknown keys and wrong values, naming who set them", async () => {
        const { engine } = makeEngine([
            plugin("p", (sous) => {
                sous.entities.add("config-key", {
                    id: "diagrams",
                    schema: jsonSchema({ type: "object", properties: { sourceGlob: { type: "string" } } }),
                });
                sous.config.contribute({
                    id: "confd/610-mac.jsonc",
                    contribute: (config) => config.root().merge({ diagrams: { sourceGlob: 3 }, mystery: true }),
                });
            }),
        ]);

        const error = (await engine.buildConfig().catch((caught: unknown) => caught)) as ConfigError;

        expect(error).toBeInstanceOf(ConfigError);
        expect(error.message).toBe("The config is not valid (2 problems).");
        expect(error.details).toEqual([
            "mystery: Not a known config key; likely a typo. (set by confd/610-mac.jsonc)",
            "diagrams.sourceGlob: Expected string, got number 3. (set by confd/610-mac.jsonc)",
        ]);
    });

    /**
     * A config key inside another plugin's key is checked by its own schema; the outer key's schema
     * never sees it.
     */
    it("should check nested config-key ids on their own", async () => {
        const { engine } = makeEngine([
            plugin("p", (sous) => {
                sous.entities.add("config-key", {
                    id: "tools",
                    schema: jsonSchema({ type: "object", additionalProperties: false, properties: { codex: { type: "object" } } }),
                });
                sous.entities.add("config-key", {
                    id: "tools.claude",
                    schema: jsonSchema({ type: "object", properties: { command: { type: "string", default: "claude" } } }),
                });
                sous.config.contribute({ id: "c", contribute: (config) => config.root().merge({ tools: { codex: {}, claude: {} } }) });
            }),
        ]);

        const built = await engine.buildConfig();

        expect(built.get("tools")).toEqual({ codex: {}, claude: { command: "claude" } });
    });

    /**
     * A what-if build adds contributors for itself only: the real config stays as it was, and the
     * what-if config gets its own config-lifetime services.
     */
    it("should build a what-if config without replacing the real one", async () => {
        let made = 0;
        const { engine } = makeEngine([
            keysPlugin("version"),
            plugin("p", (sous) => {
                sous.config.contribute({ id: "base", contribute: (config) => config.atPath("version").set("1.2.0") });
                sous.services.add("versions.reader", (config) => ({ n: ++made, version: config.get("version") }), { lifetime: "config" });
            }),
        ]);
        const real = await engine.buildConfig();

        const preview = await engine.buildConfig({
            extraContributors: [{ id: "pin", after: ["base"], contribute: (config) => config.atPath("version").set("1.3.0") }],
        });

        expect(preview.whatIf).toBe(true);
        expect(preview.get("version")).toBe("1.3.0");
        expect(engine.config.get("version")).toBe("1.2.0");
        expect(engine.config).toBe(real);
        expect(preview.services.get("versions.reader")).toEqual({ n: 1, version: "1.3.0" });
        expect(real.services.get("versions.reader")).toEqual({ n: 2, version: "1.2.0" });
        expect(real.services.get("versions.reader")).toEqual({ n: 2, version: "1.2.0" });
        expect(userKeys(engine.config.value())).toEqual({ version: "1.2.0" });
    });

    /**
     * The handle plugins get builds only what-if configs.
     */
    it("should build a what-if config from the plugin handle", async () => {
        const { engine } = makeEngine([keysPlugin("a")]);

        await engine.buildConfig();

        const preview = await engine.handle.buildConfig();

        expect(preview.whatIf).toBe(true);
        expect(engine.config.whatIf).toBe(false);
        expect(await engine.buildWhatIf()).toMatchObject({ whatIf: true });
    });
});
