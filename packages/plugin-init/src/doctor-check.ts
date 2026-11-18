/**
 * `sous doctor`'s check that the git hooks are installed, when the project was set up with them.
 *
 * Nothing records that a project chose hooks, so the check reads what `sous init hooks` committed:
 *
 * - With Husky (a `package.json`): a file in `.husky/` holding Sous's marked block. The hooks are
 *   turned on in this clone when git's hooks folder is Husky's `.husky/_`, which Husky's own command
 *   sets when the package script runs it during an install. A fresh clone whose install has not run
 *   has the files and not the folder: that is the problem this check finds.
 * - Without a `package.json`: the hook lives in the repository's own hooks folder, which is never
 *   committed, so a clone that lacks it looks the same as a project that never had one. The check
 *   reports that it cannot tell, and changes nothing.
 *
 * The fix runs `init.hooks` with the install, which writes the same blocks again (unchanged) and
 * runs the package manager's install, turning Husky on.
 */

import fs from "node:fs";
import path from "node:path";
import type { Context } from "@sous-io/plugin-api";
import type { GitRunner } from "@sous-io/plugin-git/types";
import { DOCTOR_CHECK_ORDER, type DoctorCheckEntity, type DoctorCheckResult } from "@sous-io/sous-plugin-doctor";
import { DEFAULT_HOOKS, HOOK_BLOCK_START, HUSKY_DIR, PULL_HOOKS } from "./hooks.js";
import type { GitHookName, InitHooksResult } from "./types.js";

/** The hooks whose file holds Sous's block, in a folder. */
export function hooksWithBlock(folder: string): GitHookName[] {
    return [...DEFAULT_HOOKS, ...PULL_HOOKS].filter((hook) => {
        try {
            return fs.readFileSync(path.join(folder, hook), "utf8").includes(HOOK_BLOCK_START);
        } catch {
            return false;
        }
    });
}

/** The real path of a directory, or the path itself when it cannot be resolved. */
function real(directory: string): string {
    try {
        return fs.realpathSync(directory);
    } catch {
        return path.resolve(directory);
    }
}

/** Git's hooks folder for this clone (`core.hooksPath` when set), or `undefined` outside a repository. */
async function gitHooksFolder(ctx: Context, root: string): Promise<string | undefined> {
    if (!ctx.services.has("git.runner")) {
        return undefined;
    }

    const result = await (ctx.services.get("git.runner") as GitRunner).run(["rev-parse", "--git-path", "hooks"], { cwd: root, reject: false });

    return result.exitCode === 0 && result.stdout.trim() !== "" ? path.resolve(root, result.stdout.trim()) : undefined;
}

/** What the check finds. */
export async function checkGitHooks(ctx: Context): Promise<DoctorCheckResult> {
    const root = ctx.project?.root;

    if (root === undefined) {
        return { status: "skipped", summary: "There is no project here." };
    }

    const husky = hooksWithBlock(path.join(root, HUSKY_DIR));
    const folder = await gitHooksFolder(ctx, root);

    if (folder === undefined) {
        return husky.length === 0 ? { status: "ok", summary: "The project is not in a git repository, so it has no git hooks." } : { status: "skipped", summary: "Git cannot read this project's repository, so the hooks could not be checked." };
    }

    if (husky.length > 0) {
        const huskyFolder = path.join(root, HUSKY_DIR, "_");

        if (real(folder) === real(huskyFolder) && fs.existsSync(huskyFolder)) {
            return { status: "ok", summary: `The git hooks run through Husky: ${husky.join(", ")}.` };
        }

        return {
            status: "problem",
            summary: `The project was set up with git hooks (${husky.join(", ")} in ${HUSKY_DIR}/), but they are not turned on in this clone.`,
            details: [`Git runs the hooks in ${folder}; Husky's are in ${huskyFolder}, which its command sets up during the package manager's install.`],
            fix: "Install the git hooks and run the package manager's install",
            hint: "Run 'sous init hooks --install'.",
        };
    }

    const own = hooksWithBlock(folder);

    if (own.length > 0) {
        return { status: "ok", summary: `The git hooks are installed: ${own.join(", ")}.` };
    }

    return { status: "ok", summary: "No git hooks from 'sous init hooks' were found. A project without a package.json keeps them outside git, so a new clone cannot tell; 'sous init hooks' installs them." };
}

/** The check, at its reserved place. */
export const gitHooksCheck: DoctorCheckEntity = {
    id: "git-hooks",
    order: DOCTOR_CHECK_ORDER.gitHooks,
    description: "The git hooks are installed, when the project was set up with them",
    check: (ctx) => checkGitHooks(ctx),
    async fix(ctx) {
        const root = ctx.project!.root;
        const pullHooks = hooksWithBlock(path.join(root, HUSKY_DIR)).some((hook) => (PULL_HOOKS as readonly string[]).includes(hook));
        const result = (await ctx.run("init.hooks", { directory: root, install: true, pullHooks })).toPlain() as unknown as InitHooksResult;

        if (!result.installed) {
            return { summary: `The git hooks were not installed: ${result.reason}`, details: [...result.manual] };
        }

        return {
            summary: result.install?.outcome === "ran" ? `The git hooks are installed, and '${result.install.command}' ran.` : "The git hooks are written.",
            details: result.files.map((file) => `${file.file}: ${file.change}`),
        };
    },
};
