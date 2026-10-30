/**
 * The views of updates and the lockfile: `recipe.update` (the update plan, ported from today's
 * `src/lib/repos/update-plan.ts`), `subscription.update`, `lock.rebuild` and `lock.show` (ported
 * from the printing in today's `src/commands/subscription/update.ts` and `src/commands/lock/*.ts`).
 *
 * The handlers already report some of this through the chain's reporter: `subscription.update`
 * notes its plan before it asks, and `lock.rebuild` notes every change and its closing sentence.
 * Those views print only what was not reported.
 */

import { LogLevel, type Reporter, type TableColumn } from "@sous-io/plugin-api";
import type { CliViewContext, CliViewEntity, CliViewOutput } from "../../types.js";
import { writeQuestionPlan, type PlannedQuestionShape } from "./questions.js";

// --- The result shapes these views read (plugin-recipes' types, as far as they are used) -----------

/** What an update covers. */
export type UpdateScope =
    | { kind: "all" }
    | { kind: "repository"; repo: string }
    | { kind: "namespace"; repo: string; namespace: string }
    | { kind: "recipe"; repo: string; key: string };

/** One pin that changes. */
export interface LockChangeShape {
    readonly key: string;
    readonly from?: string;
    readonly to?: string;
}

/** What changes in the lockfile. */
export interface LockDiffShape {
    readonly added: readonly LockChangeShape[];
    readonly removed: readonly LockChangeShape[];
    readonly updated: readonly LockChangeShape[];
    readonly reposAdded: readonly string[];
    readonly reposRemoved: readonly string[];
    readonly unchanged: boolean;
}

/** A repository a newer version needs that the project does not trust. */
export interface MissingRepoShape {
    readonly name: string;
    readonly url?: string;
    readonly requiredBy: ReadonlyArray<{ readonly ref: string; readonly requestedBy: string }>;
}

/** The result of `recipe.update`. */
export interface UpdatePlanShape {
    readonly scope: UpdateScope;
    readonly diff: LockDiffShape;
    readonly missingRepos: readonly MissingRepoShape[];
    /** Variables the new versions declare that have no answer yet (plugin-recipes' `PlannedQuestion`). */
    readonly newVariables: readonly PlannedQuestionShape[];
    readonly unreadable: readonly string[];
    readonly unreachable: ReadonlyArray<{ readonly repo: string; readonly reason: string }>;
    readonly linked: readonly string[];
    readonly builtIn: ReadonlyArray<{ readonly key: string; readonly version?: string }>;
    readonly switchedOff: readonly string[];
    readonly failed: ReadonlyArray<{ readonly key: string; readonly reason: string }>;
    readonly cycles: ReadonlyArray<readonly string[]>;
}

/** A follow-up intent an intent ran, or skipped. */
export interface FollowUpShape {
    readonly intent: string;
    readonly result?: unknown;
    readonly skipped?: string;
}

/** The result of `subscription.update`. */
export interface SubscriptionUpdateShape {
    readonly plan: UpdatePlanShape;
    readonly applied: boolean;
    readonly nothingToUpdate: boolean;
    readonly trusted: readonly string[];
    readonly dryRun: boolean;
    readonly followUps: readonly FollowUpShape[];
}

/** One pinned recipe of the lockfile. */
export interface LockedRecipeShape {
    readonly repo: string;
    readonly version: string;
    readonly requestedBy: readonly string[];
}

/** The result of `lock.show`. */
export interface LockShowShape {
    readonly path: string;
    readonly recipes: ReadonlyArray<{
        readonly key: string;
        readonly entry: LockedRecipeShape;
        readonly active: boolean;
        readonly skipped?: { readonly message: string };
    }>;
}

// --- Words -----------------------------------------------------------------------------------------

/**
 * The scope in words.
 *
 * ```ts
 * describeUpdateScope({ kind: "repository", repo: "sous-recipes" });
 * // -> "the recipes this project takes from the repository 'sous-recipes'"
 * ```
 */
export function describeUpdateScope(scope: UpdateScope): string {
    switch (scope.kind) {
        case "all":
            return "every subscription in this project";
        case "repository":
            return `the recipes this project takes from the repository '${scope.repo}'`;
        case "namespace":
            return `the recipes in the namespace '${scope.repo}:${scope.namespace}'`;
        case "recipe":
            return `the recipe '${scope.repo}:${scope.key}'`;
    }
}

