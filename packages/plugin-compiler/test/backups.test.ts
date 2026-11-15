/**
 * Backups through the compiler's intents: a build or prune that overwrites or removes content sous
 * did not produce copies it to `.sous/backups/<YYYY-MM-DD>/<HHMM-SS>/` first, and says so.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonObject } from "@sous-io/plugin-api";
import { makeCompiler, makeProject, type TestProject } from "./helpers.js";

let project: TestProject;

afterEach(() => {
    project?.remove();
});

const single = (entryPoint: string, ...destinations: string[]) => ({
    targets: [{ entryPoint, outputs: destinations.map((destinationFile) => ({ destinationFile })) }],
});

/** Every file under the project's backups directory, relative to it, with `/` separators. */
function backupsOf(): string[] {
    const dir = path.join(project.sousDir, "backups");

    if (!fs.existsSync(dir)) {
        return [];
    }

    return (fs.readdirSync(dir, { recursive: true }) as string[])
        .filter((entry) => fs.statSync(path.join(dir, entry)).isFile())
        .map((entry) => entry.split(path.sep).join("/"))
        .sort();
}

/** An engine whose config can be swapped between builds. */
async function swappable(initial: JsonObject) {
    let compilation = initial;
    const compiler = await makeCompiler(project, { config: () => ({ compilation }) });

    return {
        compiler,
        async swap(next: JsonObject) {
            compilation = next;
            await compiler.rebuild();
        },
    };
}

