/**
 * The text `sous init hooks` writes: the block it adds to a git hook file, and the package script
 * that runs `sous build` after an install. Pure functions over strings, so the plan and the dry run
 * are exactly what a real run writes.
 *
 * A git worktree starts without Sous's output, which is git-ignored. Git runs `post-checkout`
 * whenever a worktree is created or a branch is checked out, whoever ran git, so the hook is what
 * gets the output there:
 *
 * ```text
 * git worktree add / git checkout <branch>
 *   -> .husky/post-checkout runs `pnpm install`
 *      -> pnpm runs the "prepare" script
 *         -> sous build
 * ```
 *
 * Without a `package.json` the hook in the repository's own hooks folder runs `sous build`
 * directly. Either way the hook prints a failure and exits 0, so git carries on.
 */

import type { GitHookName } from "./types.js";

/** Husky's folder at the project root. */
export const HUSKY_DIR = ".husky";

/** The Husky range added to `devDependencies`. */
export const HUSKY_RANGE = "^9.1.7";

/** The hooks installed by default: the one git runs after a checkout and a new worktree. */
export const DEFAULT_HOOKS: readonly GitHookName[] = ["post-checkout"];

/** The hooks installed on request: after a pull that merges, and after a rebase. */
export const PULL_HOOKS: readonly GitHookName[] = ["post-merge", "post-rewrite"];

/** The name inside the markers of Sous's block in a hook file. */
const BLOCK_NAME = "init hooks";

/** The opening marker of Sous's block in a hook file. */
export const HOOK_BLOCK_START = `# >>> sous managed: ${BLOCK_NAME} (do not edit between these markers)`;

/** The closing marker of Sous's block in a hook file. */
export const HOOK_BLOCK_END = `# <<< sous managed: ${BLOCK_NAME}`;

/**
 * When each hook acts, as a shell test of the arguments git passes it, and what to call the event.
 * `post-checkout` acts on a branch checkout (its third argument is 1), which includes a new
 * worktree and a clone, and not on a checkout of single files. `post-rewrite` acts after a rebase,
 * not after an amend, which leaves the files as they were.
 */
const EVENTS: Readonly<Record<GitHookName, { readonly test?: string; readonly event: string }>> = {
    "post-checkout": { test: '[ "$3" = "1" ]', event: "a checkout" },
    "post-merge": { event: "a merge" },
    "post-rewrite": { test: '[ "$1" = "rebase" ]', event: "a rebase" },
};

/** What a hook runs, and how it was set up. */
export interface HookCommand {
    /** The command line: `pnpm install`, or `sous build`. */
    readonly command: string;
    /** `husky` when the install runs `sous build` through a package script; `git` when the hook runs it itself. */
    readonly via: "husky" | "git";
    /** The package script the install runs, with Husky. */
    readonly script?: "prepare" | "postinstall";
}

/**
 * Sous's block for one hook, markers included, ending in a newline. With Husky it runs the
 * install; without, it runs `sous build`, and does nothing when there is no `sous` command.
 *
 * ```sh
 * # >>> sous managed: init hooks (do not edit between these markers)
 * # After a checkout, install the dependencies; the "prepare" script then runs `sous build`, so the
 * # files Sous writes match this checkout. A failure is printed, and git carries on.
 * if [ "$3" = "1" ]; then
 *   pnpm install || echo "sous: 'pnpm install' failed after a checkout; git carried on." >&2
 * fi
 * # <<< sous managed: init hooks
 * ```
 */
