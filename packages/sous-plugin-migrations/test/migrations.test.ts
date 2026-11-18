import { ConfigError, IntentOutputs, scriptedPrompter, SousError, type Context } from "@sous-io/plugin-api";
import { describe, expect, it } from "vitest";
import type { MigrationDefinition, MigrationsRunResult } from "../src/types.js";
import { emptyLock, engineWith, type LockState } from "./helpers.js";

/** A migration that records that it ran, with the answers it got. */
function recording(log: string[], version: string, extra: Partial<MigrationDefinition> = {}): MigrationDefinition {
    return {
        version,
        description: `Migrate to ${version}`,
        up: (_ctx, { answers }) => {
            log.push(`${version}${Object.keys(answers).length === 0 ? "" : ` ${JSON.stringify(answers)}`}`);

            return { summary: `Did ${version}.` };
        },
        ...extra,
    };
}

/** The memories question from spec 19, as a test fixture. */
const whereQuestion = {
    id: "memories.location",
    message: "Where should the memories file be written?",
    choices: [
        { value: "move", label: "To the new rules file" },
        { value: "keep", label: "To CLAUDE.md" },
    ],
    default: "move",
};

describe("sous.migrations.add", () => {
    /**
     * A plugin adds a migration with `sous.migrations.add({ version, order, up })`; it becomes a
     * `migration` entity with an id, the default order 500 and the plugin's name.
     */
    it("should add a migration entity with the default order and a generated id", async () => {
        const { engine } = await engineWith({ lock: { lockfile: emptyLock("1.0.0") }, migrations: [{ version: "1.1.0", up: () => undefined }] });
        const [entity] = engine.config.entities.list("migration");

        expect(entity).toMatchObject({ id: "test-adder@1.1.0#1", version: "1.1.0", order: 500, plugin: "test-adder" });
    });

    /** A version that is not a version is refused when the plugin registers. */
    it("should refuse a migration whose version is not a version", async () => {
        await expect(engineWith({ lock: { lockfile: emptyLock() }, migrations: [{ version: "soon", up: () => undefined }] })).rejects.toThrow(/is not a version/);
    });
});

