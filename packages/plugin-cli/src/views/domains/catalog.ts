/**
 * The browsing views: `namespace list`, `namespace show`, `recipe list`, `recipe show`,
 * `repo search` and `repo list`. Ported from today's `src/lib/repos/catalog-display.ts` and the
 * printing in `src/commands/{namespace,recipe,repo}/*.ts`.
 *
 * The handlers already report the repositories they could not read (never fetched, or not reachable
 * upstream), so these views leave those notes out.
 */

import path from "node:path";
import type { CliViewContext, CliViewEntity } from "../../types.js";
import type { Printer, VariableEntry } from "../printer.js";
import type { TableColumn } from "../table.js";
import { BULLET, indent, wrapText } from "../text.js";

// --- The result shapes these views read (plugin-recipes' types, structurally) --------------------

type NamespaceCoverage = "whole namespace" | "some recipes" | "none";
type VersionStatus = "latest" | "pinned" | "latest and pinned" | "other";

/** One namespace `namespace.list` returns. */
export interface NamespaceListingShape {
    readonly repo: string;
    readonly namespace: string;
    readonly description?: string;
    readonly recipeCount: number;
    readonly subscribed: NamespaceCoverage;
}

/** One recipe `recipe.list` and `namespace.show` return. */
export interface RecipeListingShape {
    readonly key: string;
    readonly repo: string;
    readonly latest?: string;
    readonly pinned?: string;
    readonly linkedPath?: string;
    readonly subscribed: boolean;
    readonly description?: string;
}

/** What `namespace.show` returns. */
export interface NamespaceDetailShape {
    readonly repo: string;
    readonly repoUrl?: string;
    readonly namespace: string;
    readonly description?: string;
    readonly subscribed: NamespaceCoverage;
    readonly recipes: readonly RecipeListingShape[];
}

/** One question a recipe asks. */
export interface VariableShape {
    readonly name: string;
    readonly env?: string;
    readonly prompt?: string;
    readonly description?: string;
    readonly example?: unknown;
    readonly default?: unknown;
    readonly required?: boolean;
    readonly secret?: boolean;
    readonly scope?: string;
}

/** What `recipe.show` returns. */
export interface RecipeDetailShape {
    readonly key: string;
    readonly repo: string;
    readonly repoUrl?: string;
    readonly description?: string;
    readonly path: string;
    readonly latest?: string;
    readonly pinned?: string;
    readonly linkedPath?: string;
    readonly subscribed: boolean;
    readonly describing?: string;
    readonly versions: ReadonlyArray<{ readonly version: string; readonly status: VersionStatus; readonly prerelease: boolean; readonly releasedAt?: string }>;
    readonly dependencies: ReadonlyArray<{
        readonly key: string;
        readonly declared?: string;
        readonly kind?: string;
        readonly resolvedVersion?: string;
        readonly resolvedRange?: string;
        readonly repo?: string;
    }>;
    readonly dependenciesRecorded: boolean;
    readonly contents: ReadonlyArray<{ readonly kind: string; readonly include: readonly string[]; readonly destinations: readonly string[] }>;
    readonly variables: readonly VariableShape[];
    readonly manifestRead: boolean;
    readonly installs?: ReadonlyArray<{ readonly key: string; readonly version: string; readonly kind: string; readonly requestedBy: readonly string[] }>;
    readonly installsNeed?: ReadonlyArray<{ readonly name: string; readonly url?: string; readonly requiredBy: ReadonlyArray<{ readonly requestedBy: string }> }>;
    readonly installsProblem?: string;
    readonly questions?: QuestionPlanShape;
}

/** The questions some recipes would ask (plugin-recipes' `PlannedQuestions`). */
export interface QuestionPlanShape {
    readonly questions: ReadonlyArray<{
        readonly recipe: string;
        readonly definition: VariableShape;
        readonly storedAs?: string;
        readonly storagePath?: string;
        readonly answered: boolean;
        readonly answeredFrom?: string;
    }>;
    readonly unreadable: readonly string[];
}

/** One match `repo.search` returns. */
export interface SearchMatchShape {
    readonly key: string;
    readonly kind: "namespace" | "recipe" | "variable";
    readonly repo: string;
    readonly description?: string;
    readonly score: number;
    readonly versions?: readonly string[];
    readonly installed?: string;
}

