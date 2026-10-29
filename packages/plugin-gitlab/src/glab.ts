/**
 * The GitLab CLI, needed only to propose changes (S4).
 */

import type { RepositoryHostCli } from "@sous-io/plugin-recipes/types";
import type { CanonicalRepository } from "@sous-io/repository-hosts";

/** `glab`. */
export const GLAB: RepositoryHostCli = {
    command: "glab",
    label: "the GitLab CLI",
    install: "https://gitlab.com/gitlab-org/cli",
};

/** `owner/name`, as glab's `--repo` takes it. */
export function projectArg(repository: CanonicalRepository): string {
    return `${repository.owner}/${repository.name}`;
}
