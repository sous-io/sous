/**
 * The browsing views: `namespace list`, `namespace show`, `recipe list`, `recipe show`,
 * `repo search` and `repo list`. Ported from today's `src/lib/repos/catalog-display.ts` and the
 * printing in `src/commands/{namespace,recipe,repo}/*.ts`.
 *
 * The handlers already report the repositories they could not read (never fetched, or not reachable
 * upstream), so these views leave those notes out.
 */

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
}

/** One match `repo.search` returns. */
export interface SearchMatchShape {
    readonly key: string;
    readonly kind: "namespace" | "recipe" | "variable";
    readonly repo: string;
    readonly description?: string;
    readonly score: number;
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

const CONTENT_COLUMNS: TableColumn[] = [
    { key: "kind", header: "Content", minWidth: 7 },
    { key: "include", header: "Files", overflow: "wrap", flex: 1, minWidth: 14 },
    { key: "destination", header: "Where they land", kind: "path", overflow: "wrap", flex: 2, minWidth: 16 },
];

const SEARCH_COLUMNS: TableColumn[] = [
    { key: "key", header: "Match", kind: "path", overflow: "truncate", minWidth: 12 },
    { key: "kind", header: "Kind", minWidth: 4 },
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

// --- The views -------------------------------------------------------------------------------------

/** `sous namespace list`. */
function namespaceList(result: readonly NamespaceListingShape[], view: CliViewContext): string {
    const out = view.printer();
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
                declared: entry.declared ?? "not recorded in the index",
                resolved: entry.resolvedVersion ?? (entry.resolvedRange === undefined ? "not recorded in the index" : `the range ${entry.resolvedRange}`),
                repo: entry.repo ?? "this repository",
                kind: describeDependencyKind(entry.kind),
            })),
        );
    }

    printQuestions(out, detail);

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

/** The questions the described version asks, each with the facts `sous vars show` gives. */
function printQuestions(out: Printer, detail: RecipeDetailShape): void {
    out.blank();
    out.subheading("What subscribing asks you");
    out.blank();

    if (detail.describing === undefined) {
        out.paragraph("This recipe publishes no version a subscription would install, so nothing is described here.");

        return;
    }

    const count = detail.variables.length;

    if (count === 0) {
        out.paragraph("This recipe asks no questions, so nothing needs answering.");

        return;
    }

    out.paragraph(`This recipe asks ${count === 1 ? "1 question" : `${count} questions`}.`);

    for (const variable of detail.variables) {
        out.blank();
        out.log(`  ${out.style.label(variable.name)}${variable.prompt ? `: ${variable.prompt}` : ""}`);

        const facts: Fact[] = [
            ...factIf("about", variable.description ? firstSentence(variable.description) : undefined),
            ...(variable.default === undefined ? [] : [{ label: "default", lines: [String(variable.default)] }]),
            ...(variable.example === undefined ? [] : [{ label: "example", lines: [String(variable.example)] }]),
            { label: "stored-as", lines: [variable.env ?? variable.name] },
            { label: "required", lines: [variable.required === false ? "no, an answer is optional" : "yes"] },
            ...(variable.secret === true ? [{ label: "secret", lines: ["yes, stored in the local answers file"] }] : []),
        ];

        printFacts(out, facts);
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
    const text = typeof view.input.text === "string" ? view.input.text : "";
    const installed = installedFlag(view);

    out.section("Recipes matching your search");

    if (result.length === 0) {
        out.paragraph(installed ? `Nothing this project has installed matches '${text}'.` : `Nothing in the repositories this project trusts matches '${text}'.`);
    } else {
        printTable(
            out,
            SEARCH_COLUMNS,
            result.map((match) => ({
                key: match.key,
                kind: match.kind,
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
