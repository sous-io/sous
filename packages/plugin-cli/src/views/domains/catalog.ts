/**
 * The browsing views: `namespace list`, `namespace show`, `recipe list`, `recipe show`,
 * `repo search` and `repo list`. Ported from today's `src/lib/repos/catalog-display.ts` and the
 * printing in `src/commands/{namespace,recipe,repo}/*.ts`.
 *
 * The handlers already report the repositories they could not read (never fetched, or not reachable
 * upstream), so these views leave those notes out.
 */

import type { Reporter, TableColumn, VariableEntry } from "@sous-io/plugin-api";
import type { CliViewContext, CliViewEntity } from "../../types.js";
import { projectVariables } from "../command-variables.js";
import { writeQuestionPlan, type QuestionPlanShape } from "./questions.js";

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
export function recipeRows(listings: readonly RecipeListingShape[]): Array<Record<string, string>> {
    return listings.map((entry) => ({
        key: entry.key,
        repo: entry.repo,
        latest: entry.latest ?? "none published",
        pinned: pinnedCell(entry.pinned, entry.linkedPath),
        subscribed: entry.subscribed ? "yes" : "no",
        description: entry.description ?? "no description published",
    }));
}

/** The pinned version as a cell, marked `linked` when builds read a linked checkout. */
export function pinnedCell(pinned: string | undefined, linkedPath: string | undefined): string {
    if (pinned === undefined) {
        return "";
    }

    return linkedPath === undefined ? pinned : `${pinned} linked`;
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

/** A labeled fact, or nothing when the value is missing or empty. */
function factIf(label: string, value: string | undefined): VariableEntry[] {
    return value === undefined || value.length === 0 ? [] : [{ label, value }];
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
export function browsingVariables(reporter: Reporter, view: Pick<CliViewContext, "input" | "project" | "projectName">, asked: Record<string, string | undefined> = {}): void {
    const entries: Record<string, unknown> = { ...projectVariables(view) };

    for (const [label, value] of Object.entries(asked)) {
        if (value !== undefined) {
            entries[label] = value;
        }
    }

    entries.Reading = view.input.latest === true ? "each repository, upstream" : "the cached indexes";

    if (view.input.installed === true) {
        entries.Showing = "only what this project has installed";
    }

    reporter.commandVariables(entries);
}

/** The text of a string input, or nothing. */
function inputText(view: Pick<CliViewContext, "input">, key: string): string | undefined {
    const value = view.input[key];

    return typeof value === "string" ? value : undefined;
}

// --- The views -------------------------------------------------------------------------------------

/** `sous namespace list`. */
function namespaceList(result: readonly NamespaceListingShape[], view: CliViewContext): void {
    const reporter = view.reporter;
    const installed = installedFlag(view);

    browsingVariables(reporter, view);
    reporter.operationStart(installed ? "Namespaces this project has installed recipes from" : "Namespaces in the repositories this project trusts");

    const columns = installed ? NAMESPACE_COLUMNS.map((column) => (column.key === "recipes" ? { ...column, header: "Installed" } : column)) : NAMESPACE_COLUMNS;

    reporter.table(
        columns,
        result.map((entry) => ({
            namespace: entry.namespace,
            repo: entry.repo,
            recipes: String(entry.recipeCount),
            subscribed: describeCoverage(entry.subscribed),
            description: entry.description ?? "no description published",
        })),
        { empty: installed ? "This project has installed no recipe from the repositories it trusts." : "The repositories this project trusts publish no namespaces." },
    );
}

/** `sous namespace show <ref>`. */
function namespaceShow(detail: NamespaceDetailShape, view: CliViewContext): void {
    const reporter = view.reporter;
    const installed = installedFlag(view);

    browsingVariables(reporter, view, { Namespace: inputText(view, "ref") });
    reporter.operationStart(`The namespace ${detail.namespace}`);
    reporter.variables([
        { label: "Repository", value: detail.repo },
        ...factIf("Location", detail.repoUrl),
        ...factIf("About", detail.description),
        { label: installed ? "Installed recipes" : "Recipes", value: String(detail.recipes.length) },
        { label: "Subscribed", value: describeCoverage(detail.subscribed) },
    ]);
    reporter.table(recipeColumns(installed), recipeRows(detail.recipes), {
        title: `Recipes in ${detail.namespace}`,
        empty: `The repository ${detail.repo} publishes no recipes in this namespace.`,
    });

    if (detail.recipes.some((entry) => entry.linkedPath !== undefined)) {
        reporter.note(LINKED_NOTE);
    }
}

/** `sous recipe list`. */
function recipeList(result: readonly RecipeListingShape[], view: CliViewContext): void {
    const reporter = view.reporter;
    const installed = installedFlag(view);

    browsingVariables(reporter, view);
    reporter.operationStart(installed ? "Recipes this project has installed" : "Recipes in the repositories this project trusts");
    reporter.table(recipeColumns(installed), recipeRows(result), {
        empty: installed ? "This project has installed no recipe from the repositories it trusts." : "The repositories this project trusts publish no recipes.",
    });

    if (result.some((entry) => entry.linkedPath !== undefined)) {
        reporter.note(LINKED_NOTE);
    }
}

/** `sous recipe show <ref>`. */
function recipeShow(detail: RecipeDetailShape, view: CliViewContext): void {
    const reporter = view.reporter;
    const installed = installedFlag(view);

    browsingVariables(reporter, view, { Recipe: inputText(view, "ref") });
    reporter.operationStart(detail.key);
    reporter.variables([
        { label: "Repository", value: detail.repo },
        ...factIf("Location", detail.repoUrl),
        ...factIf("About", detail.description),
        { label: "Folder", value: detail.path },
        { label: "Latest version", value: detail.latest ?? "none published" },
        { label: installed ? "Installed version" : "Pinned version", value: detail.pinned ?? "this project pins none" },
        ...factIf("Linked", detail.linkedPath === undefined ? undefined : `builds currently read this recipe from the checkout at ${detail.linkedPath}`),
        { label: "Subscribed", value: detail.subscribed ? "yes" : "no" },
        ...factIf("Described below", detail.describing),
    ]);

    reporter.table(
        VERSION_COLUMNS,
        detail.versions.map((entry) => ({
            version: entry.version,
            status: describeVersionStatus(entry.status),
            prerelease: entry.prerelease ? "yes" : "no",
            released: entry.releasedAt ?? "not recorded",
        })),
        { title: "Published versions" },
    );

    reporter.table(
        DEPENDENCY_COLUMNS,
        detail.dependencies.map((entry) => ({
            key: entry.key,
            declared: entry.declared === undefined ? "not recorded in the index" : describeDeclaration(entry.declared),
            resolved: entry.resolvedVersion ?? (entry.resolvedRange === undefined ? "not recorded in the index" : `the range ${entry.resolvedRange}`),
            repo: entry.repo ?? "this repository",
            kind: describeDependencyKind(entry.kind),
        })),
        {
            title: "What it depends on",
            empty: detail.manifestRead || detail.dependenciesRecorded ? "This recipe depends on nothing else." : "The repository's index records no dependencies for this version.",
        },
    );

    if (detail.describing === undefined) {
        reporter.info("This recipe publishes no version a subscription would install, so nothing is described below.");
    } else if (detail.installsProblem !== undefined || detail.installs === undefined || detail.questions === undefined) {
        reporter.info(detail.installsProblem ?? "Sous could not work out what subscribing would install.");
    } else {
        reportInstalls(reporter, detail);
        reporter.stepStart("What subscribing asks you");
        writeQuestionPlan(reporter, detail.questions, { answerHints: false });
    }

    reporter.table(
        CONTENT_COLUMNS,
        detail.manifestRead
            ? detail.contents.map((entry) => ({
                  kind: entry.kind,
                  include: entry.include.join(", "),
                  destination: entry.destinations.length > 0 ? entry.destinations.join(", ") : noDestinationText(entry.kind),
              }))
            : [],
        {
            title: "Where its files land in this project",
            empty: detail.manifestRead
                ? "This recipe publishes no files."
                : "The recipe's own files are not on this machine, so the files it publishes are not known here. Subscribing to it fetches them.",
        },
    );
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
function reportInstalls(reporter: Reporter, detail: RecipeDetailShape): void {
    reporter.table(
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
        { title: "What subscribing installs" },
    );

    const missing = detail.installsNeed ?? [];

    if (missing.length > 0) {
        reporter.info(
            `Subscribing also needs ${missing.length === 1 ? "a repository" : "repositories"} this project does not trust yet, so what ${missing.length === 1 ? "it publishes" : "they publish"} is not listed above: ` +
                missing
                    .map((entry) => `${entry.name}${entry.url === undefined ? "" : ` (${entry.url})`}, needed by ${entry.requiredBy.map((holder) => holder.requestedBy).join(", ")}`)
                    .join("; ") +
                ".",
        );
    }
}

/** `sous repo search <text>`. */
function repoSearch(result: readonly SearchMatchShape[], view: CliViewContext): void {
    const reporter = view.reporter;
    const text = typeof view.input.text === "string" ? view.input.text : "";
    const installed = installedFlag(view);

    browsingVariables(reporter, view, { Searching: inputText(view, "text") });
    reporter.operationStart("Recipes matching your search");
    reporter.table(
        installed ? INSTALLED_SEARCH_COLUMNS : SEARCH_COLUMNS,
        result.map((match) => ({
            key: match.key,
            kind: match.kind,
            versions: match.versions?.join(", ") ?? "",
            installed: match.installed ?? "",
            repo: match.repo,
            description: match.description !== undefined && match.description.length > 0 ? match.description : "no description published",
        })),
        { empty: installed ? `Nothing this project has installed matches '${text}'.` : `Nothing in the repositories this project trusts matches '${text}'.` },
    );

    const limit = typeof view.input.limit === "number" ? view.input.limit : 20;

    if (result.length > 0 && result.length >= limit) {
        reporter.info(`Only the first ${limit} matches are shown. Raise the number with '--limit'.`);
    }
}

/** What `repo list` notes under a repository's row: switched off, its namespaces, its installed pins. */
function repoNote(entry: RepoListingShape, verbose: boolean): string | undefined {
    const notes: string[] = [];

    if (!entry.enabled) {
        notes.push("Switched off in the config, so nothing is read from it.");
    }

    if (verbose) {
        const namespaces = entry.namespaces === undefined ? "not fetched" : entry.namespaces.length > 0 ? entry.namespaces.join(", ") : "none";

        notes.push(`Namespaces: ${namespaces}`);
    }

    if (entry.installed !== undefined && entry.installed.length > 0) {
        notes.push(`Installed: ${entry.installed.map((pin) => `${pin.key} ${pin.version}`).join(", ")}`);
    }

    return notes.length > 0 ? notes.join(" ") : undefined;
}

/** `sous repo list`. */
function repoList(result: readonly RepoListingShape[], view: CliViewContext): void {
    const reporter = view.reporter;
    const verbose = view.input.verbose === true;

    browsingVariables(reporter, view);
    reporter.operationStart(installedFlag(view) ? "Repositories this project has installed recipes from" : "Repositories this project trusts");

    if (result.length === 0) {
        reporter.info("This project trusts no repositories yet. Add one with 'sous repo add <url>'; adding a repository is how you trust it.");

        return;
    }

    reporter.table(
        REPO_COLUMNS,
        result.map((entry) => ({
            name: entry.name,
            url: entry.url,
            provider: entry.provider,
            origin: describeOrigin(entry.addedBy),
            linked: entry.linkedPath === undefined ? "no" : `yes: ${entry.linkedPath}`,
            recipes: entry.recipeCount === undefined ? "not fetched" : String(entry.recipeCount),
        })),
        { rowNotes: result.map((entry) => repoNote(entry, verbose)) },
    );

    for (const entry of result) {
        if (entry.problem !== undefined) {
            reporter.warn(`${entry.name} could not be checked upstream, so it is shown from the cache: ${entry.problem}`);
        }
    }
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
