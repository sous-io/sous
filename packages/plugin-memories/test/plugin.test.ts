import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "@sous-io/plugin-api";
import type { CompilationTarget } from "@sous-io/plugin-compiler/types";
import type { HashNameContext, HashNameEntity } from "@sous-io/plugin-refs/types";
import type { MemoryTargetEntity } from "../src/types.js";
import { makeEngine, makeTmpDir, plugin, recipe } from "./stand-ins.js";

let tmp: { path: string; cleanup(): void };

beforeEach(() => {
    tmp = makeTmpDir();
});

afterEach(() => {
    tmp.cleanup();
});

/** A plugin that adds memory targets, as a harness plugin does. */
const targets = (...entries: MemoryTargetEntity[]) =>
    plugin("sous-plugin-agents", (sous) => {
        for (const entry of entries) {
            sous.entities.add("memory-target", entry);
        }
    });

/** A plugin that sets config values from a contributor, as a config file does. */
const settings = (values: Record<string, unknown>) =>
    plugin("user-config", (sous) => {
        sous.config.contribute({ id: "user", contribute: (config) => config.root().merge(values) });
    });

const compilationTargets = (config: { get(path: string): unknown }) =>
    (config.get("compilation.targets") as CompilationTarget[] | undefined) ?? [];

describe("memory targets (C43)", () => {
    /**
     * Each memory target becomes one `content` compilation target, id `memories/<target id>`, whose
     * default content is one `@<absolute path>` include line per memory, written to the target's file
     * at the project root.
     *
     * claude-code (CLAUDE.md) with a/one and b/two
     * // -> { id: "memories/claude-code", content: "@.../a/one/memories/m.md\n\n@.../b/two/memories/m.md",
     * //      outputs: [{ destinationFile: "${projectRoot}/CLAUDE.md" }] }
     */
    it("should add one content compilation target per memory target, with an include line per memory", async () => {
        const one = recipe(tmp.path, "a/one");
        const two = recipe(tmp.path, "b/two");
        const { engine } = makeEngine([one, two], [targets({ id: "claude-code", harness: "claude", fileName: "CLAUDE.md" })]);
        const built = await engine.buildConfig();

        expect(compilationTargets(built)).toEqual([
            {
                id: "memories/claude-code",
                content: `@${path.join(one.dir, "memories/m.md")}\n\n@${path.join(two.dir, "memories/m.md")}`,
                origin: { plugin: "@sous-io/plugin-memories" },
                outputs: [{ destinationFile: "${projectRoot}/CLAUDE.md" }],
            },
        ]);
    });

    /**
     * `directory` puts the file below the project root.
     *
     * { fileName: "AGENTS.md", directory: "docs/agents" } -> "${projectRoot}/docs/agents/AGENTS.md"
     */
    it("should write the file into the target's directory", async () => {
        const { engine } = makeEngine([recipe(tmp.path, "a/one")], [targets({ id: "codex", fileName: "AGENTS.md", directory: "docs/agents/" })]);

        expect(compilationTargets(await engine.buildConfig())[0]?.outputs).toEqual([{ destinationFile: "${projectRoot}/docs/agents/AGENTS.md" }]);
    });

    /**
     * The order is: the selection, the target's filter(), then its format(), and both get the builder
     * so they can read the config.
     *
     * filter keeps a/*; format writes "# <prefix>" from the config, then the names
     */
    it("should run the filter, then the format, with the config builder", async () => {
        const seen: string[][] = [];
        const target: MemoryTargetEntity = {
            id: "custom",
            fileName: "NOTES.md",
            filter: (memory) => memory.recipe.startsWith("a/"),
            format: (memories, config) => {
                seen.push(memories.map((memory) => memory.recipe));

                return [`# ${config.atPath("notes.title").valueOr("Notes")}`, ...memories.map((m) => `- ${m.recipe}/${m.name}`)].join("\n");
            },
        };
        const keys = plugin("notes-key", (sous) => sous.entities.add("config-key", { id: "notes", schema: { "~standard": { version: 1, vendor: "t", validate: (value) => ({ value }) } } }));
        const { engine } = makeEngine(
            [recipe(tmp.path, "a/one"), recipe(tmp.path, "a/two"), recipe(tmp.path, "b/three")],
            [targets(target), keys, settings({ notes: { title: "Team" } })],
        );
        const built = await engine.buildConfig();

        expect(compilationTargets(built)[0]?.content).toBe("# Team\n- a/one/m.md\n- a/two/m.md");
        expect(seen.at(-1)).toEqual(["a/one", "a/two"]);
    });

    /**
     * Sous says nothing about what a filter left out (ruled 2026-10-29).
     *
     * a filter that takes nothing -> no message at all
     */
    it("should not report what a filter left out", async () => {
        const { engine, reporter } = makeEngine(
            [recipe(tmp.path, "a/one")],
            [targets({ id: "picky", fileName: "PICKY.md", filter: () => false, format: () => "# Picky" })],
        );

        await engine.buildConfig();

        expect(reporter.messages.filter((message) => message.level !== "debug")).toEqual([]);
    });

    /**
     * An empty content means nothing to write, so no target is added and any existing file is left alone.
     *
     * no active recipes -> compilation.targets has no memories target
     */
    it("should add no compilation target when there is nothing to write", async () => {
        const { engine } = makeEngine([], [targets({ id: "claude-code", fileName: "CLAUDE.md" })]);

        expect(compilationTargets(await engine.buildConfig())).toEqual([]);
    });

    /**
     * recipes.memories.first and .exclude shape every target's content.
     *
     * first ["z/*"], exclude ["b/*"] with a/one, b/two, z/last -> z/last, a/one
     */
    it("should apply recipes.memories.first and .exclude before the target sees the memories", async () => {
        const recipes = [recipe(tmp.path, "a/one"), recipe(tmp.path, "b/two"), recipe(tmp.path, "z/last")];
        const { engine } = makeEngine(recipes, [
            targets({ id: "list", fileName: "LIST.md", format: (memories) => memories.map((m) => m.recipe).join(",") }),
            settings({ recipes: { memories: { first: ["z/*"], exclude: ["b/*"] } } }),
        ]);

        expect(compilationTargets(await engine.buildConfig())[0]?.content).toBe("z/last,a/one");
    });

    /**
     * A target added by a contributor (an entity the config creates) is picked up on the next pass.
     *
     * contributor adds memory-target "late" -> a "memories/late" target
     */
    it("should pick up memory targets the config creates", async () => {
        const late = plugin("late", (sous) =>
            sous.config.contribute({ id: "late", contribute: (config) => config.addEntity("memory-target", { id: "late", fileName: "LATE.md" }) }),
        );
        const { engine } = makeEngine([recipe(tmp.path, "a/one")], [late]);

        expect(compilationTargets(await engine.buildConfig()).map((target) => target.id)).toEqual(["memories/late"]);
    });

    /**
     * A memory target's filter and format must be functions.
     *
     * { filter: "a/*" } -> ConfigError naming the entity
     */
    it("should refuse a memory target whose filter is not a function", async () => {
        const { engine } = makeEngine([], [targets({ id: "bad", fileName: "BAD.md", filter: "a/*" as never })]);

        await expect(engine.buildConfig()).rejects.toThrow(/"memory-target" entity "bad"/);
    });
});

