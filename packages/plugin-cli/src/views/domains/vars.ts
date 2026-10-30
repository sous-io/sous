/**
 * The views of the `sous vars` commands (`vars.ask`, `vars.list`, `vars.show`, `vars.map`), ported
 * from today's `src/lib/vars/display.ts`, `report.ts` and the `formatAskReport` half of `ask.ts`.
 * The result shapes are plugin-recipe-answers' (`VarsAskResult`, `VariableListing`,
 * `VariableDetail`), declared here structurally so plugin-cli depends on no other plugin.
 */

import path from "node:path";
import type { CliViewContext, CliViewEntity } from "../../types.js";
import type { Printer, VariableEntry } from "../printer.js";
import type { TableColumn } from "../table.js";
import { BULLET, wrapText } from "../text.js";

// ---------------------------------------------------------------------------------------------
// The result shapes this module reads
// ---------------------------------------------------------------------------------------------

/** The recipe that defines a variable. */
export interface ViewRecipe {
    readonly repo: string;
    readonly namespace: string;
    readonly name: string;
    readonly version: string;
    readonly url?: string;
    readonly path?: string;
    readonly dir?: string;
}

/** One defined variable. */
export interface ViewVariable {
    readonly definition: {
        readonly name: string;
        readonly prompt: string;
        readonly description: string;
        readonly example: unknown;
        readonly default?: unknown;
        readonly secret: boolean;
    };
    readonly recipe: ViewRecipe;
    readonly requiredBy?: readonly ViewRecipe[];
}

/** Where an answer came from. */
export interface ViewSource {
    readonly rung: string;
    readonly envName: string;
    readonly file: string;
}

/** One variable as `vars.list` returns it. */
export interface ViewListing {
    readonly variable: ViewVariable;
    readonly answered: boolean;
    readonly value?: string;
    readonly source?: ViewSource;
    readonly storedAs: string;
    readonly storeIn: string;
}

/** One variable as `vars.show` returns it. */
export interface ViewDetail extends ViewListing {
    readonly diagnosis: {
        readonly resolved?: { readonly value: string; readonly source: ViewSource };
        readonly candidates: ReadonlyArray<{ readonly rung: string; readonly envName: string }>;
    };
    readonly constraints: readonly string[];
    readonly problem?: string;
    readonly mapping?: { readonly envName: string; readonly target: string };
}

/** What `vars.ask` returns. */
export interface ViewAskResult {
    readonly answered: ReadonlyArray<{
        readonly variable: ViewVariable;
        readonly envName: string;
        readonly file: string;
        readonly value: string;
        readonly mapping?: { readonly target: string };
        readonly replaced?: string;
        readonly shadowedBy?: string;
    }>;
    readonly inherited: ReadonlyArray<{ readonly variable: ViewVariable; readonly resolved: { readonly value: string; readonly source: ViewSource } }>;
    readonly skipped: ReadonlyArray<{ readonly variable: ViewVariable; readonly reason: string }>;
    readonly dryRun: boolean;
}

// ---------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------

/** What the value column shows for a variable nothing has answered. */
export const UNANSWERED_VALUE = "(unanswered)";

/** What a secret shows instead of its value. */
export const HIDDEN_VALUE = "(hidden)";

/** Each rung of the answer ladder, in plain words. */
export const RUNG_LABELS: Readonly<Record<string, string>> = {
    mapping: "mapping record",
    recipe: "recipe scope",
    namespace: "namespace scope",
    shared: "shared scope",
    bare: "declared name",
};

/** The env files' names, by kind. */
export const ENV_FILE_NAMES: Readonly<Record<string, string>> = { shared: ".env", local: ".env.local" };

/** Each place an answer can come from, in plain words. */
export const SOURCE_LABELS: Readonly<Record<string, string>> = {
    shell: "the shell environment",
    shared: "the .env file",
    local: "the .env.local file",
};

function rungLabel(rung: string): string {
    return RUNG_LABELS[rung] ?? rung;
}

function sourceLabel(file: string): string {
    return SOURCE_LABELS[file] ?? file;
}

function envFileName(file: string): string {
    return ENV_FILE_NAMES[file] ?? file;
}

