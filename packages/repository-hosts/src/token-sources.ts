/**
 * The three kinds of token source S4 names, tried in order by every hosted repository host:
 *
 * ```text
 * 1. the environment         GITLAB_TOKEN, GITHUB_TOKEN
 * 2. git credential fill     the credential git already stores for https://<host>
 * 3. the host's CLI          glab, gh: only when installed
 * ```
 *
 * A source that finds nothing gives `undefined`; none is ever required.
 */

import { tmpdir } from "node:os";
import type { RepositoryHostContext, RepositoryToken } from "@sous-io/plugin-recipes/types";
import type { CanonicalRepository } from "@sous-io/plugin-refs/types";
import type {} from "@sous-io/plugin-git/types";
import type {} from "@sous-io/plugin-host/types";
import { singleWord, tokenFromOutput } from "./token-output.js";
import type { ExplainedTokenSource, TokenLookup } from "./types.js";

/** How long a token command may run before it is given up on. */
const TOKEN_COMMAND_TIMEOUT_MS = 10_000;

/** The directory a token command runs in: the project, or anywhere harmless outside one. */
export function commandDirectory(ctx: RepositoryHostContext): string {
    return ctx.project?.root ?? tmpdir();
}

/** Turns a `find` into the contract's `token`. */
function tokenOf(source: Pick<ExplainedTokenSource, "find">) {
    return async (repository: CanonicalRepository, ctx: RepositoryHostContext): Promise<RepositoryToken | undefined> => {
        const found = await source.find(repository, ctx);

        return "token" in found ? found.token : undefined;
    };
}

/** Joins names the way a sentence lists them: `A`, `A and B`, `A, B and C`. */
function listed(names: readonly string[]): string {
    return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * A token from the first of some environment variables that is set.
 *
 * ```ts
 * envTokenSource({ variables: ["GITLAB_TOKEN"], tokenHint: "a token with read_repository" });
 * // finds ctx.env.GITLAB_TOKEN; when unset, the reason is "GITLAB_TOKEN unset"
 * ```
 *
 * @param options.tokenHint - What kind of token to export, for the fix line.
 */
export function envTokenSource(options: { variables: readonly string[]; tokenHint: string }): ExplainedTokenSource {
    const { variables } = options;

    const source: ExplainedTokenSource = {
        id: "env",
        label: listed(variables),

        async find(_repository, ctx): Promise<TokenLookup> {
            for (const name of variables) {
                const value = ctx.env[name]?.trim();

                if (value !== undefined && value.length > 0) {
                    return { token: { value, source: name } };
                }
            }

            return { missing: `${listed(variables)} unset` };
        },

        token: async () => undefined,

        fix: () => (variables.length === 0 ? undefined : `export ${variables[0]}=<${options.tokenHint}>`),
    };

    source.token = tokenOf(source);

    return source;
}

/**
 * The password git already stores for `https://<host>`, from `git credential fill`. Prompts are
 * switched off, so a missing credential fails at once instead of asking.
 */
export function gitCredentialTokenSource(): ExplainedTokenSource {
    const source: ExplainedTokenSource = {
        id: "git-credential",
        label: "git credential fill",

        async find(repository, ctx): Promise<TokenLookup> {
            const missing = { missing: `git has no stored credential for ${repository.host}` };

            if (!ctx.services.has("git.runner")) {
                return missing;
            }

            let result;

            try {
                result = await ctx.services.get("git.runner").run(["credential", "fill"], {
                    cwd: commandDirectory(ctx),
                    input: `protocol=https\nhost=${repository.host}\n\n`,
                    env: { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "", SSH_ASKPASS: "" },
                    timeoutMs: TOKEN_COMMAND_TIMEOUT_MS,
                    reject: false,
                    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
                });
            } catch {
                return missing;
            }

            if (result.exitCode !== 0) {
                return missing;
            }

            const password = passwordIn(result.stdout);

            return password === undefined ? missing : { token: { value: password, source: "git credential fill" } };
        },

        token: async () => undefined,
    };

    source.token = tokenOf(source);

    return source;
}

/**
 * The `password=` value `git credential fill` printed, when it is one word.
 *
 * ```ts
 * passwordIn("protocol=https\nhost=gitlab.com\nusername=me\npassword=glpat-x\n"); // "glpat-x"
 * ```
 */
export function passwordIn(output: string): string | undefined {
    for (const line of output.split(/\r?\n/)) {
        if (line.startsWith("password=")) {
            return singleWord(line.slice("password=".length));
        }
    }

    return undefined;
}

/**
 * A token printed by the host's own CLI (`glab`, `gh`), asked only when it is installed. Its output
 * passes the one-line check before it is used.
 *
 * ```ts
 * cliTokenSource({ id: "glab", command: "glab", args: (repo) => ["config", "get", "token", "--host", repo.host] });
 * ```
 */
export function cliTokenSource(options: {
    id: string;
    command: string;
    args: (repository: CanonicalRepository) => string[];
}): ExplainedTokenSource {
    const { command } = options;

    const source: ExplainedTokenSource = {
        id: options.id,
        label: command,

        async find(repository, ctx): Promise<TokenLookup> {
            const processes = ctx.services.get("host.processes");

            if ((await processes.which(command, ctx.env)) === undefined) {
                return { missing: undefined };
            }

            const args = options.args(repository);
            let result;

            try {
                result = await processes.run(command, args, {
                    cwd: commandDirectory(ctx),
                    env: ctx.env,
                    timeoutMs: TOKEN_COMMAND_TIMEOUT_MS,
                    label: `${command} token`,
                    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
                });
            } catch {
                return { missing: `${command} could not be run` };
            }

            const value = tokenFromOutput(result);

            return value === undefined ? { missing: `${command} printed no token for ${repository.host}` } : { token: { value, source: command } };
        },

        token: async () => undefined,
    };

    source.token = tokenOf(source);

    return source;
}
