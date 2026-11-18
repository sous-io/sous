/**
 * The migrations Claude Code's part of sous adds for the version that renamed its harness and moved
 * its memories file. Both run once per project, through `sous upgrade` or `sous doctor`.
 */

import type { Sous } from "@sous-io/plugin-api";
import type {} from "@sous-io/sous-plugin-migrations/types";
import { memoriesMigration } from "./memories.js";
import { toolsKeyMigration } from "./tools.js";

/**
 * The version of sous these migrations belong to: the release that ships the harness id
 * `claude-code` and `.claude/rules/SOUS-MEMORIES.md`. A project migrated to an earlier version runs
 * them.
 */
export const MIGRATIONS_VERSION = "1.1.0";

/** Adds both migrations. */
export function registerMigrations(sous: Pick<Sous, "migrations">): void {
    sous.migrations.add(toolsKeyMigration(MIGRATIONS_VERSION));
    sous.migrations.add(memoriesMigration(MIGRATIONS_VERSION));
}