export function hookBlock(hook: GitHookName, run: HookCommand): string {
    const { test, event } = EVENTS[hook];
    const explanation =
        run.via === "husky"
            ? [`# After ${event}, install the dependencies; the "${run.script ?? "prepare"}" script then runs \`sous build\`, so the`, "# files Sous writes match this checkout. A failure is printed, and git carries on."]
            : [`# After ${event}, run \`sous build\`, so the files Sous writes match this checkout. Nothing`, "# happens without a `sous` command. A failure is printed, and git carries on."];
    const tests = [...(test === undefined ? [] : [test]), ...(run.via === "git" ? ["command -v sous >/dev/null 2>&1"] : [])];
    const line = `${run.command} || echo "sous: '${run.command}' failed after ${event}; git carried on." >&2`;
    const body = tests.length === 0 ? [line] : [`if ${tests.join(" && ")}; then`, `  ${line}`, "fi"];

    return [HOOK_BLOCK_START, ...explanation, ...body, HOOK_BLOCK_END, ""].join("\n");
}

/**
 * A hook file's text with Sous's block in it: the block replaced where the markers already are,
 * added after the existing lines otherwise, or a new file. A new file in git's own hooks folder
 * starts with `#!/bin/sh`; a Husky hook needs no first line.
 *
 * @throws Error when the opening marker has no closing one, so the end of the block is unknown.
 */
export function applyHookBlock(existing: string | undefined, block: string, via: "husky" | "git"): string {
    if (existing === undefined || existing.trim() === "") {
        return via === "git" ? `#!/bin/sh\n${block}` : block;
    }

    const lines = existing.split("\n");
    const start = lines.findIndex((line) => line.trim() === HOOK_BLOCK_START);

    if (start === -1) {
        const prefix = existing.endsWith("\n") ? existing : `${existing}\n`;

        return `${prefix}\n${block}`;
    }

    const end = lines.findIndex((line, index) => index > start && line.trim() === HOOK_BLOCK_END);

    if (end === -1) {
        throw new Error(`Sous's block opens with '${HOOK_BLOCK_START}' but the line '${HOOK_BLOCK_END}' is missing, so sous cannot tell where it ends.`);
    }

    const before = lines.slice(0, start).map((line) => `${line}\n`).join("");

    return `${before}${block}${lines.slice(end + 1).join("\n")}`;
}

/**
 * The package script that runs `sous build` after an install, with Husky's own command in front
 * when the script lacks it. `|| exit 0` is the guard: a missing `sous` (an install that leaves out
 * dev dependencies) or a failed build prints its error and does not fail the install. The syntax
 * (`&&`, `||`, parentheses, `exit`) works in sh, in Windows' cmd.exe and in Yarn's own shell. An
 * existing script keeps what it has, and Sous's part runs after it. Returns `undefined` when the
 * script already runs both.
 *
 * ```ts
 * composeScript(undefined);   // "husky && sous build || exit 0"
 * composeScript("husky");     // "husky && (sous build || exit 0)"
 * composeScript("tsc -b");    // "tsc -b && (husky && sous build || exit 0)"
 * ```
 */
export function composeScript(existing: string | undefined): string | undefined {
    const current = existing?.trim() ?? "";
    const parts = [...(/(^|[\s;&|(])husky($|[\s;&|)])/.test(current) ? [] : ["husky"]), ...(/\bsous build\b/.test(current) ? [] : ["sous build"])];

    if (parts.length === 0) {
        return undefined;
    }

    const ours = `${parts.join(" && ")} || exit 0`;

    return current === "" ? ours : `${current} && (${ours})`;
}

/**
 * The lines to add by hand when `.sous/` is not at the top of the git repository: a hook line that
 * changes into the project's folder first, and, with a `package.json`, the script.
 *
 * @param relative - The project's folder from the top of the repository, with `/` separators.
 */
export function manualLines(relative: string, run: HookCommand): string[] {
    const hookLine = `(cd "${relative}" && ${run.command}) || echo "sous: '${run.command}' failed after a checkout; git carried on." >&2`;

    return [
        `In the repository's post-checkout hook${run.via === "husky" ? ` (${HUSKY_DIR}/post-checkout at the top of the repository, with Husky)` : ""}:`,
        `  ${hookLine}`,
        ...(run.via === "husky" ? [`In the "${run.script ?? "prepare"}" script of ${relative}/package.json, after what is there:`, "  sous build || exit 0"] : []),
    ];
}
