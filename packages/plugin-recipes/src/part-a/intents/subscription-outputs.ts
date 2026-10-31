/**
 * The outputs of `subscription.add`, `.remove`, `.enable`, `.disable`, `.update` and `recipe.update`.
 *
 * The handlers already report some of this as they work: `subscription.add` and `.remove` note
 * their plan and what stays before they ask, and `subscription.update` reports its plan before its
 * question. The outputs hold what was not reported: the blocks shown once the work is done.
 */

import { IntentOutput, type Context, type TableColumn } from "@sous-io/plugin-api";
import type {
    PlannedQuestion,
    RecipeUpdatePlan,
    ResolvedRecipe,
    SubscriptionAddResult,
    SubscriptionRemoveResult,
    SubscriptionToggleResult,
    SubscriptionUpdateResult,
} from "../../types.js";
import { describeUpdateScope, isEmptyUpdate } from "../update-plan.js";
import {
    blockOutput,
    dryRunOutput,
    finish,
    finishWithFollowUps,
    followUpOf,
    followUpOutputs,
    listOutput,
    lockDiffLines,
    lockfileOutput,
    noteOutput,
    plainResult,
    questionPlanOutputs,
    rebuilt,
    sentence,
    tableOutput,
    underHeading,
    type RanFollowUp,
} from "../outputs.js";

const INSTALLED_COLUMNS: TableColumn[] = [
    { key: "key", header: "Recipe", kind: "path", overflow: "truncate", minWidth: 12 },
    { key: "version", header: "Version", overflow: "truncate" },
    { key: "repo", header: "Repository", overflow: "truncate", priority: "medium" },
    { key: "why", header: "Why", overflow: "wrap", flex: 1, minWidth: 16 },
];

/** Why a recipe is part of a subscription. */
function why(recipe: ResolvedRecipe): string {
    if (recipe.requestedBy.includes("project")) {
        return "you subscribed to it";
    }

    return recipe.kind === "subscribes" ? `co-subscribed by ${recipe.requestedBy.join(", ")}` : `needed by ${recipe.requestedBy.join(", ")}`;
}

/** Reports a circle of co-subscriptions, which is unusual but not broken. */
function reportCycles(ctx: Pick<Context, "reporter">, cycles: ReadonlyArray<readonly string[]>, hint: string): void {
    if (cycles.length > 0) {
        ctx.reporter.problem("Some of these recipes co-subscribe to each other in a circle:", { cause: cycles.map((cycle) => cycle.join(" -> ")).join("\n"), hint });
    }
}

/** The outputs of `subscription.add`. */
export function subscriptionAddOutputs(ctx: Pick<Context, "reporter">, result: SubscriptionAddResult) {
    const outputs: IntentOutput[] = [];

    if (result.dryRun) {
        outputs.push(dryRunOutput("Nothing will be downloaded, written or asked."));
    }

    outputs.push(
        tableOutput(
            INSTALLED_COLUMNS,
            result.resolved.map((recipe) => ({ key: recipe.key, version: recipe.version, repo: recipe.repo, why: why(recipe) })),
            { tableTitle: result.dryRun ? "What would be installed" : "What was installed" },
        ),
    );

    if (result.trusted.length > 0) {
        outputs.push(sentence(`Repositories trusted along the way: ${result.trusted.join(", ")}. They are now recorded in this project's config, and your colleagues inherit them.`));
    }

    outputs.push(lockfileOutput(result.diff, "Nothing changed; everything asked for was already locked."));
    reportCycles(ctx, result.cycles, "That is unusual but not broken, and everything above was installed.");

    // A dry run asks nothing, so it lists what the subscription would ask instead.
    if (result.dryRun && result.questions !== undefined) {
        outputs.push(...underHeading("Questions these recipes ask", questionPlanOutputs(result.questions, { answerHints: true })));
    }

    if (result.dryRun) {
        outputs.push(dryRunOutput("Nothing was written. Run the same command without '--dry-run' to install it."));
    } else {
        outputs.push(
            sentence(
                `The subscription to '${result.key}' is recorded in this project's config, and the exact versions above are recorded in its lockfile.${rebuilt(result) ? "" : " Run 'sous build' to compile what they contribute."}`,
            ),
        );
    }

    return finishWithFollowUps(
        ctx,
        underHeading("Subscribing", outputs),
        result,
        `The subscription to '${result.key}' was saved, but the build that followed it failed, so this project's outputs may be incomplete. The subscription itself is recorded and locked; fix what the build reported above and run 'sous build' again.`,
    );
}