/** One repository `repo.list` returns. */
export interface RepoListingShape {
    readonly name: string;
    readonly url: string;
    readonly provider: string;
    readonly enabled: boolean;
    readonly alwaysPull?: boolean;
    readonly addedBy?: string;
    readonly addedAt?: string;
    readonly namespaces?: readonly string[];
    readonly recipeCount?: number;
    readonly linkedPath?: string;
    readonly indexSource?: string;
    readonly lastCheckedAt?: string;
    readonly problem?: string;
    readonly installed?: ReadonlyArray<{ readonly key: string; readonly version: string }>;
}

// --- Shared wording and columns --------------------------------------------------------------------

/** How far every line of a browsing command's output is indented. */
export const INDENT = 2;

/** The columns a recipe listing shows. */
export const RECIPE_COLUMNS: TableColumn[] = [
    { key: "key", header: "Recipe", kind: "path", overflow: "truncate", minWidth: 12 },
    { key: "repo", header: "Repository", overflow: "truncate", priority: "medium" },
    { key: "latest", header: "Latest", overflow: "truncate", minWidth: 6 },
    { key: "pinned", header: "Pinned", overflow: "truncate", minWidth: 6 },
    { key: "subscribed", header: "Subscribed", priority: "medium" },
    { key: "description", header: "What it is", overflow: "wrap", flex: 1, priority: "low", minWidth: 16 },
];

const NAMESPACE_COLUMNS: TableColumn[] = [
    { key: "namespace", header: "Namespace", overflow: "truncate", minWidth: 10 },
    { key: "repo", header: "Repository", overflow: "truncate", priority: "medium" },
    { key: "recipes", header: "Recipes", kind: "number", priority: "medium" },
    { key: "subscribed", header: "Subscribed", priority: "medium" },
    { key: "description", header: "What it is", overflow: "wrap", flex: 1, priority: "low", minWidth: 16 },
];

const VERSION_COLUMNS: TableColumn[] = [
    { key: "version", header: "Version", overflow: "truncate", minWidth: 7 },
    { key: "status", header: "What it is", overflow: "wrap", flex: 1, minWidth: 16 },
    { key: "prerelease", header: "Prerelease", priority: "medium" },
    { key: "released", header: "Released", overflow: "truncate", priority: "low" },
];

const DEPENDENCY_COLUMNS: TableColumn[] = [
    { key: "key", header: "Dependency", kind: "path", overflow: "truncate", minWidth: 12 },
    { key: "declared", header: "Declared as", overflow: "wrap", flex: 1, minWidth: 12 },
    { key: "resolved", header: "Resolved to", overflow: "truncate", minWidth: 11 },
    { key: "repo", header: "Repository", overflow: "truncate", priority: "low", minWidth: 12 },
    { key: "kind", header: "Kind", overflow: "wrap", priority: "medium", minWidth: 16 },
];

const INSTALLS_COLUMNS: TableColumn[] = [
    { key: "key", header: "Recipe", kind: "path", overflow: "truncate", minWidth: 12 },
    { key: "version", header: "Version", overflow: "truncate", minWidth: 7 },
    { key: "kind", header: "Kind", overflow: "wrap", minWidth: 16 },
    { key: "neededBy", header: "Needed by", overflow: "wrap", flex: 1, priority: "low", minWidth: 16 },
];

const CONTENT_COLUMNS: TableColumn[] = [
    { key: "kind", header: "Content", minWidth: 7 },
    { key: "include", header: "Files", overflow: "wrap", flex: 1, minWidth: 14 },
    { key: "destination", header: "Where they land", kind: "path", overflow: "wrap", flex: 2, minWidth: 16 },
];

const SEARCH_COLUMNS: TableColumn[] = [
    { key: "key", header: "Match", kind: "path", overflow: "truncate", minWidth: 12 },
    { key: "kind", header: "Kind", minWidth: 4 },
    { key: "versions", header: "Versions", overflow: "truncate", minWidth: 7 },
    { key: "repo", header: "Repository", overflow: "truncate", priority: "medium" },
    { key: "description", header: "What it is", overflow: "wrap", flex: 1, priority: "low", minWidth: 16 },
];

/** Narrowed to installed recipes, a search shows the installed version beside each, as before the refactor. */
const INSTALLED_SEARCH_COLUMNS: TableColumn[] = [
    { key: "key", header: "Recipe", kind: "path", overflow: "truncate", minWidth: 12 },
    { key: "installed", header: "Installed", overflow: "truncate", minWidth: 9 },
    { key: "versions", header: "Versions", overflow: "truncate", minWidth: 7 },
    { key: "repo", header: "Repository", overflow: "truncate", priority: "medium" },
    { key: "description", header: "What it is", overflow: "wrap", flex: 1, priority: "low", minWidth: 16 },
];

