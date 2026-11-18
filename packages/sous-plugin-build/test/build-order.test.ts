/**
 * The order inside one build: `check` handlers, `beforeBuild` handlers, the compiler and its prune,
 * `editor.apply`, `afterBuild` handlers; and the three flags that let a build finish in spite of
 * failures. The handlers and the editor are stand-ins that record each call, so what is tested is
 * the build's own orchestration.
 */

import { describe, expect, it } from "vitest";
import { IntentOutput, IntentOutputs, jsonSchema, type PluginDefinition } from "@sous-io/plugin-api";
import type { EditorApplyInput, EditorApplyResult } from "@sous-io/sous-plugin-editor/types";
import type { HandlerRunResult, HandlersIntentInput } from "@sous-io/sous-plugin-handlers/types";
import type { BuildResult } from "../src/types.js";
import { harness, plugin } from "./helpers.js";

/** What the stand-ins do and record. */
interface Calls {
    order: string[];
    checkInputs: HandlersIntentInput[];
    editorInputs: EditorApplyInput[];
    /** Errors the `check` handlers report. */
    checkErrors: number;
    /** Whether an assertion at level error fails. */
    assertionFails: boolean;
}

/** A handler run with some errors, failing unless ignored. */
function handlerResult(purpose: HandlerRunResult["purpose"], errors: number, ignore: boolean): HandlerRunResult {
    return { purpose, ran: [], errors, warnings: 0, ignoredErrors: ignore ? errors : 0, failed: errors > 0 && !ignore };
}

/** Stand-ins for `handlers.*` and `editor.apply`, each recording that it ran. */
function standIns(calls: Calls): PluginDefinition {
    return plugin("stand-ins", (sous) => {
        for (const purpose of ["check", "beforeBuild", "afterBuild"] as const) {
            sous.intents.add({
                intent: `handlers.${purpose}`,
                internal: true,
                input: jsonSchema({}),
                handle: (input) => {
                    const given = (input ?? {}) as HandlersIntentInput;

                    calls.order.push(purpose);

                    if (purpose === "check") {
                        calls.checkInputs.push(given);
                    }

                    const errors = purpose === "check" ? calls.checkErrors : 0;

                    return IntentOutputs.of(handlerResult(purpose, errors, given.ignoreFailedChecks === true));
                },
            });
        }

        sous.intents.add({
            intent: "editor.apply",
            internal: true,
            input: jsonSchema({}),
            handle: (input) => {
                const given = input as EditorApplyInput;
                const ignored = given.ignoreFailedAssertions === true;

                calls.order.push("editor");
                calls.editorInputs.push(given);

                const result: EditorApplyResult = {
                    ok: !calls.assertionFails || ignored,
                    dryRun: given.dryRun === true,
                    files: [],
                    directories: { created: [], removed: [] },
                    assertions: calls.assertionFails
                        ? [{ file: "/p/.gitignore", path: "", check: "includesLine", declarer: "project", level: "error", automatic: false, passed: false }]
                        : [],
                    applied: 1,
                    undone: 0,
                };

                return new IntentOutputs<EditorApplyResult>(new IntentOutput({ data: result }));
            },
        });
    });
}

/** A harness whose compiler and prune also record their turn. */
async function orderedHarness(change: Partial<Calls> = {}) {
    const calls: Calls = { order: [], checkInputs: [], editorInputs: [], checkErrors: 0, assertionFails: false, ...change };
    const h = await harness({ extra: [standIns(calls)] });
    const compile = h.world.compileResult;
    const prune = h.world.pruneResult;

    h.world.compileResult = (input) => (calls.order.push("compile"), compile(input));
    h.world.pruneResult = (input) => (calls.order.push("prune"), prune(input));

    return { h, calls };
}