/** The outputs of `subscription.remove`. */
export function subscriptionRemoveOutputs(ctx: Pick<Context, "reporter">, result: SubscriptionRemoveResult) {
    const pruneHint = rebuilt(result) ? "" : " Run 'sous build' to prune what it used to write.";
    const outputs: IntentOutput[] = [];

    if (result.dryRun) {
        outputs.push(dryRunOutput("Nothing will be written."));
    }

    // What stayed, and why, the handler has already reported, one line per recipe.
    outputs.push(lockfileOutput(result.diff, "Nothing changed; nothing was locked because of this subscription."));

    if (result.dryRun) {
        outputs.push(dryRunOutput("Nothing was written. Run the same command without '--dry-run' to remove it."));
    } else {
        outputs.push(
            sentence(
                result.optedOut
                    ? `The subscription to '${result.key}' is one sous provides itself, so it was switched off rather than deleted: this project's config now records '${result.key}: { enabled: false }'. The repository it came from is still trusted.${pruneHint}`
                    : `The subscription to '${result.key}' is gone. The repositories it came from are still trusted; remove one of those deliberately if you want to withdraw that too.${pruneHint}`,
            ),
        );
    }

    return finishWithFollowUps(
        ctx,
        underHeading("Unsubscribing", outputs),
        result,
        `The subscription to '${result.key}' was removed, but the build that followed it failed, so this project may still hold files it used to write. The removal itself is recorded and locked; fix what the build reported above and run 'sous build' again.`,
    );
}

/** The outputs of `subscription.enable` and `subscription.disable`. */
export function subscriptionToggleOutputs(ctx: Pick<Context, "reporter">, result: SubscriptionToggleResult) {
    const word = result.enabled ? "on" : "off";
    const outputs: IntentOutput[] = [];

    if (result.dryRun) {
        outputs.push(dryRunOutput("Nothing will be written."));
    }

    outputs.push(blockOutput({ Subscription: result.key, Enabled: result.enabled ? "yes" : "no", "Recorded in": result.file }));

    if (!result.changed) {
        outputs.push(sentence(`The subscription to '${result.key}' was already switched ${word}; nothing changed.`));
    } else if (result.dryRun) {
        outputs.push(dryRunOutput(`Nothing was written. Run the same command without '--dry-run' to switch '${result.key}' ${word}.`));
    } else {
        outputs.push(sentence(`The subscription to '${result.key}' is now switched ${word}.${rebuilt(result) ? "" : " Run 'sous build' to bring the outputs in line."}`));
    }

    return finishWithFollowUps(
        ctx,
        underHeading(result.enabled ? "Enabling a subscription" : "Disabling a subscription", outputs),
        result,
        `The subscription to '${result.key}' was switched ${word}, but the build that followed failed; fix what the build reported above and run 'sous build' again.`,
    );
}

/** The outputs of `subscription.update`. */
export function subscriptionUpdateOutputs(ctx: Pick<Context, "reporter">, result: SubscriptionUpdateResult) {
    const scope = describeUpdateScope(result.plan.scope);

    // The plan itself was reported before the question.
    if (result.nothingToUpdate) {
        return finish([], plainResult(result));
    }

    if (result.dryRun || !result.applied) {
        return finish([dryRunOutput(`Nothing was written. Run the same command without '--dry-run' to update ${scope}.`)], plainResult(result));
    }

    const outputs: IntentOutput[] = [result.plan.diff.unchanged ? sentence("Nothing changed.", "Lockfile") : listOutput(lockDiffLines(result.plan.diff), { heading: "Lockfile" })];

    if (result.trusted.length > 0) {
        outputs.push(sentence(`Repositories trusted along the way: ${result.trusted.join(", ")}. They are now recorded in this project's config, and your colleagues inherit them.`));
    }

    const ask: RanFollowUp | undefined = followUpOf(result, "vars.ask");

    if (ask?.outputs !== undefined) {
        outputs.push(...underHeading("Variables", ask.outputs.toArray()));
    }

    reportCycles(ctx, result.plan.cycles, "That is unusual but not broken, and the lockfile was updated.");

    const build: RanFollowUp | undefined = followUpOf(result, "build");

    outputs.push(
        sentence(
            `The lockfile now pins the newest versions the ranges allow for ${scope}. This project's subscriptions are exactly as they were.` +
                (build?.outputs !== undefined || result.plan.diff.unchanged ? "" : " The project was not rebuilt."),
        ),
    );

    // A failed build fails the command, though the update itself is written.
    const built = followUpOutputs({ followUps: build === undefined ? [] : [build] });

    if (built.failed) {
        ctx.reporter.error(
            "The lockfile was updated, but the build that followed it failed, so this project's outputs may not match the new versions yet. " +
                "The update itself is recorded; fix what the build reported above and run 'sous build' again.",
        );
    }

    return finish(outputs, plainResult(result), { after: built.outputs, ...(built.failed ? { exitCode: 1 } : {}) });
}

