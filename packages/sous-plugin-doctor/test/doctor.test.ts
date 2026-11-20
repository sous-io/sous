import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BufferedReporter, definePlugin, IntentOutputs, scriptedPrompter, type Prompter, type Sous } from "@sous-io/sous-plugin-api";
import { createEngine } from "@sous-io/sous-lib-core";
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

    /**
     * What waits on an answer is counted in the closing line, which never says that no problem
     * was found while something waits; the exit code stays 0 for it (#265).
     *
     * a pending check; sous doctor           // -> "Nothing failed, but 1 check is waiting for an answer."
     * a pending check and a problem          // -> "1 problem remains, and 1 check is waiting for an answer."
     */
    it("should count what waits for an answer in the closing line", async () => {
        const pending: DoctorCheckEntity = { id: "waits", order: 450, description: "Waits", check: () => ({ status: "pending", summary: "Waiting on a person." }) };
        const { doctor } = await engineWith((sous) => {
            sous.entities.add("doctor-check", pending);
            sous.entities.add("doctor-check", brokenUntilFixed("thing", 460, { fixed: false }));
        });
        const alone = await doctor({ only: ["waits"] });
        const both = await doctor({ only: ["waits", "thing"], dryRun: true });

        expect(alone.result).toMatchObject({ problems: 0, pending: 1 });
        expect(alone.outputs.toText()).toContain("Nothing failed, but 1 check is waiting for an answer.");
        expect(alone.outputs.toText()).not.toContain("No problem remains.");
        expect(alone.outputs.exitCode).toBeUndefined();
        expect(both.outputs.toText()).toContain("1 problem remains, and 1 check is waiting for an answer. Nothing was changed (--dry-run).");
        expect(both.outputs.exitCode).toBe(1);
    });

    /** An item of a finding's details with lines of its own shows them under it; a note shows whatever the status. */
    it("should show a detail's own lines under it, and a check's notes", async () => {
        const { doctor } = await engineWith((sous) => {
            sous.entities.add("doctor-check", {
                id: "nested",
                order: 450,
                description: "Nested",
                check: () => ({ status: "warning", summary: "Worth knowing.", details: ["plain", { text: "an item", details: ["its line"] }] }),
            });
            sous.entities.add("doctor-check", { id: "noted", order: 460, description: "Noted", check: () => ({ status: "ok", notes: ["Sous downloaded something to look."] }) });
        });
        const { outputs } = await doctor({ only: ["nested", "noted"] });
        const text = outputs.toText();

        expect(text).toContain("    an item\n      its line");
        expect(text).toContain("Sous downloaded something to look.");
    });
});

