/**
 * The `migrations` service: which migrations exist, which are pending for this project, and
 * recording a new project as migrated to the running version. The version is kept in the lockfile
 * by its owner, `recipes.lock`; this service only decides what it means.
 */

import type { ServiceContext } from "@sous-io/plugin-api";
import type {} from "@sous-io/plugin-recipes/types";
import { isVersion, orderMigrations, pendingMigrations } from "./pending.js";
import type { MigrationEntity, MigrationsService } from "./types.js";

/** The lockfile's owner, when the recipes plugin is loaded and there is a project. */
function lockOf(ctx: ServiceContext) {
    return ctx.project !== undefined && ctx.services.has("recipes.lock") ? ctx.services.get("recipes.lock") : undefined;
}

/** Makes the service for one config. `running` is the version of sous running now. */
export function createMigrationsService(ctx: ServiceContext, running: string): MigrationsService {
    const all = (): MigrationEntity[] => orderMigrations(ctx.entities.list("migration") as MigrationEntity[]);

    return {
        all,
        migratedVersion() {
            return lockOf(ctx)?.migratedVersion();
        },
        pending() {
            const lock = lockOf(ctx);

            // A project with no lockfile yet is new: it records the version that creates it.
            if (lock === undefined || !lock.exists()) {
                return [];
            }

            const stored = lock.migratedVersion();

            return pendingMigrations(all(), stored !== undefined && isVersion(stored) ? stored : undefined);
        },
        async markCurrent() {
            const lock = lockOf(ctx);

            if (lock !== undefined && isVersion(running)) {
                await lock.setMigratedVersion(running);
            }
        },
    };
}