const REPO_COLUMNS: TableColumn[] = [
    { key: "name", header: "Repository", overflow: "truncate", minWidth: 8 },
    { key: "provider", header: "Provider", priority: "medium" },
    { key: "origin", header: "Origin" },
    { key: "linked", header: "Linked", kind: "path", overflow: "truncate", priority: "medium", minWidth: 6 },
    { key: "recipes", header: "Recipes", kind: "number", priority: "low", minWidth: 11 },
    { key: "url", header: "URL", kind: "url", overflow: "truncate", truncate: "middle", priority: "low", flex: 1, minWidth: 12 },
];

/** What a listing says about the linked recipes it marked. */
export const LINKED_NOTE =
    "A recipe marked linked is pinned at the version shown, but builds currently read it from the linked checkout of its repository.";

/** The marker today's config writes for a repository sous adds itself. */
const BUILT_IN_ADDED_BY = "sous";

/** The recipe columns; narrowed to installed recipes, the pinned column is headed "Installed". */
export function recipeColumns(installed: boolean): TableColumn[] {
    return installed ? RECIPE_COLUMNS.map((column) => (column.key === "pinned" ? { ...column, header: "Installed" } : column)) : RECIPE_COLUMNS;
}

/** Recipe listings as table rows. */
export function recipeRows(listings: readonly RecipeListingShape[], view: CliViewContext): Array<Record<string, string>> {
    return listings.map((entry) => ({
        key: entry.key,
        repo: entry.repo,
        latest: entry.latest ?? "none published",
        pinned: pinnedCell(entry.pinned, entry.linkedPath, view),
        subscribed: entry.subscribed ? "yes" : "no",
        description: entry.description ?? "no description published",
    }));
}

/** The pinned version as a cell, marked `linked` when builds read a linked checkout. */
export function pinnedCell(pinned: string | undefined, linkedPath: string | undefined, view: CliViewContext): string {
    if (pinned === undefined) {
        return "";
    }

    return linkedPath === undefined ? pinned : `${pinned} ${view.style.muted("linked")}`;
}

/** Plain wording for how much of a namespace the project subscribes to. */
export function describeCoverage(coverage: NamespaceCoverage): string {
    if (coverage === "whole namespace") {
        return "the whole namespace";
    }

    return coverage === "some recipes" ? "some recipes" : "no";
}

/** Plain wording for what one published version is to this project. */
export function describeVersionStatus(status: VersionStatus): string {
    switch (status) {
        case "latest and pinned":
            return "the latest version, and the one pinned here";
        case "latest":
            return "the latest version";
        case "pinned":
            return "the version pinned here";
        default:
            return "an earlier version";
    }
}

/** Plain wording for a dependency kind. */
export function describeDependencyKind(kind: string | undefined): string {
    if (kind === "depends") {
        return "build dependency";
    }

    return kind === "subscribes" ? "co-subscription" : "not recorded";
}

/** Plain wording for who added a repository. */
export function describeOrigin(addedBy: string | undefined): string {
    if (addedBy === BUILT_IN_ADDED_BY) {
        return "built in";
    }

    return addedBy === undefined || addedBy === "user" ? "user" : `required by ${addedBy}`;
}

/** What to say where a content kind has no destination directory. */
export function noDestinationText(kind: string): string {
    switch (kind) {
        case "config":
            return "loaded as a config layer, so nothing is written";
        case "memories":
            return "reaches an agent through an include line in its instructions, so nothing is written";
        case "skills":
            return "nowhere: this project sets no 'recipes.skills.outputs' directory";
        default:
            return `nowhere: this project has no destination for ${kind} yet`;
    }
}

/** One labeled fact: the label, and the lines beside it. */
interface Fact {
    label: string;
    lines: string[];
}

function factIf(label: string, value: string | undefined): Fact[] {
    return value === undefined || value.length === 0 ? [] : [{ label, lines: [value] }];
}