describe("a fix that makes the config load again", () => {
    /**
     * A migration that repairs the config clears the config check's problem in the same run: the
     * config is rebuilt after the fix, the config check is looked at again, and the checks skipped
     * because the config did not load run now.
     *
     * sous doctor --yes   (the config fails until the "repair" check's fix runs)
     * // -> The config loads: fixed (Fixed by: The repair is fine); "No problem remains."; exit code 0
     */
    it("should look at the config again and end clean", async () => {
        const state = { fixed: false };
        const reporter = new BufferedReporter();
        const engine = createEngine({
            builtIns: [
                doctorPlugin,
                definePlugin({
                    name: "test-checks",
                    register: (sous) => {
                        sous.config.contribute({
                            id: "breaks-until-repaired",
                            contribute: () => {
                                if (!state.fixed) {
                                    throw new Error("an option a newer sous removed");
                                }
                            },
                        });
                        sous.entities.add("doctor-check", { ...brokenUntilFixed("repair", 400, state), confirm: false });
                        sous.entities.add("doctor-check", { id: "needs-config", order: 300, description: "Needs the config", check: (_ctx, run) => (run.configFailed ? { status: "skipped", summary: "Skipped: the config did not load." } : { status: "ok" }) });
                    },
                }),
            ],
            app: { name: "sous", version: "1.2.0" },
            project: { root: "/project", sousDir: "/project/.sous", configPath: "/project/.sous/sous.config.json", confDir: "/project/.sous/conf.d" },
            reporter,
        });

        await engine.buildConfig().catch(() => undefined);
        expect(engine.configError).toBeDefined();

        const outputs = await engine.handle.submit({ intent: "doctor", input: { only: ["config", "needs-config", "repair"], yes: true } }, { reporter });
        const result = outputs.toPlain() as unknown as DoctorResult;

        expect(result.checks.map((check) => [check.id, check.problem])).toEqual([
            ["config", false],
            ["needs-config", false],
            ["repair", false],
        ]);
        expect(result.checks[0]).toMatchObject({ found: { status: "problem" }, after: { status: "ok" }, resolvedBy: "The repair is fine" });
        expect(result.checks[1]?.found).toEqual({ status: "ok" });
        expect(result.problems).toBe(0);
        expect(outputs.toText()).toContain("Fixed by: The repair is fine");
        expect(outputs.toText()).toContain("No problem remains.");
        expect(outputs.exitCode).toBeUndefined();
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
        const diff = (unchanged: boolean) => ({ added: unchanged ? [] : added, removed: [], updated: [], changed: [], reposAdded: [], reposRemoved: [], unchanged });
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

    /**
     * A recipe whose manifest could not be read leaves the lockfile the subscriptions make
     * unknown: the check says so, naming it and why, offers no fix, and nothing is written
     * (#291). It resolves with `download`, so the resolver first tried to download it.
     *
     * lib/one unreadable (its download failed); sous doctor --yes
     * // -> problem "Sous cannot tell whether the lockfile matches the subscriptions: ...", no write, exit code 1
     */
    it("should report a recipe it could not read, and write nothing", async () => {
        const written: unknown[] = [];
        const asked: unknown[] = [];
        const { doctor } = await engineWith((sous) => {
            sous.services.add("recipes.lock" as never, (() => ({
                path: () => "/project/.sous/sous.lock.json",
                read: () => ({ formatVersion: 1, repos: {}, recipes: {} }),
                held: () => ({ keep: {} }),
                fromResolved: () => ({ formatVersion: 1, repos: {}, recipes: {} }),
                diff: () => ({ added: [], removed: [{ key: "support/base", from: "1.0.0" }], updated: [], changed: [], reposAdded: [], reposRemoved: [], unchanged: false }),
                write: async (lockfile: unknown) => void written.push(lockfile),
            })) as never);
            sous.services.add("recipes.resolver" as never, (() => ({
                resolveSubscriptions: async (options: unknown) => {
                    asked.push(options);

                    return { resolved: [], missingRepos: [], unreadable: ["lib/one"], cycles: [], downloaded: [], downloadFailures: [{ key: "lib/one", reason: "the version is not published" }] };
                },
            })) as never);
        });
        const { result, outputs } = await doctor({ only: ["lockfile"], yes: true });

        expect(asked[0]).toMatchObject({ download: true, quiet: true });
        expect(result.checks[0]?.found).toMatchObject({
            status: "problem",
            summary: "Sous cannot tell whether the lockfile matches the subscriptions: it could not read what this recipe depends on.",
            details: ["lib/one: the version is not published"],
        });
        expect(result.checks[0]?.found).not.toHaveProperty("fix");
        expect(written).toEqual([]);
        expect(outputs.exitCode).toBe(1);
    });

    /**
     * The check says which recipes it downloaded to look, even on a dry run, and counts a pin
     * whose holders changed as a difference.
     *
     * the store lacked lib/one; support/base now held by lib/one and lib/two
     * // -> "Sous downloaded this recipe into this machine's recipe store to read it: lib/one."
     */
    it("should say what it downloaded, and report a pin whose holders changed", async () => {
        const { doctor } = await engineWith((sous) => {
            sous.services.add("recipes.lock" as never, (() => ({
                path: () => "/project/.sous/sous.lock.json",
                read: () => ({ formatVersion: 1, repos: {}, recipes: { "lib/one": {} } }),
                held: () => ({ keep: {} }),
                restore: async () => ({ restored: ["lib/one"], alreadyPresent: [], failed: [] }),
                fromResolved: () => ({ formatVersion: 1, repos: {}, recipes: {} }),
                diff: () => ({
                    added: [],
                    removed: [],
                    updated: [],
                    changed: [{ key: "support/base", version: "1.0.0", requestedBy: { from: ["lib/one"], to: ["lib/one", "lib/two"] } }],
                    reposAdded: [],
                    reposRemoved: [],
                    unchanged: false,
                }),
            })) as never);
            sous.services.add("recipes.resolver" as never, (() => ({ resolveSubscriptions: async () => ({ resolved: [], missingRepos: [], unreadable: [], cycles: [] }) })) as never);
        });
        const { result, outputs } = await doctor({ only: ["lockfile"], dryRun: true });

        expect(result.checks[0]?.found).toMatchObject({
            status: "problem",
            details: ["support/base 1.0.0 is pinned for lib/one, and the subscriptions now need it for lib/one, lib/two"],
            notes: ["Sous downloaded this recipe into this machine's recipe store to read it: lib/one."],
        });
        expect(outputs.toText()).toContain("Sous downloaded this recipe into this machine's recipe store to read it: lib/one.");
    });
});
