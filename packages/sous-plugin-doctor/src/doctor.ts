/**
 * The `doctor` intent (`sous doctor`): runs every `doctor-check`, in order, and for each problem a
 * check can fix, asks whether to fix it (unless `--yes`), fixes it, and checks again. `--dry-run`
 * reports and changes nothing. The command ends with exit code 1 when a problem remains.
 *
 * Nothing here prints or prompts directly: a finding is reported through `ctx.reporter` just
 * before its question, so the person sees what they are asked about, and the question goes
 * through `ctx.prompter`, which fails with the flag that answers it when there is no terminal.
 */

import { IntentOutput, IntentOutputs, ReportEntryStyle, TextBlock, Tree, type Context, type TreeNode } from "@sous-io/sous-plugin-api";
import type { DoctorCheckEntity, DoctorCheckReport, DoctorCheckResult, DoctorInput, DoctorResult, DoctorRun } from "./types.js";

/** The flag that answers every question `sous doctor` asks. */
const YES_FLAG = "--yes (also -y)";

/** The checks in the order they run: by `order`, then in the order they were added. */
export function orderChecks(checks: readonly DoctorCheckEntity[]): DoctorCheckEntity[] {
    return checks
        .map((check, index) => ({ check, index }))
        .sort((left, right) => (left.check.order ?? 500) - (right.check.order ?? 500) || left.index - right.index)
        .map((entry) => entry.check);
}

