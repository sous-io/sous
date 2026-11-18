/**
 * What the `vars` intents show: the listing of variables in play, one variable in full, and the
 * report of what `vars.ask` stored, kept and left unanswered. Each builder returns outputs; the
 * intents add the "Command Variables" block and the machine data.
 */

import path from "node:path";
import { IntentOutput, type TableColumn, Table, VariableSet, type VariableEntry } from "@sous-io/plugin-api";
import { answeredBy, inheritedSameness, OPTIONAL_HINT, OPTIONAL_REASON, reportedOnce } from "./ask.js";
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
 * empty label, continuing the first.
 */
function variableFacts(detail: VariableDetail): VariableEntry[] {
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

    // Other recipes defining the same name: one combined question, or why each is asked alone, or
    // why this version is not asked at all.
    if (variable.unanswerable !== undefined) {
        entries.push({ label: "not-answerable", value: variable.unanswerable });
    } else if (variable.separate !== undefined) {
        entries.push({ label: "asked-separately", value: variable.separate });
    } else if (variable.requiredBy !== undefined && variable.requiredBy.length > 0) {
        entries.push({ label: "combined-with", value: variable.requiredBy.map(recipeKey).join(", ") });
    }
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
            value: displayValue(listing.answered || listing.usesDefault === true ? (listing.value ?? "") : undefined, listing.variable.definition.secret, hidden),
            source:
                listing.variable.unanswerable !== undefined
                    ? "not answerable alongside another version of this recipe"
                    : listing.usesDefault === true
                      ? "its default; no answer is stored"
                      : listing.source === undefined
                        ? "nothing yet"
                        : `${rungLabel(listing.source.rung)}, ${sourceLabel(listing.source.file)}`,
        }));

    return new IntentOutput({
        title: "Variables in play",
        result: new Table(LIST_COLUMNS, rows, {
            empty: "No recipe in this project defines any variables yet. Subscribe to a recipe that publishes some, or read a definitions file with --file.",
        }),
    });
}

/** An env file by its full path when the project's `.sous/` directory is known, else by its name. */
function envFileShown(file: string, sousDir: string | undefined): string {
    return sousDir === undefined ? envFileName(file) : path.join(sousDir, envFileName(file));
}

/**
 * Everything about one variable: the question, its documentation, its facts and its ladder. "Stored
 * in" is where the value in scope came from; "Saved to" is where a new answer goes, which can differ
 * (gh-229 defect 8).
 */
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

    return withOneLabelWidth([
        new IntentOutput({
            title: `${definition.name} (${key})`,
            result: new VariableSet({
                Question: definition.prompt,
                About: definition.description,
                "For example": String(definition.example),
                Recipe: `${key} version ${variable.recipe.version} from ${variable.recipe.repo}`,
                "Stored in": resolved === undefined ? "nowhere yet" : resolved.source.file === "shell" ? sourceLabel("shell") : envFileShown(resolved.source.file, sousDir),
                "Saved to": `${envFileShown(detail.storeIn, sousDir)} (where new answers go)`,
                Value:
                    detail.usesDefault === true
                        ? `${displayValue(detail.value, definition.secret, hidden)} (default)`
                        : displayValue(resolved === undefined ? undefined : resolved.value, definition.secret, hidden),
                Answer:
                    variable.unanswerable !== undefined
                        ? `none: this version of ${key} is not asked this variable, because another version of ${key} is`
                        : detail.usesDefault === true
                        ? "nothing in scope answers this variable, so its default is used"
                        : resolved === undefined
                        ? "nothing in scope answers this variable yet"
                        : detail.problem === undefined
                          ? "the value in scope fits this definition"
                          : `the value in scope does not fit: ${detail.problem}`,
            }),
        }),
        new IntentOutput({ result: new VariableSet(variableFacts(detail)) }),
        new IntentOutput({ result: new Table(LADDER_COLUMNS, rows, { title: "Environment variables sous looks at, most specific first" }) }),
    ]);
}

/**
 * The outputs with every label block padded to one width, the longest label of any of them, so
 * blocks printed one under another line their colons up.
 */
function withOneLabelWidth(outputs: IntentOutput[]): IntentOutput[] {
    const sets = outputs.map((output) => output.result).filter((result): result is VariableSet => result instanceof VariableSet);
    const labelWidth = Math.max(0, ...sets.flatMap((set) => set.entries.map((entry) => entry.label.length)));

    return outputs.map((output) =>
        output.result instanceof VariableSet
            ? new IntentOutput({
                  ...(output.title === undefined ? {} : { title: output.title }),
                  ...(output.summary === undefined ? {} : { summary: output.summary }),
                  ...(output.data === undefined ? {} : { data: output.data }),
                  ...(output.style === undefined ? {} : { style: output.style }),
                  result: new VariableSet(output.result.entries, { ...(output.result.title === undefined ? {} : { title: output.result.title }), labelWidth }),
              })
            : output,
    );
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
                    reportedOnce(report.inherited, inheritedSameness).map(({ entry, recipes, named }) => ({
                        label: entry.variable.definition.name,
                        value: displayValue(entry.resolved.value, entry.variable.definition.secret, hidden),
                        detail: `from ${describeSource(entry.resolved.source)}${named ? `; used by ${recipes.join(", ")}` : ""}`,
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
                result: new VariableSet(
                    reportedOnce(report.skipped, (entry) => entry.reason).map(({ entry, recipes, named }) => ({
                        label: entry.variable.definition.name,
                        value: named ? `${entry.reason} (used by ${recipes.join(", ")})` : entry.reason,
                    })),
                ),
            }),
        );

        if (report.skipped.some((entry) => entry.reason === OPTIONAL_REASON)) {
            outputs.push(new IntentOutput({ summary: OPTIONAL_HINT }));
        }
    }

    if (report.wouldAsk !== undefined && report.wouldAsk.length > 0) {
        outputs.push(
            new IntentOutput({
                title: "Questions that would be asked",
                result: new VariableSet(
                    report.wouldAsk.flatMap((entry): VariableEntry[] => [
                        { label: entry.variable.definition.name, value: entry.variable.definition.prompt, detail: recipeKey(entry.variable.recipe) },
                        ...(entry.current === undefined ? [] : [{ label: "", value: `the value in scope does not fit: ${entry.current}` }]),
                        { label: "", value: `answer it ahead of time with ${answeredBy(entry.variable)}` },
                    ]),
                ),
            }),
        );
    }

    if (outputs.length === 0) {
        outputs.push(new IntentOutput({ summary: "Every variable in play already has an answer that fits its definition." }));
    }

    return outputs;
}
