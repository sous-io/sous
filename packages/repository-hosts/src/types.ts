/**
 * What the shared token sources and read strategies add to the `repository-host` contract: a reason
 * when a source finds nothing (`GITLAB_TOKEN unset`), and the fix a user can apply when everything
 * fails (`export GITLAB_TOKEN=<a token with read_repository>`), for S4's combined error. Both are
 * extra members; a caller that knows only the contract uses `token` and `read` as usual.
 */

import type {
    RepositoryHostContext,
    RepositoryReadStrategy,
    RepositoryToken,
    RepositoryTokenSource,
} from "@sous-io/plugin-recipes/types";
import type { CanonicalRepository } from "@sous-io/plugin-refs/types";

/** What looking for a token found: a token, or why there is none (`undefined`: say nothing). */
export type TokenLookup = { readonly token: RepositoryToken } | { readonly missing: string | undefined };

/** A token source that can say why it found nothing. */
export interface ExplainedTokenSource extends RepositoryTokenSource {
    /** Like `token`, but with the reason when there is none: `GITLAB_TOKEN unset`. */
    find(repository: CanonicalRepository, ctx: RepositoryHostContext): Promise<TokenLookup>;
    /** One command that would make this source work: `export GITLAB_TOKEN=<a token with read_repository>`. */
    fix?(repository: CanonicalRepository): string | undefined;
}

/** A read strategy that can name a fix. */
export interface ExplainedReadStrategy extends RepositoryReadStrategy {
    /** One line that would make this strategy work: `set up git access to gitlab.com (an SSH key, or a credential helper)`. */
    fix?(repository: CanonicalRepository): string | undefined;
}

/** The `plugin-refs` types a host's methods take and give, for host plugins that import nothing else from it. */
export type { CanonicalRepository, LocationReading, WrittenLocation } from "@sous-io/plugin-refs/types";