/** A labeled facts block, indented four, every colon lined up (`renderFacts` today). */
function printFacts(out: Printer, facts: readonly Fact[]): void {
    const labelWidth = Math.max(...facts.map((fact) => fact.label.length));

    for (const fact of facts) {
        fact.lines.forEach((text, index) => {
            const entry: VariableEntry = { label: index === 0 ? fact.label : "", value: text };

            out.push(...out.formatVariable(entry, { indent: 4, labelWidth }));
        });
    }
}

/** A table, each line indented the browsing commands' two. */
function printTable(out: Printer, columns: TableColumn[], rows: Array<Record<string, unknown>>, options: { rowNote?: (row: Record<string, unknown>) => string | undefined } = {}): void {
    for (const line of out.formatTable(columns, rows, { indent: INDENT, ...options })) {
        out.log(indent(line, INDENT));
    }
}

function installedFlag(view: CliViewContext): boolean {
    return view.input.installed === true;
}

/**
 * The "Command Variables" block a browsing command opens with, as before the refactor: the project,
 * its config, what was asked about, where the indexes were read from and any narrowing.
 *
 * ```text
 * $ Command Variables:
 *     Project: my-app
 *     Config : /work/my-app/.sous/sous.config.js
 *     Recipe : alpha
 *     Reading: the cached indexes
 * ```
 */
export function browsingVariables(out: Printer, view: Pick<CliViewContext, "input" | "project">, asked: Record<string, string | undefined> = {}): void {
    const entries: Record<string, unknown> = {};

    if (view.project !== undefined) {
        entries.Project = path.basename(view.project.root);

        if (view.project.configPath !== undefined) {
            entries.Config = view.project.configPath;
        }
    }

    for (const [label, value] of Object.entries(asked)) {
        if (value !== undefined) {
            entries[label] = value;
        }
    }

    entries.Reading = view.input.latest === true ? "each repository, upstream" : "the cached indexes";

    if (view.input.installed === true) {
        entries.Showing = "only what this project has installed";
    }

    out.subheading("Command Variables", "$");
    out.variables(entries);
}

/** The text of a string input, or nothing. */
function inputText(view: Pick<CliViewContext, "input">, key: string): string | undefined {
    const value = view.input[key];

    return typeof value === "string" ? value : undefined;
}

// --- The views -------------------------------------------------------------------------------------

/** `sous namespace list`. */
function namespaceList(result: readonly NamespaceListingShape[], view: CliViewContext): string {
    const out = view.printer();

    browsingVariables(out, view);
    const installed = installedFlag(view);

    out.heading(installed ? "Namespaces this project has installed recipes from" : "Namespaces in the repositories this project trusts");
    out.blank();

    if (result.length === 0) {
        out.paragraph(installed ? "This project has installed no recipe from the repositories it trusts." : "The repositories this project trusts publish no namespaces.");
    } else {
        const columns = installed ? NAMESPACE_COLUMNS.map((column) => (column.key === "recipes" ? { ...column, header: "Installed" } : column)) : NAMESPACE_COLUMNS;

        printTable(
            out,
            columns,
            result.map((entry) => ({
                namespace: entry.namespace,
                repo: entry.repo,
                recipes: String(entry.recipeCount),
                subscribed: describeCoverage(entry.subscribed),
                description: entry.description ?? "no description published",
            })),
        );
    }

    return out.footer().text();
}

/** `sous namespace show <ref>`. */
function namespaceShow(detail: NamespaceDetailShape, view: CliViewContext): string {
    const out = view.printer();

    browsingVariables(out, view, { Namespace: inputText(view, "ref") });
    const installed = installedFlag(view);

    out.heading(`The namespace ${detail.namespace}`);
    out.blank();
    printFacts(out, [
        { label: "Repository", lines: [detail.repo] },
        ...factIf("Location", detail.repoUrl),
        ...factIf("About", detail.description),
        { label: installed ? "Installed recipes" : "Recipes", lines: [String(detail.recipes.length)] },
        { label: "Subscribed", lines: [describeCoverage(detail.subscribed)] },
    ]);
    out.blank();
    out.subheading(`Recipes in ${detail.namespace}`);
    out.blank();

    if (detail.recipes.length === 0) {
        out.paragraph(`The repository ${detail.repo} publishes no recipes in this namespace.`);

        return out.footer().text();
    }

    printTable(out, recipeColumns(installed), recipeRows(detail.recipes, view));

    if (detail.recipes.some((entry) => entry.linkedPath !== undefined)) {
        out.blank();
        out.note(LINKED_NOTE);
    }

    return out.footer().text();
}