/** `namespace/recipe`. */
export function recipeKey(recipe: ViewRecipe): string {
    return `${recipe.namespace}/${recipe.name}`;
}

/** `namespace/recipe.name`. */
function variableKey(variable: ViewVariable): string {
    return `${recipeKey(variable.recipe)}.${variable.definition.name}`;
}

/** The value a listing shows: the answer, or `(unanswered)`; a secret never prints. */
export function displayValue(value: string | undefined, secret: boolean): string {
    if (value === undefined) {
        return UNANSWERED_VALUE;
    }

    return secret ? HIDDEN_VALUE : value;
}

/** "the shared scope name SOUS_VAR_API_URL, from the .env file". */
export function describeSource(source: ViewSource): string {
    return `the ${rungLabel(source.rung)} name ${source.envName}, from ${sourceLabel(source.file)}`;
}

// ---------------------------------------------------------------------------------------------
// The labeled facts about one variable
// ---------------------------------------------------------------------------------------------

/** One line of a fact, with an optional muted detail after it. */
export interface FactLine {
    text: string;
    detail?: string;
}

/** One labeled fact. */
export interface LabeledFact {
    label: string;
    lines: Array<string | FactLine>;
}

function isHostedUrl(location: string): boolean {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(location) || location.startsWith("git@");
}

/** Where a recipe's source lives: its repository URL and folder, a path, or nothing. */
export function recipeLocation(recipe: ViewRecipe): string | undefined {
    if (recipe.url !== undefined && isHostedUrl(recipe.url)) {
        const base = recipe.url.replace(/\/+$/, "");

        return recipe.path === undefined ? base : `${base}/${recipe.path}`;
    }

    if (recipe.url !== undefined) {
        return recipe.path === undefined ? recipe.url : `${recipe.url.replace(/\/+$/, "")}/${recipe.path}`;
    }

    return recipe.dir;
}

/** A recipe as a fact line: its key, its location muted after it. */
export function recipeLink(recipe: ViewRecipe): FactLine {
    const location = recipeLocation(recipe);

    return location === undefined ? { text: recipeKey(recipe) } : { text: recipeKey(recipe), detail: location };
}

/**
 * The facts about one variable, in the order `vars show` prints them. With the project's `.sous/`
 * directory, the storage path is the env file's full path, as before the refactor.
 */
export function variableFacts(detail: ViewDetail, sousDir?: string): LabeledFact[] {
    const { variable } = detail;
    const { definition } = variable;
    const facts: LabeledFact[] = [];

    if (definition.default !== undefined) {
        facts.push({ label: "default", lines: [String(definition.default)] });
    }

    facts.push({ label: "example", lines: [String(definition.example)] });

    const chain = variable.requiredBy && variable.requiredBy.length > 0 ? variable.requiredBy : [variable.recipe];
    const requiredBy: Array<string | FactLine> = [recipeLink(chain[0] ?? variable.recipe)];

    if (chain.length > 1) {
        requiredBy.push(`pulled in through ${chain.map(recipeKey).join(" then ")}`);
    }

    facts.push({ label: "required-by", lines: requiredBy });
    facts.push({ label: "defined-by", lines: [recipeLink(variable.recipe)] });
    facts.push({ label: "storage-path", lines: [sousDir === undefined ? envFileName(detail.storeIn) : path.join(sousDir, envFileName(detail.storeIn))] });
    facts.push({ label: "stored-as", lines: [detail.storedAs] });
    facts.push({ label: "constraints", lines: detail.constraints.map((bullet) => `${BULLET} ${bullet}`) });

    return facts;
}

/** Lays the facts out as one key and value block, colons lined up, indented four. */
export function renderFacts(out: Printer, facts: readonly LabeledFact[], width = out.columns): string[] {
    const labelWidth = Math.max(...facts.map((fact) => fact.label.length));
    const lines: string[] = [];

    for (const fact of facts) {
        fact.lines.forEach((raw, index) => {
            const line: FactLine = typeof raw === "string" ? { text: raw } : raw;
            const entry: VariableEntry = { label: index === 0 ? fact.label : "", value: line.text, ...(line.detail === undefined ? {} : { detail: line.detail }) };

            lines.push(...out.formatVariable(entry, { indent: 4, labelWidth, width }));
        });
    }

    return lines;
}

