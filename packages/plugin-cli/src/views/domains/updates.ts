/**
 * The views of updates and the lockfile: `recipe.update` (the update plan, ported from today's
 * `src/lib/repos/update-plan.ts`), `subscription.update`, `lock.rebuild` and `lock.show` (ported
 * from the printing in today's `src/commands/subscription/update.ts` and `src/commands/lock/*.ts`).
 *
 * The handlers already report some of this through the chain's reporter: `subscription.update`
 * notes its plan before it asks, and `lock.rebuild` notes every change and its closing sentence.
 * Those views print only what was not reported.
 */

import type { CliViewContext, CliViewEntity, CliViewOutput } from "../../types.js";
import type { Printer } from "../printer.js";
import type { TableColumn } from "../table.js";
import { BULLET, wrapText } from "../text.js";

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
    readonly newVariables: ReadonlyArray<{ readonly recipe: string; readonly name: string }>;
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

function questionCount(count: number): string {
    return count === 1 ? "1 question" : `${count} questions`;
}

// --- recipe.update ---------------------------------------------------------------------------------

/**
 * The plan, as lines: pin changes first, then the repositories that need trusting, then the
 * questions, then notes about what the update left alone.
 */
export function formatUpdatePlan(plan: UpdatePlanShape, view: Pick<CliViewContext, "style" | "columns">): string[] {
    const { style } = view;
    const width = Math.max(20, view.columns - 2) - 4;
    const lines: string[] = [""];
    const sentence = (text: string, paint = (line: string): string => line): string[] => wrapText(text, width).map(paint);
    const bullet = (text: string): string[] => wrapText(`  ${BULLET} ${text}`, width, { hangingIndent: 2 });

    if (isEmptyUpdate(plan)) {
        lines.push(
            ...sentence(`Nothing to update: every pin in ${describeUpdateScope(plan.scope)} is already the newest published version its range allows.`),
        );
    } else {
        lines.push(...sentence(`Updating ${describeUpdateScope(plan.scope)} changes the lockfile:`), "");

        if (plan.diff.unchanged) {
            lines.push(...bullet("No pin moves until the repositories below are trusted and read."));
        } else {
            for (const change of describeLockDiff(plan.diff)) {
                lines.push(...bullet(change));
            }
        }
    }

    if (plan.missingRepos.length > 0) {
        lines.push(
            "",
            ...sentence(
                `A newer version needs ${plan.missingRepos.length === 1 ? "a repository" : "repositories"} this project ${style.highlight("does not trust yet")}. You are asked about each one by name before anything is fetched from it:`,
                style.warning,
            ),
            "",
        );

        for (const missing of plan.missingRepos) {
            const where = missing.url === undefined ? "" : ` at ${missing.url}`;

            lines.push(...bullet(`${missing.name}${where}, needed by ${missing.requiredBy.map((entry) => entry.requestedBy).join(", ")}`));
        }
    }

    if (plan.newVariables.length > 0 || plan.unreadable.length > 0) {
        lines.push("", ...sentence("Questions the new versions ask that nothing answers yet:"), "");

        for (const line of formatNewQuestions(plan, view, width)) {
            lines.push(line === "" ? "" : `  ${line}`);
        }
    }

    const notes: string[] = [];

    if (plan.unreadable.length > 0) {
        notes.push(
            `A dry run downloads no recipe, so the dependencies of the versions not on this machine yet, and not described by their index, are not shown: ${plan.unreadable.join(", ")}.`,
        );
    }

    for (const entry of plan.unreachable) {
        notes.push(`The index of '${entry.repo}' could not be fetched, so its pins stay where they are. ${firstLine(entry.reason)}`);
    }

    for (const entry of plan.failed) {
        notes.push(`The subscription to '${entry.key}' could not be resolved, so its pins stay where they are. ${firstLine(entry.reason)}`);
    }

    for (const repo of plan.linked) {
        notes.push(`The repository '${repo}' is linked to a working copy, so builds keep reading that checkout until it is unlinked; the pins above take effect then.`);
    }

    for (const entry of plan.builtIn) {
        notes.push(
            `The subscription to '${entry.key}' is one sous provides itself, and it stays at ${entry.version === undefined ? "the version" : `version ${entry.version}, the version`} this installation of sous ships.`,
        );
    }

    if (plan.switchedOff.length > 0) {
        notes.push(`Switched off, so left alone: ${plan.switchedOff.join(", ")}.`);
    }

    if (notes.length > 0) {
        lines.push("");

        for (const text of notes) {
            lines.push(...wrapText(`${BULLET} ${text}`, width, { hangingIndent: 2 }).map(style.note));
        }
    }

    lines.push("");

    return lines;
}

/**
 * The questions the new versions ask, grouped by recipe (a shorter form of today's
 * `formatQuestionPlan`: the plan now carries only each question's recipe and name).
 */