/** `sous recipe list`. */
function recipeList(result: readonly RecipeListingShape[], view: CliViewContext): string {
    const out = view.printer();

    browsingVariables(out, view);
    const installed = installedFlag(view);

    out.heading(installed ? "Recipes this project has installed" : "Recipes in the repositories this project trusts");
    out.blank();

    if (result.length === 0) {
        out.paragraph(installed ? "This project has installed no recipe from the repositories it trusts." : "The repositories this project trusts publish no recipes.");
    } else {
        printTable(out, recipeColumns(installed), recipeRows(result, view));
    }

    if (result.some((entry) => entry.linkedPath !== undefined)) {
        out.blank();
        out.note(LINKED_NOTE);
    }

    return out.footer().text();
}

/** `sous recipe show <ref>`. */
function recipeShow(detail: RecipeDetailShape, view: CliViewContext): string {
    const out = view.printer();

    browsingVariables(out, view, { Recipe: inputText(view, "ref") });
    const installed = installedFlag(view);

    out.heading(detail.key);
    out.blank();
    printFacts(out, [
        { label: "Repository", lines: [detail.repo] },
        ...factIf("Location", detail.repoUrl),
        ...factIf("About", detail.description),
        { label: "Folder", lines: [detail.path] },
        { label: "Latest version", lines: [detail.latest ?? "none published"] },
        { label: installed ? "Installed version" : "Pinned version", lines: [detail.pinned ?? "this project pins none"] },
        ...factIf("Linked", detail.linkedPath === undefined ? undefined : `builds currently read this recipe from the checkout at ${detail.linkedPath}`),
        { label: "Subscribed", lines: [detail.subscribed ? "yes" : "no"] },
        ...factIf("Described below", detail.describing),
    ]);

    out.blank();
    out.subheading("Published versions");
    out.blank();
    printTable(
        out,
        VERSION_COLUMNS,
        detail.versions.map((entry) => ({
            version: entry.version,
            status: describeVersionStatus(entry.status),
            prerelease: entry.prerelease ? "yes" : "no",
            released: entry.releasedAt ?? "not recorded",
        })),
    );

    out.blank();
    out.subheading("What it depends on");
    out.blank();

    if (detail.dependencies.length === 0) {
        out.paragraph(detail.manifestRead || detail.dependenciesRecorded ? "This recipe depends on nothing else." : "The repository's index records no dependencies for this version.");
    } else {
        printTable(
            out,
            DEPENDENCY_COLUMNS,
            detail.dependencies.map((entry) => ({
                key: entry.key,
                declared: entry.declared === undefined ? "not recorded in the index" : describeDeclaration(entry.declared),
                resolved: entry.resolvedVersion ?? (entry.resolvedRange === undefined ? "not recorded in the index" : `the range ${entry.resolvedRange}`),
                repo: entry.repo ?? "this repository",
                kind: describeDependencyKind(entry.kind),
            })),
        );
    }

    if (detail.describing === undefined) {
        out.blank();
        out.paragraph("This recipe publishes no version a subscription would install, so nothing is described below.");
    } else if (detail.installsProblem !== undefined || detail.installs === undefined || detail.questions === undefined) {
        out.blank();
        out.paragraph(detail.installsProblem ?? "Sous could not work out what subscribing would install.");
    } else {
        printInstalls(out, detail);
        out.blank();
        out.subheading("What subscribing asks you");
        out.blank();
        writeQuestionPlan(out, detail.questions, { answerHints: false });
    }

    out.blank();
    out.subheading("Where its files land in this project");
    out.blank();

    if (!detail.manifestRead) {
        out.paragraph("The recipe's own files are not on this machine, so the files it publishes are not known here. Subscribing to it fetches them.");
    } else if (detail.contents.length === 0) {
        out.paragraph("This recipe publishes no files.");
    } else {
        printTable(
            out,
            CONTENT_COLUMNS,
            detail.contents.map((entry) => ({
                kind: entry.kind,
                include: entry.include.join(", "),
                destination: entry.destinations.length > 0 ? entry.destinations.join(", ") : noDestinationText(entry.kind),
            })),
        );
    }

    return out.footer().text();
}

/**
 * How a manifest entry brings a dependency in: a whole namespace is named as one, any other entry
 * is shown as written.
 *
 * ```ts
 * describeDeclaration("workflow"); // -> "the whole 'workflow' namespace"
 * describeDeclaration("tools/lint"); // -> "tools/lint"
 * ```
 */