/** True when the plan has nothing to do: no pin moves and no new repository is needed. */
export function isEmptyUpdate(plan: Pick<UpdatePlanShape, "diff" | "missingRepos">): boolean {
    return plan.diff.unchanged && plan.missingRepos.length === 0;
}

/**
 * A lockfile change as plain-language lines, one per change, as today's lock service wrote them.
 *
 * ```ts
 * describeLockDiff(diff);
 * // -> ["Updating workflow/a from version 1.0.0 to version 1.1.0"]
 * ```
 */
export function describeLockDiff(diff: LockDiffShape): string[] {
    const byKey = (left: LockChangeShape, right: LockChangeShape) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
    const lines: string[] = [];

    for (const name of diff.reposAdded) {
        lines.push(`Repository added: ${name}`);
    }

    for (const change of [...diff.added].sort(byKey)) {
        lines.push(`Adding ${change.key} version ${change.to}`);
    }

    for (const change of [...diff.updated].sort(byKey)) {
        lines.push(`Updating ${change.key} from version ${change.from} to version ${change.to}`);
    }

    for (const change of [...diff.removed].sort(byKey)) {
        lines.push(`Removing ${change.key}, which nothing needs any more`);
    }

    for (const name of diff.reposRemoved) {
        lines.push(`Repository no longer needed: ${name}`);
    }

    if (lines.length === 0) {
        lines.push("Nothing changed.");
    }

    return lines;
}

function firstLine(text: string): string {
    return (text.split("\n")[0] ?? "").trim();
}

// --- recipe.update ---------------------------------------------------------------------------------

/**
 * Reports the plan: pin changes first, then the repositories that need trusting, then the
 * questions, then notes about what the update left alone.
 */
export function reportUpdatePlan(reporter: Reporter, plan: UpdatePlanShape): void {
    if (isEmptyUpdate(plan)) {
        reporter.info(`Nothing to update: every pin in ${describeUpdateScope(plan.scope)} is already the newest published version its range allows.`);
    } else {
        reporter.list(plan.diff.unchanged ? ["No pin moves until the repositories below are trusted and read."] : describeLockDiff(plan.diff), {
            title: `Updating ${describeUpdateScope(plan.scope)} changes the lockfile:`,
        });
    }

    if (plan.missingRepos.length > 0) {
        reporter.list(
            plan.missingRepos.map((missing) => {
                const where = missing.url === undefined ? "" : ` at ${missing.url}`;

                return `${missing.name}${where}, needed by ${missing.requiredBy.map((entry) => entry.requestedBy).join(", ")}`;
            }),
            {
                title: `A newer version needs ${plan.missingRepos.length === 1 ? "a repository" : "repositories"} this project does not trust yet. You are asked about each one by name before anything is fetched from it:`,
            },
            LogLevel.Warning,
        );
    }

    if (plan.newVariables.length > 0 || plan.unreadable.length > 0) {
        reporter.info("Questions the new versions ask that nothing answers yet:");
        writeQuestionPlan(reporter, { questions: plan.newVariables, unreadable: plan.unreadable }, { answerHints: true });
    }

    if (plan.unreadable.length > 0) {
        reporter.note(
            `A dry run downloads no recipe, so the dependencies of the versions not on this machine yet, and not described by their index, are not shown: ${plan.unreadable.join(", ")}.`,
        );
    }

    for (const entry of plan.unreachable) {
        reporter.note(`The index of '${entry.repo}' could not be fetched, so its pins stay where they are. ${firstLine(entry.reason)}`);
    }

    for (const entry of plan.failed) {
        reporter.note(`The subscription to '${entry.key}' could not be resolved, so its pins stay where they are. ${firstLine(entry.reason)}`);
    }

    for (const repo of plan.linked) {
        reporter.note(`The repository '${repo}' is linked to a working copy, so builds keep reading that checkout until it is unlinked; the pins above take effect then.`);
    }

    for (const entry of plan.builtIn) {
        reporter.note(
            `The subscription to '${entry.key}' is one sous provides itself, and it stays at ${entry.version === undefined ? "the version" : `version ${entry.version}, the version`} this installation of sous ships.`,
        );
    }

    if (plan.switchedOff.length > 0) {
        reporter.note(`Switched off, so left alone: ${plan.switchedOff.join(", ")}.`);
    }
}

function recipeUpdateView(plan: UpdatePlanShape, view: CliViewContext): void {
    view.reporter.operationStart("Update plan");
    reportUpdatePlan(view.reporter, plan);
    view.reporter.dryRun("Nothing was written. Run 'sous subscription update' to apply it.");
}