describe("backups before overwriting or removing", () => {
    /**
     * A build that overwrites a file sous did not write should back it up first, in
     * `.sous/backups/<YYYY-MM-DD>/<HHMM-SS>/<path>`, and report the backup and where it went.
     *
     * backed-up: /p/CLAUDE.md (backed up to /p/.sous/backups/2026-11-15/0912-04/CLAUDE.md)
     */
    it("should back up and report an untracked file the build overwrites", async () => {
        project = makeProject();
        const src = project.write("src.md", "COMPILED");
        const dest = project.write("CLAUDE.md", "the user's own");
        const compiler = await makeCompiler(project, { config: { compilation: single(src, dest) } });

        const result = await compiler.compile();
        const backup = result.outputs[0]?.backup;

        expect(backupsOf()).toEqual([expect.stringMatching(/^\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}\/CLAUDE\.md$/)]);
        expect(backup).toBe(path.join(project.sousDir, "backups", backupsOf()[0]!));
        expect(fs.readFileSync(backup!, "utf8")).toBe("the user's own");
        expect(project.read("CLAUDE.md")).toBe("COMPILED");
        expect(compiler.output()).toContain(`backed-up: ${dest} (backed up to ${backup})`);
    });

    /**
     * A build should not keep a hand edit to an output whose source did not change as sous's
     * own: it compiles the output again, backing up the edited copy first.
     *
     * build; edit CLAUDE.md by hand; build
     * // -> CLAUDE.md is the compiled content again, the edit is in .sous/backups/
     */
    it("should back up a hand-edited output on the next build and restore the compiled content", async () => {
        project = makeProject();
        const src = project.write("src.md", "COMPILED");
        const dest = project.at("CLAUDE.md");
        const compiler = await makeCompiler(project, { config: { compilation: single(src, dest) } });

        await compiler.compile();
        expect(backupsOf()).toEqual([]);

        project.write("CLAUDE.md", "COMPILED, edited by hand");

        const result = await compiler.compile();

        expect(result.outputs[0]?.action).toBe("updated");
        expect(project.read("CLAUDE.md")).toBe("COMPILED");
        expect(fs.readFileSync(result.outputs[0]!.backup!, "utf8")).toBe("COMPILED, edited by hand");
    });

    /**
     * A build that finds every output as sous wrote it, or a file already identical to the
     * output, should back up nothing.
     */
    it("should back up nothing when the content is sous's own or already identical", async () => {
        project = makeProject();
        const src = project.write("src.md", "COMPILED");
        const dest = project.write("CLAUDE.md", "COMPILED");
        const compiler = await makeCompiler(project, { config: { compilation: single(src, dest) } });

        await compiler.compile();
        await compiler.compile();
        await compiler.compile({ rebuild: true });

        expect(backupsOf()).toEqual([]);
        expect(compiler.output()).not.toContain("backed-up");
    });

    /**
     * A dry run should report the backup it would make and write nothing.
     *
     * would-back-up: /p/CLAUDE.md (would back up to /p/.sous/backups/.../CLAUDE.md)
     */
    it("should report a would-be backup on a dry run and write nothing", async () => {
        project = makeProject();
        const src = project.write("src.md", "COMPILED");
        const dest = project.write("CLAUDE.md", "the user's own");
        const compiler = await makeCompiler(project, { config: { compilation: single(src, dest) } });

        const result = await compiler.compile({ dryRun: true });

        expect(compiler.output()).toContain(`would-back-up: ${dest} (would back up to ${result.outputs[0]?.backup})`);
        expect(backupsOf()).toEqual([]);
        expect(project.read("CLAUDE.md")).toBe("the user's own");
    });

    /**
     * A prune that removes an output edited by hand should back it up first and report it inside
     * the removed outputs; an output still as sous wrote it is removed without a backup.
     */
    it("should back up a hand-edited output before prune removes it", async () => {
        project = makeProject();
        const src = project.write("src.md", "COMPILED");
        const edited = project.at("edited.md");
        const own = project.at("own.md");
        const kept = project.at("kept.md");
        const { compiler, swap } = await swappable(single(src, edited, own, kept));

        await compiler.compile();
        project.write("edited.md", "COMPILED, edited by hand");
        await swap(single(src, kept));

        const result = await compiler.prune();
        const backup = result.backedUp?.[0]?.backup;

        expect(result.removed).toEqual(expect.arrayContaining([edited, own]));
        expect(result.backedUp).toEqual([{ file: edited, backup: expect.stringMatching(/edited\.md$/) }]);
        expect(fs.readFileSync(backup!, "utf8")).toBe("COMPILED, edited by hand");
        expect(backupsOf()).toHaveLength(1);
        expect(compiler.output()).toContain(`backed-up: ${edited} (backed up to ${backup})`);
    });

    /**
     * Clearing (prune with `all`, which reports no removals itself) should still report each
     * backup, since the caller lists only the removed files.
     */
    it("should report backups when clearing without reporting removals", async () => {
        project = makeProject();
        const src = project.write("src.md", "COMPILED");
        const dest = project.at("CLAUDE.md");
        const compiler = await makeCompiler(project, { config: { compilation: single(src, dest) } });

        await compiler.compile();
        project.write("CLAUDE.md", "COMPILED, edited by hand");

        const result = await compiler.prune({ all: true, report: false });

        expect(result.removed).toEqual([dest]);
        expect(compiler.output()).toContain(`backed-up: ${dest} (backed up to ${result.backedUp?.[0]?.backup})`);
        expect(compiler.output()).not.toContain(`removed: ${dest}`);
    });

    /**
     * Every backup of one run should go in the same timestamp folder.
     */
    it("should put every backup of one run in one timestamp folder", async () => {
        project = makeProject();
        const src = project.write("src.md", "COMPILED");
        const first = project.write("one.md", "mine");
        const second = project.write(path.join("docs", "two.md"), "mine too");
        const compiler = await makeCompiler(project, { config: { compilation: single(src, first, second) } });

        await compiler.compile();

        const folders = new Set(backupsOf().map((entry) => entry.split("/").slice(0, 2).join("/")));

        expect(folders.size).toBe(1);
        expect(backupsOf().map((entry) => entry.split("/").slice(2).join("/"))).toEqual(["docs/two.md", "one.md"]);
    });
});
