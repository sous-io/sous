/**
 * Pruning and clearing through `compiler.prune`, and where the state file lives, ported from the
 * `prune()` and `resolveStateFilePath()` parts of today's `src/test/integration/build-service.test.ts`
 * and from `src/commands/clear.ts`.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonObject } from "@sous-io/plugin-api";
import { loadState } from "../src/state.js";
import { makeCompiler, makeProject, type TestProject } from "./helpers.js";

let project: TestProject;

afterEach(() => {
    project?.remove();
});

/** An engine whose config can be swapped between builds. */
async function swappable(initial: JsonObject, extra: JsonObject = {}) {
    let compilation = initial;
    const compiler = await makeCompiler(project, { config: () => ({ ...extra, compilation }) });

    return {
        compiler,
        async swap(next: JsonObject) {
            compilation = next;
            await compiler.rebuild();
        },
    };
}

const statePath = () => path.join(project.sousDir, "sous.state.json");
const single = (entryPoint: string, ...destinations: string[]) => ({
    targets: [{ entryPoint, outputs: destinations.map((destinationFile) => ({ destinationFile })) }],
});

describe("compiler.prune", () => {
    /** A file the config no longer produces is removed, and its entry dropped. */
    it("should remove a file that is no longer in the config", async () => {
        project = makeProject();
        const src = project.write("source.md", "# Source\n");
        const stale = project.at("stale.md");
        const dest = project.at("dest.md");
        const { compiler, swap } = await swappable(single(src, stale));

        await compiler.compile();
        expect(fs.existsSync(stale)).toBe(true);

        await swap(single(src, dest));

        const result = await compiler.prune();

        expect(result).toEqual({ removed: [stale], dirsRemoved: [], dryRun: false });
        expect(fs.existsSync(stale)).toBe(false);
        expect(loadState(statePath()).files.find((entry) => entry.dest === stale)).toBeUndefined();
        expect(compiler.output()).toContain(`  ✗ pruned: ${stale}`);
    });

    /** A plain build (compile, then prune) removes an output dropped from the config. */
    it("should remove a file dropped from the config on a plain build", async () => {
        project = makeProject();
        const src = project.write("source.md", "# Source\n");
        const stale = project.at("stale.md");
        const dest = project.at("dest.md");
        const { compiler, swap } = await swappable(single(src, dest, stale));

        await compiler.compile();
        await swap(single(src, dest));
        await compiler.compile();
        await compiler.prune();

        expect(fs.existsSync(stale)).toBe(false);
        expect(fs.existsSync(dest)).toBe(true);
        expect(loadState(statePath()).files.map((entry) => entry.dest)).toEqual([dest]);
    });

    /** A directory sous made is removed once its last file is pruned. */
    it("should remove an empty Sous-created directory after its file is pruned", async () => {
        project = makeProject();
        const src = project.write("source.md", "# Source\n");
        const subDir = project.at("sous-created-dir");
        const stale = path.join(subDir, "output.md");
        const { compiler, swap } = await swappable(single(src, stale));

        await compiler.compile();
        expect(loadState(statePath()).dirs).toContain(subDir);

        await swap(single(src, project.at("dest.md")));

        const result = await compiler.prune();

        expect(result.dirsRemoved).toEqual([subDir]);
        expect(fs.existsSync(subDir)).toBe(false);
        expect(loadState(statePath()).dirs).not.toContain(subDir);
    });

    /** A directory that still holds a current output stays. */
    it("should leave a directory that still contains non-stale files", async () => {
        project = makeProject();
        const one = project.write("source.md", "# One\n");
        const two = project.write("source2.md", "# Two\n");
        const kept = project.at("shared-dir/kept.md");
        const stale = project.at("shared-dir/stale.md");
        const { compiler, swap } = await swappable({
            targets: [
                { entryPoint: one, outputs: [{ destinationFile: kept }] },
                { entryPoint: two, outputs: [{ destinationFile: stale }] },
            ],
        });

        await compiler.compile();
        await swap(single(one, kept));
        await compiler.prune();

        expect(fs.existsSync(stale)).toBe(false);
        expect(fs.existsSync(kept)).toBe(true);
        expect(fs.existsSync(project.at("shared-dir"))).toBe(true);
    });

    /** A dry run says what it would remove, and removes nothing, the state included. */
    it("should say 'would prune' but delete nothing when dryRun is true", async () => {
        project = makeProject();
        const src = project.write("source.md", "# Source\n");
        const stale = project.at("stale.md");
        const { compiler, swap } = await swappable(single(src, stale));

        await compiler.compile();
        await swap(single(src, project.at("dest.md")));

        const result = await compiler.prune({ dryRun: true });

        expect(result).toEqual({ removed: [stale], dirsRemoved: [], dryRun: true });
        expect(fs.existsSync(stale)).toBe(true);
        expect(compiler.output()).toContain(`  ○ would prune: ${stale}`);
        expect(loadState(statePath()).files.find((entry) => entry.dest === stale)).toBeDefined();
    });

    /**
     * Outputs are counted file by file, so when several targets write into one directory, a
     * file whose source is gone is pruned even though the directory is still written to.
     */
    it("should prune a glob target's output whose source is gone", async () => {
        project = makeProject();
        project.write("skills/a/SKILL.md", "A");
        project.write("skills/b/SKILL.md", "B");
        const { compiler } = await swappable({ targets: [{ entryGlob: "skills/**/*.md", outputs: [{ destinationDir: project.at(".claude/skills") }] }] });

        await compiler.compile();
        fs.rmSync(project.at("skills/b"), { recursive: true });
        await compiler.rebuild();

        const result = await compiler.prune();

        expect(result.removed).toEqual([project.at(".claude/skills/b/SKILL.md")]);
        expect(project.exists(".claude/skills/a/SKILL.md")).toBe(true);
    });

    /** Nothing inside a linked checkout or the recipe store is ever removed, whatever the state says. */
    it("should never remove a file inside a protected directory", async () => {
        project = makeProject();
        const src = project.write("source.md", "x");
        const linked = path.join(project.sousDir, "repos", "team", "x.md");
        const store = path.join(project.root, "sous-home", "cache", "x.md");
        const { compiler, swap } = await swappable(single(src, linked, store));

        await compiler.compile();
        await swap({ targets: [] });

        const result = await compiler.prune();

        expect(result.removed).toEqual([]);
        expect(fs.existsSync(linked)).toBe(true);
        expect(fs.existsSync(store)).toBe(true);
    });

    /** `all` (clear) removes every file the compiler wrote, its directories, and the state file. */
    it("should remove every output and the state file with all", async () => {
        project = makeProject();
        const src = project.write("source.md", "x");
        const one = project.at("out/one.md");
        const two = project.at("two.md");
        const { compiler } = await swappable(single(src, one, two));

        await compiler.compile();

        const result = await compiler.prune({ all: true });

        expect(result.removed.sort()).toEqual([one, two].sort());
        expect(result.dirsRemoved).toEqual([project.at("out")]);
        expect(fs.existsSync(one)).toBe(false);
        expect(fs.existsSync(statePath())).toBe(false);
    });

    /** `compiler.pruned` says what a prune removed. */
    it("should announce what it removed", async () => {
        project = makeProject();
        const src = project.write("source.md", "x");
        const heard: unknown[] = [];
        const compiler = await makeCompiler(project, {
            config: { compilation: single(src, project.at("a.md")) },
            register: (sous) => sous.on("compiler.pruned", (event) => void heard.push(event.payload)),
        });

        await compiler.compile();
        await compiler.prune({ all: true, dryRun: true });

        expect(heard).toEqual([{ removed: [project.at("a.md")], dryRun: true }]);
    });

    /** Removing a repository reads what it deletes from the state file (`filesFrom`). */
    it("should tell which files came from a repository", async () => {
        project = makeProject();
        const src = project.write("source.md", "x");
        const compiler = await makeCompiler(project, {
            config: {
                compilation: {
                    targets: [
                        { id: "r1", entryPoint: src, origin: { recipe: "ns/one", repository: "team" }, outputs: [{ destinationFile: project.at("one.md") }] },
                        { id: "r2", entryPoint: src, origin: { recipe: "ns/two", repository: "other" }, outputs: [{ destinationFile: project.at("two.md") }] },
                    ],
                },
            },
        });

        await compiler.compile();

        const state = compiler.engine.handle.config.services.get("compiler.state");

        expect(state.filesFrom({ repository: "team" }).map((entry) => entry.dest)).toEqual([project.at("one.md")]);
        expect(state.filesFrom({ recipe: "ns/two" }).map((entry) => entry.target)).toEqual(["r2"]);
    });
});

describe("the state file's path", () => {
    /** By default, `<sousDir>/sous.state.json`. */
    it("should default to <sousDir>/sous.state.json", async () => {
        project = makeProject();
        const compiler = await makeCompiler(project);

        expect(compiler.engine.handle.config.services.get("compiler.state").path()).toBe(statePath());
    });

    /** `_vars.stateFilePath` still wins, as before the refactor, `${sousDir}` substituted. */
    it("should honour a stateFilePath var, with ${sousDir} substituted", async () => {
        project = makeProject();
        const compiler = await makeCompiler(project, { config: { _vars: { stateFilePath: "${sousDir}/proj-state.json" } } });

        expect(compiler.engine.handle.config.services.get("compiler.state").path()).toBe(path.join(project.sousDir, "proj-state.json"));
    });

    /** `compilation.stateFile` sets it in the config. */
    it("should honour compilation.stateFile", async () => {
        project = makeProject();
        const src = project.write("source.md", "x");
        const compiler = await makeCompiler(project, { config: { compilation: { stateFile: "state/built.json", ...single(src, project.at("a.md")) } } });

        await compiler.compile();

        expect(fs.existsSync(project.at("state/built.json"))).toBe(true);
    });
});
