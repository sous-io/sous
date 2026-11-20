/**
 * `sous doctor`'s check of the `check` handlers: it runs them, as a build does, and reports their
 * errors as a problem and their warnings as a warning. There is no fix: what a check handler finds
 * (a command that is not installed, a tool that is not signed in) is the person's to put right.
 */

import { BufferedReporter, type Context } from "@sous-io/sous-plugin-api";
import { DOCTOR_CHECK_ORDER, type DoctorCheckEntity, type DoctorCheckResult, type DoctorRun } from "@sous-io/sous-plugin-doctor";
import { reportLine, runHandlers } from "./run.js";

/** What the check finds. */
export async function checkHandlers(ctx: Context, run: Pick<DoctorRun, "configFailed">): Promise<DoctorCheckResult> {
    if (run.configFailed) {
        return { status: "skipped", summary: "The config did not load, so the check handlers it declares could not run." };
    }

    // The handlers report into the result; the doctor prints its own report, so nothing is printed here.
    const quiet = Object.create(ctx, { reporter: { value: new BufferedReporter() } }) as Context;
    const result = await runHandlers(quiet, "check");

    if (result.ran.length === 0) {
        return { status: "ok", summary: "No recipe or plugin declares a check handler." };
    }

    const lines = (level: "error" | "warn") => result.ran.flatMap((one) => one.reports.filter((report) => report.level === level).map((report) => reportLine(one.label, report.message)));
    const ran = `${result.ran.length} check ${result.ran.length === 1 ? "handler" : "handlers"} ran`;

    if (result.errors > 0) {
        return {
            status: "problem",
            summary: `${ran}, and ${result.errors === 1 ? "one reported an error" : `they reported ${result.errors} errors`}, which would stop a build.`,
            details: [...lines("error"), ...lines("warn")],
            hint: "Put right what each one reports; 'sous build --ignore-failed-checks' builds anyway.",
        };
    }

    if (result.warnings > 0) {
        return { status: "warning", summary: `${ran}, with ${result.warnings === 1 ? "a warning" : `${result.warnings} warnings`}.`, details: lines("warn") };
    }

    return { status: "ok", summary: `${ran}, and found nothing wrong.` };
}

/** The check, at its reserved place. */
export const checkHandlersCheck: DoctorCheckEntity = {
    id: "check-handlers",
    order: DOCTOR_CHECK_ORDER.checkHandlers,
    description: "The check handlers of the recipes and plugins report no errors",
    check: (ctx, run) => checkHandlers(ctx, run),
};
