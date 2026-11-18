import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Context } from "@sous-io/plugin-api";
import { checkGitHooks, gitHooksCheck, hooksWithBlock } from "./doctor-check.js";
import { HOOK_BLOCK_END, HOOK_BLOCK_START } from "./hooks.js";

let root: string;

beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sous-init-doctor-")));
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

/** Writes a hook file holding Sous's block. */
function hook(folder: string, name: string): void {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, name), `${HOOK_BLOCK_START}\npnpm install\n${HOOK_BLOCK_END}\n`);
}

/** A context whose git says the hooks folder is `hooksFolder` (or that there is no repository). */
function context(hooksFolder: string | undefined, runs: Array<{ intent: string; input: unknown }> = []): Context {
    const git = {
        run: async () => (hooksFolder === undefined ? { exitCode: 128, stdout: "", stderr: "not a git repository" } : { exitCode: 0, stdout: `${hooksFolder}\n`, stderr: "" }),
    };

    return {
        project: { root, sousDir: path.join(root, ".sous"), configPath: undefined, confDir: path.join(root, ".sous", "conf.d") },
        services: { has: (name: string) => name === "git.runner", get: () => git },
        run: async (intent: string, input: unknown) => {
            runs.push({ intent, input });

            return { toPlain: () => ({ installed: true, files: [], install: { command: "pnpm install", outcome: "ran" } }) };
        },
    } as unknown as Context;
}

describe("the git hooks doctor check", () => {
    /**
     * A project with Husky hook files is set up with hooks; they are on when git's hooks folder is
     * Husky's `.husky/_`.
     *
     * .husky/post-checkout holds the block, core.hooksPath = .husky/_ -> ok
     */
    it("should find Husky's hooks turned on", async () => {
        hook(path.join(root, ".husky"), "post-checkout");
        fs.mkdirSync(path.join(root, ".husky", "_"));

        expect(await checkGitHooks(context(path.join(root, ".husky", "_")))).toMatchObject({ status: "ok" });
    });

    /**
     * A fresh clone: the Husky files are committed, but the install that turns Husky on has not run.
     * The fix runs init.hooks with the install, keeping the pull hooks the project chose.
     *
     * .husky/post-checkout and post-merge, git's hooks folder .git/hooks -> problem; fix: init.hooks { install, pullHooks }
     */
    it("should report hooks that are not turned on, and fix them with init.hooks", async () => {
        hook(path.join(root, ".husky"), "post-checkout");
        hook(path.join(root, ".husky"), "post-merge");

        const runs: Array<{ intent: string; input: unknown }> = [];
        const ctx = context(path.join(root, ".git", "hooks"), runs);
        const found = await checkGitHooks(ctx);

        expect(found).toMatchObject({ status: "problem", fix: "Install the git hooks and run the package manager's install" });

        const fixed = await gitHooksCheck.fix!(ctx, { dryRun: false, yes: true, answers: [], configFailed: false });

        expect(runs).toEqual([{ intent: "init.hooks", input: { directory: root, install: true, pullHooks: true } }]);
        expect(fixed.summary).toContain("'pnpm install' ran");
    });

    /**
     * Without Husky, the hook is in git's own folder: found there it is ok; missing, the check cannot
     * tell a project that never had hooks from a clone, and reports ok without a fix.
     */
    it("should find a plain git hook, and change nothing when there is none", async () => {
        const folder = path.join(root, ".git", "hooks");

        expect(await checkGitHooks(context(folder))).toMatchObject({ status: "ok", summary: expect.stringContaining("cannot tell") });

        hook(folder, "post-checkout");
        expect(hooksWithBlock(folder)).toEqual(["post-checkout"]);
        expect(await checkGitHooks(context(folder))).toMatchObject({ status: "ok", summary: "The git hooks are installed: post-checkout." });
        expect(await checkGitHooks(context(undefined))).toMatchObject({ status: "ok", summary: expect.stringContaining("not in a git repository") });
    });
});
