/**
 * The contract of plugin-pnpm: one `package-manager`
 * entity, `pnpm`, that detects pnpm (and its workspaces), lists installed packages and plans
 * installs. It declares no services, intents or events of its own.
 */

import type {} from "@sous-io/plugin-host/types";
import type { PackageManagerEntity } from "@sous-io/plugin-update/types";

/** The id of the `package-manager` entity this plugin adds. */
export type PnpmManagerId = "pnpm";

/** The entity, as this plugin adds it. */
export type PnpmPackageManager = PackageManagerEntity & { id: PnpmManagerId };

/** This plugin's options (`plugins.options."@sous-io/plugin-pnpm"`). */
export interface PnpmPluginOptions {
    /** The command to run instead of `pnpm`. */
    command?: string;
}
