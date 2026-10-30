/**
 * Asking for missing answers.
 *
 * A definition is inert. A question is asked only when an active recipe needs a variable and
 * nothing answers it, or when the answer in scope no longer fits the definition. An answer already
 * there is kept and reported with where it came from.
 *
 * Answers are stored in the project's env files: `.sous/.env` for shared ones, committed with the
 * project, and `.sous/.env.local` for machine-specific values and every secret, which git ignores.
 *
 * Questions go through the chain's `Prompter`. Every one is answered by a flag too,
 * `--answer <name>=<value>`; a run that cannot ask fails naming, for each variable, the
 * environment variables that would answer it, most specific first.
 */

import { NonInteractiveError, type Prompter, type Reporter } from "@sous-io/plugin-api";
import type { EnvFileKind } from "@sous-io/plugin-config-files/types";
import type { VariableDefinition } from "@sous-io/plugin-formats/types";
import { recipeKey } from "./definitions.js";
import { describeSource, ENV_FILE_NAMES, type Ladder, RUNG_LABELS } from "./ladder.js";
import { formatMappingTarget, mappingTargetFor } from "./mappings.js";
import { answerFileFor, displayValue } from "./sources.js";
import type { AnsweredVariable, ApplicableAnswer, DefinedVariable, LadderCandidate, ResolvedAnswer, VarsAskResult } from "./types.js";
import { validateAnswer } from "./validate.js";

/** Where an answer is stored: which env file, under which name. */
export interface StoragePlan {
    readonly file: EnvFileKind;
    readonly envName: string;
}

/** Writing what `vars.ask` stores. Its methods do nothing on a dry run but say where they would write. */
export interface AnswerStore {
    /** The path of an env file. */
    envPath(file: EnvFileKind): string;
    /** The path of the mapping file. */
    mappingPath(): string;
    /** Writes one answer. */
    writeAnswer(file: EnvFileKind, envName: string, value: string, comment: string): Promise<void>;
    /** Writes one mapping record; returns the file. */
    writeMapping(envName: string, target: string): Promise<string>;
}

/** What one run needs besides the variables and the ladder. */
export interface AskRun {
    readonly prompter: Prompter;
    readonly reporter: Reporter;
    readonly store: AnswerStore;
    /** What a hidden value prints as. */
    readonly hidden: string;
    readonly dryRun: boolean;
}

/** How the questions are picked. */
export interface AskOptions {
    /** Only these variables, by key; they are asked even when answered or optional. */
    only?: ReadonlySet<string>;
    /** Only the variables of these recipes (`namespace/recipe`), asked as an unnamed run asks. */
    within?: ReadonlySet<string>;
    /** Variables an answer was given for up front, by key: neither asked nor reported here. */
    skip?: ReadonlySet<string>;
    /** Ask again even when an answer fits. */
    reask?: boolean;
}

/** What one run did, before it is merged with the answers given up front. */
export interface AskReport {
    answered: AnsweredVariable[];
    inherited: Array<{ variable: DefinedVariable; resolved: ResolvedAnswer }>;
    skipped: Array<{ variable: DefinedVariable; reason: string }>;
}

/** One question to ask, and the value Enter alone would accept. */
interface PlannedQuestion {
    readonly variable: DefinedVariable;
    readonly suggestion?: string;
}

/** The words a stored boolean may be written with that mean yes. */
const TRUE_WORDS = ["true", "yes", "y", "on", "1"];

/** "1 answer" or "4 answers". */
function answerCount(count: number): string {
    return count === 1 ? "1 answer" : `${count} answers`;
}

/** The flag that answers one variable. */
export function answeredBy(variable: DefinedVariable): string {
    return `--answer ${variable.definition.name}=<value>`;
}

/**
 * The one sentence reported before any question when a run spans more than one recipe.
 *
 * ```ts
 * askLeadIn([
 *     { key: "workflow/task-files", count: 4, direct: true },
 *     { key: "workflow/sub-agent-delegation", count: 2, direct: false },
 * ]);
 * // -> "workflow/task-files needs 4 answers, and workflow/sub-agent-delegation, which it depends on, needs 2."
 * ```
 */
