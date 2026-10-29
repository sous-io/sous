/**
 * The contract of plugin-local (S6, "Host and package-manager plugins"): one `repository-host`
 * entity, `local`, for a recipe repository on disk (`file://` URLs and absolute paths), for local
 * development and tests. It declares no services, intents or events.
 */

import type {} from "@sous-io/plugin-git/types";
import type {} from "@sous-io/plugin-host/types";
import type { RepositoryHostEntity } from "@sous-io/plugin-recipes/types";

/** The id of the `repository-host` entity this plugin adds. */
export type LocalHostId = "local";

/** The entity, as this plugin adds it: feature `fetch` only. */
export type LocalRepositoryHost = RepositoryHostEntity & { id: LocalHostId };

/** The read strategies it registers: reading the working tree, then a tag through git. */
export type LocalReadStrategyId = "file" | "git";