// ---------------------------------------------------------------------------------------------
// vars list
// ---------------------------------------------------------------------------------------------

/** How far every line of the reports is indented. */
const INDENT = 2;

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
export function renderVariableList(out: Printer, listings: readonly ViewListing[]): void {
    out.heading("Variables in play");

    if (listings.length === 0) {
        out.blank();
        out.paragraph("No recipe in this project defines any variables yet. Subscribe to a recipe that publishes some, or read a definitions file with --file.");

        return;
    }

    const rows = [...listings]
        .sort((left, right) => variableKey(left.variable).localeCompare(variableKey(right.variable)))
        .map((listing) => ({
            name: listing.variable.definition.name,
            recipe: recipeKey(listing.variable.recipe),
            envName: listing.source?.envName ?? "",
            value: displayValue(listing.answered ? (listing.value ?? "") : undefined, listing.variable.definition.secret),
            source: listing.source === undefined ? "nothing yet" : `${rungLabel(listing.source.rung)}, ${sourceLabel(listing.source.file)}`,
        }));

    out.blank();
    out.table(LIST_COLUMNS, rows, { indent: INDENT });
}

// ---------------------------------------------------------------------------------------------
// vars show
// ---------------------------------------------------------------------------------------------

/** Everything about one variable: the question, its documentation, its facts and its ladder. */
export function renderVariableDetail(out: Printer, detail: ViewDetail, sousDir?: string): void {
    const { variable } = detail;
    const { definition } = variable;
    const resolved = detail.diagnosis.resolved;
    const key = recipeKey(variable.recipe);

    out.heading(`${definition.name} (${key})`);
    out.blank();
    out.variables({
        Question: definition.prompt,
        About: definition.description,
        "For example": String(definition.example),
        Recipe: `${key} version ${variable.recipe.version} from ${variable.recipe.repo}`,
        "Stored in": envFileName(detail.storeIn),
        Value: displayValue(resolved === undefined ? undefined : resolved.value, definition.secret),
        Answer:
            resolved === undefined
                ? "nothing in scope answers this variable yet"
                : detail.problem === undefined
                  ? "the value in scope fits this definition"
                  : `the value in scope does not fit: ${detail.problem}`,
    });

    out.blank();
    out.push(...renderFacts(out, variableFacts(detail, sousDir)));

    out.blank();
    out.subheading("Environment variables sous looks at, most specific first");
    out.blank();

    const rows = detail.diagnosis.candidates.map((candidate) => ({
        envName: candidate.envName,
        rung: rungLabel(candidate.rung),
        status: candidate.envName === resolved?.source.envName ? `answered it, from ${sourceLabel(resolved.source.file)}` : "not set",
    }));

    out.table(LADDER_COLUMNS, rows, { indent: INDENT });
}

// ---------------------------------------------------------------------------------------------
// vars ask
// ---------------------------------------------------------------------------------------------

