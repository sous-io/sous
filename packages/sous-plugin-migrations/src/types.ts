/**
 * The contract of the migrations plugin.
 *
 * A migration brings a project's files in line with a newer version of sous. Each belongs to the
 * version of sous that needs it; the project's lockfile records the version of sous whose
 * migrations it last ran (`migratedVersion`), and every migration of a later version is pending.
 *
 * ```ts
 * sous.migrations.add({
 *     version: "1.1.0",
 *     description: "Move the memories file out of the project's CLAUDE.md",
 *     questions: [
 *         {
 *             id: "memories.location",
 *             message: "Where should the memories file be written?",
 *             choices: [
 *                 { value: "move", label: "To .claude/rules/SOUS-MEMORIES.md (the new default)" },
 *                 { value: "keep", label: "To CLAUDE.md, as before" },
 *             ],
 *             default: "move",
 *             answered: (ctx) => (ctx.config.get("tools.claude-code.memoriesOutputPath") === undefined ? undefined : "keep"),
 *         },
 *     ],
 *     async up(ctx, { answers }) {
 *         // answers["memories.location"] is "move" or "keep"
 *         return { summary: "The memories file now goes to ..." };
 *     },
 * });
 * ```
 */

import type { Context } from "@sous-io/plugin-api";

/** One option of a question with choices. */
export interface MigrationChoice {
    /** What `--answer <id>=<value>` gives, and what `up` receives. */
    value: string;
    /** What the person sees. */
    label: string;
}

/**
 * A question a migration asks before it runs. Every question can be answered without a terminal
 * (law L4): `--answer <id>=<value>`, or `--yes`, which takes its default.
 */
export interface MigrationQuestion {
    /** Names it on the command line: `--answer <id>=<value>`. Unique across every migration. */
    id: string;
    /** The question, as a person reads it. */
    message: string;
    /** The options. Without any, it is a yes-or-no question answered `yes` or `no`. */
    choices?: readonly MigrationChoice[];
    /** The answer `--yes` takes: a choice's value, or `yes` or `no`. */
    default: string;
    /**
     * The answer the project's config already gives, if any. A question answered this way is not
     * asked: the project has already made the choice. `earlier` holds the answers to the same
     * migration's questions listed before this one, so a follow-up question can stand down when an
     * earlier answer makes it moot (it returns the answer that means "nothing to do").
     */
    answered?(ctx: Context, earlier: Readonly<Record<string, string>>): string | undefined;
}

/** What a migration did, for the report. */
export interface MigrationOutcome {
    /** One sentence stating what changed. */
    summary?: string;
    /** One line per change. */
    details?: readonly string[];
}

/** What `up` receives besides the context. */
export interface MigrationRun {
    /** Every question's answer, by question id. */
    readonly answers: Readonly<Record<string, string>>;
}

/** What `sous.migrations.add` takes. */
export interface MigrationDefinition {
    /** The version of sous this migration belongs to: it is pending for a project migrated to an earlier one. */
    version: string;
    /** `number = 500`. Among migrations of one version, a higher number runs later. */
    order?: number;
    /** Names it. Default: `<plugin>@<version>#<n>`, n counting the plugin's migrations from 1. */
    id?: string;
    /** One sentence saying what it changes. */
    description?: string;
    /** What it asks before it runs. */
    questions?: readonly MigrationQuestion[];
    /**
     * Brings the project's files in line. It neither prints nor prompts: its questions are asked
     * before it runs, and what it did is returned. There is no `down`.
     */
    up(ctx: Context, run: MigrationRun): MigrationOutcome | void | Promise<MigrationOutcome | void>;
}

/** A migration as the `migration` entity kind holds it. */
export interface MigrationEntity extends Required<Pick<MigrationDefinition, "version" | "order" | "id" | "description">> {
    questions?: readonly MigrationQuestion[];
    /** The plugin that added it. */
    plugin: string;
    up: MigrationDefinition["up"];
}

/** Reading which migrations are pending, for the notice, `sous doctor` and `sous init`. */
export interface MigrationsService {
    /** Every migration, in the order they run: lowest version first, then by `order`, then as added. */
    all(): MigrationEntity[];
    /** The version the project last migrated to, if its lockfile records one. */
    migratedVersion(): string | undefined;
    /**
     * The migrations waiting to run, in order. None outside a project, or in a project that has no
     * lockfile yet: a new project starts at the version that created it.
     */
    pending(): MigrationEntity[];
    /**
     * Records that the project is migrated to the running version without running anything: what a
     * new project needs, since nothing written by an older version is there to migrate.
     */
    markCurrent(): Promise<void>;
}

/** The input of `migrations.run`. */
export interface MigrationsRunInput {
    /** Take every question's default instead of asking. */
    yes?: boolean;
    /** `<id>=<value>` answers, ahead of the questions. */
    answer?: string[];
    /** List what would run, and with which answers; change nothing. */
    dryRun?: boolean;
}

/** How one question was, or would be, answered. */
export interface PlannedAnswer {
    readonly question: string;
    readonly value: string;
    /** `config`: the project already chose; `answer`: `--answer`; `asked`: the person; `default`: `--yes`. */
    readonly source: "config" | "answer" | "asked" | "default";
}

/** A question that could not be answered: no terminal, no `--yes`, no `--answer`. */
export interface UnansweredQuestion {
    readonly migration: string;
    readonly question: string;
    readonly message: string;
    /** The values `--answer` accepts for it. */
    readonly values: readonly string[];
    readonly default: string;
}

/** One migration, as `migrations.run` reports it. */
export interface MigrationReport {
    readonly id: string;
    readonly version: string;
    readonly description: string;
    readonly answers: readonly PlannedAnswer[];
    readonly result: "ran" | "would-run" | "waiting" | "failed" | "not-run";
    readonly outcome?: MigrationOutcome;
    readonly error?: string;
}

/** The result of `migrations.run`. */
export interface MigrationsRunResult {
    /** The version the project had migrated to before. */
    readonly from: string | undefined;
    /** The version stored now (unchanged when nothing could run). */
    readonly to: string | undefined;
    readonly migrations: readonly MigrationReport[];
    /** The questions nobody could answer; when there are any, nothing ran. */
    readonly unanswered: readonly UnansweredQuestion[];
    readonly dryRun: boolean;
}

declare module "@sous-io/plugin-api" {
    interface SousExtensions {
        /** Sous's own migrations: `sous.migrations.add({ version, order, up })`. */
        migrations: {
            /** Adds a migration that runs once for each project upgraded past `version`. */
            add(migration: MigrationDefinition): void;
        };
    }

    interface SousEntities {
        migration: MigrationEntity;
    }

    interface SousServices {
        migrations: MigrationsService;
    }

    interface SousIntents {
        "migrations.run": { input: MigrationsRunInput; result: MigrationsRunResult };
    }
}
