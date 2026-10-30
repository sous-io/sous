/**
 * The `update.scan` contributor: when `plugins.discover` is `scan`, asks the package managers which
 * installed packages are sous plugins and adds them to `plugins.load`. The
 * engine loads what it adds and builds again.
 */

import type { ContributorDefinition, ServiceContext, Sous } from "@sous-io/plugin-api";
import type { PackageManagerEntity } from "./types.js";

/** The contributor's id. */
export const SCAN_CONTRIBUTOR = "update.scan";

/**
 * The context a package manager is asked with while the config is still being built: there is no
 * finished config to hand over yet, so `config` is the engine's latest one when it has one.
 */
function scanContext(sous: Sous): ServiceContext {
    return {
        plugin: sous.plugin.name,
        get config() {
            return sous.engine.config;
        },
        services: sous.services,
        entities: sous.entities,
        project: sous.project,
        env: sous.env,
    };
}

/** The scanning contributor. */
export function scanContributor(sous: Sous): ContributorDefinition {
    return {
        id: SCAN_CONTRIBUTOR,
        monitors: ["plugins.discover", "plugins.load", { entities: "package-manager" }],

        async contribute(config) {
            if (config.atPath("plugins.discover").valueOr<string>("dependencies") !== "scan" || config.project === undefined) {
                return;
            }

            const ctx = scanContext(sous);
            const root = config.project.root;
            const load = config.atPath("plugins.load");
            const known = new Set(load.valueOr<string[]>([]));
            const found = new Set<string>();

            for (const manager of config.entities("package-manager") as PackageManagerEntity[]) {
                try {
                    if ((await manager.detect(root, ctx)) === undefined) {
                        continue;
                    }

                    for (const pkg of await manager.installed("project", root, ctx)) {
                        if (pkg.isSousPlugin && !known.has(pkg.name)) {
                            found.add(pkg.name);
                        }
                    }
                } catch (error) {
                    config.log("warning", `${manager.id} could not list the installed packages: ${error instanceof Error ? error.message : String(error)}`);
                }
            }

            for (const name of [...found].sort()) {
                load.append(name);
            }
        },
    };
}