/** What `vars ask` stored, kept and skipped, as aligned key and value blocks. */
export function formatAskReport(out: Printer, report: ViewAskResult): string[] {
    const lines: string[] = [];
    const width = out.wrapWidth - 2;
    const labelWidth = Math.max(0, ...[...report.inherited, ...report.answered, ...report.skipped].map((entry) => entry.variable.definition.name.length));
    const entryLines = (label: string, value: string, detail?: string): string[] =>
        out.formatVariable({ label, value, ...(detail === undefined ? {} : { detail }) }, { labelWidth, width });
    const noteLines = (text: string): string[] =>
        wrapText(text, width - 4 - labelWidth - 2).map((line) => `${" ".repeat(4 + labelWidth + 2)}${out.style.muted(line)}`);

    if (report.inherited.length > 0) {
        lines.push("Answers already in scope:");

        for (const entry of report.inherited) {
            const shown = displayValue(entry.resolved.value, entry.variable.definition.secret);

            lines.push(...entryLines(entry.variable.definition.name, shown, `from ${describeSource(entry.resolved.source)}`));
        }

        lines.push("");
    }

    if (report.answered.length > 0) {
        lines.push(report.dryRun ? "Answers that would be stored:" : "Answers stored:");

        for (const entry of report.answered) {
            const secret = entry.variable.definition.secret;

            lines.push(...entryLines(entry.variable.definition.name, displayValue(entry.value, secret), `${entry.envName} in ${envFileName(entry.file)}`));

            if (entry.mapping !== undefined) {
                lines.push(...noteLines(`mapped to ${entry.mapping.target} in the conf.d layer`));
            }

            if (entry.replaced !== undefined) {
                const previous = displayValue(entry.replaced, secret);

                lines.push(...noteLines(`${report.dryRun ? "replacing" : "replaced"} the answer already there: ${previous}`));
            }

            if (entry.shadowedBy !== undefined) {
                lines.push(
                    ...noteLines(`${entry.shadowedBy} is set in your shell environment and answers this variable first; unset it for the stored answer to take effect`),
                );
            }
        }

        lines.push("");
    }

    if (report.skipped.length > 0) {
        lines.push("Left unanswered:");

        for (const entry of report.skipped) {
            lines.push(...entryLines(entry.variable.definition.name, entry.reason));
        }

        lines.push("");
    }

    if (lines.length === 0) {
        lines.push(...wrapText("Every variable in play already has an answer that fits its definition.", width));
    }

    return lines;
}

// ---------------------------------------------------------------------------------------------
// The views
// ---------------------------------------------------------------------------------------------

/**
 * The "Command Variables" block `vars list` and `vars show` open with: the project, its config file
 * and where the definitions came from. Nothing about the project is shown outside one.
 *
 * ```text
 * $ Command Variables:
 *     Project    : my-app
 *     Config     : /work/my-app/.sous/sous.config.json
 *     Definitions: questions.yaml
 * ```
 */
export function renderCommandVariables(out: Printer, view: Pick<CliViewContext, "input" | "project">): void {
    const file = view.input.file;
    const entries: Record<string, unknown> = {};

    if (view.project !== undefined) {
        entries.Project = path.basename(view.project.root);

        if (view.project.configPath !== undefined) {
            entries.Config = view.project.configPath;
        }
    }

    entries.Definitions = typeof file === "string" ? file : "the project's subscribed recipes";
    out.subheading("Command Variables", "$");
    out.variables(entries);
}

function isDetail(listing: ViewListing): listing is ViewDetail {
    return "diagnosis" in listing && "constraints" in listing;
}

/** `vars list`, and `sous vars <name>` (whose result holds every match in full). */
function varsList(result: readonly ViewListing[], view: CliViewContext): string {
    const out = view.printer();

    renderCommandVariables(out, view);

    if (typeof view.input.name === "string" && result.every(isDetail)) {
        for (const detail of result) {
            renderVariableDetail(out, detail, view.project?.sousDir);
        }
    } else {
        renderVariableList(out, result);
    }

    out.footer();

    return out.text();
}

/** `vars show <name>`. */
function varsShow(result: ViewDetail, view: CliViewContext): string {
    const out = view.printer();

    renderCommandVariables(out, view);
    renderVariableDetail(out, result, view.project?.sousDir);
    out.footer();

    return out.text();
}

/** `vars ask`: the report, under "Answering variables". */
function varsAsk(result: ViewAskResult, view: CliViewContext): string {
    const out = view.printer();

    out.heading("Answering variables");
    out.blank();

    // The handler already says there was nothing to ask when nothing defines a variable.
    if (result.answered.length > 0 || result.inherited.length > 0 || result.skipped.length > 0) {
        out.blank();

        for (const line of formatAskReport(out, result)) {
            out.push(line === "" ? "" : `  ${line}`);
        }
    }

    out.footer();

    return out.text();
}

/** `vars map`: the handler's note says what changed, so nothing more is printed. */
function varsMap(): undefined {
    return undefined;
}

/** The views of this domain, by intent. */
export const views: Record<string, CliViewEntity["render"]> = {
    "vars.ask": varsAsk,
    "vars.list": varsList,
    "vars.show": varsShow,
    "vars.map": varsMap,
};
