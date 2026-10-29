/**
 * Problems a release, a check or a submission finds. They are collected rather than thrown, so one
 * run tells an author everything that is wrong instead of only the first thing.
 */

import type { ReleaseProblem } from "../types.js";

/** True when any problem in the list is an error. */
export function hasErrors(problems: readonly ReleaseProblem[]): boolean {
    return problems.some((problem) => problem.level === "error");
}

/** The errors in a problem list, in the order they were found. */
export function errorsIn(problems: readonly ReleaseProblem[]): ReleaseProblem[] {
    return problems.filter((problem) => problem.level === "error");
}

/** The warnings in a problem list, in the order they were found. */
export function warningsIn(problems: readonly ReleaseProblem[]): ReleaseProblem[] {
    return problems.filter((problem) => problem.level === "warning");
}

/** The message a thrown value is reported with. */
export function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** "1 recipe", "3 recipes". */
export function describeCount(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Renders a list of problems as an indented block. */
export function renderProblems(problems: readonly ReleaseProblem[]): string {
    return problems.map((problem) => `    ${problem.where}: ${problem.message}`).join("\n");
}
