/**
 * The GitHub CLI, needed only to propose changes (S4).
 */

import type { RepositoryHostCli } from "@sous-io/plugin-recipes/types";
import type { CanonicalRepository } from "@sous-io/repository-hosts";

/** `gh`. */
export const GH: RepositoryHostCli = {
    command: "gh",
    label: "the GitHub CLI",
    install: "https://cli.github.com",
};

/** `owner/name`, as gh's `--repo` takes it. */
export function repoArg(repository: CanonicalRepository): string {
    return `${repository.owner}/${repository.name}`;
}

/** The environment that points gh at the repository's host: `GH_HOST` for GitHub Enterprise. */
export function ghEnv(repository: CanonicalRepository): { env: Record<string, string> } {
    return { env: repository.host === "github.com" ? {} : { GH_HOST: repository.host } };
}
