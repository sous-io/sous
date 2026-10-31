/**
 * The outputs of the browsing intents: `namespace.list`, `namespace.show`, `recipe.list`,
 * `recipe.show`, `repo.search`, `repo.list` and `subscription.list`.
 *
 * The handlers already report the repositories they could not read (never fetched, or not
 * reachable upstream), so these outputs leave those notes out.
 */

import { commandVariables, IntentOutput, type Context, type TableColumn, type VariableEntry } from "@sous-io/plugin-api";
import type {
    BrowsingFlags,
    CatalogShowInput,
    NamespaceCoverage,
    NamespaceDetail,
    NamespaceListing,
    RecipeDetail,
    RecipeListing,
    RepoListing,
    RepoListInput,
    RepoSearchInput,
    SearchMatch,
    SubscriptionListing,
    VersionStatus,
} from "../../types.js";
import { BUILT_IN_ADDED_BY, USER_ADDED_BY } from "../defaults.js";
import { blockOutput, finish, noteOutput, questionPlanOutputs, sentence, tableOutput, underHeading } from "../outputs.js";

// --- Columns ----------------------------------------------------------------------------------------

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

/** Narrowed to installed recipes, a search shows the installed version beside each. */
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

const SUBSCRIPTION_COLUMNS: TableColumn[] = [
    { key: "key", header: "Subscription", kind: "path", overflow: "truncate", minWidth: 12 },
    { key: "range", header: "Range", overflow: "truncate", minWidth: 7 },
    { key: "pinned", header: "Pinned version", flex: 1, minWidth: 14 },
    { key: "latest", header: "Latest version", overflow: "wrap", priority: "medium", minWidth: 14 },
    { key: "origin", header: "Origin", priority: "medium" },
    { key: "enabled", header: "Enabled", priority: "medium" },
];

/** What a listing says about the linked recipes it marked. */
export const LINKED_NOTE = "A recipe marked linked is pinned at the version shown, but builds currently read it from the linked checkout of its repository.";

// --- Words ------------------------------------------------------------------------------------------

/** The recipe columns; narrowed to installed recipes, the pinned column is headed "Installed". */
export function recipeColumns(installed: boolean): TableColumn[] {
    return installed ? RECIPE_COLUMNS.map((column) => (column.key === "pinned" ? { ...column, header: "Installed" } : column)) : RECIPE_COLUMNS;
}

/** The pinned version as a cell, marked `linked` when builds read a linked checkout. */
export function pinnedCell(pinned: string | undefined, linkedPath: string | undefined): string {
    if (pinned === undefined) {
        return "";
    }

    return linkedPath === undefined ? pinned : `${pinned} linked`;
}

