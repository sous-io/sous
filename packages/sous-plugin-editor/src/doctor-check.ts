/**
 * `sous doctor`'s check of the assertions: it works out every declared edit and checks every
 * assertion on the files as a build would write them, writing nothing (`editor.apply`'s dry run).
 * A failed assertion at level error is a problem, since it would fail a build; one at level warn,
 * and every automatic one, is a warning. There is no fix: an assertion states what the person or a
 * recipe's author must put right.
 */

import { BufferedReporter, type Context } from "@sous-io/sous-plugin-api";
import { DOCTOR_CHECK_ORDER, type DoctorCheckEntity, type DoctorCheckResult, type DoctorRun } from "@sous-io/sous-plugin-doctor";
import { applyIntent } from "./intent.js";
import type { AssertionOutcome, EditorApplyResult } from "./types.js";

/** One line for a failed assertion: the first line of its report, or what it checks. */
function describe(outcome: AssertionOutcome): string {
    const first = outcome.report?.split("\n")[0]?.trim();

    return first !== undefined && first !== "" ? `${first} (${outcome.declarer} expects ${outcome.check})` : `${outcome.file} at ${outcome.path || "the root"}: ${outcome.check}, declared by ${outcome.declarer}`;
}

/** What the check finds. */
export async function checkAssertions(ctx: Context, run: Pick<DoctorRun, "configFailed">): Promise<DoctorCheckResult> {
    if (run.configFailed) {
        return { status: "skipped", summary: "The config did not load, so the edits and assertions it declares could not be checked." };
    }

    if (ctx.project === undefined) {
        return { status: "skipped", summary: "There is no project here." };
    }

    // The editor reports each failure as it finds it; the doctor prints its own report instead.
    const quiet = Object.create(ctx, { reporter: { value: new BufferedReporter() } }) as Context;
    const result = (await applyIntent({ dryRun: true }, quiet)).toPlain() as unknown as EditorApplyResult;
    const failed = result.assertions.filter((outcome) => !outcome.passed && outcome.silenced !== true);
    const errors = failed.filter((outcome) => outcome.level === "error");
    const warnings = failed.filter((outcome) => outcome.level === "warn");
    const checked = result.assertions.filter((outcome) => outcome.silenced !== true).length;

    if (checked === 0) {
        return { status: "ok", summary: "No assertion is declared." };
    }

    if (errors.length > 0) {
        return {
            status: "problem",
            summary: `${errors.length === 1 ? "An assertion fails" : `${errors.length} assertions fail`}, so a build would not write ${errors.length === 1 ? "that file" : "those files"} and would fail.`,
            details: [...errors, ...warnings].map(describe),
            hint: "Put right what each one expects; 'sous build --ignore-failed-assertions' builds anyway.",
        };
    }

    if (warnings.length > 0) {
        return { status: "warning", summary: `${warnings.length === 1 ? "An assertion at level warn fails" : `${warnings.length} assertions at level warn fail`}.`, details: warnings.map(describe) };
    }

    return { status: "ok", summary: `${checked === 1 ? "The one assertion holds" : `All ${checked} assertions hold`}.` };
}

/** The check, at its reserved place. */
export const assertionsCheck: DoctorCheckEntity = {
    id: "assertions",
    order: DOCTOR_CHECK_ORDER.assertions,
    description: "Every assertion on the files Sous edits holds, checked without writing",
    check: (ctx, run) => checkAssertions(ctx, run),
};