describe("the order inside one build", () => {
    /**
     * A build runs every step in the decided order.
     *
     * sous build; // -> check, beforeBuild, compile, prune, editor, afterBuild
     */
    it("should run the checks, beforeBuild, the compiler, the editor and afterBuild, in that order", async () => {
        const { h, calls } = await orderedHarness();
        const result = await h.run<BuildResult>("build");

        expect(calls.order).toEqual(["check", "beforeBuild", "compile", "prune", "editor", "afterBuild"]);
        expect(calls.editorInputs).toEqual([{ dryRun: false, ignoreFailedAssertions: false }]);
        expect(result).toMatchObject({ ok: true, checks: { purpose: "check" }, edits: { ok: true }, afterBuild: { purpose: "afterBuild" } });
    });

    /**
     * A failed check stops the build before anything is written, naming the flag that builds anyway.
     *
     * check reports an error; sous build; // -> exit 1, no compile, no editor
     */
    it("should stop before anything is written when a check fails", async () => {
        const { h, calls } = await orderedHarness({ checkErrors: 1 });
        const error = await h.engine.submit({ intent: "build" }, { reporter: h.reporter }).then(
            () => undefined,
            (thrown: unknown) => thrown as { message: string; details?: unknown },
        );

        expect(error?.message).toContain("so nothing was built");
        expect(JSON.stringify(error?.details)).toContain("--ignore-failed-checks");
        expect(calls.order).toEqual(["check"]);
    });

    /**
     * --ignore-failed-checks, and --keep-going, let a build past a failed check.
     *
     * sous build --ignore-failed-checks; // -> the whole build runs
     */
    it("should build past a failed check with --ignore-failed-checks or --keep-going", async () => {
        for (const flag of ["ignoreFailedChecks", "keepGoing"]) {
            const { h, calls } = await orderedHarness({ checkErrors: 1 });
            const result = await h.run<BuildResult>("build", { [flag]: true });

            expect(result.ok, flag).toBe(true);
            expect(calls.checkInputs, flag).toEqual([{ ignoreFailedChecks: true }]);
            expect(calls.order, flag).toEqual(["check", "beforeBuild", "compile", "prune", "editor", "afterBuild"]);
        }
    });

    /**
     * A failed assertion at level error fails the build after the other files are written: the
     * editor ran, the exit code is 1, and the closing line says why.
     *
     * an assertion fails; sous build; // -> exit 1, "Done, but an assertion failed"
     */
    it("should fail the build when an assertion fails, after the editor ran", async () => {
        const { h, calls } = await orderedHarness({ assertionFails: true });
        const outputs = await h.engine.submit({ intent: "build" }, { reporter: h.reporter });

        expect(outputs.exitCode).toBe(1);
        expect((outputs.toPlain() as unknown as BuildResult).ok).toBe(false);
        expect(calls.order).toContain("editor");
        expect(h.reporter.messages.map((message) => message.message).join("\n")).toContain("an assertion failed");
    });

    /**
     * --ignore-failed-assertions, and --keep-going, pass the switch to the editor, and the build
     * ends as successful.
     *
     * sous build --keep-going; // -> editor.apply { ignoreFailedAssertions: true }, exit 0
     */
    it("should end as successful with --ignore-failed-assertions or --keep-going", async () => {
        for (const flag of ["ignoreFailedAssertions", "keepGoing"]) {
            const { h, calls } = await orderedHarness({ assertionFails: true });
            const outputs = await h.engine.submit({ intent: "build", input: { [flag]: true } }, { reporter: h.reporter });

            expect(outputs.exitCode, flag).toBeUndefined();
            expect(calls.editorInputs, flag).toEqual([{ dryRun: false, ignoreFailedAssertions: true }]);
        }
    });

    /**
     * A dry run runs the checks, which only report, and the editor with dryRun, and no handler that
     * acts.
     *
     * sous build --dry-run; // -> check, compile, prune, editor { dryRun: true }
     */
    it("should run no beforeBuild or afterBuild handler on a dry run, and the editor with dryRun", async () => {
        const { h, calls } = await orderedHarness();

        await h.run<BuildResult>("build", { dryRun: true });

        expect(calls.order).toEqual(["check", "compile", "prune", "editor"]);
        expect(calls.editorInputs).toEqual([{ dryRun: true, ignoreFailedAssertions: false }]);
    });

    /**
     * `prune` (a build that compiles nothing) runs neither the handlers nor the editor; a failed
     * compile runs no editor and no afterBuild.
     *
     * sous prune; // -> prune only
     */
    it("should run neither handlers nor the editor when nothing is compiled or the compile failed", async () => {
        const pruning = await orderedHarness();

        await pruning.h.run("prune");
        expect(pruning.calls.order).toEqual(["prune"]);

        const failing = await orderedHarness();

        failing.h.world.compileResult = () => (failing.calls.order.push("compile"), { ok: false, outputs: [], problems: [{ level: "error", message: "bad" }], durationMs: 1 });
        await failing.h.run("build");
        expect(failing.calls.order).toEqual(["check", "beforeBuild", "compile"]);
    });

    /**
     * Without the handlers and editor plugins, a build is the compiler alone.
     *
     * no handlers plugin; sous build; // -> ok, no checks in the result
     */
    it("should build without the handlers and editor plugins", async () => {
        const h = await harness();
        const result = await h.run<BuildResult>("build");

        expect(result.ok).toBe(true);
        expect(result.checks).toBeUndefined();
        expect(result.edits).toBeUndefined();
    });

    /**
     * The flags are passed on to watch mode, so every rebuild honors them.
     *
     * sous build --watch --keep-going; // -> build.watch { ignoreFailedChecks, ignoreFailedAssertions }
     */
    it("should pass the flags on to watch mode", async () => {
        const { h } = await orderedHarness();
        const seen: unknown[] = [];

        h.engine.submit = new Proxy(h.engine.submit, {
            apply(target, self, args: Parameters<typeof h.engine.submit>) {
                if (args[0].intent === "build.watch") {
                    seen.push(args[0].input);

                    return new Promise(() => {});
                }

                return Reflect.apply(target, self, args);
            },
        });

        await h.run<BuildResult>("build", { watch: true, keepGoing: true });

        expect(seen).toEqual([{ ignoreFailedChecks: true, ignoreFailedAssertions: true }]);
    });
});
