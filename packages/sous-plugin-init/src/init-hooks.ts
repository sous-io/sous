/**
 * The `init.hooks` intent (`sous init hooks`): installs the git hooks that give a new worktree, or a
 * freshly checked-out branch, Sous's output. It is a one-time action: no later build puts the hooks
 * back, since a project may change them.
 *
 * - With a `package.json`: Husky is added as a dev dependency, `.husky/post-checkout` runs the
 *   package manager's install, and the script the manager runs after an install (`prepare` for npm
 *   and pnpm, `postinstall` for Yarn) runs Husky and `sous build`. Other hook managers are not
 *   detected. At the end it offers to run the install, which turns Husky on.
 * - Without one: the repository's own `post-checkout` hook runs `sous build` directly.
 *
 * `post-checkout` only by default; `post-merge` and `post-rewrite` on request. A hook file that
 * already exists keeps what it has, and gains Sous's block. Only a project whose `.sous/` is at the
 * top of the git repository is supported; anywhere else the intent stops and names the lines to
 * add by hand. Every question has a flag, and nothing prints or prompts directly.
 */

import fs from "node:fs";
import path from "node:path";
import { ConfigError, type Context, IntentOutput, IntentOutputs, VariableSet } from "@sous-io/plugin-api";
import "@sous-io/sous-plugin-config-files/types";
import type { GitRunner } from "@sous-io/sous-plugin-git/types";
import "@sous-io/sous-plugin-host/types";
import { ownerOf } from "@sous-io/sous-plugin-update";
import type { PlannedCommand } from "@sous-io/sous-plugin-update/types";
import { applyHookBlock, composeScript, DEFAULT_HOOKS, HUSKY_DIR, HUSKY_RANGE, hookBlock, type HookCommand, manualLines, PULL_HOOKS } from "./hooks.js";
import { planHooksPackageJson } from "./package-json.js";
import { sousDirFor } from "./scaffold.js";
import type { GitHookName, HookFileChange, InitHooksInput, InitHooksResult } from "./types.js";

/** What the hooks will run, with the install command when there is a package manager. */
export interface HooksRun extends HookCommand {
    /** The package manager's id, with a `package.json`. */
    readonly manager?: string;
    /** The install command, with a `package.json`. */
    readonly install?: PlannedCommand;
}

/** Whether hooks can be installed for a project, and if not, why and what to add by hand. */
export type HooksSupport = { readonly supported: true; readonly run: HooksRun } | { readonly supported: false; readonly reason: string; readonly manual: readonly string[]; readonly run?: HooksRun };

/** A command line as one string. */
function commandLine(command: PlannedCommand): string {
    return [command.command, ...command.args].join(" ");
}

/** The real path of a directory, or the path itself when it cannot be resolved. */
function real(directory: string): string {
    try {
        return fs.realpathSync(directory);
    } catch {
        return path.resolve(directory);
    }
}

/** The git runner, when the git plugin is loaded. */
function gitOf(ctx: Context): GitRunner | undefined {
    return ctx.services.has("git.runner") ? (ctx.services.get("git.runner") as GitRunner) : undefined;
}

/**
 * What the hooks run: the package manager's install with a `package.json`, `sous build` without.
 *
 * @throws ConfigError when there is a `package.json` but no package-manager plugin can plan an install.
 */
export async function planRun(ctx: Context, root: string): Promise<HooksRun> {
    if (!fs.existsSync(path.join(root, "package.json"))) {
        return { command: "sous build", via: "git" };
    }

    const owner = await ownerOf(root, ctx.entities.list("package-manager"), ctx);
    const install = owner?.entity.installCommand?.({ cwd: root });
    const script = owner?.entity.afterInstallScript;

    if (owner === undefined || install === undefined || script === undefined) {
        throw new ConfigError(`${root} has a package.json, but no package-manager plugin ${owner === undefined ? "claims the project" : `can plan an install for ${owner.detection.id}`}, so sous cannot tell which install command the hook should run.`, {
            details: ["Sous knows npm, pnpm and Yarn through its own plugins. Add the hook by hand, or load a plugin for your package manager."],
        });
    }

    return { command: commandLine(install), via: "husky", script, manager: owner.detection.id, install };
}

/**
 * Whether hooks can be installed: only when `.sous/` is at the top of the git repository, since the
 * hook runs there. Anywhere else, the reason and the lines to add by hand.
 */
