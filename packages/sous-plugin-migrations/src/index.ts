/**
 * sous-plugin-migrations: sous's own migrations. A plugin adds one with
 * `sous.migrations.add({ version, order, up })`; the project's lockfile records the version of
 * sous whose migrations it last ran (`migratedVersion`); `migrations.run` runs the pending ones,
 * and `sous upgrade` and `sous doctor` call it; every other command prints one line when some are
 * pending.
 *
 * The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, jsonSchema, type PluginDefinition } from "@sous-io/plugin-api";
import { DOCTOR_CHECK_ORDER, type DoctorCheckEntity } from "@sous-io/sous-plugin-doctor";
import type {} from "@sous-io/plugin-recipes/types";
import { pendingNotice } from "./notice.js";
import { DEFAULT_ORDER, isVersion } from "./pending.js";
import { valuesOf } from "./run.js";
import { createMigrationsService } from "./service.js";
import type { MigrationDefinition, MigrationEntity, MigrationsRunInput, MigrationsRunResult, MigrationsService } from "./types.js";
import "./types.js";
import packageJson from "../package.json" with { type: "json" };

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/sous-plugin-migrations";

/** The `migration` kind's schema. `up` and `answered` are functions, which JSON Schema cannot describe. */
const migrationSchema = jsonSchema<MigrationEntity>({
    type: "object",
    required: ["id", "version", "order", "description", "plugin"],
    properties: {
        id: { type: "string" },
        version: { type: "string", description: "The version of sous this migration belongs to." },
        order: { type: "number", description: "Among migrations of one version, a higher number runs later." },
        description: { type: "string" },
        plugin: { type: "string" },
    },
});

const runInput = jsonSchema<MigrationsRunInput>({
    type: "object",
    properties: {
        yes: { type: "boolean", default: false, description: "Take every question's default instead of asking." },
        answer: { type: "array", items: { type: "string" }, description: "Answer a migration's question ahead of time, as <name>=<value>." },
        dryRun: { type: "boolean", default: false, description: "List the pending migrations and their answers, and change nothing." },
    },
    additionalProperties: false,
});

/** Turns what a plugin passed to `sous.migrations.add` into the entity, checking the version. */
export function toEntity(migration: MigrationDefinition, plugin: string, index: number): MigrationEntity {
    if (typeof migration.version !== "string" || !isVersion(migration.version)) {
        throw new Error(`${plugin} added a migration whose version "${String(migration.version)}" is not a version such as 1.2.0.`);
    }

    if (typeof migration.up !== "function") {
        throw new Error(`${plugin} added the migration for sous ${migration.version} without an up function.`);
    }

    const id = migration.id ?? `${plugin}@${migration.version}#${index}`;

    return {
        id,
        version: migration.version,
        order: migration.order ?? DEFAULT_ORDER,
        description: migration.description ?? `The migration ${id}`,
        plugin,
        up: migration.up,
        ...(migration.questions === undefined ? {} : { questions: migration.questions }),
    };
}