function formatNewQuestions(plan: UpdatePlanShape, view: Pick<CliViewContext, "style">, width: number): string[] {
    const { style } = view;
    const sentence = (text: string, paint = (line: string): string => line): string[] => wrapText(text, width - 2).map(paint);
    const unreadable =
        plan.unreadable.length === 0
            ? []
            : sentence(
                  `Not on this machine yet, and their repository's index does not record their questions, so they cannot be listed: ${plan.unreadable.join(", ")}. A dry run downloads nothing; run this command again without '--dry-run' to install them and be asked.`,
                  style.note,
              );

    if (plan.newVariables.length === 0) {
        return unreadable;
    }

    const subject = plan.unreadable.length === 0 ? "These recipes ask" : "The recipes sous could read ask";
    const count = plan.newVariables.length;
    const lines = sentence(`${subject} ${questionCount(count)}, ${count} of which nothing answers yet.`);
    const groups = new Map<string, string[]>();

    for (const variable of plan.newVariables) {
        groups.set(variable.recipe, [...(groups.get(variable.recipe) ?? []), variable.name]);
    }

    for (const [recipe, names] of groups) {
        lines.push("", `${recipe} asks ${questionCount(names.length)}:`);

        for (const name of names) {
            lines.push("", `  ${style.cyan(name)}`, `    ${style.label("answer-with")}: ${style.value(`--answer ${name}=<value>`)}`);
        }
    }

    if (unreadable.length > 0) {
        lines.push("", ...unreadable);
    }

    return lines;
}

function recipeUpdateView(plan: UpdatePlanShape, view: CliViewContext): string {
    const out = view.printer();

    out.heading("Update plan");

    for (const line of formatUpdatePlan(plan, view)) {
        out.log(line === "" ? "" : `  ${line}`);
    }

    out.paragraph("Nothing was written. Run 'sous subscription update' to apply it.");

    return out.footer().text();
}

// --- subscription.update ---------------------------------------------------------------------------

async function subscriptionUpdateView(result: SubscriptionUpdateShape, view: CliViewContext): Promise<CliViewOutput> {
    const out = view.printer();
    const scope = describeUpdateScope(result.plan.scope);

    // The plan itself was reported before the question.
    if (result.nothingToUpdate) {
        return undefined;
    }

    if (result.dryRun || !result.applied) {
        out.blank();
        out.paragraph(`Nothing was written. Run the same command without '--dry-run' to update ${scope}.`);

        return out.footer().text();
    }

    out.blank();
    out.subheading("Lockfile");
    out.blank();

    if (result.plan.diff.unchanged) {
        out.paragraph("Nothing changed.");
    } else {
        for (const line of describeLockDiff(result.plan.diff)) {
            out.log(`  ${line}`);
        }
    }

    if (result.trusted.length > 0) {
        out.blank();
        out.paragraph(
            `Repositories trusted along the way: ${result.trusted.join(", ")}. They are now recorded in this project's config, and your colleagues inherit them.`,
        );
    }

    const ask = result.followUps.find((followUp) => followUp.intent === "vars.ask");

    if (ask?.result !== undefined) {
        out.blank();
        out.subheading("Variables");
        await appendRendered(out, view, "vars.ask", ask.result);
    }

    if (result.plan.cycles.length > 0) {
        out.warning(
            `Some of these recipes co-subscribe to each other in a circle:\n${result.plan.cycles.map((cycle) => `  ${cycle.join(" -> ")}`).join("\n")}\nThat is unusual but not broken, and the lockfile was updated.`,
        );
    }

    const build = result.followUps.find((followUp) => followUp.intent === "build");
    const rebuilt = build?.result !== undefined;

    out.blank();
    out.paragraph(
            `The lockfile now pins the newest versions the ranges allow for ${scope}. This project's subscriptions are exactly as they were.` +
            (rebuilt || result.plan.diff.unchanged ? "" : " The project was not rebuilt."),
    );
    out.footer();

    if (build?.result !== undefined) {
        await appendRendered(out, view, "build", build.result);

        // A failed build fails the command, though the update itself is written (as before the refactor).
        if ((build.result as { ok?: unknown }).ok === false) {
            return {
                stdout: out.text(),
                stderr:
                    "Error: The lockfile was updated, but the build that followed it failed, so this project's outputs may not match the new versions yet. " +
                    "The update itself is recorded; fix what the build reported above and run 'sous build' again.\n",
                exitCode: 1,
            };
        }
    }

    return out.text();
}

/** Adds another intent's result, as its own view shows it. */
async function appendRendered(out: Printer, view: CliViewContext, intent: string, result: unknown): Promise<void> {
    const text = await view.render(intent, result);

    if (text !== "") {
        out.log(text.replace(/\n$/, ""));
    }
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

/** How far every line of `lock show` is indented. */
const LOCK_INDENT = 2;

function describeHolder(holder: string): string {
    return holder === "project" ? "this project" : holder;
}

function lockShowView(result: LockShowShape, view: CliViewContext): string {
    const out = view.printer();

    out.heading("Recipe versions this project pins");
    out.blank();

    if (result.recipes.length === 0) {
        out.paragraph(`This project pins nothing yet. Its lockfile is ${result.path}.`);

        return out.footer().text();
    }

    const rows = [...result.recipes]
        .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
        .map((recipe) => ({
            key: recipe.key,
            version: recipe.entry.version,
            repo: recipe.entry.repo,
            heldBy: recipe.entry.requestedBy.map(describeHolder).join(", "),
            skipped: recipe.active ? undefined : (recipe.skipped?.message ?? "Not built on this machine."),
        }));

    out.table(LOCK_COLUMNS, rows, {
        indent: LOCK_INDENT,
        rowNote: (row) => (row.skipped === undefined ? undefined : view.style.muted(`  not built here: ${row.skipped}`)),
    });
    out.blank();
    out.paragraph(`This project's lockfile is ${result.path}.`);

    return out.footer().text();
}

/** The views of this domain, by intent. */
export const views: Record<string, CliViewEntity["render"]> = {
    "recipe.update": recipeUpdateView,
    "subscription.update": subscriptionUpdateView,
    "lock.rebuild": lockRebuildView,
    "lock.show": lockShowView,
};
