/**
 * The contract of plugin-github (S6, "Host and package-manager plugins"; S4): one
 * `repository-host` entity, `github`: reading indexes (HTTP with a token, HTTP without, then git),
 * the token (`GITHUB_TOKEN`, then `git credential fill`, then `gh`), proposing pull requests, and
 * the GitHub Actions workflow a scaffold writes. It declares no services, intents or events.
 */

import type {} from "@sous-io/plugin-git/types";
import type {} from "@sous-io/plugin-host/types";
import type { RepositoryHostEntity } from "@sous-io/plugin-recipes/types";

/** The id of the `repository-host` entity this plugin adds. */
export type GithubHostId = "github";

/** The entity, as this plugin adds it: features `fetch`, `submit` and `proposals`. */
export type GithubRepositoryHost = RepositoryHostEntity & { id: GithubHostId };

/** The read strategies it registers, in order (S4). */
export type GithubReadStrategyId = "http-token" | "http" | "git";

/** The token sources it registers, in order (S4). */
export type GithubTokenSourceId = "env" | "git-credential" | "gh";

/** This plugin's options (`plugins.options."@sous-io/plugin-github"`). */
export interface GithubPluginOptions {
    /** More hosts that are GitHub (GitHub Enterprise), besides `github.com`. */
    hosts?: string[];
    /** The environment variables a token is read from, in order. Default `["GITHUB_TOKEN", "GH_TOKEN"]`. */
    tokenVariables?: string[];
}