/** The doctor check for pending migrations: its fix runs them, and they ask their own questions. */
export const migrationsCheck: DoctorCheckEntity = {
    id: "migrations",
    order: DOCTOR_CHECK_ORDER.migrations,
    description: "Every migration for this version of sous has run",
    confirm: false,
    check(ctx, run) {
        if (run.configFailed) {
            return { status: "skipped", summary: "Skipped: the config did not load." };
        }

        const pending = (ctx.services.get("migrations") as MigrationsService).pending();

        if (pending.length === 0) {
            return { status: "ok" };
        }

        // Without a terminal, --yes or an answer, a question cannot be answered, so nothing would
        // run (spec 19, 7-e). That waits on a person rather than being a problem: it does not fail
        // the command, which scripts calling `sous doctor` rely on.
        const given = new Set(answersForMigrations(ctx, run.answers).map((entry) => entry.slice(0, entry.indexOf("=")).trim()));
        const waiting = run.yes || ctx.prompter.interactive
            ? []
            : pending.flatMap((migration) => (migration.questions ?? []).filter((question) => question.answered?.(ctx, {}) === undefined && !given.has(question.id)));

        if (waiting.length > 0) {
            return {
                status: "pending",
                summary: `${pending.length === 1 ? "1 migration is" : `${pending.length} migrations are`} waiting to run, and sous could not ask ${waiting.length === 1 ? "its question" : "their questions"} without a terminal.`,
                details: waiting.map((question) => `${question.message} Answer it with --answer ${question.id}=<${valuesOf(question).join("|")}> (--yes takes ${question.default}).`),
            };
        }

        return {
            status: "problem",
            summary: `${pending.length === 1 ? "1 migration is" : `${pending.length} migrations are`} waiting to run.`,
            details: pending.map((migration) => `${migration.description} [sous ${migration.version}]`),
            fix: "Run the pending migrations",
        };
    },
    async fix(ctx, run) {
        const outputs = await ctx.run("migrations.run", { ...(run.yes ? { yes: true } : {}), ...(run.answers.length === 0 ? {} : { answer: answersForMigrations(ctx, run.answers) }) });
        const result = outputs.toPlain() as MigrationsRunResult;

        if (result.unanswered.length > 0) {
            return {
                summary: "No migration ran: sous could not ask their questions without a terminal.",
                details: result.unanswered.map((question) => `${question.message} Answer it with --answer ${question.question}=<${question.values.join("|")}> (--yes takes ${question.default}).`),
            };
        }

        return {
            summary: `${result.migrations.length === 1 ? "1 migration ran" : `${result.migrations.length} migrations ran`}; the project is recorded as migrated to sous ${result.to}.`,
            details: result.migrations.map((report) => `${report.description}${report.outcome?.summary === undefined ? "" : `: ${report.outcome.summary}`}`),
        };
    },
};

/**
 * The `--answer` entries of `sous doctor` that answer a migration's question: `sous doctor` takes
 * one `--answer` list for migrations and recipe variables alike.
 */
function answersForMigrations(ctx: Parameters<NonNullable<DoctorCheckEntity["fix"]>>[0], answers: readonly string[]): string[] {
    const ids = new Set((ctx.services.get("migrations") as MigrationsService).all().flatMap((migration) => (migration.questions ?? []).map((question) => question.id)));

    return answers.filter((entry) => ids.has(entry.slice(0, Math.max(0, entry.indexOf("="))).trim()));
}

/** The plugin. */
export const migrationsPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: packageJson.version,
    description: "Sous's own migrations, the version a project last migrated to, and the notice that some are waiting.",
    dependsOn: {
        "@sous-io/sous-plugin-doctor": `^${packageJson.version}`,
    },

    register(sous) {
        sous.entities.define("migration", migrationSchema, {
            description: "A step that brings a project's files in line with a newer version of sous.",
        });

        const counts = new Map<string, number>();

        sous.extensions.add("migrations", (other) => ({
            add(migration: MigrationDefinition) {
                const index = (counts.get(other.plugin.name) ?? 0) + 1;

                counts.set(other.plugin.name, index);
                other.entities.add("migration", toEntity(migration, other.plugin.name, index));
            },
        }));

        sous.services.add("migrations", (_config, ctx) => createMigrationsService(ctx, sous.engine.app.version), { lifetime: "config" });

        sous.entities.add("doctor-check", migrationsCheck);

        sous.intents.add({
            intent: "migrations.run",
            summary: "Run the migrations from newer versions of sous that this project has not run",
            input: runInput,
            requiresProject: true,
            cli: {
                command: ["migrations", "run"],
                // `sous upgrade` runs it in the new copy, and `sous doctor` runs it here; people use `sous doctor`.
                hidden: true,
                flags: { yes: { short: "y", aliases: ["force"] } },
            },
            load: () => import("./run.js"),
        });

        sous.on("*.before", pendingNotice());

        // A project's first lockfile records the running version: nothing an older version wrote is
        // there to migrate (spec 19: "`sous init` stores the running version in a new project").
        sous.on("recipes.locked", async (event, ctx) => {
            if (event.payload.created === true && ctx.services.has("recipes.lock")) {
                const lock = ctx.services.get("recipes.lock");

                if (lock.migratedVersion() === undefined && isVersion(ctx.engine.app.version)) {
                    await lock.setMigratedVersion(ctx.engine.app.version);
                }
            }
        });
    },
});

export default migrationsPlugin;

export { orderMigrations, pendingMigrations, versionReached, versionToStore, DEFAULT_ORDER } from "./pending.js";
export { noticeText, QUIET_INTENTS } from "./notice.js";
export type * from "./types.js";