// --- recipe.update ----------------------------------------------------------------------------------

/** The first line of a message, trimmed. */
function firstLine(text: string): string {
    return (text.split("\n")[0] ?? "").trim();
}

/**
 * The update plan: pin changes first, then the repositories that need trusting, then the
 * questions, then notes about what the update left alone.
 */
export function updatePlanOutputs(plan: RecipeUpdatePlan): IntentOutput[] {
    const outputs: IntentOutput[] = [];

    if (isEmptyUpdate(plan)) {
        outputs.push(sentence(`Nothing to update: every pin in ${describeUpdateScope(plan.scope)} is already the newest published version its range allows.`));
    } else {
        outputs.push(
            listOutput(plan.diff.unchanged ? ["No pin moves until the repositories below are trusted and read."] : lockDiffLines(plan.diff), {
                listTitle: `Updating ${describeUpdateScope(plan.scope)} changes the lockfile:`,
            }),
        );
    }

    if (plan.missingRepos.length > 0) {
        outputs.push(
            listOutput(
                plan.missingRepos.map((missing) => {
                    const where = missing.url === undefined ? "" : ` at ${missing.url}`;

                    return `${missing.name}${where}, needed by ${missing.requiredBy.map((entry) => entry.requestedBy).join(", ")}`;
                }),
                {
                    listTitle: `A newer version needs ${plan.missingRepos.length === 1 ? "a repository" : "repositories"} this project does not trust yet. You are asked about each one by name before anything is fetched from it:`,
                },
            ),
        );
    }

    if (plan.newVariables.length > 0 || plan.unreadable.length > 0) {
        outputs.push(sentence("Questions the new versions ask that nothing answers yet:"));
        outputs.push(...questionPlanOutputs({ questions: plan.newVariables as readonly PlannedQuestion[], unreadable: plan.unreadable }, { answerHints: true }));
    }

    if (plan.unreadable.length > 0) {
        outputs.push(
            noteOutput(
                `A dry run downloads no recipe, so the dependencies of the versions not on this machine yet, and not described by their index, are not shown: ${plan.unreadable.join(", ")}.`,
            ),
        );
    }

    for (const entry of plan.unreachable) {
        outputs.push(noteOutput(`The index of '${entry.repo}' could not be fetched, so its pins stay where they are. ${firstLine(entry.reason)}`));
    }

    for (const entry of plan.failed) {
        outputs.push(noteOutput(`The subscription to '${entry.key}' could not be resolved, so its pins stay where they are. ${firstLine(entry.reason)}`));
    }

    for (const repo of plan.linked) {
        outputs.push(noteOutput(`The repository '${repo}' is linked to a working copy, so builds keep reading that checkout until it is unlinked; the pins above take effect then.`));
    }

    for (const entry of plan.builtIn) {
        outputs.push(
            noteOutput(
                `The subscription to '${entry.key}' is one sous provides itself, and it stays at ${entry.version === undefined ? "the version" : `version ${entry.version}, the version`} this installation of sous ships.`,
            ),
        );
    }

    if (plan.switchedOff.length > 0) {
        outputs.push(noteOutput(`Switched off, so left alone: ${plan.switchedOff.join(", ")}.`));
    }

    return outputs;
}

/** The outputs of `recipe.update`: the plan, and that nothing was written. */
export function recipeUpdateOutputs(plan: RecipeUpdatePlan) {
    return finish(underHeading("Update plan", [...updatePlanOutputs(plan), dryRunOutput("Nothing was written. Run 'sous subscription update' to apply it.")]), plan);
}
