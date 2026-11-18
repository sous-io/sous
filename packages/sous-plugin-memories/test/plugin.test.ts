import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "@sous-io/sous-plugin-api";
import type { CompilationTarget } from "@sous-io/sous-plugin-compiler/types";
import type { HashNameContext, HashNameEntity } from "@sous-io/sous-plugin-refs/types";
import type { MemoryTargetEntity } from "../src/types.js";
import { defaultFormat, skipEmptyTransform } from "../src/targets.js";
import { makeEngine, makeTmpDir, plugin, recipe, write } from "./stand-ins.js";

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

describe("memory targets", () => {
    /**
     * With no `.sous/MEMORIES.tpl.md`, the source is the default: the project's own memories as one
     * glob line (when `.sous/memories/` holds any), then one include line per recipe memory. The
     * output is the target's `outputPath`, marked with its harness.
     *
     * claude-code -> { id: "memories/claude-code",
     * //   content: "@<project>/.sous/memories/**\/*.md\n\n@.../a/one/memories/m.md\n\n@.../b/two/memories/m.md",
     * //   transforms: ["memories/skip-empty"],
     * //   outputs: [{ destinationFile: "${projectRoot}/.claude/rules/SOUS-MEMORIES.md", harness: "claude-code", backupExisting: true }] }
     */
    it("should compile the default source into the target's outputPath", async () => {
        const one = recipe(tmp.path, "a/one");
        const two = recipe(tmp.path, "b/two");
        const project = path.join(tmp.path, "project");

        write(project, ".sous/memories/project.tpl.md", "# Project");

        const { engine } = makeEngine(
            [one, two],
            [targets({ id: "claude-code", harness: "claude-code", outputPath: ".claude/rules/SOUS-MEMORIES.md", backupExisting: true })],
            project,
        );

        expect(compilationTargets(await engine.buildConfig())).toEqual([
            {
                id: "memories/claude-code",
                content: `@${path.join(project, ".sous", "memories")}/**/*.md\n\n@${path.join(one.dir, "memories/m.md")}\n\n@${path.join(two.dir, "memories/m.md")}`,
                transforms: ["memories/skip-empty"],
                origin: { plugin: "@sous-io/sous-plugin-memories" },
                outputs: [{ destinationFile: "${projectRoot}/.claude/rules/SOUS-MEMORIES.md", harness: "claude-code", backupExisting: true }],
            },
        ]);
    });

    /**
     * `.sous/MEMORIES.tpl.md`, when it exists, is the whole source; a `prependWith` file that exists
     * comes first. Both are included by their absolute paths.
     *
     * MEMORIES.tpl.md and AGENTS.md exist, prependWith "AGENTS.md", outputPath "${projectRoot}/AGENTS.override.md"
     * // -> content "@<project>/AGENTS.md\n\n@<project>/.sous/MEMORIES.tpl.md"
     */
    it("should use .sous/MEMORIES.tpl.md as the source, after the file to prepend", async () => {
        const project = path.join(tmp.path, "project");

        write(project, ".sous/MEMORIES.tpl.md", "@#memories/**/*.md\n");
        write(project, "AGENTS.md", "# Agents");

        const { engine } = makeEngine(
            [recipe(tmp.path, "a/one")],
            [targets({ id: "codex", harness: "codex", outputPath: "${projectRoot}/AGENTS.override.md", prependWith: "AGENTS.md" })],
            project,
        );
        const [target] = compilationTargets(await engine.buildConfig());

        expect(target?.content).toBe(`@${path.join(project, "AGENTS.md")}\n\n@${path.join(project, ".sous", "MEMORIES.tpl.md")}`);
        expect(target?.outputs).toEqual([{ destinationFile: "${projectRoot}/AGENTS.override.md", harness: "codex" }]);
    });

    /**
     * A `prependWith` file that does not exist is skipped without a word.
     *
     * prependWith "AGENTS.md", which is missing -> content holds only the recipe memory; no message
     */
    it("should skip a missing file to prepend silently", async () => {
        const one = recipe(tmp.path, "a/one");
        const { engine, reporter } = makeEngine([one], [targets({ id: "codex", outputPath: "AGENTS.override.md", prependWith: "AGENTS.md" })], path.join(tmp.path, "p"));

        expect(compilationTargets(await engine.buildConfig())[0]?.content).toBe(`@${path.join(one.dir, "memories/m.md")}`);
        expect(reporter.messages.filter((message) => message.level !== "debug")).toEqual([]);
    });

    /**
     * Inline content from a manifest has no file, so the default source writes it in place.
     *
     * { $inline: "Be brief.", path: "memories/brief.md" } -> "{% raw %}Be brief.{% endraw %}"
     */
    it("should write a recipe's inline memory in place", () => {
        expect(defaultFormat([{ path: "/store/a/one/memories/brief.md", content: "Be brief." }])).toBe("{% raw %}Be brief.{% endraw %}");
    });

    /**
     * With nothing that could be in the file, no target is added, so a file an earlier build wrote
     * is removed by the prune.
     *
     * no MEMORIES.tpl.md, no .sous/memories/, no recipes -> no memories target
     */
    it("should add no compilation target when there is nothing to write", async () => {
        const { engine } = makeEngine([], [targets({ id: "claude-code", outputPath: ".claude/rules/SOUS-MEMORIES.md" })], path.join(tmp.path, "p"));

        expect(compilationTargets(await engine.buildConfig())).toEqual([]);
    });

    /**
     * Outside a project there is no `.sous/` to read a source from, so nothing is added.
     */
    it("should add nothing outside a project", async () => {
        const { engine } = makeEngine([recipe(tmp.path, "a/one")], [targets({ id: "claude-code", outputPath: "X.md" })]);

        expect(compilationTargets(await engine.buildConfig())).toEqual([]);
    });

    /**
     * recipes.memories.first and .exclude shape the recipe memories in the default source.
     *
     * first ["z/*"], exclude ["b/*"] with a/one, b/two, z/last -> z/last, a/one
     */
    it("should apply recipes.memories.first and .exclude to the recipe memories", async () => {
        const recipes = [recipe(tmp.path, "a/one"), recipe(tmp.path, "b/two"), recipe(tmp.path, "z/last")];
        const { engine } = makeEngine(
            recipes,
            [targets({ id: "list", outputPath: "LIST.md" }), settings({ recipes: { memories: { first: ["z/*"], exclude: ["b/*"] } } })],
            path.join(tmp.path, "p"),
        );

        expect(compilationTargets(await engine.buildConfig())[0]?.content).toBe(
            `@${path.join(tmp.path, "store/z/last/memories/m.md")}\n\n@${path.join(tmp.path, "store/a/one/memories/m.md")}`,
        );
    });

    /**
     * A target added by a contributor (an entity the config creates) is picked up on the next pass.
     *
     * contributor adds memory-target "late" -> a "memories/late" target
     */
    it("should pick up memory targets the config creates", async () => {
        const late = plugin("late", (sous) =>
            sous.config.contribute({ id: "late", contribute: (config) => config.addEntity("memory-target", { id: "late", outputPath: "LATE.md" }) }),
        );
        const { engine } = makeEngine([recipe(tmp.path, "a/one")], [late], path.join(tmp.path, "p"));

        expect(compilationTargets(await engine.buildConfig()).map((target) => target.id)).toEqual(["memories/late"]);
    });

    /**
     * A field memory targets had before 1.1.0 is refused by name.
     *
     * { fileName: "CLAUDE.md" } -> ConfigError naming the entity and "outputPath"
     */
    it("should refuse a memory target written for the old fields", async () => {
        const { engine } = makeEngine([], [targets({ id: "old", outputPath: "X.md", fileName: "CLAUDE.md" } as never)]);

        await expect(engine.buildConfig()).rejects.toThrow(/"memory-target" entity "old"/);
    });
});