describe("pointer files (C44)", () => {
    /**
     * A memory target read in any directory also names a pointer file; one read only at the project
     * root does not.
     *
     * claude-code (any-directory), codex (project-root) -> pointer-file CLAUDE.md only
     */
    it("should add a pointer-file entity for each memory target read in any directory", async () => {
        const { engine } = makeEngine(
            [],
            [
                targets(
                    { id: "claude-code", fileName: "CLAUDE.md", readIn: "any-directory" },
                    { id: "codex", fileName: "AGENTS.md" },
                ),
            ],
        );
        const built = await engine.buildConfig();

        expect(built.entities.list("pointer-file")).toEqual([{ id: "memories/claude-code", fileName: "CLAUDE.md" }]);
    });
});

describe("memories.selection", () => {
    /**
     * After the build, the service gives the selection, each target's memories after its filter, and
     * what the selection excluded with the setting that did it.
     *
     * exclude ["b/*"]; target "a-only" filters to a/* -> selected a/one, z/last; forTarget a/one; excluded b/two
     */
    it("should give the selection, each target's memories and the excluded ones", async () => {
        const recipes = [recipe(tmp.path, "a/one"), recipe(tmp.path, "b/two"), recipe(tmp.path, "z/last")];
        const { engine } = makeEngine(recipes, [
            targets({ id: "a-only", fileName: "A.md", filter: (memory) => memory.recipe.startsWith("a/") }),
            settings({ recipes: { memories: { exclude: ["b/*"] } } }),
        ]);
        const selection = (await engine.buildConfig()).services.get("memories.selection");

        expect(selection.selected().map((memory) => memory.recipe)).toEqual(["a/one", "z/last"]);
        expect(selection.forTarget("a-only").map((memory) => memory.recipe)).toEqual(["a/one"]);
        expect(selection.excluded().map(({ memory, by }) => [memory.recipe, by])).toEqual([["b/two", "recipes.memories.exclude[0]"]]);
        expect(() => selection.forTarget("nope")).toThrow('No memory target "nope" exists.');
    });
});