describe("migrations.run", () => {
    /**
     * Every migration above the stored version runs, lowest version first and then by order, and
     * the running version is stored.
     *
     * stored 1.0.0, running 1.2.0; migrations 1.2.0, 1.1.0/900, 1.1.0/100, 1.0.0 -> 1.1.0/100, 1.1.0/900, 1.2.0
     */
    it("should run the pending migrations in order and store the running version", async () => {
        const log: string[] = [];
        const lock: LockState = { lockfile: emptyLock("1.0.0") };
        const { submit } = await engineWith({
            lock,
            migrations: [
                recording(log, "1.2.0"),
                recording(log, "1.1.0", { order: 900, up: () => void log.push("1.1.0 late") }),
                recording(log, "1.1.0", { order: 100, up: () => void log.push("1.1.0 early") }),
                recording(log, "1.0.0"),
            ],
        });
        const result = (await submit("migrations.run")).toPlain() as MigrationsRunResult;

        expect(log).toEqual(["1.1.0 early", "1.1.0 late", "1.2.0"]);
        expect(lock.lockfile?.migratedVersion).toBe("1.2.0");
        expect(result).toMatchObject({ from: "1.0.0", to: "1.2.0", unanswered: [] });
    });

    /**
     * Without a terminal and without --yes, a migration that needs an answer does not run, and
     * neither does any other; the result names the question and the --answer for it. The command
     * does not fail.
     */
    it("should run nothing and list the question when nobody can answer it", async () => {
        const log: string[] = [];
        const lock: LockState = { lockfile: emptyLock("1.0.0") };
        const { submit } = await engineWith({ lock, migrations: [recording(log, "1.1.0"), recording(log, "1.2.0", { questions: [whereQuestion] })] });
        const outputs = await submit("migrations.run");
        const result = outputs.toPlain() as MigrationsRunResult;

        expect(log).toEqual([]);
        expect(lock.lockfile?.migratedVersion).toBe("1.0.0");
        expect(result.unanswered).toEqual([
            { migration: "test-adder@1.2.0#2", question: "memories.location", message: whereQuestion.message, values: ["move", "keep"], default: "move" },
        ]);
        expect(outputs.toText()).toContain("Answer it with --answer memories.location=<move|keep> (--yes takes move).");
        expect(outputs.exitCode).toBeUndefined();
    });

    /** With --yes, each question takes its default. */
    it("should take each question's default under --yes", async () => {
        const log: string[] = [];
        const { submit } = await engineWith({ lock: { lockfile: emptyLock("1.0.0") }, migrations: [recording(log, "1.1.0", { questions: [whereQuestion] })] });

        await submit("migrations.run", { yes: true });

        expect(log).toEqual(['1.1.0 {"memories.location":"move"}']);
    });

    /** --answer answers a question ahead of time; a value the question does not take is refused. */
    it("should take --answer, and refuse a value the question does not offer", async () => {
        const log: string[] = [];
        const { submit } = await engineWith({ lock: { lockfile: emptyLock("1.0.0") }, migrations: [recording(log, "1.1.0", { questions: [whereQuestion] })] });

        await submit("migrations.run", { answer: ["memories.location=keep"] });

        expect(log).toEqual(['1.1.0 {"memories.location":"keep"}']);

        const again = await engineWith({ lock: { lockfile: emptyLock("1.0.0") }, migrations: [recording([], "1.1.0", { questions: [whereQuestion] })] });

        const error = (await again.submit("migrations.run", { answer: ["memories.location=elsewhere"] }).catch((caught: unknown) => caught)) as { details: string[] };

        expect(error.details.join("\n")).toContain('memories.location takes move or keep, not "elsewhere"');
    });

    /** A question the config already answers is not asked, even with no terminal. */
    it("should not ask a question the config already answers", async () => {
        const log: string[] = [];
        const { submit } = await engineWith({
            lock: { lockfile: emptyLock("1.0.0") },
            migrations: [recording(log, "1.1.0", { questions: [{ ...whereQuestion, answered: () => "keep" }] })],
        });
        const result = (await submit("migrations.run")).toPlain() as MigrationsRunResult;

        expect(log).toEqual(['1.1.0 {"memories.location":"keep"}']);
        expect(result.migrations[0]?.answers).toEqual([{ question: "memories.location", value: "keep", source: "config" }]);
    });

    /**
     * A follow-up question sees the answers given before it in the same migration, so it can stand
     * down when an earlier answer makes it moot.
     *
     * memories.location=keep (--answer) -> memories.cleanup answered "no" from the config, never asked
     */
    it("should give a question the answers to the questions before it", async () => {
        const log: string[] = [];
        const cleanup = {
            id: "memories.cleanup",
            message: "Remove the duplicated line?",
            default: "no",
            answered: (_ctx: Context, earlier: Readonly<Record<string, string>>) => (earlier["memories.location"] === "keep" ? "no" : undefined),
        };
        const { submit } = await engineWith({ lock: { lockfile: emptyLock("1.0.0") }, migrations: [recording(log, "1.1.0", { questions: [whereQuestion, cleanup] })] });
        const result = (await submit("migrations.run", { answer: ["memories.location=keep"] })).toPlain() as MigrationsRunResult;

        expect(result.unanswered).toEqual([]);
        expect(result.migrations[0]?.answers).toEqual([
            { question: "memories.location", value: "keep", source: "answer" },
            { question: "memories.cleanup", value: "no", source: "config" },
        ]);
    });

    /** With a terminal, the question is asked. */
    it("should ask the question when there is a terminal", async () => {
        const log: string[] = [];
        const prompter = scriptedPrompter(["keep"]);
        const { submit } = await engineWith({ lock: { lockfile: emptyLock("1.0.0") }, migrations: [recording(log, "1.1.0", { questions: [whereQuestion] })] });

        await submit("migrations.run", {}, prompter);

        expect(prompter.asked).toEqual([whereQuestion.message]);
        expect(log).toEqual(['1.1.0 {"memories.location":"keep"}']);
    });

    /** --dry-run lists what would run and changes nothing. */
    it("should change nothing on a dry run", async () => {
        const log: string[] = [];
        const lock: LockState = { lockfile: emptyLock("1.0.0") };
        const { submit } = await engineWith({ lock, migrations: [recording(log, "1.1.0")] });
        const result = (await submit("migrations.run", { dryRun: true })).toPlain() as MigrationsRunResult;

        expect(log).toEqual([]);
        expect(lock.lockfile?.migratedVersion).toBe("1.0.0");
        expect(result.migrations.map((entry) => entry.result)).toEqual(["would-run"]);
    });

    /**
     * A failed migration stops the run; the version stored is the highest one all of whose
     * migrations ran, so the failed one runs again next time.
     */
    it("should store the version reached before a failure and report the failure", async () => {
        const log: string[] = [];
        const lock: LockState = { lockfile: emptyLock("1.0.0") };
        const { submit } = await engineWith({
            lock,
            migrations: [
                recording(log, "1.1.0"),
                recording(log, "1.2.0", {
                    up: () => {
                        throw new Error("disk full");
                    },
                }),
            ],
        });
        const error = await submit("migrations.run").catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(SousError);
        expect((error as Error).message).toContain("failed: disk full");
        expect(log).toEqual(["1.1.0"]);
        expect(lock.lockfile?.migratedVersion).toBe("1.1.0");
    });

    /** A project with no lockfile yet is new: nothing is pending. */
    it("should treat a project with no lockfile as having nothing pending", async () => {
        const { engine } = await engineWith({ lock: { lockfile: undefined }, migrations: [recording([], "1.1.0")] });

        expect(engine.config.services.get("migrations").pending()).toEqual([]);
    });
});