describe("the skip-empty transform", () => {
    /**
     * A memories file that compiled to nothing but white space is left out; anything else passes.
     *
     * " \n" -> undefined; "# x" -> the file
     */
    it("should leave out a file with nothing in it", async () => {
        const file = { source: "s", destination: "/p/X.md", content: " \n" };

        expect(await skipEmptyTransform.transform(file, {} as never)).toBeUndefined();
        expect(await skipEmptyTransform.transform({ ...file, content: "# x" }, {} as never)).toEqual({ ...file, content: "# x" });
    });
});

describe("memories.selection", () => {
    /**
     * After the build, the service gives the selection, each target's memories (the whole
     * selection), and what the selection excluded with the setting that did it.
     *
     * exclude ["b/*"] -> selected a/one, z/last; forTarget the same; excluded b/two
     */
    it("should give the selection, each target's memories and the excluded ones", async () => {
        const recipes = [recipe(tmp.path, "a/one"), recipe(tmp.path, "b/two"), recipe(tmp.path, "z/last")];
        const { engine } = makeEngine(recipes, [targets({ id: "t", outputPath: "T.md" }), settings({ recipes: { memories: { exclude: ["b/*"] } } })]);
        const selection = (await engine.buildConfig()).services.get("memories.selection");

        expect(selection.selected().map((memory) => memory.recipe)).toEqual(["a/one", "z/last"]);
        expect(selection.forTarget("t").map((memory) => memory.recipe)).toEqual(["a/one", "z/last"]);
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

        expect(view.bases).toBeUndefined();
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
     * leak/secret.md -> one warning
     */
    it("should warn once about a memory that leads out of its recipe", async () => {
        const one = recipe(tmp.path, "c/one", { include: ["memories/**/*.md"] });
        const outside = path.join(tmp.path, "outside");

        fs.mkdirSync(outside);
        fs.writeFileSync(path.join(outside, "secret.md"), "secret");
        // A junction on Windows, where a file symlink needs elevated rights; the type is ignored elsewhere.
        fs.symlinkSync(outside, path.join(one.dir, "memories", "leak"), "junction");

        const { engine, reporter } = makeEngine([one], [targets({ id: "t", outputPath: "T.md" })], path.join(tmp.path, "p"));

        await engine.buildConfig();
        await engine.buildConfig();

        const warnings = reporter.messages.filter((message) => message.level === "warning");

        expect(warnings).toHaveLength(1);
        expect(warnings[0]?.message).toContain(path.join("leak", "secret.md"));
    });
});