export async function hooksSupport(ctx: Context, root: string): Promise<HooksSupport> {
    const git = gitOf(ctx);
    const top = git === undefined ? undefined : await git.run(["rev-parse", "--show-toplevel"], { cwd: root, reject: false });

    if (top === undefined || top.exitCode !== 0 || top.stdout.trim() === "") {
        return {
            supported: false,
            reason: `${root} is not inside a git repository, so there is no hooks folder to install into. Run 'git init' there first.`,
            manual: [],
        };
    }

    const topLevel = path.resolve(root, top.stdout.trim());

    if (real(topLevel) === real(root)) {
        return { supported: true, run: await planRun(ctx, root) };
    }

    const run = await planRun(ctx, root);
    const relative = path.relative(real(topLevel), real(root)).split(path.sep).join("/");

    return {
        supported: false,
        reason: `The git repository's top is ${topLevel}, but this project's .sous/ is in ${relative}/. Sous installs hooks only for a project at the top of its repository, because the hook, the install and the build would each run in a different folder. Add the lines below by hand instead.`,
        manual: manualLines(relative, run),
        run,
    };
}

/** The repository's own hooks folder: `core.hooksPath` when set, else `.git/hooks`, for a worktree too. */
async function gitHooksFolder(ctx: Context, root: string): Promise<string> {
    const result = await gitOf(ctx)!.run(["rev-parse", "--git-path", "hooks"], { cwd: root });

    return path.resolve(root, result.stdout.trim());
}

/**
 * Which hooks to install: `post-checkout`, and the pull hooks when the flag or the user says so.
 * `yes` and a dry run take the default, `post-checkout` only.
 */
async function chooseHooks(ctx: Context, input: InitHooksInput, dryRun: boolean): Promise<GitHookName[]> {
    const pull = await askPullHooks(ctx, input, dryRun);

    return [...DEFAULT_HOOKS, ...(pull ? PULL_HOOKS : [])];
}

/**
 * Whether to install the pull hooks too: the flag's answer, no under `yes` or in a dry run (the
 * default), else the user's answer.
 *
 * @throws NonInteractiveError when it has to ask and cannot.
 */
export async function askPullHooks(ctx: Context, input: { pullHooks?: boolean; yes?: boolean }, dryRun: boolean): Promise<boolean> {
    if (input.pullHooks !== undefined) {
        return input.pullHooks;
    }

    if (input.yes === true || dryRun) {
        return false;
    }

    return ctx.prompter.confirm({
        message: "Also install post-merge and post-rewrite, so the same runs after a pull and a rebase?",
        default: false,
        answeredBy: "--pull-hooks or --no-pull-hooks (--yes leaves them out)",
    });
}

/** Writes (or, in a dry run, plans) Sous's block into each hook file. */
function writeHooks(folder: string, hooks: readonly GitHookName[], run: HooksRun, dryRun: boolean): HookFileChange[] {
    return hooks.map((hook) => {
        const file = path.join(folder, hook);
        const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
        let next: string;

        try {
            next = applyHookBlock(existing, hookBlock(hook, run), run.via);
        } catch (error) {
            throw new ConfigError(`Sous cannot add its block to ${file}.`, { details: [(error as Error).message, "Add the closing marker back, or delete the opening one, and run 'sous init hooks' again."] });
        }

        const change: HookFileChange["change"] = existing === undefined ? "created" : next === existing ? "unchanged" : existing.includes("# >>> sous managed: init hooks") ? "updated" : "added";

        if (!dryRun && change !== "unchanged") {
            fs.mkdirSync(folder, { recursive: true });
            fs.writeFileSync(file, next, "utf8");
            fs.chmodSync(file, 0o755);
        }

        return { file, change };
    });
}

/** The note beside one hook file in the report. */
function changeNote(change: HookFileChange["change"], dryRun: boolean): string | undefined {
    switch (change) {
        case "added":
            return dryRun ? "would add Sous's block after the lines already there" : "Sous's block added after the lines already there";
        case "updated":
            return dryRun ? "would replace Sous's block" : "Sous's block replaced";
        default:
            return undefined;
    }
}

/**
 * Runs the package manager's install, which installs Husky (turning the hooks on) and runs
 * `sous build` through the package script: `--install` and `--yes` run it, `--no-install` skips it,
 * otherwise the user is asked. A failure is reported, not thrown: the hooks are in place either way.
 */