/** Runs one check, turning a check that throws into a problem that says so. */
async function look(check: DoctorCheckEntity, ctx: Context, run: DoctorRun): Promise<DoctorCheckResult> {
    try {
        return await check.check(ctx, run);
    } catch (error) {
        return { status: "problem", summary: `The check could not run: ${messageOf(error)}` };
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Whether a finding is something to fix. */
function needsFix(found: DoctorCheckResult): found is Extract<DoctorCheckResult, { status: "problem" | "warning" | "pending" }> {
    return found.status === "problem" || found.status === "warning" || found.status === "pending";
}

/** Asks whether to apply a fix: yes under `--yes`, the person's answer with a terminal, else no. */
async function mayFix(check: DoctorCheckEntity, found: Extract<DoctorCheckResult, { fix?: string }>, ctx: Context, run: DoctorRun): Promise<"yes" | "declined" | "cannot-ask"> {
    if (check.confirm === false || run.yes) {
        return "yes";
    }

    if (!ctx.prompter.interactive) {
        return "cannot-ask";
    }

    // The person sees what they are asked about first.
    ctx.reporter.problem(found.summary, found.details === undefined || found.details.length === 0 ? {} : { cause: found.details.join("\n") });

    const answer = await ctx.prompter.confirm({ message: `${found.fix}?`, default: true, answeredBy: YES_FLAG });

    return answer ? "yes" : "declined";
}

/** Runs one check and, when it found something it can fix, the fix. */
async function examine(check: DoctorCheckEntity, ctx: Context, run: DoctorRun): Promise<DoctorCheckReport> {
    const found = await look(check, ctx, run);
    const base = { id: check.id, description: check.description, found };

    if (!needsFix(found) || found.fix === undefined || check.fix === undefined) {
        return { ...base, problem: found.status === "problem" };
    }

    if (run.dryRun) {
        return { ...base, fix: { result: "dry-run" }, problem: found.status === "problem" };
    }

    const decision = await mayFix(check, found, ctx, run);

    if (decision !== "yes") {
        return { ...base, fix: { result: decision }, problem: found.status === "problem" };
    }

    try {
        const fixed = await check.fix(ctx, run);
        const after = await look(check, ctx, run);

        return {
            ...base,
            fix: { result: "applied", summary: fixed.summary, ...(fixed.details === undefined ? {} : { details: fixed.details }) },
            after,
            problem: after.status === "problem",
        };
    } catch (error) {
        return { ...base, fix: { result: "failed", error: messageOf(error) }, problem: found.status === "problem" };
    }
}

/** Rebuilds the config after a fix, and says whether it loads now. */
async function configLoadsNow(ctx: Context): Promise<boolean> {
    try {
        await ctx.refreshConfig();
    } catch {
        // A config that still does not load is reported by the checks as it was.
    }

    return ctx.engine.configError === undefined;
}

/**
 * The reports of the checks that ran before a fix made the config load again, brought up to date:
 * the `config` check is looked at again (its problem is gone, put right by `resolvedBy`), and a
 * check that was skipped because the config did not load is examined now, fix and all.
 *
 * ```text
 * The config loads ............ fixed   (Fixed by: Sous's migrations have run)
 * The lockfile agrees ......... ok      (was: Skipped: the config did not load.)
 * ```
 */
async function recheckAfterConfigLoads(
    reports: readonly DoctorCheckReport[],
    checks: readonly DoctorCheckEntity[],
    resolvedBy: string,
    ctx: Context,
    run: DoctorRun,
): Promise<DoctorCheckReport[]> {
    const updated: DoctorCheckReport[] = [];

    for (const report of reports) {
        const check = checks.find((entry) => entry.id === report.id);

        if (check === undefined || (!report.problem && report.found.status !== "skipped")) {
            updated.push(report);
        } else if (report.fix === undefined && report.found.status === "problem") {
            const after = await look(check, ctx, run);

            updated.push({ ...report, after, problem: after.status === "problem", ...(after.status === "ok" ? { resolvedBy } : {}) });
        } else if (report.found.status === "skipped") {
            updated.push(await examine(check, ctx, run));
        } else {
            updated.push(report);
        }
    }

    return updated;
}

/** Runs the intent. */
export async function handle(input: DoctorInput, ctx: Context): Promise<IntentOutputs<DoctorResult>> {
    let run: DoctorRun = {
        dryRun: input.dryRun === true,
        yes: input.yes === true,
        answers: input.answer ?? [],
        configFailed: ctx.engine.configError !== undefined,
    };
    const only = input.only === undefined || input.only.length === 0 ? undefined : new Set(input.only);
    const checks = orderChecks(ctx.entities.list("doctor-check")).filter((check) => only === undefined || only.has(check.id));
    let reports: DoctorCheckReport[] = [];

    for (const check of checks) {
        const report = await examine(check, ctx, run);

        reports.push(report);

        // A fix (a migration) may be what makes the config load again: the checks before it, and
        // every one after it, then see the config as it is now, so a run whose fix worked ends clean.
        if (run.configFailed && report.fix?.result === "applied" && (await configLoadsNow(ctx))) {
            run = { ...run, configFailed: false };
            reports = [...(await recheckAfterConfigLoads(reports.slice(0, -1), checks, report.description, ctx, run)), report];
        }
    }

    const result: DoctorResult = { checks: reports, problems: reports.filter((report) => report.problem).length, dryRun: run.dryRun };

    return doctorOutputs(result);
}

/** The status word a finding shows with. */
function statusOf(found: DoctorCheckResult): string {
    switch (found.status) {
        case "ok":
            return "ok";
        case "skipped":
            return "skipped";
        case "pending":
            return "waiting for an answer";
        default:
            return found.status;
    }
}

/** One check as a tree node: the check, its status, and what it found and did under it. */
function nodeOf(report: DoctorCheckReport): TreeNode {
    const final = report.after ?? report.found;
    const children: TreeNode[] = [];

    if (report.found.status !== "ok") {
        children.push({ label: report.found.summary ?? "", children: (("details" in report.found ? report.found.details : undefined) ?? []).map((line) => ({ label: line })) });
    }

    switch (report.fix?.result) {
        case "applied":
            children.push({ label: `Fixed: ${report.fix.summary}`, children: (report.fix.details ?? []).map((line) => ({ label: line })) });

            if (report.after !== undefined && report.after.status !== "ok") {
                children.push({ label: `Still found: ${report.after.summary ?? ""}` });
            }
            break;
        case "failed":
            children.push({ label: `The fix failed: ${report.fix.error}` });
            break;
        case "declined":
            children.push({ label: "Not fixed: the fix was declined." });
            break;
        case "cannot-ask":
            children.push({ label: `Not fixed: sous could not ask without a terminal. Pass ${YES_FLAG} to apply the fix.` });
            break;
        case "dry-run":
            children.push({ label: `Would fix: ${"fix" in report.found ? (report.found.fix ?? "") : ""}` });
            break;
        default:
            break;
    }

    if (report.resolvedBy !== undefined) {
        children.push({ label: `Fixed by: ${report.resolvedBy}` });
    }

    const hint = "hint" in final ? final.hint : undefined;

    if (hint !== undefined && final.status !== "ok") {
        children.push({ label: hint });
    }

    const fixed = (report.fix?.result === "applied" || report.resolvedBy !== undefined) && final.status === "ok";

    return { label: report.description, detail: fixed ? "fixed" : statusOf(final), children };
}

/** The outputs of `doctor`: every check and what became of it, then one sentence. */
export function doctorOutputs(result: DoctorResult): IntentOutputs<DoctorResult> {
    const closing =
        result.problems === 0
            ? result.dryRun
                ? "No problem was found. Nothing was changed (--dry-run)."
                : "No problem remains."
            : `${result.problems === 1 ? "1 problem remains" : `${result.problems} problems remain`}.${result.dryRun ? " Nothing was changed (--dry-run)." : ""}`;
    const outputs = new IntentOutputs<DoctorResult>([
        new IntentOutput({ title: "Checks", result: new Tree(result.checks.map(nodeOf)), style: ReportEntryStyle.Tree }),
        new IntentOutput({ result: new TextBlock(closing), style: result.dryRun ? ReportEntryStyle.DryRun : ReportEntryStyle.Plain }),
    ]).withData(result);

    return result.problems > 0 ? outputs.withExitCode(1) : outputs;
}

export default handle;
