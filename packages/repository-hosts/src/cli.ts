/**
 * Driving a host's own CLI (`gh`, `glab`) through `host.processes` (timed, L5). Only proposing
 * changes needs one (S4); reading never does.
 */

import { ConfigError } from "@sous-io/plugin-api";
import type { Environment } from "@sous-io/plugin-api";
import type { ProcessResult } from "@sous-io/plugin-host/types";
import type { RepositoryAuthStatus, RepositoryHostCli, RepositoryHostContext } from "@sous-io/plugin-recipes/types";
import { commandDirectory } from "./token-sources.js";

/** How to run one CLI command. */
export interface CliRunOptions {
    /** More environment variables: `GH_HOST`, `GITLAB_HOST`. */
    env?: Environment;
}

/**
 * Runs the CLI, failing with how to install it when it is missing.
 *
 * ```ts
 * const result = await runCli(GH, ["pr", "create", "--repo", "o/r"], ctx);
 * ```
 */
export async function runCli(cli: RepositoryHostCli, args: readonly string[], ctx: RepositoryHostContext, options: CliRunOptions = {}): Promise<ProcessResult> {
    const processes = ctx.services.get("host.processes");

    if ((await processes.which(cli.command, ctx.env)) === undefined) {
        throw new ConfigError(`${capitalized(cli.label)} ('${cli.command}') is not installed.`, {
            details: [`Sous needs it only to propose changes. Install it from ${cli.install}, then run '${cli.command} auth login'.`],
        });
    }

    return processes.run(cli.command, args, {
        cwd: commandDirectory(ctx),
        env: { ...ctx.env, ...options.env },
        label: `${cli.command} ${args.slice(0, 2).join(" ")}`,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });
}

/** The CLI's trimmed output, or `undefined` when it failed, is missing, or printed nothing. */
export async function cliOutput(cli: RepositoryHostCli, args: readonly string[], ctx: RepositoryHostContext, options: CliRunOptions = {}): Promise<string | undefined> {
    try {
        const result = await runCli(cli, args, ctx, options);
        const output = result.stdout.trim();

        return result.exitCode === 0 && output.length > 0 ? output : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Runs a CLI command that prints JSON, and parses it.
 *
 * @param what - The subcommand, for a failure: `pr list`.
 * @param noun - What the JSON describes, for a failure: `pull request`.
 */
export async function cliJson<T>(cli: RepositoryHostCli, args: readonly string[], what: string, noun: string, ctx: RepositoryHostContext, options: CliRunOptions = {}): Promise<T> {
    const result = await runCli(cli, args, ctx, options);

    if (result.exitCode !== 0) {
        throw cliFailure(cli, what, result, "");
    }

    try {
        return JSON.parse(result.stdout) as T;
    } catch {
        throw new ConfigError(`'${cli.command} ${what}' printed something that is not JSON, so sous cannot read the ${noun} it describes.`);
    }
}

/**
 * The error for a CLI command that failed: what was run, what did not happen, and what it said.
 *
 * ```ts
 * cliFailure(GH, "pr create", result, "so no proposal was opened");
 * // "'gh pr create' did not succeed, so no proposal was opened." + what gh printed
 * ```
 */
export function cliFailure(cli: RepositoryHostCli, what: string, result: Pick<ProcessResult, "stdout" | "stderr">, consequence: string): ConfigError {
    const reported = result.stderr.trim() || result.stdout.trim();

    return new ConfigError(`'${cli.command} ${what}' did not succeed${consequence.length === 0 ? "" : `, ${consequence}`}.`, {
        details: reported.length === 0 ? [] : reported.split("\n"),
    });
}

/**
 * The first URL in a command's output, where a host's CLI prints what it made.
 *
 * ```ts
 * firstUrlIn("https://github.com/o/r/pull/7\n"); // "https://github.com/o/r/pull/7"
 * ```
 */
export function firstUrlIn(output: string): string | undefined {
    return /https?:\/\/\S+/.exec(output)?.[0];
}

/** Whether the CLI is installed and signed in (`<cli> auth status`). */
export async function cliAuthStatus(cli: RepositoryHostCli, ctx: RepositoryHostContext, options: CliRunOptions = {}): Promise<RepositoryAuthStatus> {
    let ok = false;

    try {
        ok = (await runCli(cli, ["auth", "status"], ctx, options)).exitCode === 0;
    } catch {
        ok = false;
    }

    if (ok) {
        return { ok: true, detail: `${cli.label} ('${cli.command}') is installed and signed in.` };
    }

    return {
        ok: false,
        detail:
            `Sous proposes a change through ${cli.label} ('${cli.command}'), and it is either not installed or not signed in.\n` +
            `  Install it from ${cli.install}, then run '${cli.command} auth login'.`,
    };
}

function capitalized(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}
