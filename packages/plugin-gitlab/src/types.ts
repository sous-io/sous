/**
 * The contract of plugin-gitlab (S6, "Host and package-manager plugins"; S4): one
 * `repository-host` entity, `gitlab`, with S4's fixes: the index is read from the API address
 * (`/api/v4/projects/<owner>%2F<name>/repository/files/sous.index.json/raw?ref=HEAD`), and the token
 * from `GITLAB_TOKEN`, then `git credential fill`, then `glab config get token --host <host>`. It
 * declares no services, intents or events.
 */

import type {} from "@sous-io/plugin-git/types";
import type {} from "@sous-io/plugin-host/types";
import type { RepositoryHostEntity } from "@sous-io/plugin-recipes/types";

/** The id of the `repository-host` entity this plugin adds. */
export type GitlabHostId = "gitlab";

/** The entity, as this plugin adds it: features `fetch`, `submit` and `proposals`. */
export type GitlabRepositoryHost = RepositoryHostEntity & { id: GitlabHostId };

/** The read strategies it registers, in order (S4). */
export type GitlabReadStrategyId = "http-token" | "http" | "git";

/** The token sources it registers, in order (S4). */
export type GitlabTokenSourceId = "env" | "git-credential" | "glab";

/** This plugin's options (`plugins.options."@sous-io/plugin-gitlab"`). */
export interface GitlabPluginOptions {
    /** More hosts that are GitLab (self-managed instances), besides `gitlab.com`. */
    hosts?: string[];
    /** The environment variables a token is read from, in order. Default `["GITLAB_TOKEN"]`. */
    tokenVariables?: string[];
}
