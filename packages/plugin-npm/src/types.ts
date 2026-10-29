/**
 * The contract of plugin-npm (S6, "Host and package-manager plugins"): one `package-manager`
 * entity, `npm`, that detects npm, lists installed packages and plans installs. It declares no
 * services, intents or events of its own.
 */

import type {} from "@sous-io/plugin-host/types";
import type { PackageManagerEntity } from "@sous-io/plugin-update/types";

/** The id of the `package-manager` entity this plugin adds. */
export type NpmManagerId = "npm";

/** The entity, as this plugin adds it. */
export type NpmPackageManager = PackageManagerEntity & { id: NpmManagerId };

/** This plugin's options (`plugins.options."@sous-io/plugin-npm"`). */
export interface NpmPluginOptions {
    /** The command to run instead of `npm`. */
    command?: string;
}
