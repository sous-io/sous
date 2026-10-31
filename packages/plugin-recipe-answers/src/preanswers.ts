/**
 * Answers given up front, by flag or file.
 *
 * A person at a terminal answers each question as it comes. A script, a CI job or an agent knows
 * every answer already and gives them up front: `--answer name=value`, repeated, or a file of the
 * same pairs. The rules are strict, because no person sees a given answer before it is stored:
 *
 * - Every answer is checked against its definition before anything is written, so a run stores all
 *   of them or none.
 * - A name no variable has fails the run, listing every variable in play, so a typo never becomes
 *   a stored value nothing reads.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { InputError, type ServiceContext } from "@sous-io/plugin-api";
import { namesVariable, recipeKey } from "./definitions.js";
import { resolveUserPath } from "./paths.js";
import type { ApplicableAnswer, DefinedVariable, ProvidedAnswer, ProvidedAnswerInputs, RecipeAnswersPreanswers } from "./types.js";
import { validateAnswer } from "./validate.js";

/** How an answer is written on the command line. */
export const ANSWER_FLAG_FORM = "--answer <name>=<value>";

/** The sentence added to every error about a given answer. */
export const ANSWER_NAME_HELP = "A name is spelled exactly as the recipe declares it, in camelCase; the full 'namespace/recipe.name' key works too.";

/** The intent whose input the answers are. */
const INTENT = "vars.ask";

/** An `InputError` about one input field, with the lines that explain it. */
function answerError(field: "answer" | "answersFile", lines: readonly string[]): InputError {
    return new InputError(INTENT, [{ path: field, message: lines[0] ?? "" }], { details: lines });
}

/**
 * Splits one `name=value` pair at the first `=`, so a value may hold more of them.
 *
 * ```ts
 * parseAnswerPair("apiUrl=https://x.test/?a=1&b=2");
 * // -> { name: "apiUrl", value: "https://x.test/?a=1&b=2", from: "--answer" }
 * ```
 */
export function parseAnswerPair(entry: string, from = "--answer"): ProvidedAnswer {
    const at = entry.indexOf("=");
    const name = at === -1 ? "" : entry.slice(0, at).trim();

    if (at === -1 || name.length === 0) {
        throw answerError("answer", [
            `'${entry}' is not an answer sous can read.`,
            `Write one as '${ANSWER_FLAG_FORM}', for example '--answer apiUrl=https://api.example.com'.`,
            "Everything after the first '=' is the answer, so a value may contain more of them.",
        ]);
    }

    return { name, value: entry.slice(at + 1), from };
}

/** Whether a file holds env-file lines rather than YAML or JSON. */
export function isEnvFile(filePath: string): boolean {
    const base = path.basename(filePath);

    return base === ".env" || base.startsWith(".env.") || base.endsWith(".env");
}

/**
 * The answers in a parsed answers file: a map of `name: value`. A list, a map or an empty value
 * as an answer fails, naming the entry.
 */
export function answersFromData(raw: unknown, filePath: string): ProvidedAnswer[] {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw answerError("answersFile", [
            `The answers file at ${filePath} is not a map of answers.`,
            "It holds one entry per variable, written as 'name: value'.",
        ]);
    }

    const answers: ProvidedAnswer[] = [];

    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === "object" && value !== null) {
            throw answerError("answersFile", [
                `The answer for '${name}' in ${filePath} is a list or a map, and an answer is a single value.`,
                "Answers are stored in environment files, which hold text; write the answer as a string, a number or a boolean.",
            ]);
        }

        if (value === null || value === undefined) {
            throw answerError("answersFile", [
                `The answer for '${name}' in ${filePath} is empty.`,
                "Write the value the variable should be given, or leave the entry out entirely so sous asks for it.",
            ]);
        }

        answers.push({ name: name.trim(), value: String(value), from: filePath });
    }

    return answers;
}

/**
 * Every given answer in one list: the file first, the flags over it, so `--answer` wins over the
 * file for the same name. A name given twice in one place keeps the last.
 */
export function collectAnswers(fromFile: readonly ProvidedAnswer[], flags: readonly string[]): ProvidedAnswer[] {
    const collected = new Map<string, ProvidedAnswer>();

    for (const answer of fromFile) {
        collected.set(answer.name, answer);
    }

    for (const entry of flags) {
        const answer = parseAnswerPair(entry);

        collected.set(answer.name, answer);
    }

    return [...collected.values()];
}