export function askLeadIn(groups: ReadonlyArray<{ key: string; count: number; direct: boolean }>): string | undefined {
    if (groups.length < 2) {
        return undefined;
    }

    const parts = groups.map((group, index) => {
        const relation = index === 0 || group.direct ? "" : ", which it depends on,";
        const needs = index === 0 ? answerCount(group.count) : String(group.count);

        return `${group.key}${relation} needs ${needs}`;
    });
    const last = parts.pop()!;

    return `${[...parts, `and ${last}`].join(", ")}.`;
}

/**
 * The line reported before one recipe's questions.
 *
 * ```ts
 * recipeOpeningLine("workflow/task-files", 4);
 * // -> "workflow/task-files needs 4 answers before it can be used."
 * ```
 */
export function recipeOpeningLine(key: string, count: number): string {
    return `${key} needs ${answerCount(count)} before it can be used.`;
}

/** The comment written above a newly stored answer. */
export function answerComment(variable: DefinedVariable): string {
    return `Set by sous for ${recipeKey(variable.recipe)}: ${variable.definition.prompt}`;
}

/** The error a run that cannot ask fails with: each variable, and every name that would answer it. */
export function nonInteractiveError(pending: ReadonlyArray<{ variable: DefinedVariable; candidates: readonly LadderCandidate[]; current?: string }>): NonInteractiveError {
    const details: string[] = ["Set one of the environment variables listed under each variable, pass --answer <name>=<value>, or run 'sous vars ask' from a terminal."];

    for (const entry of pending) {
        details.push("", `${entry.variable.definition.name} (${recipeKey(entry.variable.recipe)}): ${entry.variable.definition.prompt}`);

        if (entry.current !== undefined) {
            details.push(`  The value currently in scope does not fit this variable: ${entry.current}`);
        }

        for (const candidate of entry.candidates) {
            details.push(`  ${candidate.envName}  (${RUNG_LABELS[candidate.rung]})`);
        }
    }

    const first = pending[0]!;
    const question = pending.length === 1 ? first.variable.definition.prompt : `${pending.length} questions about recipe variables`;

    // Exit code 1, as before the refactor: nothing was typed wrong, an answer is just missing.
    const error = new NonInteractiveError(question, pending.length === 1 ? answeredBy(first.variable) : "--answer <name>=<value>", { details, exitCode: 1 });

    // The count says how much is missing, which the generic "sous needed to ask" sentence cannot.
    error.message =
        pending.length === 1
            ? "One variable still needs an answer, and there is no terminal to ask on."
            : `${pending.length} variables still need answers, and there is no terminal to ask on.`;

    return error;
}

/** Checks a value against a variable's definition, naming its recipe. */
function check(variable: DefinedVariable, value: string) {
    return validateAnswer(variable.definition, value, { recipe: recipeKey(variable.recipe) });
}

/**
 * Stores the answers given up front, each where the asking flow would put it; an answer already in
 * one of the env files is replaced where it lives, so the old value does not keep winning. A value
 * the shell sets is not sous's to rewrite: the answer is stored where it belongs and the result
 * says what covers it.
 *
 * @returns What was stored, and the keys of the variables these answers settled.
 */
