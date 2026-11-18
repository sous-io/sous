import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BufferedReporter, definePlugin, IntentOutputs, scriptedPrompter, type Prompter, type Sous } from "@sous-io/plugin-api";
import { createEngine } from "@sous-io/core";
import { orderChecks } from "../src/doctor.js";
import { doctorPlugin } from "../src/index.js";
import type { DoctorCheckEntity, DoctorResult } from "../src/types.js";

const temporary: string[] = [];

afterEach(() => {
    for (const dir of temporary.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/** An engine with the doctor plugin and whatever a test registers. */
async function engineWith(register: (sous: Sous) => void) {
    const reporter = new BufferedReporter();
    const engine = createEngine({
        builtIns: [doctorPlugin, definePlugin({ name: "test-checks", register })],
        app: { name: "sous", version: "1.2.0" },
        project: { root: "/project", sousDir: "/project/.sous", configPath: "/project/.sous/sous.config.json", confDir: "/project/.sous/conf.d" },
        reporter,
    });

    await engine.buildConfig();

    return {
        reporter,
        doctor: async (input: Record<string, unknown> = {}, prompter?: Prompter) => {
            const outputs = await engine.handle.submit({ intent: "doctor", input }, { reporter, ...(prompter === undefined ? {} : { prompter }) });

            return { outputs, result: outputs.toPlain() as unknown as DoctorResult };
        },
    };
}

/** A check that finds a problem until its fix runs. */
function brokenUntilFixed(id: string, order: number, state: { fixed: boolean }): DoctorCheckEntity {
    return {
        id,
        order,
        description: `The ${id} is fine`,
        check: () => (state.fixed ? { status: "ok" } : { status: "problem", summary: `The ${id} is broken.`, details: ["one detail"], fix: `Fix the ${id}` }),
        fix: () => {
            state.fixed = true;

            return { summary: `The ${id} was fixed.` };
        },
    };
}

describe("orderChecks()", () => {
    /** Lowest order first; a tie keeps the order they were added. */
    it("should order checks by order, then as added", () => {
        const check = (id: string, order: number): DoctorCheckEntity => ({ id, order, description: id, check: () => ({ status: "ok" }) });

        expect(orderChecks([check("c", 800), check("a", 100), check("b", 100)]).map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    });
});

describe("sous doctor", () => {
    /**
     * Every check runs; the built-in ones come first by their order, and a plugin's check takes
     * its place by its own order.
     */
    it("should run every check a plugin adds, in order", async () => {
        const { doctor } = await engineWith((sous) => {
            sous.entities.add("doctor-check", { id: "late", order: 900, description: "Late", check: () => ({ status: "ok" }) });
            sous.entities.add("doctor-check", { id: "hooks", order: 500, description: "Hooks", check: () => ({ status: "ok" }) });
        });
        const { result } = await doctor({ dryRun: true });

        expect(result.checks.map((check) => check.id)).toEqual(["config", "lockfile", "variables", "hooks", "outputs", "late"]);
    });

    /**
     * With a terminal, each fix is asked about first, the finding is shown before the question,
     * and the check runs again after the fix.
     */
    it("should ask before each fix, fix, and check again", async () => {
        const state = { fixed: false };
        const prompter = scriptedPrompter([true]);
        const { doctor, reporter } = await engineWith((sous) => sous.entities.add("doctor-check", brokenUntilFixed("thing", 450, state)));
        const { result, outputs } = await doctor({ only: ["thing"] }, prompter);

        expect(prompter.asked).toEqual(["Fix the thing?"]);
        expect(reporter.messages.some((entry) => String(entry.message).includes("The thing is broken."))).toBe(true);
        expect(result.checks[0]).toMatchObject({ fix: { result: "applied", summary: "The thing was fixed." }, after: { status: "ok" }, problem: false });
        expect(outputs.exitCode).toBeUndefined();
    });

    /** A declined fix leaves the problem, and the command ends with exit code 1. */
    it("should leave a declined problem and end with exit code 1", async () => {
        const state = { fixed: false };
        const { doctor } = await engineWith((sous) => sous.entities.add("doctor-check", brokenUntilFixed("thing", 450, state)));
        const { result, outputs } = await doctor({ only: ["thing"] }, scriptedPrompter([false]));

        expect(state.fixed).toBe(false);
        expect(result).toMatchObject({ problems: 1, checks: [{ fix: { result: "declined" }, problem: true }] });
        expect(outputs.exitCode).toBe(1);
    });

    /** Without a terminal, nothing is fixed unless --yes; with --yes, every fix runs unasked. */
    it("should fix nothing without a terminal, and everything under --yes", async () => {
        const state = { fixed: false };
        const { doctor } = await engineWith((sous) => sous.entities.add("doctor-check", brokenUntilFixed("thing", 450, state)));
        const unasked = await doctor({ only: ["thing"] });

        expect(unasked.result.checks[0]?.fix).toEqual({ result: "cannot-ask" });
        expect(unasked.outputs.toText()).toContain("Pass --yes (also -y) to apply the fix.");
        expect(state.fixed).toBe(false);

        const yes = await doctor({ only: ["thing"], yes: true });

        expect(yes.result.problems).toBe(0);
        expect(state.fixed).toBe(true);
    });

    /** --dry-run reports and changes nothing, and still ends with exit code 1 for a problem. */
    it("should change nothing on a dry run", async () => {
        const state = { fixed: false };
        const { doctor } = await engineWith((sous) => sous.entities.add("doctor-check", brokenUntilFixed("thing", 450, state)));
        const { result, outputs } = await doctor({ only: ["thing"], dryRun: true, yes: true });

        expect(state.fixed).toBe(false);
        expect(result.checks[0]?.fix).toEqual({ result: "dry-run" });
        expect(outputs.toText()).toContain("Would fix: Fix the thing");
        expect(outputs.exitCode).toBe(1);
    });

    /** A warning does not change the exit code; a check that throws is a problem that says so. */
    it("should not fail for a warning, and report a check that throws", async () => {
        const { doctor } = await engineWith((sous) => {
            sous.entities.add("doctor-check", { id: "warn", order: 450, description: "Warn", check: () => ({ status: "warning", summary: "Worth knowing." }) });
            sous.entities.add("doctor-check", {
                id: "throws",
                order: 460,
                description: "Throws",
                check: () => {
                    throw new Error("cannot read");
                },
            });
        });
        const { result } = await doctor({ only: ["warn", "throws"] });

        expect(result.checks.map((check) => [check.id, check.found.status, check.problem])).toEqual([
            ["warn", "warning", false],
            ["throws", "problem", true],
        ]);
        expect(result.checks[1]?.found).toMatchObject({ summary: "The check could not run: cannot read" });
    });
});

describe("the built-in checks", () => {
    /** Outside a plugin that provides them, the built-in checks skip themselves, saying why. */
    it("should skip the lockfile, variables and outputs checks when their owners are not loaded", async () => {
        const { doctor } = await engineWith(() => undefined);
        const { result } = await doctor({ dryRun: true });

        expect(result.checks.map((check) => [check.id, check.found.status])).toEqual([
            ["config", "ok"],
            ["lockfile", "skipped"],
            ["variables", "skipped"],
            ["outputs", "skipped"],
        ]);
    });

    /**
     * The outputs check reads the compiler's state: a file sous wrote that is missing, or whose
     * content is not what sous wrote, is a problem whose fix is a build.
     */
    it("should find written files that are missing or changed, and fix them with a build", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sous-doctor-"));
        const kept = path.join(dir, "kept.md");
        const changed = path.join(dir, "changed.md");
        const missing = path.join(dir, "missing.md");
        const hash = (text: string) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
        let built = 0;

        temporary.push(dir);
        fs.writeFileSync(kept, "kept", "utf8");
        fs.writeFileSync(changed, "edited by hand", "utf8");

        const { doctor } = await engineWith((sous) => {
            sous.services.add("compiler.state" as never, (() => ({ entries: () => [kept, changed, missing].map((dest) => ({ dest, destHash: hash(path.basename(dest, ".md")) })) })) as never);
            sous.intents.add({
                intent: "build" as string,
                handle: () => {
                    built += 1;

                    return IntentOutputs.of({});
                },
            });
        });
        const { result } = await doctor({ only: ["outputs"], yes: true });

        expect(result.checks[0]?.found).toMatchObject({
            status: "problem",
            details: [`${missing} is missing`, `${changed} has changed since sous wrote it`],
            fix: "Build the project, which writes them again",
        });
        expect(built).toBe(1);
    });

    /** The variables check names each required variable with no answer and no default. */
    it("should name required variables that have no answer", async () => {
        const listing = (key: string, required: boolean, answered: boolean, value?: string) => ({ answered, ...(value === undefined ? {} : { value }), variable: { key, definition: { required } } });
        const { doctor } = await engineWith((sous) => {
            sous.intents.add({
                intent: "vars.list" as string,
                handle: () =>
                    IntentOutputs.of({
                        variables: [listing("a/b.needed", true, false), listing("a/b.optional", false, false), listing("a/b.defaulted", true, false, "x"), listing("a/b.given", true, true, "y")],
                    }),
            });
        });
        const { result } = await doctor({ only: ["variables"], dryRun: true });

        expect(result.checks[0]?.found).toMatchObject({ status: "problem", details: ["a/b.needed"] });
    });

    /**
     * The lockfile check resolves the subscriptions holding every pin, and compares: a recipe a
     * subscription needs that is not pinned is a problem, fixed by writing the lockfile the
     * subscriptions make.
     *
     * subscriptions need workflow/a 1.0.0; lockfile pins nothing -> problem; fix writes it
     */
    it("should find a lockfile that does not match the subscriptions, and write the one they make", async () => {
        const written: unknown[] = [];
        const added = [{ key: "workflow/a", to: "1.0.0" }];
        const diff = (unchanged: boolean) => ({ added: unchanged ? [] : added, removed: [], updated: [], reposAdded: [], reposRemoved: [], unchanged });
        const { doctor } = await engineWith((sous) => {
            sous.services.add("recipes.lock" as never, (() => ({
                path: () => "/project/.sous/sous.lock.json",
                read: () => ({ formatVersion: 1, repos: {}, recipes: {} }),
                held: () => ({ keep: {} }),
                fromResolved: () => ({ formatVersion: 1, repos: {}, recipes: { "workflow/a": {} } }),
                diff: () => diff(written.length > 0),
                write: async (lockfile: unknown) => void written.push(lockfile),
            })) as never);
            sous.services.add("recipes.resolver" as never, (() => ({ resolveSubscriptions: async () => ({ resolved: [], missingRepos: [], unreadable: [], cycles: [] }) })) as never);
        });
        const { result } = await doctor({ only: ["lockfile"], yes: true });

        expect(result.checks[0]?.found).toMatchObject({ status: "problem", details: ["workflow/a 1.0.0 is not pinned, and a subscription needs it"] });
        expect(written).toHaveLength(1);
        expect(result.checks[0]).toMatchObject({ after: { status: "ok" }, problem: false });
    });
});
