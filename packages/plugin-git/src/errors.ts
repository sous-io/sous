/** The error `git.runner` throws when git fails. */

import { SousError } from "@sous-io/plugin-api";
import type { GitResult } from "./types.js";

/** The exit code git is given when it ran out of time (the code of `timeout(1)`). */
export const GIT_TIMEOUT_EXIT_CODE = 124;

/** Git exited non-zero, was stopped, or could not be started. Holds what git gave back. */
export class GitError extends SousError {
    /** What git gave back. */
    readonly result: GitResult;
    /** The directory git ran in. */
    readonly cwd: string | undefined;
    /** True when git was stopped for taking too long. */
    readonly timedOut: boolean;

    constructor(result: GitResult, options: { cwd?: string; timedOut?: boolean } = {}) {
        const timedOut = options.timedOut ?? false;
        const said = (result.stderr.trim() || result.stdout.trim()).split("\n").filter((line) => line.length > 0);
        const details: string[] = [];

        if (options.cwd !== undefined) {
            details.push(`It was run in ${options.cwd}.`);
        }

        details.push(...said);

        if (result.exitCode === 127) {
            details.push("Sous fetches recipes with git, so git must be installed and on your PATH.");
        }

        super(
            timedOut
                ? `The command 'git ${result.args.join(" ")}' did not finish in time and was stopped.`
                : `The command 'git ${result.args.join(" ")}' failed with exit code ${result.exitCode}.`,
            { details },
        );
        this.result = result;
        this.cwd = options.cwd;
        this.timedOut = timedOut;
    }
}