export async function storeGivenAnswers(applicable: readonly ApplicableAnswer[], ladder: Ladder, run: AskRun): Promise<{ stored: AnsweredVariable[]; keys: Set<string> }> {
    const stored: AnsweredVariable[] = [];
    const keys = new Set<string>();
    const written = new Set<string>();

    for (const entry of applicable) {
        keys.add(entry.target.key);

        const existing = ladder.resolve(entry.target);
        const fallback: StoragePlan = { file: answerFileFor(entry.target.definition), envName: ladder.bareName(entry.target) };
        const plan: StoragePlan = existing === undefined || existing.source.file === "shell" ? fallback : { file: existing.source.file, envName: existing.source.envName };
        const slot = `${plan.file}:${plan.envName}`;

        if (written.has(slot)) {
            continue;
        }

        written.add(slot);

        const outcome = run.dryRun ? "not written" : ladder.lookupIn(plan.file, plan.envName) === undefined ? "appended" : "updated";

        if (!run.dryRun) {
            await run.store.writeAnswer(plan.file, plan.envName, entry.value, answerComment(entry.target));
        }

        // Recorded on a dry run too: the rest of the run plans as though it were stored.
        ladder.record(plan.file, plan.envName, entry.value);

        stored.push({
            variable: entry.target,
            envName: plan.envName,
            file: plan.file,
            filePath: run.store.envPath(plan.file),
            value: displayValue(entry.value, entry.target.definition.secret, run.hidden),
            outcome,
            ...(existing === undefined || existing.value === entry.value ? {} : { replaced: displayValue(existing.value, entry.target.definition.secret, run.hidden) }),
            ...(existing?.source.file === "shell" ? { shadowedBy: existing.source.envName } : {}),
        });
    }

    return { stored, keys };
}

/**
 * Walks every definition, keeps the answers that fit, asks for the rest, and stores what it
 * collects. Everything is decided before the first question, so the run can say how many answers
 * each recipe needs first.
 */
export async function askForMissing(variables: readonly DefinedVariable[], ladder: Ladder, options: AskOptions, run: AskRun): Promise<AskReport> {
    const report: AskReport = { answered: [], inherited: [], skipped: [] };
    const pending: Array<{ variable: DefinedVariable; candidates: readonly LadderCandidate[]; current?: string }> = [];
    const questions: PlannedQuestion[] = [];
    const deferred: DefinedVariable[] = [];
    /** Names an earlier question in this run will write. */
    const plannedNames = new Set<string>();
    const named = options.only !== undefined;

    for (const variable of variables) {
        if (options.only !== undefined && !options.only.has(variable.key)) continue;
        if (options.within !== undefined && !options.within.has(recipeKey(variable.recipe))) continue;
        if (options.skip?.has(variable.key) === true) continue;

        const { definition } = variable;
        const diagnosis = ladder.diagnose(variable);
        const existing = diagnosis.resolved;
        const validity = existing === undefined ? undefined : check(variable, existing.value);

        if (existing !== undefined && validity?.ok === true && options.reask !== true && !named) {
            report.inherited.push({ variable, resolved: existing });
            continue;
        }

        // An earlier question in this run will answer one of this variable's names, so it is
        // settled once that answer is stored.
        if (existing === undefined && options.reask !== true && !named && diagnosis.candidates.some((candidate) => plannedNames.has(candidate.envName))) {
            deferred.push(variable);
            continue;
        }

        const invalid = existing !== undefined && validity?.ok === false;
        const mustAsk = invalid || (existing === undefined && definition.required) || options.reask === true || named;

        if (!mustAsk) {
            report.skipped.push({ variable, reason: "no answer yet, and this variable is optional" });
            continue;
        }

        if (!run.prompter.interactive) {
            pending.push({ variable, candidates: diagnosis.candidates, ...(validity?.ok === false ? { current: validity.message } : {}) });
            continue;
        }

        const suggestion = existing !== undefined && validity?.ok === true ? existing.value : definition.default !== undefined ? String(definition.default) : undefined;

        plannedNames.add(ladder.bareName(variable));
        questions.push({ variable, ...(suggestion === undefined ? {} : { suggestion }) });
    }

    if (pending.length > 0) {
        throw nonInteractiveError(pending);
    }

    const groups = groupQuestions(questions);
    const leadIn = askLeadIn(groups.map((group) => ({ key: group.key, count: group.questions.length, direct: group.direct })));

    if (leadIn !== undefined) {
        run.reporter.note(leadIn);
    }

    for (const group of groups) {
        run.reporter.note(recipeOpeningLine(group.key, group.questions.length));

        for (const [position, question] of group.questions.entries()) {
            await runQuestion(question, { index: position + 1, total: group.questions.length }, ladder, run, report);
        }
    }

    // A variable another answer was expected to cover: inherited if it now is, else asked alone.
    for (const variable of deferred) {
        const resolved = ladder.resolve(variable);

        if (resolved !== undefined && check(variable, resolved.value).ok) {
            report.inherited.push({ variable, resolved });
            continue;
        }

        run.reporter.note(recipeOpeningLine(recipeKey(variable.recipe), 1));
        await runQuestion({ variable }, { index: 1, total: 1 }, ladder, run, report);
    }

    return report;
}

