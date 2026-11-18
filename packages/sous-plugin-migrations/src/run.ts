/**
 * The `migrations.run` intent: runs every pending migration, lowest version first and then by
 * `order`, and records the running version in the lockfile.
 *
 * It works out every answer first and runs only once each question has one (plan, then execute):
 *
 * 1. an answer the project's config already gives (the question is not asked);
 * 2. `--answer <id>=<value>`;
 * 3. the person's answer, when there is a terminal to ask in;
 * 4. the question's default, under `--yes`.
 *
 * Without a terminal and without `--yes`, a question with no answer leaves its migration waiting,
 * and then nothing runs: running the migrations around it would record a version past it, so it
 * would never run, or run them out of order. The result lists each waiting question and the
 * `--answer` that answers it (spec 19, 7-e: the command neither takes defaults by itself nor fails).
 *
 * Nothing here prints or prompts directly: questions go through `ctx.prompter`, the report is the
 * returned outputs.
 */

import { InputError, IntentOutput, IntentOutputs, ItemList, ReportEntryStyle, SousError, TextBlock, type Context } from "@sous-io/plugin-api";
import type {} from "@sous-io/sous-plugin-recipes/types";
import { isVersion, semverLess, versionReached, versionToStore } from "./pending.js";
import type { MigrationEntity, MigrationQuestion, MigrationReport, MigrationsRunInput, MigrationsRunResult, PlannedAnswer, UnansweredQuestion } from "./types.js";

/** Reads `--answer <id>=<value>` entries; one without `=` is an input error naming it. */
export function parseAnswers(entries: readonly string[] | undefined): Map<string, string> {
    const answers = new Map<string, string>();

    for (const entry of entries ?? []) {
        const equals = entry.indexOf("=");

        if (equals <= 0) {
            throw new InputError("migrations.run", [{ path: "answer", message: `"${entry}" is not <name>=<value>` }]);
        }

        answers.set(entry.slice(0, equals).trim(), entry.slice(equals + 1));
    }

    return answers;
}

/** The values a question accepts. */
export function valuesOf(question: MigrationQuestion): string[] {
    return question.choices === undefined || question.choices.length === 0 ? ["yes", "no"] : question.choices.map((choice) => choice.value);
}

/** Checks an answer against the question's values; a wrong one is an input error naming them. */
function accepted(question: MigrationQuestion, value: string): string {
    const values = valuesOf(question);

    if (!values.includes(value)) {
        throw new InputError("migrations.run", [{ path: "answer", message: `${question.id} takes ${values.join(" or ")}, not "${value}"` }]);
    }

    return value;
}

/** Asks one question through the prompter. */
async function ask(question: MigrationQuestion, ctx: Context): Promise<string> {
    const answeredBy = `--answer ${question.id}=<${valuesOf(question).join("|")}>, or --yes for ${question.default}`;

    if (question.choices === undefined || question.choices.length === 0) {
        return (await ctx.prompter.confirm({ message: question.message, default: question.default === "yes", answeredBy })) ? "yes" : "no";
    }

    const index = question.choices.findIndex((choice) => choice.value === question.default);

    return ctx.prompter.askChoice({
        message: question.message,
        choices: question.choices.map((choice) => ({ label: choice.label, value: choice.value })),
        ...(index === -1 ? {} : { defaultIndex: index }),
        answeredBy,
    });
}

/** The plan for one migration: each question's answer, or why it has none. */
interface Planned {
    readonly migration: MigrationEntity;
    readonly answers: PlannedAnswer[];
    readonly unanswered: UnansweredQuestion[];
}

/**
 * Works out every answer. A dry run asks nothing: a question it cannot answer from the config,
 * `--answer` or `--yes` shows what a terminal would be asked.
 */
async function plan(pending: readonly MigrationEntity[], input: MigrationsRunInput, ctx: Context): Promise<Planned[]> {
    const given = parseAnswers(input.answer);
    const planned: Planned[] = [];

    for (const migration of pending) {
        const answers: PlannedAnswer[] = [];
        const unanswered: UnansweredQuestion[] = [];

        for (const question of migration.questions ?? []) {
            const configured = question.answered?.(ctx, Object.fromEntries(answers.map((answer) => [answer.question, answer.value])));

            if (configured !== undefined) {
                answers.push({ question: question.id, value: configured, source: "config" });
            } else if (given.has(question.id)) {
                answers.push({ question: question.id, value: accepted(question, given.get(question.id)!), source: "answer" });
            } else if (input.yes === true) {
                answers.push({ question: question.id, value: question.default, source: "default" });
            } else if (ctx.prompter.interactive && input.dryRun !== true) {
                answers.push({ question: question.id, value: await ask(question, ctx), source: "asked" });
            } else {
                unanswered.push({ migration: migration.id, question: question.id, message: question.message, values: valuesOf(question), default: question.default });
            }
        }

        planned.push({ migration, answers, unanswered });
    }

    return planned;
}