/** Recipe listings as table rows. */
export function recipeRows(listings: readonly RecipeListing[]): Array<Record<string, string>> {
    return listings.map((entry) => ({
        key: entry.key,
        repo: entry.repo,
        latest: entry.latest ?? "none published",
        pinned: pinnedCell(entry.pinned, entry.linkedPath),
        subscribed: entry.subscribed ? "yes" : "no",
        description: entry.description ?? "no description published",
    }));
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

    return addedBy === undefined || addedBy === USER_ADDED_BY ? "user" : `required by ${addedBy}`;
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

/** A labeled fact, or nothing when the value is missing or empty. */
function factIf(label: string, value: string | undefined): VariableEntry[] {
    return value === undefined || value.length === 0 ? [] : [{ label, value }];
}

/**
 * The "Command Variables" output a browsing command opens with: the project, its config, what was
 * asked about, where the indexes were read from and any narrowing.
 *
 * ```text
 * Command Variables:
 *     Project: my-app
 *     Config : /work/my-app/.sous/sous.config.js
 *     Recipe : alpha
 *     Reading: the cached indexes
 * ```
 */
export function browsingVariables(ctx: Pick<Context, "project" | "config">, input: BrowsingFlags, asked: Record<string, string | undefined> = {}): IntentOutput {
    const extra: Record<string, unknown> = {};

    for (const [label, value] of Object.entries(asked)) {
        if (value !== undefined) {
            extra[label] = value;
        }
    }

    extra.Reading = input.latest === true ? "each repository, upstream" : "the cached indexes";

    if (input.installed === true) {
        extra.Showing = "only what this project has installed";
    }

    return commandVariables(ctx, extra);
}

// --- namespace.list ---------------------------------------------------------------------------------

/** The outputs of `namespace.list`. */
export function namespaceListOutputs(ctx: Context, input: BrowsingFlags, result: readonly NamespaceListing[]) {
    const installed = input.installed === true;
    const columns = installed ? NAMESPACE_COLUMNS.map((column) => (column.key === "recipes" ? { ...column, header: "Installed" } : column)) : NAMESPACE_COLUMNS;

    return finish(
        [
            browsingVariables(ctx, input),
            tableOutput(
                columns,
                result.map((entry) => ({
                    namespace: entry.namespace,
                    repo: entry.repo,
                    recipes: String(entry.recipeCount),
                    subscribed: describeCoverage(entry.subscribed),
                    description: entry.description ?? "no description published",
                })),
                {
                    heading: installed ? "Namespaces this project has installed recipes from" : "Namespaces in the repositories this project trusts",
                    empty: installed ? "This project has installed no recipe from the repositories it trusts." : "The repositories this project trusts publish no namespaces.",
                },
            ),
        ],
        { namespaces: [...result] },
    );
}

// --- namespace.show ---------------------------------------------------------------------------------

/** The outputs of `namespace.show`. */
export function namespaceShowOutputs(ctx: Context, input: CatalogShowInput, detail: NamespaceDetail) {
    const installed = input.installed === true;
    const outputs = [
        browsingVariables(ctx, input, { Namespace: input.ref }),
        blockOutput(
            [
                { label: "Repository", value: detail.repo },
                ...factIf("Location", detail.repoUrl),
                ...factIf("About", detail.description),
                { label: installed ? "Installed recipes" : "Recipes", value: String(detail.recipes.length) },
                { label: "Subscribed", value: describeCoverage(detail.subscribed) },
            ],
            { heading: `The namespace ${detail.namespace}` },
        ),
        tableOutput(recipeColumns(installed), recipeRows(detail.recipes), {
            tableTitle: `Recipes in ${detail.namespace}`,
            empty: `The repository ${detail.repo} publishes no recipes in this namespace.`,
        }),
    ];

    if (detail.recipes.some((entry) => entry.linkedPath !== undefined)) {
        outputs.push(noteOutput(LINKED_NOTE));
    }

    return finish(outputs, detail);
}

// --- recipe.list ------------------------------------------------------------------------------------

/** The outputs of `recipe.list`. */
export function recipeListOutputs(ctx: Context, input: BrowsingFlags, result: readonly RecipeListing[]) {
    const installed = input.installed === true;
    const outputs = [
        browsingVariables(ctx, input),
        tableOutput(recipeColumns(installed), recipeRows(result), {
            heading: installed ? "Recipes this project has installed" : "Recipes in the repositories this project trusts",
            empty: installed ? "This project has installed no recipe from the repositories it trusts." : "The repositories this project trusts publish no recipes.",
        }),
    ];

    if (result.some((entry) => entry.linkedPath !== undefined)) {
        outputs.push(noteOutput(LINKED_NOTE));
    }

    return finish(outputs, { recipes: [...result] });
}

// --- recipe.show ------------------------------------------------------------------------------------

/** Every recipe a subscription to the described version installs, and what brings each in. */
function installsOutputs(detail: RecipeDetail): IntentOutput[] {
    const outputs = [
        tableOutput(
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
            { tableTitle: "What subscribing installs" },
        ),
    ];
    const missing = detail.installsNeed ?? [];

    if (missing.length > 0) {
        outputs.push(
            sentence(
                `Subscribing also needs ${missing.length === 1 ? "a repository" : "repositories"} this project does not trust yet, so what ${missing.length === 1 ? "it publishes" : "they publish"} is not listed above: ` +
                    missing
                        .map((entry) => `${entry.name}${entry.url === undefined ? "" : ` (${entry.url})`}, needed by ${entry.requiredBy.map((holder) => holder.requestedBy).join(", ")}`)
                        .join("; ") +
                    ".",
            ),
        );
    }

    return outputs;
}

/** The outputs of `recipe.show`. */
export function recipeShowOutputs(ctx: Context, input: CatalogShowInput, detail: RecipeDetail) {
    const installed = input.installed === true;
    const outputs: IntentOutput[] = [
        browsingVariables(ctx, input, { Recipe: input.ref }),
        blockOutput(
            [
                { label: "Repository", value: detail.repo },
                ...factIf("Location", detail.repoUrl),
                ...factIf("About", detail.description),
                { label: "Folder", value: detail.path },
                { label: "Latest version", value: detail.latest ?? "none published" },
                { label: installed ? "Installed version" : "Pinned version", value: detail.pinned ?? "this project pins none" },
                ...factIf("Linked", detail.linkedPath === undefined ? undefined : `builds currently read this recipe from the checkout at ${detail.linkedPath}`),
                { label: "Subscribed", value: detail.subscribed ? "yes" : "no" },
                ...factIf("Described below", detail.describing),
            ],
            { heading: detail.key },
        ),
        tableOutput(
            VERSION_COLUMNS,
            detail.versions.map((entry) => ({
                version: entry.version,
                status: describeVersionStatus(entry.status),
                prerelease: entry.prerelease ? "yes" : "no",
                released: entry.releasedAt ?? "not recorded",
            })),
            { tableTitle: "Published versions" },
        ),
        tableOutput(
            DEPENDENCY_COLUMNS,
            detail.dependencies.map((entry) => ({
                key: entry.key,
                declared: entry.declared === undefined ? "not recorded in the index" : describeDeclaration(entry.declared),
                resolved: entry.resolvedVersion ?? (entry.resolvedRange === undefined ? "not recorded in the index" : `the range ${entry.resolvedRange}`),
                repo: entry.repo ?? "this repository",
                kind: describeDependencyKind(entry.kind),
            })),
            {
                tableTitle: "What it depends on",
                empty: detail.manifestRead || detail.dependenciesRecorded ? "This recipe depends on nothing else." : "The repository's index records no dependencies for this version.",
            },
        ),
    ];

    if (detail.describing === undefined) {
        outputs.push(sentence("This recipe publishes no version a subscription would install, so nothing is described below."));
    } else if (detail.installsProblem !== undefined || detail.installs === undefined || detail.questions === undefined) {
        outputs.push(sentence(detail.installsProblem ?? "Sous could not work out what subscribing would install."));
    } else {
        outputs.push(...installsOutputs(detail), ...underHeading("What subscribing asks you", questionPlanOutputs(detail.questions, { answerHints: false })));
    }

    outputs.push(
        tableOutput(
            CONTENT_COLUMNS,
            detail.manifestRead
                ? detail.contents.map((entry) => ({
                      kind: entry.kind,
                      include: entry.include.join(", "),
                      destination: entry.destinations.length > 0 ? entry.destinations.join(", ") : noDestinationText(entry.kind),
                  }))
                : [],
            {
                tableTitle: "Where its files land in this project",
                empty: detail.manifestRead
                    ? "This recipe publishes no files."
                    : "The recipe's own files are not on this machine, so the files it publishes are not known here. Subscribing to it fetches them.",
            },
        ),
    );

    return finish(outputs, detail);
}

// --- repo.search ------------------------------------------------------------------------------------

/** The outputs of `repo.search`. */
export function repoSearchOutputs(ctx: Context, input: RepoSearchInput, result: readonly SearchMatch[]) {
    const installed = input.installed === true;
    const outputs = [
        browsingVariables(ctx, input, { Searching: input.text }),
        tableOutput(
            installed ? INSTALLED_SEARCH_COLUMNS : SEARCH_COLUMNS,
            result.map((match) => ({
                key: match.key,
                kind: match.kind,
                versions: match.versions?.join(", ") ?? "",
                installed: match.installed ?? "",
                repo: match.repo,
                description: match.description !== undefined && match.description.length > 0 ? match.description : "no description published",
            })),
            {
                heading: "Recipes matching your search",
                empty: installed ? `Nothing this project has installed matches '${input.text}'.` : `Nothing in the repositories this project trusts matches '${input.text}'.`,
            },
        ),
    ];
    const limit = input.limit ?? 20;

    if (result.length > 0 && result.length >= limit) {
        outputs.push(sentence(`Only the first ${limit} matches are shown. Raise the number with '--limit'.`));
    }

    return finish(outputs, { matches: [...result] });
}

// --- repo.list --------------------------------------------------------------------------------------

/** What `repo list` notes under a repository's row: switched off, its namespaces, its installed pins. */
function repoNote(entry: RepoListing, verbose: boolean): string | undefined {
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

/** The outputs of `repo.list`. */
export function repoListOutputs(ctx: Context, input: RepoListInput, result: readonly RepoListing[]) {
    const verbose = input.verbose === true;
    const outputs = [
        browsingVariables(ctx, input),
        tableOutput(
            REPO_COLUMNS,
            result.map((entry) => ({
                name: entry.name,
                url: entry.url,
                provider: entry.provider,
                origin: describeOrigin(entry.addedBy),
                linked: entry.linkedPath === undefined ? "no" : `yes: ${entry.linkedPath}`,
                recipes: entry.recipeCount === undefined ? "not fetched" : String(entry.recipeCount),
            })),
            {
                heading: input.installed === true ? "Repositories this project has installed recipes from" : "Repositories this project trusts",
                empty: "This project trusts no repositories yet. Add one with 'sous repo add <url>'; adding a repository is how you trust it.",
                rowNotes: result.map((entry) => repoNote(entry, verbose)),
            },
        ),
    ];

    for (const entry of result) {
        if (entry.problem !== undefined) {
            ctx.reporter.warn(`${entry.name} could not be checked upstream, so it is shown from the cache: ${entry.problem}`);
        }
    }

    return finish(outputs, { repos: [...result] });
}

// --- subscription.list ------------------------------------------------------------------------------

/** The "Pinned version" cell: every locked recipe with its version, or why there is none. */
export function describePinned(pinned: ReadonlyArray<{ key: string; version: string }>, enabled: boolean): string {
    if (pinned.length > 0) {
        return pinned.map((entry) => `${entry.key} ${entry.version}`).join(", ");
    }

    return enabled ? "pinned on first build" : "not pinned";
}

/** The "Latest version" cell: the newer in-range version of each pinned recipe, or that it is current. */
export function describeLatest(listing: SubscriptionListing): string {
    if (listing.pinned.length === 0) {
        return "";
    }

    // The newest published version, as the handler read it; before it said, the newer one in range.
    const published = new Map((listing.latest ?? []).map((entry) => [entry.key, entry.version]));
    const newer = new Map((listing.newer ?? []).map((entry) => [entry.key, entry.version]));
    const latestOf = (key: string, pinned: string) => (listing.latest === undefined ? (newer.get(key) ?? pinned) : (published.get(key) ?? "not in any index sous has read"));

    if (listing.pinned.length === 1) {
        const only = listing.pinned[0]!;

        return latestOf(only.key, only.version);
    }

    return listing.pinned.map((pin) => `${pin.key} ${latestOf(pin.key, pin.version)}`).join(", ");
}

function describeSubscriptionOrigin(addedBy: string | undefined): string {
    if (addedBy === BUILT_IN_ADDED_BY) {
        return "built in";
    }

    return addedBy === undefined || addedBy === USER_ADDED_BY ? "user" : addedBy;
}

/** The outputs of `subscription.list`; with `--installed`, a subscription that installed nothing is left out. */
export function subscriptionListOutputs(ctx: Context, input: BrowsingFlags, result: readonly SubscriptionListing[]) {
    const installed = input.installed === true;
    const listings = result.filter((entry) => !installed || entry.pinned.length > 0);
    const columns = SUBSCRIPTION_COLUMNS.map((column) => (installed && column.key === "pinned" ? { ...column, header: "Installed version" } : column));

    return finish(
        [
            browsingVariables(ctx, input),
            tableOutput(
                columns,
                listings.map((entry) => ({
                    key: entry.key,
                    range: entry.range ?? "any version",
                    pinned: describePinned(entry.pinned, entry.enabled),
                    latest: describeLatest(entry),
                    origin: describeSubscriptionOrigin(entry.addedBy),
                    enabled: entry.enabled ? "yes" : "no",
                })),
                {
                    heading: "Subscriptions",
                    empty: installed ? "No subscription of this project has installed anything yet." : "This project subscribes to nothing yet.",
                },
            ),
        ],
        { subscriptions: listings },
    );
}