/** The error for an answer whose name no variable has: every variable in play, by recipe. */
export function unknownAnswerError(answer: ProvidedAnswer, variables: readonly DefinedVariable[]): InputError {
    const lines = [`Nothing in this project defines a variable called '${answer.name}', so the answer given with ${answer.from} cannot be stored.`];

    if (variables.length === 0) {
        lines.push("No recipe this project subscribes to defines any variables yet, so there is nothing to answer.");

        return answerError(answer.from === "--answer" ? "answer" : "answersFile", lines);
    }

    const groups = new Map<string, string[]>();

    for (const entry of variables) {
        const key = recipeKey(entry.recipe);
        const names = groups.get(key) ?? [];

        if (!names.includes(entry.definition.name)) {
            names.push(entry.definition.name);
        }

        groups.set(key, names);
    }

    lines.push("", "These are the variables in play, and the recipes that declare them:", "");

    for (const [key, names] of groups) {
        lines.push(`  ${key}`, ...names.map((name) => `    ${name}`));
    }

    lines.push("", ANSWER_NAME_HELP);

    return answerError(answer.from === "--answer" ? "answer" : "answersFile", lines);
}

/** The error for a given answer that does not fit its definition. A secret is never echoed. */
export function invalidAnswerError(answer: ProvidedAnswer, variable: DefinedVariable, message: string, hidden: string): InputError {
    const shown = variable.definition.secret ? hidden : answer.value;

    return answerError(answer.from === "--answer" ? "answer" : "answersFile", [
        `The answer given for '${answer.name}' does not fit the definition ${recipeKey(variable.recipe)} publishes.`,
        message,
        `For example: ${String(variable.definition.example)}`,
        `The answer given with ${answer.from} was: ${shown}`,
        "Nothing was written; fix the answer and run the command again.",
    ]);
}

/**
 * Matches every given answer to the variables it answers and checks it against each, writing
 * nothing. One name can answer several variables, since two recipes may define the same name;
 * each must accept the value.
 */
export function matchAnswers(answers: readonly ProvidedAnswer[], variables: readonly DefinedVariable[], hidden = "(hidden)"): ApplicableAnswer[] {
    const applicable: ApplicableAnswer[] = [];

    for (const answer of answers) {
        const targets = variables.filter((entry) => namesVariable(entry, answer.name));

        if (targets.length === 0) {
            throw unknownAnswerError(answer, variables);
        }

        for (const target of targets) {
            const checked = validateAnswer(target.definition, answer.value, { recipe: recipeKey(target.recipe) });

            if (!checked.ok) {
                throw invalidAnswerError(answer, target, checked.message, hidden);
            }

            applicable.push({ answer, target, value: String(checked.value) });
        }
    }

    return applicable;
}

/** The `recipe-answers.preanswers` service. */
export class PreanswersService implements RecipeAnswersPreanswers {
    constructor(private readonly ctx: ServiceContext) {}

    async read(inputs: ProvidedAnswerInputs): Promise<ProvidedAnswer[]> {
        const fromFile = inputs.answersFile === undefined ? [] : await this.readFile(resolveUserPath(inputs.answersFile, this.ctx));

        return collectAnswers(fromFile, inputs.answer ?? []);
    }

    match(answers: readonly ProvidedAnswer[], variables: readonly DefinedVariable[]): ApplicableAnswer[] {
        const secrets = this.ctx.services.has("variables.secrets") ? this.ctx.services.get("variables.secrets") : undefined;

        return matchAnswers(answers, variables, secrets?.hiddenValue);
    }

    private async readFile(filePath: string): Promise<ProvidedAnswer[]> {
        if (isEnvFile(filePath)) {
            let text: string;

            try {
                text = await readFile(filePath, "utf8");
            } catch (error) {
                throw answerError("answersFile", [`Could not read the answers file at ${filePath}: ${(error as Error).message}`]);
            }

            return answersFromData(this.ctx.services.get("config-files.env").parse(text), filePath);
        }

        return answersFromData(await this.ctx.services.get("formats.manifests").readFile(filePath), filePath);
    }
}