/** The questions of each recipe, in the order they arrived. */
function groupQuestions(questions: readonly PlannedQuestion[]): Array<{ key: string; direct: boolean; questions: PlannedQuestion[] }> {
    const groups = new Map<string, { key: string; direct: boolean; questions: PlannedQuestion[] }>();

    for (const question of questions) {
        const key = recipeKey(question.variable.recipe);
        const group = groups.get(key);

        if (group === undefined) {
            groups.set(key, { key, direct: question.variable.recipe.direct !== false, questions: [question] });
        } else {
            group.questions.push(question);
        }
    }

    return [...groups.values()];
}

/**
 * Asks the one question a variable's type calls for: a pick for an enum, yes or no for a boolean,
 * free text otherwise.
 */
async function askByType(definition: VariableDefinition, variable: DefinedVariable, suggestion: string | undefined, prompter: Prompter): Promise<string> {
    const by = answeredBy(variable);

    if (definition.type === "enum") {
        const options = definition.validate?.enum ?? [];
        const index = suggestion === undefined ? -1 : options.indexOf(suggestion);

        return prompter.askChoice({
            message: definition.prompt,
            answeredBy: by,
            choices: options.map((option) => ({ label: option, value: option })),
            ...(index === -1 ? {} : { defaultIndex: index }),
        });
    }

    if (definition.type === "boolean") {
        const current = suggestion ?? String(definition.default ?? "");

        return String(await prompter.confirm({ message: definition.prompt, answeredBy: by, default: TRUE_WORDS.includes(current.toLowerCase()) }));
    }

    return prompter.askValue({
        message: definition.prompt,
        answeredBy: by,
        validate: (value) => {
            const result = check(variable, value);

            return result.ok ? undefined : result.message;
        },
        ...(suggestion === undefined ? {} : { default: suggestion }),
        ...(definition.secret ? { secret: true } : {}),
    });
}

/** Asks one question, stores the answer, and reports what was stored and where. */
async function runQuestion(question: PlannedQuestion, place: { index: number; total: number }, ladder: Ladder, run: AskRun, report: AskReport): Promise<void> {
    const { variable } = question;
    const { definition } = variable;
    const plan: StoragePlan = { file: answerFileFor(definition), envName: ladder.bareName(variable) };

    run.reporter.note(`Question ${place.index} of ${place.total}: ${definition.name}`, {
        description: definition.description,
        example: definition.example,
        recipe: recipeKey(variable.recipe),
        storedIn: run.store.envPath(plan.file),
        storedAs: plan.envName,
    });
    run.reporter.log("info", definition.description);

    const answer = await askByType(definition, variable, question.suggestion, run.prompter);
    const checked = check(variable, answer);

    if (!checked.ok) {
        report.skipped.push({ variable, reason: checked.message });

        return;
    }

    const stored = await storeAnswer(variable, String(checked.value), plan, ladder, run);

    report.answered.push(stored);
    run.reporter.note(`Answer: ${stored.envName}=${stored.value}`);
    run.reporter.note(`${run.dryRun ? "Would be saved to" : "Saved to"}: ${stored.filePath}`);
}

/**
 * Stores one answer under its plan. When the name it would be stored under already holds a value
 * that does not fit, a mapping record under the recipe-scoped name is offered instead of an
 * overwrite (taken without asking when the run cannot ask).
 */