/** A migration as the report shows it. */
function reportOf(entry: Planned, result: MigrationReport["result"], extra: Partial<MigrationReport> = {}): MigrationReport {
    return { id: entry.migration.id, version: entry.migration.version, description: entry.migration.description, answers: entry.answers, result, ...extra };
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Runs the intent. */
export async function handle(input: MigrationsRunInput, ctx: Context): Promise<IntentOutputs<MigrationsRunResult>> {
    const service = ctx.services.get("migrations");
    const dryRun = input.dryRun === true;
    const from = service.migratedVersion();
    const pending = service.pending();
    const running = ctx.engine.app.version;

    if (pending.length === 0) {
        // Nothing to run, but the project is recorded as migrated to the running version, as after
        // any run (a project with no lockfile yet records it when the lockfile is created).
        const behind = from === undefined || (isVersion(from) && isVersion(running) && semverLess(from, running));

        if (!dryRun && behind && ctx.services.has("recipes.lock") && ctx.services.get("recipes.lock").exists() && isVersion(running)) {
            await ctx.services.get("recipes.lock").setMigratedVersion(running);
            ctx.configChanged();

            return runOutputs({ from, to: running, migrations: [], unanswered: [], dryRun });
        }

        return runOutputs({ from, to: from, migrations: [], unanswered: [], dryRun });
    }

    const planned = await plan(pending, input, ctx);
    const unanswered = planned.flatMap((entry) => entry.unanswered);

    if (dryRun || unanswered.length > 0) {
        const migrations = planned.map((entry) => reportOf(entry, entry.unanswered.length > 0 ? "waiting" : dryRun ? "would-run" : "not-run"));

        return runOutputs({ from, to: from, migrations, unanswered, dryRun });
    }

    const lock = ctx.services.get("recipes.lock");
    const reports: MigrationReport[] = [];
    const ran: MigrationEntity[] = [];

    for (const entry of planned) {
        try {
            const outcome = await entry.migration.up(ctx, { answers: Object.fromEntries(entry.answers.map((answer) => [answer.question, answer.value])) });

            ran.push(entry.migration);
            reports.push(reportOf(entry, "ran", outcome === undefined ? {} : { outcome }));
        } catch (error) {
            reports.push(reportOf(entry, "failed", { error: messageOf(error) }));

            const reached = versionReached(pending, ran);

            if (reached !== undefined) {
                await lock.setMigratedVersion(reached);
            }

            ctx.configChanged();

            throw new SousError(`The migration "${entry.migration.id}" (sous ${entry.migration.version}) failed: ${messageOf(error)}`, {
                details: [
                    ...reports.filter((report) => report.result === "ran").map((report) => `Ran: ${report.id} (sous ${report.version})`),
                    reached === undefined ? `The project is still recorded as migrated to ${from ?? "no version"}.` : `The project is recorded as migrated to ${reached}.`,
                    "The failed migration and every one after it stay pending; sous doctor runs them again.",
                ],
            });
        }
    }

    const to = versionToStore(running, ran);

    await lock.setMigratedVersion(to);
    ctx.configChanged();

    return runOutputs({ from, to, migrations: reports, unanswered: [], dryRun: false });
}

/** One line per migration: what it is, and what became of it. */
function migrationLine(report: MigrationReport): string {
    const answers = report.answers.length === 0 ? "" : ` (${report.answers.map((answer) => `${answer.question}=${answer.value}${answer.source === "config" ? " from the config" : ""}`).join(", ")})`;
    const verb = { ran: "Ran", "would-run": "Would run", waiting: "Waiting for an answer", failed: "Failed", "not-run": "Not run" }[report.result];
    const outcome = report.outcome?.summary === undefined ? "" : ` ${report.outcome.summary}`;

    return `${verb}: ${report.description} [sous ${report.version}]${answers}.${outcome}`;
}

/** The outputs of `migrations.run`. */
export function runOutputs(result: MigrationsRunResult): IntentOutputs<MigrationsRunResult> {
    if (result.migrations.length === 0) {
        return IntentOutputs.of(result, { result: new TextBlock("No migration is pending.") });
    }

    const outputs: IntentOutput[] = [
        new IntentOutput({ title: "Migrations", result: new ItemList(result.migrations.map(migrationLine)), style: ReportEntryStyle.List }),
    ];

    if (result.unanswered.length > 0) {
        outputs.push(
            new IntentOutput({
                result: new ItemList(
                    result.unanswered.map((question) => `${question.message} Answer it with --answer ${question.question}=<${question.values.join("|")}> (--yes takes ${question.default}).`),
                    {
                        title: "No migration ran: sous could not ask these questions without a terminal.",
                        footer: "Run the same command again with the answers, or with --yes to take every default.",
                    },
                ),
                style: ReportEntryStyle.List,
            }),
        );
    } else if (result.dryRun) {
        outputs.push(new IntentOutput({ result: new TextBlock("Nothing was changed (--dry-run)."), style: ReportEntryStyle.DryRun }));
    } else {
        outputs.push(new IntentOutput({ result: new TextBlock(`The project is now recorded as migrated to sous ${result.to}.`) }));
    }

    return new IntentOutputs(outputs).withData(result);
}

export default handle;
