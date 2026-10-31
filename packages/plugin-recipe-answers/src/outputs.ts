/**
 * What the `vars` intents show: the listing of variables in play, one variable in full, and the
 * report of what `vars.ask` stored, kept and left unanswered. Each builder returns outputs; the
 * intents add the "Command Variables" block and the machine data.
 */

import path from "node:path";
import { IntentOutput, type TableColumn, Table, VariableSet, type VariableEntry } from "@sous-io/plugin-api";
import { recipeKey } from "./definitions.js";
import { describeSource, ENV_FILE_NAMES, RUNG_LABELS, SOURCE_LABELS } from "./ladder.js";
import { displayValue } from "./sources.js";
import type { AnsweredVariable, DefinedVariable, DefiningRecipe, VariableDetail, VariableListing, VarsAskResult } from "./types.js";

function rungLabel(rung: string): string {
    return (RUNG_LABELS as Readonly<Record<string, string>>)[rung] ?? rung;
}

function sourceLabel(file: string): string {
    return (SOURCE_LABELS as Readonly<Record<string, string>>)[file] ?? file;
}

function envFileName(file: string): string {
    return (ENV_FILE_NAMES as Readonly<Record<string, string>>)[file] ?? file;
}

/** `namespace/recipe.name`. */
function variableKeyOf(variable: DefinedVariable): string {
    return `${recipeKey(variable.recipe)}.${variable.definition.name}`;
}

function isHostedUrl(location: string): boolean {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(location) || location.startsWith("git@");
}

/** Where a recipe's source lives: its repository URL and folder, a path, or nothing. */
function recipeLocation(recipe: DefiningRecipe): string | undefined {
    const { url, path: folder, dir } = recipe;

    if (url !== undefined && isHostedUrl(url)) {
        const base = url.replace(/\/+$/, "");

        return folder === undefined ? base : `${base}/${folder}`;
    }

    if (url !== undefined) {
        return folder === undefined ? url : `${url.replace(/\/+$/, "")}/${folder}`;
    }

    return dir;
}

/** A recipe as a fact line: its key, its location muted after it. */
function recipeLink(recipe: DefiningRecipe, label: string): VariableEntry {
    const location = recipeLocation(recipe);

    return location === undefined ? { label, value: recipeKey(recipe) } : { label, value: recipeKey(recipe), detail: location };
}

/**
 * The facts about one variable, in the order `vars show` prints them. A fact's later lines have an
 * empty label, continuing the first. With the project's `.sous/` directory, the storage path is the
 * env file's full path.
 */
function variableFacts(detail: VariableDetail, sousDir: string | undefined): VariableEntry[] {
    const { variable } = detail;
    const { definition } = variable;
    const entries: VariableEntry[] = [];

    if (definition.default !== undefined) {
        entries.push({ label: "default", value: String(definition.default) });
    }

    entries.push({ label: "example", value: String(definition.example) });

    const chain: readonly DefiningRecipe[] = variable.requiredBy !== undefined && variable.requiredBy.length > 0 ? variable.requiredBy : [variable.recipe];

    entries.push(recipeLink(chain[0] ?? variable.recipe, "required-by"));

    if (chain.length > 1) {
        entries.push({ label: "", value: `pulled in through ${chain.map(recipeKey).join(" then ")}` });
    }

    entries.push(recipeLink(variable.recipe, "defined-by"));
    entries.push({ label: "storage-path", value: sousDir === undefined ? envFileName(detail.storeIn) : path.join(sousDir, envFileName(detail.storeIn)) });
    entries.push({ label: "stored-as", value: detail.storedAs });

    detail.constraints.forEach((line, index) => entries.push({ label: index === 0 ? "constraints" : "", value: line }));

    return entries;
}

const LIST_COLUMNS: TableColumn[] = [
    { key: "name", header: "Variable", overflow: "truncate", minWidth: 8 },
    { key: "recipe", header: "Recipe", kind: "path", overflow: "truncate", priority: "medium", minWidth: 8 },
    { key: "envName", header: "Answered by", overflow: "truncate", truncate: "start", priority: "medium", minWidth: 11 },
    { key: "value", header: "Value", overflow: "truncate", truncate: "end", flex: 1, minWidth: 10 },
    { key: "source", header: "Source", priority: "low" },
];

const LADDER_COLUMNS: TableColumn[] = [
    { key: "envName", header: "Environment variable", overflow: "truncate", truncate: "start" },
    { key: "rung", header: "Rung", priority: "medium" },
    { key: "status", header: "Status", flex: 1, priority: "medium" },
];