async function storeAnswer(variable: DefinedVariable, value: string, plan: StoragePlan, ladder: Ladder, run: AskRun): Promise<AnsweredVariable> {
    let envName = plan.envName;
    let mapping: AnsweredVariable["mapping"];
    const occupant = ladder.lookup(envName);

    if (occupant !== undefined && !check(variable, occupant.value).ok) {
        const scoped = ladder.recipeScopedName(variable);
        const target = formatMappingTarget(mappingTargetFor(variable));
        const useMapping = run.prompter.interactive
            ? await run.prompter.askChoice({
                  message: `${envName} already holds a value that does not fit ${variable.definition.name}. Where should this answer go?`,
                  choices: [
                      { label: `${scoped}, with a mapping record (recommended)`, value: true },
                      { label: `${envName}, replacing what is there`, value: false },
                  ],
              })
            : true;

        if (useMapping) {
            envName = scoped;
            mapping = { envName: scoped, target, filePath: run.dryRun ? run.store.mappingPath() : await run.store.writeMapping(scoped, target) };
            ladder.addMapping(scoped, target);
        }
    }

    const outcome = run.dryRun ? "not written" : ladder.lookupIn(plan.file, envName) === undefined ? "appended" : "updated";

    if (!run.dryRun) {
        await run.store.writeAnswer(plan.file, envName, value, answerComment(variable));
        ladder.record(plan.file, envName, value);
    }

    // A value the shell sets may still win over the one just stored; the result says so.
    const winner = ladder.resolve(variable);
    const shadowedBy = winner?.source.file === "shell" && (winner.source.envName !== envName || winner.value !== value) ? winner.source.envName : undefined;

    return {
        variable,
        envName,
        file: plan.file,
        filePath: run.store.envPath(plan.file),
        value: displayValue(value, variable.definition.secret, run.hidden),
        outcome,
        ...(mapping === undefined ? {} : { mapping }),
        ...(shadowedBy === undefined ? {} : { shadowedBy }),
    };
}

/**
 * The summary of a run, in plain lines: what was stored, what was already answered (always shown,
 * with where it came from, so an answer from elsewhere is never a surprise) and what was left.
 */
export function askSummary(result: VarsAskResult, hidden: string): string[] {
    const lines: string[] = [];

    if (result.inherited.length > 0) {
        lines.push("Answers already in scope:");

        for (const entry of result.inherited) {
            const shown = displayValue(entry.resolved.value, entry.variable.definition.secret, hidden);

            lines.push(`  ${entry.variable.definition.name}  ${shown}  (from ${describeSource(entry.resolved.source)})`);
        }

        lines.push("");
    }

    if (result.answered.length > 0) {
        lines.push(result.dryRun ? "Answers that would be stored:" : "Answers stored:");

        for (const entry of result.answered) {
            lines.push(`  ${entry.variable.definition.name}  ${entry.value}  (${entry.envName} in ${ENV_FILE_NAMES[entry.file]})`);

            if (entry.mapping !== undefined) {
                lines.push(`    mapped to ${entry.mapping.target} in the conf.d layer`);
            }

            if (entry.replaced !== undefined) {
                lines.push(`    ${result.dryRun ? "replacing" : "replaced"} the answer already there: ${entry.replaced}`);
            }

            if (entry.shadowedBy !== undefined) {
                lines.push(`    ${entry.shadowedBy} is set in your shell environment and answers this variable first; unset it for the stored answer to take effect`);
            }
        }

        lines.push("");
    }

    if (result.skipped.length > 0) {
        lines.push("Left unanswered:");

        for (const entry of result.skipped) {
            lines.push(`  ${entry.variable.definition.name}  ${entry.reason}`);
        }

        lines.push("");
    }

    if (lines.length === 0) {
        lines.push("Every variable in play already has an answer that fits its definition.");
    }

    while (lines.at(-1) === "") {
        lines.pop();
    }

    return lines;
}