// --- subscription.update ---------------------------------------------------------------------------

async function subscriptionUpdateView(result: SubscriptionUpdateShape, view: CliViewContext): Promise<CliViewOutput> {
    const { reporter } = view;
    const scope = describeUpdateScope(result.plan.scope);

    // The plan itself was reported before the question.
    if (result.nothingToUpdate) {
        return undefined;
    }

    if (result.dryRun || !result.applied) {
        reporter.dryRun(`Nothing was written. Run the same command without '--dry-run' to update ${scope}.`);

        return undefined;
    }

    reporter.stepStart("Lockfile");

    if (result.plan.diff.unchanged) {
        reporter.info("Nothing changed.");
    } else {
        reporter.list(describeLockDiff(result.plan.diff));
    }

    if (result.trusted.length > 0) {
        reporter.info(
            `Repositories trusted along the way: ${result.trusted.join(", ")}. They are now recorded in this project's config, and your colleagues inherit them.`,
        );
    }

    const ask = result.followUps.find((followUp) => followUp.intent === "vars.ask");

    if (ask?.result !== undefined) {
        reporter.stepStart("Variables");
        await view.show("vars.ask", ask.result);
    }

    if (result.plan.cycles.length > 0) {
        reporter.problem("Some of these recipes co-subscribe to each other in a circle:", {
            cause: result.plan.cycles.map((cycle) => cycle.join(" -> ")).join("\n"),
            hint: "That is unusual but not broken, and the lockfile was updated.",
        });
    }

    const build = result.followUps.find((followUp) => followUp.intent === "build");
    const rebuilt = build?.result !== undefined;

    reporter.info(
        `The lockfile now pins the newest versions the ranges allow for ${scope}. This project's subscriptions are exactly as they were.` +
            (rebuilt || result.plan.diff.unchanged ? "" : " The project was not rebuilt."),
    );

    if (build?.result !== undefined) {
        await view.show("build", build.result);

        // A failed build fails the command, though the update itself is written (as before the refactor).
        if ((build.result as { ok?: unknown }).ok === false) {
            reporter.error(
                "The lockfile was updated, but the build that followed it failed, so this project's outputs may not match the new versions yet. " +
                    "The update itself is recorded; fix what the build reported above and run 'sous build' again.",
            );

            return { exitCode: 1 };
        }
    }

    return undefined;
}

// --- lock.rebuild ----------------------------------------------------------------------------------

/**
 * `lock.rebuild` reports every change, every note and its closing sentence as it goes, so the view
 * adds nothing to them.
 */
function lockRebuildView(): undefined {
    return undefined;
}

// --- lock.show -------------------------------------------------------------------------------------

/** The recipe and its version stay at any width; the holders take what is left and wrap. */
const LOCK_COLUMNS: TableColumn[] = [
    { key: "key", header: "Recipe", kind: "path", overflow: "truncate", minWidth: 12 },
    { key: "version", header: "Version", overflow: "truncate", minWidth: 7 },
    { key: "repo", header: "Repository", overflow: "truncate", priority: "medium" },
    { key: "heldBy", header: "Held by", overflow: "wrap", flex: 1, priority: "low", minWidth: 16 },
];

function describeHolder(holder: string): string {
    return holder === "project" ? "this project" : holder;
}

function lockShowView(result: LockShowShape, view: CliViewContext): void {
    const { reporter } = view;

    reporter.operationStart("Recipe versions this project pins");

    const recipes = [...result.recipes].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
    const rows = recipes.map((recipe) => ({
        key: recipe.key,
        version: recipe.entry.version,
        repo: recipe.entry.repo,
        heldBy: recipe.entry.requestedBy.map(describeHolder).join(", "),
    }));
    const rowNotes = recipes.map((recipe) => (recipe.active ? undefined : `not built here: ${recipe.skipped?.message ?? "Not built on this machine."}`));

    reporter.table(LOCK_COLUMNS, rows, { empty: `This project pins nothing yet. Its lockfile is ${result.path}.`, rowNotes });

    if (rows.length > 0) {
        reporter.info(`This project's lockfile is ${result.path}.`);
    }
}

/** The views of this domain, by intent. */
export const views: Record<string, CliViewEntity["render"]> = {
    "recipe.update": recipeUpdateView,
    "subscription.update": subscriptionUpdateView,
    "lock.rebuild": lockRebuildView,
    "lock.show": lockShowView,
};
