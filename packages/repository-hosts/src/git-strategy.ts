/**
 * The git read strategy: a shallow, sparse fetch of the one file through
 * `git.runner.readRemoteFile`, with the user's own git credentials (SSH keys, credential helpers).
 * It tries the SSH address first, then HTTPS.
 */

import type {} from "@sous-io/plugin-git/types";
import type { CanonicalRepository } from "@sous-io/plugin-refs/types";
import type { ExplainedReadStrategy } from "./types.js";

/** Lines of git's error output that say what went wrong, most telling first. */
const TELLING_LINES = [/denied/i, /authentication failed/i, /not found/i, /could not resolve/i, /could not read/i, /fatal:/i];

/**
 * A read strategy that reads one file through git.
 *
 * ```ts
 * gitReadStrategy();
 * // tries git@gitlab.com:acme/recipes.git, then https://gitlab.com/acme/recipes.git
 * // reason on failure: "Permission denied (publickey)"
 * ```
 */
export function gitReadStrategy(options: { urls?: (repository: CanonicalRepository) => string[] } = {}): ExplainedReadStrategy {
    const urlsOf = options.urls ?? ((repository: CanonicalRepository) => [repository.sshUrl, repository.httpsUrl]);

    return {
        id: "git",
        label: "git",

        async read(request, ctx) {
            if (!ctx.services.has("git.runner")) {
                return { ok: false, reason: "git is not available" };
            }

            const git = ctx.services.get("git.runner");
            const reasons: string[] = [];

            for (const url of urlsOf(request.repository)) {
                try {
                    const text = await git.readRemoteFile(url, request.path, {
                        ref: request.ref,
                        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
                    });

                    return { ok: true, text, ref: request.ref };
                } catch (error) {
                    const reason = gitFailureReason(error);

                    if (!reasons.includes(reason)) {
                        reasons.push(reason);
                    }
                }
            }

            return { ok: false, reason: reasons.join("; ") || "git could not read it" };
        },

        fix: (repository) => `set up git access to ${repository.host} (an SSH key, or a credential helper)`,
    };
}

/**
 * The one line of a git failure that says why, without git's prefixes.
 *
 * ```ts
 * gitFailureReason(new Error("git@gitlab.com: Permission denied (publickey).\nfatal: Could not read from remote repository."));
 * // "Permission denied (publickey)"
 * ```
 */
export function gitFailureReason(error: unknown): string {
    const lines = errorLines(error);

    for (const pattern of TELLING_LINES) {
        const line = lines.find((candidate) => pattern.test(candidate));

        if (line !== undefined) {
            return clean(line);
        }
    }

    return clean(lines[0] ?? "git failed");
}

/** Every non-empty line of an error's message, its details and its stderr. */
function errorLines(error: unknown): string[] {
    const parts: string[] = [];

    if (error instanceof Error) {
        const { details, stderr } = error as Error & { details?: readonly string[]; stderr?: string };

        parts.push(...(stderr === undefined ? [] : [stderr]), ...(details ?? []), error.message);
    } else {
        parts.push(String(error));
    }

    return parts
        .flatMap((part) => part.split("\n"))
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

/** Drops `fatal:`, `remote:`, `git@host:` and a final full stop. */
function clean(line: string): string {
    return line
        .replace(/^(fatal|error|remote):\s*/i, "")
        .replace(/^[\w.-]+@[\w.-]+:\s*/, "")
        .replace(/\.$/, "")
        .trim();
}
