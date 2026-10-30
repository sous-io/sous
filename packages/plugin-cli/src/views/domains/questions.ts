/**
 * The questions some recipes would ask, as `recipe show`, `subscription add --dry-run` and the
 * update plan show them: one block of facts per question, grouped by recipe.
 */

import type { Reporter, VariableEntry } from "@sous-io/plugin-api";
import type { VariableShape } from "./catalog.js";

/** One question a recipe would ask (plugin-recipes' `PlannedQuestion`). */
export interface PlannedQuestionShape {
    /** The recipe asking it, `namespace/recipe`. */
    readonly recipe: string;
    readonly definition: VariableShape;
    /** The environment name the answer is stored as. */
    readonly storedAs?: string;
    /** The env file the answer is written to. */
    readonly storagePath?: string;
    /** True when an answer is in scope already. */
    readonly answered: boolean;
    /** Where the answer in scope comes from, in words. */
    readonly answeredFrom?: string;
}

/** The questions some recipes would ask (plugin-recipes' `PlannedQuestions`). */
export interface QuestionPlanShape {
    readonly questions: readonly PlannedQuestionShape[];
    readonly unreadable: readonly string[];
}

/** The first sentence of a description. */
export function firstSentence(text: string): string {
    const match = /^.*?[.!?](?=\s|$)/s.exec(text.trim());

    return (match?.[0] ?? text.trim()).replace(/\s+/g, " ");
}

function questionCount(count: number): string {
    return count === 1 ? "1 question" : `${count} questions`;
}

/**
 * The facts one question shows: what it is for, its example, where its answer goes, whether it has
 * one, and (with `answerHint`) the flag that answers it.
 */
export function questionFacts(question: PlannedQuestionShape, answerHint: boolean): VariableEntry[] {
    const variable = question.definition;
    const entries: VariableEntry[] = [];

    if (variable.description !== undefined && variable.description !== "") {
        entries.push({ label: "about", value: firstSentence(variable.description) });
    }

    if (variable.example !== undefined) {
        entries.push({ label: "example", value: String(variable.example) });
    }

    if (question.storedAs !== undefined && question.storedAs !== "") {
        entries.push({ label: "stored-as", value: question.storedAs });
    }

    if (question.storagePath !== undefined && question.storagePath !== "") {
        entries.push({ label: "storage-path", value: question.storagePath });
    }

    entries.push({
        label: "answered",
        value: question.answered
            ? `yes${question.answeredFrom === undefined ? "" : `, from ${question.answeredFrom}`}`
            : variable.required === false
              ? "no, and an answer is optional"
              : "no, and this recipe requires an answer",
    });

    if (answerHint) {
        entries.push({ label: "answer-with", value: `--answer ${variable.name}=<value>` });
    }

    return entries;
}

/**
 * The questions some recipes would ask, grouped by recipe. `answerHints` adds the flag that answers
 * each question and the closing sentence about answering ahead of time.
 */
export function writeQuestionPlan(reporter: Reporter, plan: QuestionPlanShape, options: { answerHints: boolean }): void {
    const count = plan.questions.length;
    const unanswered = plan.questions.filter((question) => !question.answered).length;
    const unreadable =
        plan.unreadable.length === 0
            ? undefined
            : `Not on this machine yet, and their repository's index does not record their questions, so they cannot be listed: ${plan.unreadable.join(", ")}.` +
              (options.answerHints ? " A dry run downloads nothing; run this command again without '--dry-run' to install them and be asked." : "");

    if (count === 0) {
        if (unreadable === undefined) {
            reporter.info("None of these recipes ask any questions, so nothing needs answering.");
        } else {
            reporter.note(unreadable);
        }

        return;
    }

    const subject = plan.unreadable.length === 0 ? "These recipes ask" : "The recipes sous could read ask";

    reporter.info(
        unanswered === 0
            ? `${subject} ${questionCount(count)}, and everything they ask is already answered.`
            : `${subject} ${questionCount(count)}, ${unanswered} of which nothing answers yet.`,
    );

    const groups = new Map<string, PlannedQuestionShape[]>();

    for (const question of plan.questions) {
        groups.set(question.recipe, [...(groups.get(question.recipe) ?? []), question]);
    }

    for (const [recipe, questions] of groups) {
        reporter.stepStart(`${recipe} asks ${questionCount(questions.length)}:`);

        for (const question of questions) {
            reporter.variables(questionFacts(question, options.answerHints), question.definition.name);
        }
    }

    if (unreadable !== undefined) {
        reporter.note(unreadable);
    }

    if (options.answerHints && unanswered > 0) {
        reporter.note("Answer them all ahead of time by running this command again without '--dry-run', with one '--answer <name>=<value>' for each, or with '--answers-file <path>'.");
    }
}
