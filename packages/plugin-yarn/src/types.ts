/**
 * The contract of plugin-yarn (S6, "Host and package-manager plugins"; S1, "Loading"): one
 * `package-manager` entity, `yarn` (Classic and Berry), and a `plugin-locator` entity (a kind core
 * defines) that finds plugins through Yarn Plug'n'Play's resolver. It declares no services,
 * intents or events of its own.
 */

import type { PluginLocatorEntity } from "@sous-io/plugin-api";
import type {} from "@sous-io/plugin-host/types";
import type { PackageManagerEntity } from "@sous-io/plugin-update/types";

/** The id of the `package-manager` entity this plugin adds. */
export type YarnManagerId = "yarn";

/** The entity, as this plugin adds it; `detect` reports `yarn@berry` for Yarn 2 and later. */
export type YarnPackageManager = PackageManagerEntity & { id: YarnManagerId };

/** The id of the `plugin-locator` entity this plugin adds. */
export type YarnPnpLocatorId = "yarn-pnp";

/** The locator, as this plugin adds it: it answers only in a Plug'n'Play project (`.pnp.cjs`). */
export type YarnPnpLocator = PluginLocatorEntity & { id: YarnPnpLocatorId };

/** This plugin's options (`plugins.options."@sous-io/plugin-yarn"`). */
export interface YarnPluginOptions {
    /** The command to run instead of `yarn`. */
    command?: string;
}
