import { describe, expect, it } from "vitest";
import { ConfigError, type ContributorDefinition, jsonSchema, type JsonObject, type Sous } from "@sous-io/plugin-api";
import { contributorsPlugin, keysPlugin, makeEngine, plugin, userKeys } from "./helpers.js";

/** A plugin that defines the `harness` kind and registers the given harnesses. */
function harnesses(...ids: string[]) {
    return plugin("test-harnesses", (sous: Sous) => {
        sous.entities.define("harness", jsonSchema({}));

        for (const id of ids) {
            sous.entities.add("harness", { id } as never);
        }
    });
}

/** A contributor that writes one marked output per harness, and an unmarked one, into one target. */
const outputsContributor: ContributorDefinition = {
    id: "outputs",
    contribute(config) {
        const id = config.harness.id;

        config.atPath("compilation").set({
            includeSourceComments: id === "codex",
            targets: [
                {
                    id: "t",
                    entryPoint: "a.md",
                    outputs: [
                        { destinationDir: "docs" },
                        { destinationDir: ".claude/skills", harness: "claude", _vars: { built: id } },
                        { destinationDir: ".codex/skills", harness: "codex", _vars: { built: id } },
                    ],
                },
            ],
        });
    },
};

describe("one config build per harness", () => {
    /** With no harness registered, the build runs once, with harness.id "", and nothing is merged. */
    it("should build once when no harness is registered", async () => {
        const seen: string[] = [];
        const { engine } = makeEngine([
            keysPlugin("x"),
            contributorsPlugin("p", [{ id: "a", contribute: (config) => void seen.push(config.harness.id) }]),
        ]);

        const built = await engine.buildConfig();

        expect(seen).toEqual([""]);
        expect(built.harness).toBe("");
        expect(built.harnesses).toEqual([]);
        expect(built.forHarness("")).toBe(built);
        expect(built.forHarness("codex")).toBeUndefined();
        expect(engine.timings.entries().filter((entry) => entry.category === "config.harness" || entry.category === "config.merge")).toEqual([]);
    });

    /**
     * Each registered harness gets one more full build, which reads its id; the merged config takes
     * each marked output from its harness's build, and keeps everything else from the build with
     * no harness.
     */
    it("should build once more per harness and merge the marked outputs", async () => {
        const seen: string[] = [];
        const { engine } = makeEngine([
            keysPlugin("compilation"),
            harnesses("codex", "claude"),
            contributorsPlugin("p", [outputsContributor, { id: "spy", contribute: (config) => void seen.push(config.harness.id) }]),
        ]);

        const built = await engine.buildConfig();

        expect(seen.sort()).toEqual(["", "claude", "codex"]);
        expect(built.harnesses).toEqual(["claude", "codex"]);
        expect(built.get("compilation.includeSourceComments")).toBe(false);
        expect(built.get("compilation.targets[0].outputs")).toEqual([
            { destinationDir: "docs" },
            { destinationDir: ".claude/skills", harness: "claude", _vars: { built: "claude" } },
            { destinationDir: ".codex/skills", harness: "codex", _vars: { built: "codex" } },
        ]);
        expect(Object.isFrozen(built.value())).toBe(true);
    });

    /** Each harness's full config stays reachable, with the values only its build has. */
    it("should keep each harness's full config reachable", async () => {
        const { engine } = makeEngine([keysPlugin("compilation"), harnesses("codex"), contributorsPlugin("p", [outputsContributor])]);

        const built = await engine.buildConfig();
        const codex = built.forHarness("codex")!;

        expect(codex.harness).toBe("codex");
        expect(codex.get("compilation.includeSourceComments")).toBe(true);
        expect(codex.harnesses).toEqual(["codex"]);
        expect(codex.forHarness("")!.get("compilation.includeSourceComments")).toBe(false);
        expect(built.forHarness("")!.get("compilation.targets[0].outputs[2]._vars")).toEqual({ built: "" });
        expect(codex.contributions().every((contribution) => contribution.build === "codex")).toBe(true);
    });

    /**
     * A harness's build may register another harness, which gets its own build; no harness is built
     * twice.
     */
    it("should build a harness a harness's build registers, once", async () => {
        const seen: string[] = [];
        const { engine } = makeEngine([
            keysPlugin("x"),
            harnesses("first"),
            contributorsPlugin("p", [
                {
                    id: "chain",
                    contribute(config) {
                        seen.push(config.harness.id);

                        if (config.harness.id === "first") {
                            config.addEntity("harness" as never, { id: "second" } as never);
                        }

                        if (config.harness.id === "second") {
                            config.addEntity("harness" as never, { id: "first" } as never);
                        }
                    },
                },
            ]),
        ]);

        const built = await engine.buildConfig();

        expect(seen).toEqual(["", "first", "second"]);
        expect(built.harnesses).toEqual(["first", "second"]);
    });

    /** Harness builds run side by side: the second starts before the first has finished. */
    it("should run harness builds at the same time", async () => {
        const events: string[] = [];
        const { engine } = makeEngine([
            keysPlugin("x"),
            harnesses("a", "b"),
            contributorsPlugin("p", [
                {
                    id: "slow",
                    async contribute(config) {
                        events.push(`start ${config.harness.id}`);
                        await new Promise((resolve) => setTimeout(resolve, 5));
                        events.push(`end ${config.harness.id}`);
                    },
                },
            ]),
        ]);

        await engine.buildConfig();

        expect(events.slice(2, 4).sort()).toEqual(["start a", "start b"]);
    });

    /** Contributors read `harness.id` as a value of the build; a harness's build may set anything differently. */
    it("should give the config every intent reads the values of the build with no harness", async () => {
        const { engine } = makeEngine([
            keysPlugin("tool"),
            harnesses("codex"),
            contributorsPlugin("p", [{ id: "tool", contribute: (config) => config.atPath("tool").set(config.harness.id || "none") }]),
        ]);

        const built = await engine.buildConfig();

        expect(userKeys(built.value())).toEqual({ tool: "none" });
        expect(built.forHarness("codex")!.get("tool")).toBe("codex");
    });

    /** `--layers` names the build of each change; changes to a merged list name the harness builds too. */
    it("should name the build in each layer", async () => {
        const { engine } = makeEngine([keysPlugin("compilation"), harnesses("codex"), contributorsPlugin("p", [outputsContributor])]);

        const built = await engine.buildConfig();

        expect(built.layers("compilation.targets[0].outputs").map((layer) => [layer.contributor, layer.build])).toEqual([
            ["outputs", ""],
            ["outputs", "codex"],
        ]);
        expect(built.layers("compilation.includeSourceComments").map((layer) => layer.build)).toEqual([""]);
        expect(built.contributions().map((contribution) => contribution.build)).toEqual([""]);
    });

    /** Every harness build, and the merge, shows in the timings. */
    it("should time each harness build and the merge", async () => {
        const { engine } = makeEngine([keysPlugin("compilation"), harnesses("codex"), contributorsPlugin("p", [outputsContributor])]);

        await engine.buildConfig();

        const keys = engine.timings.entries().map((entry) => entry.key);

        expect(keys).toEqual(expect.arrayContaining(["config.build:config", "config.harness:codex", "config.merge:config", "config.stage:0", "config.stage:codex/0", "config.pass:codex/0.1"]));
    });

    /** A harness's build that fails fails the whole build, and the error names the harness. */
    it("should name the harness when its build fails", async () => {
        const { engine } = makeEngine([
            keysPlugin("x"),
            harnesses("codex"),
            contributorsPlugin("p", [
                {
                    id: "picky",
                    contribute(config) {
                        if (config.harness.id === "codex") {
                            throw new ConfigError("codex is not welcome");
                        }
                    },
                },
            ]),
        ]);

        const error = await engine.buildConfig().catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).details).toContain('This happened in the config build for the harness "codex".');
        // The build with no harness succeeded, so intents that tolerate a broken config get it.
        expect(engine.configError).toBe(error);
        expect(engine.config.harness).toBe("");
    });

    /** A plugin may add its own list to the merge with a `harness-list` entity. */
    it("should merge a list a plugin declares", async () => {
        const { engine } = makeEngine([
            keysPlugin("hooks"),
            harnesses("codex"),
            plugin("p", (sous) => {
                sous.entities.add("harness-list" as never, { id: "hooks", path: "hooks.list" } as never);
                sous.config.contribute({
                    id: "hooks",
                    contribute(config) {
                        const list: JsonObject[] = [{ name: "always" }];

                        if (config.harness.id === "codex") {
                            list.push({ name: "codex" });
                        }

                        config.atPath("hooks").set({ list });
                    },
                });
            }),
        ]);

        const built = await engine.buildConfig();

        expect(built.get("hooks.list")).toEqual([{ name: "always" }, { name: "codex", harness: "codex" }]);
    });
});