describe("the #memories view", () => {
    /**
     * `#memories` lists every selected memory at <namespace>/<recipe>/<name>, in selection order, and
     * stands for no directory.
     *
     * z/base requested by a/app -> ["z/base/m.md", "a/app/m.md"]
     */
    it("should list the selected memories in dependency order", async () => {
        const app = recipe(tmp.path, "a/app");
        const base = recipe(tmp.path, "z/base", { requestedBy: ["a/app"] });
        const { engine } = makeEngine([app, base]);
        const built = await engine.buildConfig();
        const view = built.entities.get("hash-name", "memories") as HashNameEntity;
        const ctx = { services: built.services, entities: built.entities, config: built, scope: {} } as unknown as HashNameContext;

        expect(view.bases?.(ctx)).toEqual([]);
        expect(view.view?.(ctx)).toEqual([
            { path: "z/base/m.md", file: path.join(base.dir, "memories/m.md") },
            { path: "a/app/m.md", file: path.join(app.dir, "memories/m.md") },
        ]);
    });
});

describe("recipes.memories", () => {
    /**
     * The key defaults to empty lists.
     *
     * nothing set -> { first: [], exclude: [] }
     */
    it("should default to empty lists", async () => {
        const { engine } = makeEngine([]);

        expect((await engine.buildConfig()).get("recipes.memories")).toEqual({ first: [], exclude: [] });
    });

    /**
     * An entry that is a broken regular expression stops the build with a ConfigError naming it.
     *
     * exclude ["/(/"] -> ConfigError mentioning "/(/"
     */
    it("should refuse an invalid regular expression", async () => {
        const { engine } = makeEngine([], [settings({ recipes: { memories: { exclude: ["/(/"] } } })]);
        const error = await engine.buildConfig().catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(ConfigError);
        expect(JSON.stringify([(error as ConfigError).message, (error as ConfigError).details])).toContain("/(/");
    });

    /**
     * A memory that is a link out of its recipe is reported once, as a warning, however often the
     * contributor runs.
     *
     * leak.md -> one warning
     */
    it("should warn once about a memory that leads out of its recipe", async () => {
        const one = recipe(tmp.path, "c/one");
        const secret = path.join(tmp.path, "secret.md");

        fs.writeFileSync(secret, "secret");
        fs.symlinkSync(secret, path.join(one.dir, "memories", "leak.md"));

        const { engine, reporter } = makeEngine([one], [targets({ id: "t", fileName: "T.md" })]);

        await engine.buildConfig();
        await engine.buildConfig();

        const warnings = reporter.messages.filter((message) => message.level === "warning");

        expect(warnings).toHaveLength(1);
        expect(warnings[0]?.message).toContain("leak.md");
    });
});