/** The table of every variable in play, sorted by recipe then name. */
export function variableListOutput(listings: readonly VariableListing[], hidden: string): IntentOutput {
    const rows = [...listings]
        .sort((left, right) => variableKeyOf(left.variable).localeCompare(variableKeyOf(right.variable)))
        .map((listing) => ({
            name: listing.variable.definition.name,
            recipe: recipeKey(listing.variable.recipe),
            envName: listing.source?.envName ?? "",
            value: displayValue(listing.answered ? (listing.value ?? "") : undefined, listing.variable.definition.secret, hidden),
            source: listing.source === undefined ? "nothing yet" : `${rungLabel(listing.source.rung)}, ${sourceLabel(listing.source.file)}`,
        }));

    return new IntentOutput({
        title: "Variables in play",
        result: new Table(LIST_COLUMNS, rows, {
            empty: "No recipe in this project defines any variables yet. Subscribe to a recipe that publishes some, or read a definitions file with --file.",
        }),
    });
}

/** Everything about one variable: the question, its documentation, its facts and its ladder. */
export function variableDetailOutputs(detail: VariableDetail, hidden: string, sousDir: string | undefined): IntentOutput[] {
    const { variable } = detail;
    const { definition } = variable;
    const resolved = detail.diagnosis.resolved;
    const key = recipeKey(variable.recipe);

    const rows = detail.diagnosis.candidates.map((candidate) => ({
        envName: candidate.envName,
        rung: rungLabel(candidate.rung),
        status: candidate.envName === resolved?.source.envName ? `answered it, from ${sourceLabel(resolved.source.file)}` : "not set",
    }));

    return [
        new IntentOutput({
            title: `${definition.name} (${key})`,
            result: new VariableSet({
                Question: definition.prompt,
                About: definition.description,
                "For example": String(definition.example),
                Recipe: `${key} version ${variable.recipe.version} from ${variable.recipe.repo}`,
                "Stored in": envFileName(detail.storeIn),
                Value: displayValue(resolved === undefined ? undefined : resolved.value, definition.secret, hidden),
                Answer:
                    resolved === undefined
                        ? "nothing in scope answers this variable yet"
                        : detail.problem === undefined
                          ? "the value in scope fits this definition"
                          : `the value in scope does not fit: ${detail.problem}`,
            }),
        }),
        new IntentOutput({ result: new VariableSet(variableFacts(detail, sousDir)) }),
        new IntentOutput({ result: new Table(LADDER_COLUMNS, rows, { title: "Environment variables sous looks at, most specific first" }) }),
    ];
}

/** One answer stored, with the notes under it. */
function answeredEntries(entry: AnsweredVariable, dryRun: boolean, hidden: string): VariableEntry[] {
    const secret = entry.variable.definition.secret;
    const note = (text: string): VariableEntry => ({ label: "", value: text });
    const entries: VariableEntry[] = [
        { label: entry.variable.definition.name, value: displayValue(entry.value, secret, hidden), detail: `${entry.envName} in ${envFileName(entry.file)}` },
    ];

    if (entry.mapping !== undefined) {
        entries.push(note(`mapped to ${entry.mapping.target} in the conf.d layer`));
    }

    if (entry.replaced !== undefined) {
        entries.push(note(`${dryRun ? "replacing" : "replaced"} the answer already there: ${displayValue(entry.replaced, secret, hidden)}`));
    }

    if (entry.shadowedBy !== undefined) {
        entries.push(note(`${entry.shadowedBy} is set in your shell environment and answers this variable first; unset it for the stored answer to take effect`));
    }

    return entries;
}

/** What `vars ask` stored, kept and left unanswered, as blocks under their own titles. */
export function askReportOutputs(report: VarsAskResult, hidden: string): IntentOutput[] {
    const outputs: IntentOutput[] = [];

    if (report.inherited.length > 0) {
        outputs.push(
            new IntentOutput({
                title: "Answers already in scope",
                result: new VariableSet(
                    report.inherited.map((entry) => ({
                        label: entry.variable.definition.name,
                        value: displayValue(entry.resolved.value, entry.variable.definition.secret, hidden),
                        detail: `from ${describeSource(entry.resolved.source)}`,
                    })),
                ),
            }),
        );
    }

    if (report.answered.length > 0) {
        outputs.push(
            new IntentOutput({
                title: report.dryRun ? "Answers that would be stored" : "Answers stored",
                result: new VariableSet(report.answered.flatMap((entry) => answeredEntries(entry, report.dryRun, hidden))),
            }),
        );
    }

    if (report.skipped.length > 0) {
        outputs.push(
            new IntentOutput({
                title: "Left unanswered",
                result: new VariableSet(report.skipped.map((entry) => ({ label: entry.variable.definition.name, value: entry.reason }))),
            }),
        );
    }

    if (outputs.length === 0) {
        outputs.push(new IntentOutput({ summary: "Every variable in play already has an answer that fits its definition." }));
    }

    return outputs;
}