export function describeDeclaration(declared: string): string {
    const match = /^(?:([a-z0-9][a-z0-9._-]*):)?([a-z][a-z0-9-]*)(?:@.*)?$/i.exec(declared.trim());

    if (match === null) {
        return declared;
    }

    return match[1] === undefined ? `the whole '${match[2]}' namespace` : `the whole '${match[2]}' namespace of ${match[1]}`;
}

/** Every recipe a subscription to the described version installs, and what brings each in. */
function printInstalls(out: Printer, detail: RecipeDetailShape): void {
    out.blank();
    out.subheading("What subscribing installs");
    out.blank();
    printTable(
        out,
        INSTALLS_COLUMNS,
        (detail.installs ?? []).map((recipe) => {
            const holders = recipe.requestedBy.filter((holder) => holder !== "project");

            return {
                key: recipe.key,
                version: recipe.version,
                kind: recipe.requestedBy.includes("project") ? "the subscription itself" : describeDependencyKind(recipe.kind),
                neededBy: holders.length === 0 ? "this subscription" : holders.join(", "),
            };
        }),
    );

    const missing = detail.installsNeed ?? [];

    if (missing.length > 0) {
        out.blank();
        out.paragraph(
            `Subscribing also needs ${missing.length === 1 ? "a repository" : "repositories"} this project does not trust yet, so what ${missing.length === 1 ? "it publishes" : "they publish"} is not listed above: ` +
                missing
                    .map((entry) => `${entry.name}${entry.url === undefined ? "" : ` (${entry.url})`}, needed by ${entry.requiredBy.map((holder) => holder.requestedBy).join(", ")}`)
                    .join("; ") +
                ".",
        );
    }
}

/**
 * The questions some recipes would ask, grouped by recipe, as `subscription add --dry-run` and
 * `recipe show` showed them before the refactor. `answerHints` adds the flag that answers each.
 */
export function writeQuestionPlan(out: Printer, plan: QuestionPlanShape, options: { answerHints: boolean }): void {
    const count = plan.questions.length;
    const unanswered = plan.questions.filter((question) => !question.answered).length;
    const unreadable =
        plan.unreadable.length === 0
            ? undefined
            : `Not on this machine yet, and their repository's index does not record their questions, so they cannot be listed: ${plan.unreadable.join(", ")}.` +
              (options.answerHints ? " A dry run downloads nothing; run this command again without '--dry-run' to install them and be asked." : "");

    if (count === 0) {
        out.paragraph(unreadable ?? "None of these recipes ask any questions, so nothing needs answering.");

        return;
    }

    const subject = plan.unreadable.length === 0 ? "These recipes ask" : "The recipes sous could read ask";

    out.paragraph(`${subject} ${count === 1 ? "1 question" : `${count} questions`}, ${unanswered} of which nothing answers yet.`);

    const groups = new Map<string, QuestionPlanShape["questions"][number][]>();

    for (const question of plan.questions) {
        groups.set(question.recipe, [...(groups.get(question.recipe) ?? []), question]);
    }

    for (const [recipe, questions] of groups) {
        out.blank();
        out.log(`  ${recipe} asks ${questions.length === 1 ? "1 question" : `${questions.length} questions`}:`);

        for (const question of questions) {
            const variable = question.definition;

            out.blank();
            out.log(`    ${out.style.cyan(variable.name)}`);

            const facts: Fact[] = [
                ...factIf("about", variable.description ? firstSentence(variable.description) : undefined),
                ...(variable.example === undefined ? [] : [{ label: "example", lines: [String(variable.example)] }]),
                ...factIf("stored-as", question.storedAs),
                ...factIf("storage-path", question.storagePath),
                {
                    label: "answered",
                    lines: [
                        question.answered
                            ? `yes${question.answeredFrom === undefined ? "" : `, from ${question.answeredFrom}`}`
                            : variable.required === false
                              ? "no, and an answer is optional"
                              : "no, and this recipe requires an answer",
                    ],
                },
                ...(options.answerHints ? [{ label: "answer-with", lines: [`--answer ${variable.name}=<value>`] }] : []),
            ];
            const labelWidth = Math.max(...facts.map((fact) => fact.label.length));

            for (const fact of facts) {
                out.push(...out.formatVariable({ label: fact.label, value: fact.lines[0] ?? "" }, { indent: 6, labelWidth }));
            }
        }
    }

    if (unreadable !== undefined) {
        out.blank();
        out.paragraph(unreadable);
    }

    if (options.answerHints && unanswered > 0) {
        out.blank();
        out.paragraph("Answer them all ahead of time by running this command again without '--dry-run', with one '--answer <name>=<value>' for each, or with '--answers-file <path>'.");
    }
}