describe("the notice other commands print", () => {
    /**
     * Any other command prints one line when migrations are pending, once, through the reporter
     * (which writes to standard error under --json), and carries on with its own result.
     */
    it("should print one line for another command and leave its result alone", async () => {
        const { submit, reporter } = await engineWith({
            lock: { lockfile: emptyLock("1.0.0") },
            migrations: [recording([], "1.1.0"), recording([], "1.2.0")],
            extra: (sous) => {
                sous.intents.add({
                    intent: "work",
                    handle: async (_input: unknown, ctx: Context) => {
                        await ctx.run("inner" as never);

                        return IntentOutputs.of({ worked: true });
                    },
                });
                sous.intents.add({ intent: "inner", handle: () => IntentOutputs.of({}) });
            },
        });

        expect((await submit("work")).toPlain()).toEqual({ worked: true });
        expect(reporter.at("notice" as never)).toEqual(["2 migrations from a newer version of sous are waiting to run in this project. Run 'sous doctor' to run them."]);
    });

    /** sous doctor, which runs them, prints no notice; neither does anything once none is pending. */
    it("should print nothing for sous doctor or when nothing is pending", async () => {
        const pending = await engineWith({ lock: { lockfile: emptyLock("1.0.0") }, migrations: [recording([], "1.1.0")] });

        await pending.submit("doctor", { dryRun: true });

        expect(pending.reporter.at("notice" as never)).toEqual([]);

        const current = await engineWith({
            lock: { lockfile: emptyLock("1.2.0") },
            migrations: [recording([], "1.1.0")],
            extra: (sous) => sous.intents.add({ intent: "work", handle: () => IntentOutputs.of({}) }),
        });

        await current.submit("work");

        expect(current.reporter.at("notice" as never)).toEqual([]);
    });
});

describe("the doctor check for migrations", () => {
    /**
     * sous doctor runs pending migrations without asking first (they ask their own questions),
     * and reports that nothing is left.
     */
    it("should run pending migrations from sous doctor", async () => {
        const log: string[] = [];
        const lock: LockState = { lockfile: emptyLock("1.0.0") };
        const { submit } = await engineWith({ lock, migrations: [recording(log, "1.1.0")] });
        const outputs = await submit("doctor", { only: ["migrations"] });
        const result = outputs.toPlain() as { problems: number; checks: Array<{ id: string; fix?: { result: string } }> };

        expect(log).toEqual(["1.1.0"]);
        expect(lock.lockfile?.migratedVersion).toBe("1.2.0");
        expect(result.problems).toBe(0);
        expect(result.checks[0]).toMatchObject({ id: "migrations", fix: { result: "applied" } });
    });

    /**
     * Passing `--answer` to sous doctor answers a migration's question, and a migration still
     * waiting for an answer is reported, without failing the command.
     */
    it("should pass doctor's answers to the migrations, and not fail while one waits for an answer", async () => {
        const log: string[] = [];
        const answered = await engineWith({ lock: { lockfile: emptyLock("1.0.0") }, migrations: [recording(log, "1.1.0", { questions: [whereQuestion] })] });

        await answered.submit("doctor", { only: ["migrations"], answer: ["memories.location=keep", "apiUrl=x"] });

        expect(log).toEqual(['1.1.0 {"memories.location":"keep"}']);

        const waiting = await engineWith({ lock: { lockfile: emptyLock("1.0.0") }, migrations: [recording([], "1.1.0", { questions: [whereQuestion] })] });
        const outputs = await waiting.submit("doctor", { only: ["migrations"] });
        const result = outputs.toPlain() as { problems: number; checks: Array<{ found: { status: string; details?: string[] } }> };

        expect(outputs.exitCode).toBeUndefined();
        expect(result.problems).toBe(0);
        expect(result.checks[0]?.found.status).toBe("pending");
        expect(result.checks[0]?.found.details).toEqual([`${whereQuestion.message} Answer it with --answer memories.location=<move|keep> (--yes takes move).`]);
    });

    /**
     * A config that does not load may be what a migration repairs (an option a newer sous
     * removed): sous doctor still finds and runs the pending migrations, and migrations.run runs
     * in spite of the config error.
     *
     * config fails; sous doctor --only migrations  // -> the migration runs
     */
    it("should run pending migrations when the config does not load", async () => {
        const log: string[] = [];
        const lock: LockState = { lockfile: emptyLock("1.0.0") };
        const failing = (sous: Parameters<NonNullable<Parameters<typeof engineWith>[0]["extra"]>>[0]) =>
            sous.config.contribute({
                id: "removed-option",
                contribute() {
                    throw new ConfigError("compilation.targets[0].outputs[0]._if: '_if' was removed.");
                },
            });
        const { submit } = await engineWith({ lock, migrations: [recording(log, "1.1.0")], extra: failing, configFails: true });
        const result = (await submit("doctor", { only: ["migrations"] })).toPlain() as { checks: Array<{ id: string; fix?: { result: string } }> };

        expect(log).toEqual(["1.1.0"]);
        expect(result.checks[0]).toMatchObject({ id: "migrations", fix: { result: "applied" } });
    });
});
