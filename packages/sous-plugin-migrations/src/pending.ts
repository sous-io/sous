/**
 * Which migrations are pending, and in what order they run.
 *
 * Luke's rule (2026-11-18): "every migration function is given a version and a 'order', which is
 * a number (higher numbers run last, ties use a predictable order, but its arbitrary), default
 * `500`. We store the last version migrations were run for. If the current version > last
 * migration version, we know we have migrations to run."
 *
 * The tie-break is the order the migrations were added (plugin order, then each plugin's own
 * order), which is fixed for a given set of plugins.
 */

import semver from "semver";
import type { MigrationEntity } from "./types.js";

/** The default `order`. */
export const DEFAULT_ORDER = 500;

/** Compares two versions, prereleases included. */
function compareVersions(left: string, right: string): number {
    return semver.compare(left, right);
}

/**
 * The migrations in the order they run: lowest version first, then lowest `order`, then as added.
 *
 * ```ts
 * orderMigrations([{ id: "b", version: "1.2.0", order: 500 }, { id: "a", version: "1.1.0", order: 900 }, { id: "c", version: "1.1.0", order: 100 }]);
 * // -> c, a, b
 * ```
 */
export function orderMigrations(migrations: readonly MigrationEntity[]): MigrationEntity[] {
    return migrations
        .map((migration, index) => ({ migration, index }))
        .sort((left, right) => compareVersions(left.migration.version, right.migration.version) || left.migration.order - right.migration.order || left.index - right.index)
        .map((entry) => entry.migration);
}

/**
 * The migrations a project migrated to `stored` has not run, in order. With no stored version
 * (a lockfile written before migrations existed) every migration is pending.
 */
export function pendingMigrations(migrations: readonly MigrationEntity[], stored: string | undefined): MigrationEntity[] {
    return orderMigrations(migrations).filter((migration) => stored === undefined || compareVersions(migration.version, stored) > 0);
}

/**
 * The version to store after migrations ran: the running version, or the highest version among
 * those that ran when it is higher (a migration may name the release it ships in before the
 * package's own version is raised), so nothing that ran is pending again.
 */
export function versionToStore(running: string, ran: readonly MigrationEntity[]): string {
    return ran.reduce((highest, migration) => (compareVersions(migration.version, highest) > 0 ? migration.version : highest), running);
}

/**
 * The version to store when a migration failed: the highest version every one of whose migrations
 * ran, so the failed one and every later one stay pending. Undefined when no version completed.
 *
 * ```ts
 * // ran: 1.1.0 (both of them), 1.2.0#1; failed: 1.2.0#2
 * versionReached(pending, ran) // -> "1.1.0"
 * ```
 */
export function versionReached(pending: readonly MigrationEntity[], ran: readonly MigrationEntity[]): string | undefined {
    const done = new Set(ran);
    let reached: string | undefined;

    for (const migration of pending) {
        if (!done.has(migration)) {
            break;
        }

        const next = pending[pending.indexOf(migration) + 1];

        // A version counts once its last migration ran.
        if (next === undefined || next.version !== migration.version) {
            reached = migration.version;
        }
    }

    return reached;
}

/** Whether one version is lower than another. */
export function semverLess(left: string, right: string): boolean {
    return compareVersions(left, right) < 0;
}

/** Whether `version` is a version sous can compare. */
export function isVersion(version: string): boolean {
    return semver.valid(version) !== null;
}