async function runInstall(ctx: Context, input: InitHooksInput, run: HooksRun, dryRun: boolean): Promise<NonNullable<Extract<InitHooksResult, { installed: true }>["install"]>> {
    const install = run.install!;
    const command = commandLine(install);

    if (input.install === false) {
        ctx.reporter.notice(`The hooks are not on until '${command}' runs: it installs Husky, which points git at ${HUSKY_DIR}/.`);

        return { command, outcome: "skipped" };
    }

    if (dryRun) {
        ctx.reporter.command(install.command, install.args, { dryRun: true });

        return { command, outcome: "planned" };
    }

    const proceed =
        input.install === true ||
        input.yes === true ||
        (await ctx.prompter.confirm({
            message: `Run '${command}' now? It installs Husky, which turns the hooks on, and its "${run.script}" script runs 'sous build'.`,
            default: true,
            answeredBy: "--install or --no-install (or --yes)",
        }));

    if (!proceed) {
        ctx.reporter.notice(`The hooks are not on until '${command}' runs: it installs Husky, which points git at ${HUSKY_DIR}/.`);

        return { command, outcome: "declined" };
    }

    ctx.reporter.command(install.command, install.args);

    const result = await ctx.services.get("host.processes").runInteractive(install.command, install.args, {
        ...(install.cwd === undefined ? {} : { cwd: install.cwd }),
        env: ctx.env,
        label: command,
        // A package manager is a `.cmd` shim on Windows; the command line is one sous planned.
        windowsShell: true,
    });
    const exitCode = result.exitCode ?? 1;

    if (exitCode !== 0) {
        ctx.reporter.warn(`'${command}' exited with code ${exitCode}. The hooks and the script are in place; the hooks are on once '${command}' succeeds.`);

        return { command, outcome: "failed", exitCode };
    }

    return { command, outcome: "ran", exitCode };
}

/** The closing output: what was installed, carrying the result. */
function summary(result: Extract<InitHooksResult, { installed: true }>, folder: string): IntentOutput<InitHooksResult> {
    return new IntentOutput<InitHooksResult>({
        title: "Git hooks",
        result: new VariableSet([
            { label: "Hooks", value: result.hooks.join(", "), detail: `in ${folder}` },
            { label: "Each hook runs", value: result.hookCommand, detail: "a failure is printed, and git carries on" },
            ...(result.script === undefined ? [] : [{ label: "Script", value: `${result.script.name}: ${result.script.text}`, detail: "in package.json; runs 'sous build' after an install" }]),
        ]),
        data: result,
    });
}

/** Runs the intent. */
export async function handle(input: InitHooksInput, ctx: Context): Promise<IntentOutputs<InitHooksResult>> {
    const dryRun = input.dryRun === true;
    const root = path.resolve(ctx.cwd, input.directory ?? ctx.project?.root ?? ".");

    if (!dryRun && ctx.services.get("config-files.loader").findMain(sousDirFor(root)) === undefined) {
        throw new ConfigError(`${root} is not set up for sous, so a hook that runs 'sous build' there would fail.`, {
            details: ["Run 'sous init' there first; it offers to install the hooks."],
        });
    }

    const support = await hooksSupport(ctx, root);

    if (!support.supported) {
        throw new ConfigError(`Sous did not install the git hooks. ${support.reason}`, { details: support.manual.length === 0 ? [] : support.manual });
    }

    const { run } = support;
    const hooks = await chooseHooks(ctx, input, dryRun);
    const folder = run.via === "husky" ? path.join(root, HUSKY_DIR) : await gitHooksFolder(ctx, root);
    const pkg = run.via === "husky" ? planHooksPackageJson(root, run.script!, HUSKY_RANGE, composeScript) : undefined;
    const files = writeHooks(folder, hooks, run, dryRun);

    if (pkg?.contents !== undefined && !dryRun) {
        fs.writeFileSync(pkg.file, pkg.contents, "utf8");
    }

    ctx.reporter.operationStart("Installing the git hooks");

    for (const { file, change } of files) {
        const note = changeNote(change, dryRun);

        ctx.reporter.operation(change === "unchanged" ? "unchanged" : dryRun ? "would-write" : "written", path.relative(root, file) || file, note === undefined ? {} : { note });
    }

    if (pkg?.contents !== undefined) {
        const what = [...(pkg.huskyAdded ? [`husky ${HUSKY_RANGE} in devDependencies`] : []), ...(pkg.script.changed ? [`the "${pkg.script.name}" script: ${pkg.script.text}`] : [])].join(", and ");

        ctx.reporter.operation(dryRun ? "would-write" : "written", "package.json", { note: `${dryRun ? "would set" : "set"} ${what}` });
    }

    const install = run.via === "husky" ? await runInstall(ctx, input, run, dryRun) : undefined;
    const result: Extract<InitHooksResult, { installed: true }> = {
        installed: true,
        root,
        via: run.via,
        hooks,
        files: [...files, ...(pkg?.contents === undefined ? [] : [{ file: pkg.file, change: "updated" as const }])],
        ...(run.manager === undefined ? {} : { manager: run.manager }),
        hookCommand: run.command,
        ...(pkg === undefined ? {} : { script: { name: pkg.script.name as "prepare" | "postinstall", text: pkg.script.text } }),
        install,
        dryRun,
    };

    return new IntentOutputs<InitHooksResult>(summary(result, folder));
}

export default handle;
