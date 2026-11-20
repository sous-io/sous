/**
 * Running one purpose's handlers, in order, each call timed and named by the handler's id (the
 * engine times every entity method, as `handler:<id>.handle`). What a handler reports is returned
 * and handed to the chain's reporter, which belongs to the command: a handler never prints.
 */

import { IntentOutput, IntentOutputs, messageText, SousError, type Context, type HandlerPurpose } from "@sous-io/sous-plugin-api";
import { createTools, ReportCollector } from "./tools.js";
import type { HandlerEntity, HandlerReportEntry, HandlerRun, HandlerRunResult, RunHandlersOptions } from "./types.js";

/** The `order` a handler has when it gives none. */
export const DEFAULT_ORDER = 500;

/**
 * A purpose's handlers in run order: plugins' first, in the order the plugins loaded and then the
 * order each registered them; then recipes', in the lockfile's order and then each manifest's.
 * `order` (default 500) then moves a handler: lower runs earlier, ties keep that order.
 *
 * ```ts
 * orderHandlers(ctx.entities.describe("handler"), "check", (record) => record.entry);
 * orderHandlers(config.entities("handler"), "configure", (entry) => entry);
 * ```
 */
export function orderHandlers<T>(items: readonly T[], purpose: HandlerPurpose, entryOf: (item: T) => HandlerEntity): T[] {
    const mine = items.filter((item) => entryOf(item).purpose === purpose);
    const grouped = [...mine.filter((item) => entryOf(item).recipe === undefined), ...mine.filter((item) => entryOf(item).recipe !== undefined)];

    return grouped
        .map((item, index) => ({ item, index }))
        .sort((a, b) => (entryOf(a.item).order ?? DEFAULT_ORDER) - (entryOf(b.item).order ?? DEFAULT_ORDER) || a.index - b.index)
        .map(({ item }) => item);
}

/** A thrown value as one line. */
export function describeThrown(error: unknown): string {
    return error instanceof Error ? messageText(error) : String(error);
}

/**
 * Who reported a line: the recipe or plugin, then the purpose and the handler. A recipe's handler is
 * named by its function, a plugin's by its id.
 *
 * ```ts
 * handlerLabel({ id: "workflow/github-projects/check/handlers/check.js#hasGh", purpose: "check", recipe: "workflow/github-projects", source: "handlers/check.js#hasGh" });
 * // -> "workflow/github-projects (check: hasGh)"
 * handlerLabel({ id: "acme/needs-jq", purpose: "check", plugin: "sous-plugin-acme" });
 * // -> "sous-plugin-acme (check: acme/needs-jq)"
 * ```
 */
export function handlerLabel(entry: Pick<HandlerEntity, "id" | "purpose" | "recipe" | "plugin" | "source">): string {
    if (entry.recipe !== undefined) {
        const name = entry.source === undefined ? entry.id : entry.source.slice(entry.source.lastIndexOf("#") + 1);

        return `${entry.recipe} (${entry.purpose}: ${name})`;
    }

    return entry.plugin === undefined ? `${entry.purpose}: ${entry.id}` : `${entry.plugin} (${entry.purpose}: ${entry.id})`;
}

/** A report line as printed: who reported it, then what it says. */
export function reportLine(label: string, message: string): string {
    return `${label}: ${message}`;
}

/**
 * Runs every handler of a purpose and reports what they found through the chain's reporter.
 *
 * ```ts
 * const checks = await runHandlers(ctx, "check", { ignoreFailedChecks: input.ignoreFailedChecks });
 *
 * if (checks.failed) {
 *     throw checksFailedError(checks);   // before anything is written
 * }
 * ```
 */
export async function runHandlers(ctx: Context, purpose: HandlerPurpose, options: RunHandlersOptions = {}): Promise<HandlerRunResult> {
    const project = ctx.project;
    const only = options.recipes === undefined ? undefined : new Set(options.recipes);
    const ignoring = purpose === "check" && options.ignoreFailedChecks === true;
    const records = ctx.entities.kinds().includes("handler") ? ctx.entities.describe("handler") : [];
    const ran: HandlerRun[] = [];
    let errors = 0;
    let warnings = 0;

    if (project === undefined) {
        return { purpose, ran, errors, warnings, ignoredErrors: 0, failed: false };
    }

    for (const record of orderHandlers(records, purpose, (one) => one.entry)) {
        const { entry } = record;

        if (only !== undefined && (entry.recipe === undefined || !only.has(entry.recipe))) {
            continue;
        }

        const label = handlerLabel({ ...entry, plugin: entry.plugin ?? record.plugin });
        const collector = new ReportCollector(entry.id);
        const tools = createTools(ctx, project, entry.recipe, collector.report);
        let threw: string | undefined;

        try {
            await (entry.handle as (sous: unknown, input: unknown) => unknown)(tools, options.input);
        } catch (error) {
            threw = describeThrown(error);
            collector.entries.push({ level: "error", message: `failed: ${threw}`, handler: entry.id });
        }

        for (const report of collector.entries) {
            forward(ctx, label, report, ignoring);
            errors += report.level === "error" ? 1 : 0;
            warnings += report.level === "warn" ? 1 : 0;
        }

        ran.push({
            id: entry.id,
            plugin: record.plugin,
            label,
            ...(entry.recipe === undefined ? {} : { recipe: entry.recipe }),
            reports: collector.entries,
            ...(threw === undefined ? {} : { threw }),
        });
    }

    return { purpose, ran, errors, warnings, ignoredErrors: ignoring ? errors : 0, failed: errors > 0 && !ignoring };
}

/** Hands one report to the command's reporter, naming who reported it. An ignored failed check is shown as a warning. */
function forward(ctx: Context, label: string, report: HandlerReportEntry, ignoring: boolean): void {
    const details = { handler: report.handler };
    const line = reportLine(label, report.message);

    if (report.level === "error") {
        if (ignoring) {
            ctx.reporter.warning(`${line} (a failed check, ignored)`, details);
        } else {
            ctx.reporter.error(line, details);
        }
    } else if (report.level === "warn") {
        ctx.reporter.warning(line, details);
    } else {
        ctx.reporter.info(line, details);
    }
}

/** The error a build stops with when `check` handlers reported errors. */
export function checksFailedError(result: HandlerRunResult): SousError {
    const failing = result.ran.filter((run) => run.reports.some((report) => report.level === "error")).map((run) => run.id);
    const count = result.errors === 1 ? "an error" : `${result.errors} errors`;

    return new SousError(`The checks reported ${count} (${failing.join(", ")}), so nothing was built.`, {
        details: ["Fix what they report, or pass --ignore-failed-checks to build anyway."],
    });
}

/** What a `handlers.*` intent returns: the result as data; a failed check ends with exit code 1. */
export function handlerOutputs(result: HandlerRunResult): IntentOutputs<HandlerRunResult> {
    return new IntentOutputs<HandlerRunResult>([new IntentOutput<HandlerRunResult>({ data: result })], result.purpose === "check" && result.failed ? { exitCode: 1 } : {});
}