/** The first sentence of a description. */
export function firstSentence(text: string): string {
    const match = /^.*?[.!?](?=\s|$)/s.exec(text.trim());

    return (match?.[0] ?? text.trim()).replace(/\s+/g, " ");
}

/** `sous repo search <text>`. */
function repoSearch(result: readonly SearchMatchShape[], view: CliViewContext): string {
    const out = view.printer();

    browsingVariables(out, view, { Searching: inputText(view, "text") });
    const text = typeof view.input.text === "string" ? view.input.text : "";
    const installed = installedFlag(view);

    out.section("Recipes matching your search");

    if (result.length === 0) {
        out.paragraph(installed ? `Nothing this project has installed matches '${text}'.` : `Nothing in the repositories this project trusts matches '${text}'.`);
    } else {
        printTable(
            out,
            installed ? INSTALLED_SEARCH_COLUMNS : SEARCH_COLUMNS,
            result.map((match) => ({
                key: match.key,
                kind: match.kind,
                versions: match.versions?.join(", ") ?? "",
                installed: match.installed ?? "",
                repo: match.repo,
                description: match.description !== undefined && match.description.length > 0 ? match.description : "no description published",
            })),
        );

        const limit = typeof view.input.limit === "number" ? view.input.limit : 20;

        if (result.length >= limit) {
            out.blank();
            out.paragraph(`Only the first ${limit} matches are shown. Raise the number with '--limit'.`);
        }
    }

    return out.footer().text();
}

/** `sous repo list`. */
function repoList(result: readonly RepoListingShape[], view: CliViewContext): string {
    const out = view.printer();

    browsingVariables(out, view);
    const verbose = view.input.verbose === true;

    out.section(installedFlag(view) ? "Repositories this project has installed recipes from" : "Repositories this project trusts");

    if (result.length === 0) {
        out.paragraph("This project trusts no repositories yet. Add one with 'sous repo add <url>'; adding a repository is how you trust it.");

        return out.footer().text();
    }

    const rows = result.map((entry) => ({
        name: entry.name,
        url: entry.url,
        provider: entry.provider,
        origin: describeOrigin(entry.addedBy),
        linked: entry.linkedPath === undefined ? "no" : `yes: ${entry.linkedPath}`,
        recipes: entry.recipeCount === undefined ? "not fetched" : String(entry.recipeCount),
        namespaces: entry.namespaces === undefined ? "not fetched" : entry.namespaces.length > 0 ? entry.namespaces.join(", ") : "none",
        enabled: entry.enabled,
        installed: entry.installed,
    }));
    const width = Math.max(20, out.wrapWidth - INDENT * 2);

    printTable(out, REPO_COLUMNS, rows, {
        rowNote: (row) => {
            const notes: string[] = [];

            if (row.enabled === false) {
                notes.push("Switched off in the config, so nothing is read from it.");
            }

            if (verbose) {
                notes.push(`Namespaces: ${String(row.namespaces)}`);
            }

            const pins = row.installed as RepoListingShape["installed"];

            if (pins !== undefined && pins.length > 0) {
                notes.push(`Installed: ${pins.map((pin) => `${pin.key} ${pin.version}`).join(", ")}`);
            }

            return notes.length === 0
                ? undefined
                : notes
                      .flatMap((text) => wrapText(text, width))
                      .map((line) => view.style.gray(indent(line, INDENT)))
                      .join("\n");
        },
    });

    const problems = result.filter((entry) => entry.problem !== undefined);

    if (problems.length > 0) {
        out.blank();

        for (const entry of problems) {
            out.paragraph(`${BULLET} ${entry.name} could not be checked upstream, so it is shown from the cache: ${entry.problem}`);
        }
    }

    return out.footer().text();
}

/** The views of this domain, by intent. */
export const views: Record<string, CliViewEntity["render"]> = {
    "namespace.list": namespaceList,
    "namespace.show": namespaceShow,
    "recipe.list": recipeList,
    "recipe.show": recipeShow,
    "repo.search": repoSearch,
    "repo.list": repoList,
};
