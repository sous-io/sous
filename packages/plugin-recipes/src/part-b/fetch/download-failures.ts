/**
 * The error a build gives when recipes it needs could not be downloaded: each recipe with what went
 * wrong (git's own reason for each URL it tried, or the hint the failure carried), then one fix for
 * each kind of failure seen. Network advice is given only when git could not reach a host.
 */

import { ConfigError, isSousError } from "@sous-io/plugin-api";
import type { RecipeDownloadAttempt } from "../../types.js";
import { messageOf, plural } from "../support.js";

/** One recipe that could not be made active, and why. */
export interface RecipeFailure {
    readonly key: string;
    readonly error: unknown;
}

/**
 * The lines describing each failure, and the fixes that fit them.
 *
 * ```ts
 * describeFailures([{ key: "acme/widget", error: downloadError }]);
 * // {
 * //   lines: [
 * //     "acme/widget: Could not fetch 'recipes/acme/widget' at the tag 'acme/widget@0.1.0'.",
 * //     "  https://gitlab.com/acme/recipes.git: could not read Username for 'https://gitlab.com': terminal prompts disabled",
 * //   ],
 * //   fixes: ["Git has no credentials for gitlab.com. Set up git access to it (a credential helper or an SSH key), then run the command again."],
 * // }
 * ```
 */
export function describeFailures(failures: readonly RecipeFailure[]): { lines: string[]; fixes: string[] } {
    const lines: string[] = [];
    const attempts: RecipeDownloadAttempt[] = [];

    for (const failure of failures) {
        lines.push(`${failure.key}: ${messageOf(failure.error)}`);

        for (const detail of isSousError(failure.error) ? failure.error.details : []) {
            lines.push(`  ${detail}`);
        }

        attempts.push(...attemptsOf(failure.error));
    }

    return { lines, fixes: fixesFor(attempts) };
}

/** The error a build throws when recipes it needs could not be downloaded. */
export function downloadFailureError(failures: readonly RecipeFailure[]): ConfigError {
    const { lines, fixes } = describeFailures(failures);

    return new ConfigError(`Sous could not download ${failures.length === 1 ? "a recipe" : plural(failures.length, "recipe")} this project's subscriptions need.`, {
        details: [...lines, ...fixes],
    });
}

/** The clone attempts a download error carries (`RecipeDownloadError` in repository-hosts), or none. */
export function attemptsOf(error: unknown): readonly RecipeDownloadAttempt[] {
    const attempts = (error as { attempts?: unknown } | null)?.attempts;

    return Array.isArray(attempts) ? (attempts as RecipeDownloadAttempt[]) : [];
}

/** One fix for each kind of failure seen, in the order a user should try them. */
function fixesFor(attempts: readonly RecipeDownloadAttempt[]): string[] {
    const fixes: string[] = [];
    const seen = (problem: RecipeDownloadAttempt["problem"]) => attempts.filter((attempt) => attempt.problem === problem);
    const hostsOf = (list: readonly RecipeDownloadAttempt[]) => [...new Set(list.map((attempt) => attempt.host).filter((host): host is string => host !== undefined))];

    if (seen("git-missing").length > 0) {
        fixes.push("Sous needs git to download recipes, and git was not found on PATH. Install git, then run the command again.");

        // Every other attempt failed for the same reason; nothing else is worth saying.
        return fixes;
    }

    for (const host of hostsOf(seen("credentials"))) {
        fixes.push(`Git has no credentials for ${host}. Set up git access to it (a credential helper or an SSH key), then run the command again.`);
    }

    const unreachable = hostsOf([...seen("network"), ...seen("timeout")]);

    if (unreachable.length > 0) {
        fixes.push(`Git could not reach ${unreachable.join(" or ")}. Check the network, then run the command again.`);
    }

    if (seen("missing-tag").length > 0) {
        fixes.push("A tag the lockfile pins is not on its repository: it was released but never pushed. Ask whoever released it to push its tags ('sous repo release --push').");
    }

    return fixes;
}
