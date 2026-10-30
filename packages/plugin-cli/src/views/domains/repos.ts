/**
 * Views of the repository and subscription intents of plugin-recipes, ported from the printing in
 * today's `src/commands/repo/{add,remove,gc,link,unlink}.ts` and
 * `src/commands/subscription/{add,remove,list}.ts`.
 *
 * The handlers already report their plans and notes as they work (the trust ceremony, "The recipe
 * 'x' stays, because ...", "Linked 'x' to ..."), so these views show only the outcome: the blocks a
 * command printed after its work was done.
 */

import { browsingVariables, writeQuestionPlan, type QuestionPlanShape } from "./catalog.js";
import type { CliViewContext, CliViewEntity, CliViewOutput } from "../../types.js";
import type { Printer } from "../printer.js";
import type { TableColumn } from "../table.js";
import { indent } from "../text.js";

// --- The result shapes these views read (plugin-recipes' types, kept local: plugin-cli depends on no plugin) ---

interface LockChange {
    readonly key: string;
    readonly from?: string;
    readonly to?: string;
}

interface LockDiff {
    readonly added: readonly LockChange[];
    readonly removed: readonly LockChange[];
    readonly updated: readonly LockChange[];
    readonly reposAdded: readonly string[];
    readonly reposRemoved: readonly string[];
    readonly unchanged: boolean;
}

interface IntentFollowUp {
    readonly intent: string;
    readonly result?: unknown;
    readonly skipped?: string;
}

interface Stayed {
    readonly key: string;
    readonly heldBy: readonly string[];
}

interface RepoAddResult {
    readonly name: string;
    readonly url: string;
    readonly provider: string;
    readonly alreadyTrusted: boolean;
    readonly namespaces: readonly string[];
    readonly recipeCount: number;
    readonly dryRun: boolean;
}

interface RepoRemoveResult {
    readonly name: string;
    readonly url: string;
    readonly optedOut: boolean;
    readonly stayed: readonly Stayed[];
    readonly diff: LockDiff;
    readonly dryRun: boolean;
    readonly followUps: readonly IntentFollowUp[];
    readonly plan?: readonly string[];
}

interface RepoTrustResult {
    readonly name: string;
    readonly url: string;
    readonly trusted: boolean;
    readonly alreadyTrusted: boolean;
    readonly dryRun: boolean;
}

interface StoreEntry {
    readonly repo: string;
    readonly namespace: string;
    readonly name: string;
    readonly version: string;
    readonly lastAccessAt: string;
    readonly sizeBytes: number;
}

interface StoreGcReport {
    readonly evicted: readonly StoreEntry[];
    readonly kept: readonly StoreEntry[];
    readonly bytesBefore: number;
    readonly bytesAfter: number;
    readonly dryRun: boolean;
}

interface UpstreamComparison {
    readonly upstream: string;
    readonly merged?: boolean;
    readonly behind?: number;
    readonly detachedAt?: string;
}

interface RepoLinkResult {
    readonly repo: string;
    readonly path: string;
    readonly origin: string;
    readonly scope: "project" | "global";
    readonly cloned: boolean;
    readonly branch?: string;
    readonly trusted: readonly string[];
    readonly dryRun: boolean;
    readonly notes?: readonly string[];
    readonly recordedIn?: string;
    readonly replaced?: string;
    readonly upstream?: UpstreamComparison;
    readonly upstreamNote?: string;
    readonly wouldDo?: readonly string[];
}

interface RepoUnlinkResult {
    readonly repo: string;
    readonly path: string;
    readonly scope: "project" | "global";
    readonly removedCheckout: boolean;
    readonly diff?: LockDiff;
    readonly dryRun: boolean;
    readonly followUps: readonly IntentFollowUp[];
    readonly recordedIn?: string;
    readonly published?: {
        readonly checked: boolean;
        readonly reason?: string;
        readonly newer: ReadonlyArray<{ readonly key: string; readonly from: string; readonly to: string }>;
    };
    readonly checkoutNote?: string;
    readonly wouldDo?: readonly string[];
}

interface ResolvedRecipe {
    readonly key: string;
    readonly repo: string;
    readonly version: string;
    readonly kind: string;
    readonly requestedBy: readonly string[];
}

interface SubscriptionAddResult {
    readonly key: string;
    readonly resolved: readonly ResolvedRecipe[];
    readonly trusted: readonly string[];
    readonly diff: LockDiff;
    readonly cycles: ReadonlyArray<readonly string[]>;
    readonly dryRun: boolean;
    readonly followUps: readonly IntentFollowUp[];
    readonly questions?: QuestionPlanShape;
}

interface SubscriptionRemoveResult {
    readonly key: string;
    readonly diff: LockDiff;
    readonly optedOut: boolean;
    readonly dryRun: boolean;
    readonly followUps: readonly IntentFollowUp[];
}

interface SubscriptionToggleResult {
    readonly key: string;
    readonly enabled: boolean;
    readonly file: string;
    readonly changed: boolean;
    readonly dryRun: boolean;
    readonly followUps: readonly IntentFollowUp[];
}

interface SubscriptionListing {
    readonly key: string;
    readonly range: string | undefined;
    readonly enabled: boolean;
    readonly addedBy: string | undefined;
    readonly pinned: ReadonlyArray<{ readonly key: string; readonly version: string }>;
    readonly newer?: ReadonlyArray<{ readonly key: string; readonly version: string }>;
    readonly latest?: ReadonlyArray<{ readonly key: string; readonly version?: string }>;
}

// --- Shared pieces ---------------------------------------------------------------------------------

/** How far every line of these commands' output is indented. */
const INDENT = 2;

/** Who added an entry, as `addedBy` records it. */
const BUILT_IN_ADDED_BY = "sous";
const USER_ADDED_BY = "user";

const STAYED_COLUMNS: TableColumn[] = [
    { key: "key", header: "Recipe", kind: "path", overflow: "truncate", minWidth: 12 },
    { key: "heldBy", header: "Still held by", overflow: "wrap", flex: 1, minWidth: 16 },
];

const INSTALLED_COLUMNS: TableColumn[] = [
    { key: "key", header: "Recipe", kind: "path", overflow: "truncate", minWidth: 12 },
    { key: "version", header: "Version", overflow: "truncate" },
    { key: "repo", header: "Repository", overflow: "truncate", priority: "medium" },
    { key: "why", header: "Why", overflow: "wrap", flex: 1, minWidth: 16 },
];

const EVICTED_COLUMNS: TableColumn[] = [
    { key: "recipe", header: "Recipe", kind: "path", overflow: "truncate", minWidth: 12 },
    { key: "version", header: "Version", overflow: "truncate" },
    { key: "size", header: "Size", kind: "number" },
    { key: "repo", header: "Repository", overflow: "truncate", priority: "medium" },
    { key: "lastUsed", header: "Last used", priority: "low", flex: 1 },
];

const SUBSCRIPTION_COLUMNS: TableColumn[] = [
    { key: "key", header: "Subscription", kind: "path", overflow: "truncate", minWidth: 12 },
    { key: "range", header: "Range", overflow: "truncate", minWidth: 7 },
    { key: "pinned", header: "Pinned version", flex: 1, minWidth: 14 },
    { key: "latest", header: "Latest version", overflow: "wrap", priority: "medium", minWidth: 14 },
    { key: "origin", header: "Origin", priority: "medium" },
    { key: "enabled", header: "Enabled", priority: "medium" },
];

/**
 * A lockfile diff as plain-language lines, one per change, as today's lock service wrote them.
 *
 * ```ts
 * lockDiffLines({ added: [{ key: "core/a", to: "1.0.0" }], ... }); // ["Adding core/a version 1.0.0"]
 * ```
 */
export function lockDiffLines(diff: LockDiff): string[] {
    const byKey = (left: LockChange, right: LockChange) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
    const lines: string[] = [];

    for (const name of diff.reposAdded) {
        lines.push(`Repository added: ${name}`);
    }

    for (const change of [...diff.added].sort(byKey)) {
        lines.push(`Adding ${change.key} version ${change.to}`);
    }

    for (const change of [...diff.updated].sort(byKey)) {
        lines.push(`Updating ${change.key} from version ${change.from} to version ${change.to}`);
    }

    for (const change of [...diff.removed].sort(byKey)) {
        lines.push(`Removing ${change.key}, which nothing needs any more`);
    }

    for (const name of diff.reposRemoved) {
        lines.push(`Repository no longer needed: ${name}`);
    }

    return lines.length === 0 ? ["Nothing changed."] : lines;
}

/** The `➔ Lockfile:` block: the diff's lines, or `whenUnchanged`. */
function lockfileBlock(out: Printer, diff: LockDiff, whenUnchanged: string, asParagraph = true): void {
    out.blank().subheading("Lockfile").blank();

    if (diff.unchanged) {
        if (asParagraph) {
            out.paragraph(whenUnchanged);
        } else {
            out.log(indent(whenUnchanged));
        }

        return;
    }

    for (const line of lockDiffLines(diff)) {
        out.log(indent(line));
    }
}

function stayedBlock(out: Printer, stayed: readonly Stayed[]): void {
    if (stayed.length === 0) {
        return;
    }

    out.blank().subheading("What stayed, and why").blank();
    out.table(
        STAYED_COLUMNS,
        stayed.map((entry) => ({ key: entry.key, heldBy: entry.heldBy.join(", ") })),
        { indent: INDENT },
    );
}

/** A byte count the way a person reads one. */
export function describeSize(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} bytes`;
    }

    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes / 1024;
    let unit = 0;

    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }

    return `${value.toFixed(1)} ${units[unit]}`;
}

function followUp(result: { readonly followUps?: readonly IntentFollowUp[] }, intent: string): IntentFollowUp | undefined {
    return result.followUps?.find((entry) => entry.intent === intent);
}

/** Whether a follow-up build ran (it did not when skipped by `--no-build` or `--dry-run`). */
function rebuilt(result: { readonly followUps?: readonly IntentFollowUp[] }): boolean {
    const build = followUp(result, "build");

    return build !== undefined && build.skipped === undefined;
}

/**
 * The follow-ups' own views, in order (`vars.ask` under "Variables", then the build), and the exit
 * code: a build that failed makes the command fail, with the message today's command gave.
 */
async function withFollowUps(
    out: Printer,
    result: { readonly followUps?: readonly IntentFollowUp[] },
    view: CliViewContext,
    buildFailed: string,
): Promise<CliViewOutput> {
    let failed = false;

    for (const entry of result.followUps ?? []) {
        if (entry.skipped !== undefined || entry.result === undefined) {
            continue;
        }

        if (entry.intent === "vars.ask") {
            out.blank().subheading("Variables");
        }

        const text = await view.render(entry.intent, entry.result);

        if (text !== "") {
            out.log(text.replace(/\n$/, ""));
        }

        if (entry.intent === "build" && (entry.result as { ok?: unknown }).ok === false) {
            failed = true;
        }
    }

    if (!failed) {
        return out.text();
    }

    return { stdout: out.text(), stderr: `Error: ${buildFailed}\n`, exitCode: 1 };
}

// --- repo.add -----------------------------------------------------------------------------------------

function repoAdd(result: RepoAddResult, view: CliViewContext): string {
    const out = view.printer();

    out.heading("Adding a repository");

    if (result.dryRun) {
        out.dryRunNotice("Nothing will be trusted, written or downloaded.");
        out.blank();
    }

    out.blank();

    if (result.dryRun) {
        out.note(`The repository would be added as '${result.name}', read through the ${result.provider} provider, and its index would be fetched.`);
        out.footer();

        return out.text();
    }

    out.variables({
        Repository: result.name,
        Location: result.url,
        Provider: result.provider,
        Namespaces: result.namespaces.length > 0 ? result.namespaces.join(", ") : "none; this repository publishes nothing yet",
        Recipes: String(result.recipeCount),
    });
    out.blank();
    out.note(
        result.alreadyTrusted
            ? `This project already trusted '${result.name}', so only its index was refreshed.`
            : `This project now trusts '${result.name}'. Nothing from it has been installed.`,
    );
    out.footer();

    return out.text();
}

// --- repo.remove --------------------------------------------------------------------------------------

async function repoRemove(result: RepoRemoveResult, view: CliViewContext): Promise<CliViewOutput> {
    const out = view.printer();
    const rebuilding = rebuilt(result);
    const pruneHint = rebuilding ? "" : " Run 'sous build' to prune what it used to write.";

    out.heading("Removing a repository");

    if (result.dryRun) {
        out.dryRunNotice("Nothing will be written.");
    }

    // The plan, unless the handler reported it already before asking.
    const [first, ...rest] = result.plan ?? [];

    if (first !== undefined) {
        out.blank();
        out.paragraph(first);

        if (rest.length > 0) {
            out.blank();
            out.log(indent("Here is what goes with it:"));
            out.blank();

            for (const line of rest) {
                out.log(indent(line, 4));
            }
        }
    }

    lockfileBlock(out, result.diff, "Nothing changed; nothing was locked because of this repository.", false);
    stayedBlock(out, result.stayed);
    out.blank();
    out.log(
        indent(
            result.dryRun
                ? "Nothing was written. Run the same command without '--dry-run' to remove it."
                : result.optedOut
                  ? `The repository '${result.name}' is one sous provides itself, so it was switched off rather than deleted: this project's config now records '${result.name}: { enabled: false }'.${pruneHint}`
                  : `This project no longer trusts '${result.name}'. Nothing is read from it any more, and its entry is gone from the repositories layer.${pruneHint}`,
        ),
    );
    out.footer();

    return withFollowUps(
        out,
        result,
        view,
        `The repository '${result.name}' was removed, but the build that followed it failed, so this project may still hold files its recipes used to write. The removal itself is recorded and locked; fix what the build reported above and run 'sous build' again.`,
    );
}

// --- repo.trust ---------------------------------------------------------------------------------------

function repoTrust(result: RepoTrustResult, view: CliViewContext): string {
    const out = view.printer();

    out.heading("Trusting a repository");

    if (result.dryRun) {
        out.dryRunNotice("Nothing will be written.");
    }

    out.blank();
    out.variables({ Repository: result.name, Location: result.url });
    out.blank();
    out.note(
        result.alreadyTrusted
            ? `This project already trusts '${result.name}'; nothing changed.`
            : result.dryRun
              ? `Nothing was written. Run the same command without '--dry-run' to trust '${result.name}'.`
              : result.trusted
                ? `This project now trusts '${result.name}'. Nothing from it has been installed.`
                : `'${result.name}' was not trusted; nothing changed.`,
    );
    out.footer();

    return out.text();
}

// --- repo.gc ------------------------------------------------------------------------------------------

function repoGc(report: StoreGcReport, view: CliViewContext): string {
    const out = view.printer();

    out.section("Collecting the recipe store");

    if (report.dryRun) {
        out.dryRunNotice("Nothing will be removed.");
        out.blank();
    }

    out.variables({
        "Entries before": String(report.evicted.length + report.kept.length),
        "Entries kept": String(report.kept.length),
        "Entries evicted": String(report.evicted.length),
        "Size before": describeSize(report.bytesBefore),
        "Size after": describeSize(report.bytesAfter),
    });

    if (report.evicted.length > 0) {
        out.blank();
        out.table(
            EVICTED_COLUMNS,
            report.evicted.map((entry) => ({
                repo: entry.repo,
                recipe: `${entry.namespace}/${entry.name}`,
                version: entry.version,
                size: describeSize(entry.sizeBytes),
                lastUsed: entry.lastAccessAt,
            })),
            { indent: INDENT },
        );
    }

    out.blank();
    out.paragraph(
        report.evicted.length === 0
            ? "The store is already inside its size cap, so nothing was removed."
            : report.dryRun
              ? "Nothing was removed. Everything listed above is re-fetchable from the lockfile that pins it."
              : "Everything removed is re-fetchable from the lockfile that pins it; the next build that needs one will download it again.",
    );
    out.footer();

    return out.text();
}

// --- repo.link ----------------------------------------------------------------------------------------

function repoLink(result: RepoLinkResult, view: CliViewContext): string {
    const out = view.printer();

    out.heading("Linking a repository");

    if (result.dryRun) {
        out.blank();

        for (const line of result.wouldDo ?? []) {
            out.dryRunNotice(line);
        }

        out.footer();

        return out.text();
    }

    out.blank();

    for (const line of result.notes ?? []) {
        out.log(indent(line));
    }

    if ((result.notes ?? []).length > 0) {
        out.blank();
    }

    out.variables({
        Repository: result.repo,
        Checkout: result.path,
        ...(result.branch === undefined ? {} : { Branch: result.branch }),
        Scope: result.scope === "global" ? "every project on this machine" : "this project",
        ...(result.recordedIn === undefined ? {} : { "Recorded in": result.recordedIn }),
    });

    if (result.replaced !== undefined) {
        out.blank();
        out.log(indent(`This replaces an earlier link to ${result.replaced}, which is untouched.`));
    }

    if (result.upstream !== undefined) {
        const upstream = result.upstream.upstream;
        const yesNo = (value: boolean | undefined): string => (value === undefined ? "unknown" : value ? "yes" : "no");

        out.blank();
        out.variables({
            ...(result.upstream.detachedAt === undefined ? {} : { "Checked out": `no branch; HEAD is detached at ${result.upstream.detachedAt}` }),
            "Compared with": upstream,
            [`Merged into ${upstream}`]: yesNo(result.upstream.merged),
            [`Behind ${upstream}`]: result.upstream.behind === undefined ? "unknown" : `${result.upstream.behind} ${result.upstream.behind === 1 ? "commit" : "commits"}`,
        });
        out.blank();
        out.note("Upstream was fetched just now; nothing in the checkout was changed.");
    } else if (result.upstreamNote !== undefined) {
        out.blank();
        out.note(result.upstreamNote);
    }

    if (result.trusted.length > 0) {
        out.blank();
        out.paragraph(`Repositories trusted along the way: ${result.trusted.join(", ")}.`);
    }

    out.footer();

    return out.text();
}

// --- repo.unlink --------------------------------------------------------------------------------------

async function repoUnlink(result: RepoUnlinkResult, view: CliViewContext): Promise<CliViewOutput> {
    const out = view.printer();

    out.section("Unlinking a repository");

    if (result.dryRun) {
        for (const line of result.wouldDo ?? []) {
            out.dryRunNotice(line);
        }
    } else {
        out.variables({
            Repository: result.repo,
            Checkout: result.path,
            Scope: result.scope === "global" ? "every project on this machine" : "this project",
            ...(result.recordedIn === undefined ? {} : { Updated: result.recordedIn }),
        });
        out.blank();
        out.paragraph(`'${result.repo}' is read from the versions the lockfile pins again.`);
    }

    if (result.published !== undefined) {
        out.blank().subheading("Published versions").blank();

        if (!result.published.checked) {
            out.note(`Sous could not check '${result.repo}' for newer published versions. ${result.published.reason ?? ""}`.trim());
        } else if (result.published.newer.length === 0) {
            out.paragraph(`Every pin from '${result.repo}' is the newest published version its range allows.`);
        } else {
            out.paragraph(`'${result.repo}' publishes newer versions within range. The lockfile still pins the older ones:`);
            out.blank();
            out.variables(result.published.newer.map((entry) => ({ label: entry.key, value: `${entry.from} pinned, ${entry.to} published` })));
        }
    }

    for (const entry of result.followUps) {
        if (entry.intent === "subscription.update" && entry.result !== undefined) {
            out.blank().subheading("Updating the pins");

            const text = await view.render(entry.intent, entry.result);

            if (text !== "") {
                out.log(text.replace(/\n$/, ""));
            }
        }
    }

    if (result.checkoutNote !== undefined) {
        out.blank();
        out.paragraph(result.checkoutNote);
    }

    out.footer();

    return withFollowUps(
        out,
        { followUps: result.followUps.filter((entry) => entry.intent !== "subscription.update") },
        view,
        `The repository '${result.repo}' was unlinked, but the build that followed it failed; fix what the build reported above and run 'sous build' again.`,
    );
}

// --- subscription.add ---------------------------------------------------------------------------------

function why(recipe: ResolvedRecipe): string {
    if (recipe.requestedBy.includes("project")) {
        return "you subscribed to it";
    }

    return recipe.kind === "subscribes" ? `co-subscribed by ${recipe.requestedBy.join(", ")}` : `needed by ${recipe.requestedBy.join(", ")}`;
}

async function subscriptionAdd(result: SubscriptionAddResult, view: CliViewContext): Promise<CliViewOutput> {
    const out = view.printer();

    out.heading("Subscribing");

    if (result.dryRun) {
        out.dryRunNotice("Nothing will be downloaded, written or asked.");
    }

    out.blank().subheading(result.dryRun ? "What would be installed" : "What was installed").blank();
    out.table(
        INSTALLED_COLUMNS,
        result.resolved.map((recipe) => ({ key: recipe.key, version: recipe.version, repo: recipe.repo, why: why(recipe) })),
        { indent: INDENT },
    );

    if (result.trusted.length > 0) {
        out.blank();
        out.paragraph(`Repositories trusted along the way: ${result.trusted.join(", ")}. They are now recorded in this project's config, and your colleagues inherit them.`);
    }

    lockfileBlock(out, result.diff, "Nothing changed; everything asked for was already locked.");

    if (result.cycles.length > 0) {
        out.warning(
            `Some of these recipes co-subscribe to each other in a circle:\n${result.cycles.map((cycle) => `  ${cycle.join(" -> ")}`).join("\n")}\nThat is unusual but not broken, and everything above was installed.`,
        );
    }

    // A dry run asks nothing, so it lists what the subscription would ask instead.
    if (result.dryRun && result.questions !== undefined) {
        out.blank().subheading("Questions these recipes ask").blank();
        writeQuestionPlan(out, result.questions, { answerHints: true });
    }

    out.blank();
    out.paragraph(
        result.dryRun
            ? "Nothing was written. Run the same command without '--dry-run' to install it."
            : `The subscription to '${result.key}' is recorded in this project's config, and the exact versions above are recorded in its lockfile.${rebuilt(result) ? "" : " Run 'sous build' to compile what they contribute."}`,
    );
    out.footer();

    return withFollowUps(
        out,
        result,
        view,
        `The subscription to '${result.key}' was saved, but the build that followed it failed, so this project's outputs may be incomplete. The subscription itself is recorded and locked; fix what the build reported above and run 'sous build' again.`,
    );
}

// --- subscription.remove ------------------------------------------------------------------------------

async function subscriptionRemove(result: SubscriptionRemoveResult, view: CliViewContext): Promise<CliViewOutput> {
    const out = view.printer();
    const pruneHint = rebuilt(result) ? "" : " Run 'sous build' to prune what it used to write.";

    out.heading("Unsubscribing");

    if (result.dryRun) {
        out.dryRunNotice("Nothing will be written.");
    }

    // What stayed, and why, the handler has already reported, one line per recipe.
    lockfileBlock(out, result.diff, "Nothing changed; nothing was locked because of this subscription.");
    out.blank();
    out.paragraph(
        result.dryRun
            ? "Nothing was written. Run the same command without '--dry-run' to remove it."
            : result.optedOut
              ? `The subscription to '${result.key}' is one sous provides itself, so it was switched off rather than deleted: this project's config now records '${result.key}: { enabled: false }'. The repository it came from is still trusted.${pruneHint}`
              : `The subscription to '${result.key}' is gone. The repositories it came from are still trusted; remove one of those deliberately if you want to withdraw that too.${pruneHint}`,
    );
    out.footer();

    return withFollowUps(
        out,
        result,
        view,
        `The subscription to '${result.key}' was removed, but the build that followed it failed, so this project may still hold files it used to write. The removal itself is recorded and locked; fix what the build reported above and run 'sous build' again.`,
    );
}

// --- subscription.enable and .disable -----------------------------------------------------------------

async function subscriptionToggle(result: SubscriptionToggleResult, view: CliViewContext): Promise<CliViewOutput> {
    const out = view.printer();
    const word = result.enabled ? "on" : "off";

    out.heading(result.enabled ? "Enabling a subscription" : "Disabling a subscription");

    if (result.dryRun) {
        out.dryRunNotice("Nothing will be written.");
    }

    out.blank();
    out.variables({ Subscription: result.key, Enabled: result.enabled ? "yes" : "no", "Recorded in": result.file });
    out.blank();
    out.paragraph(
        !result.changed
            ? `The subscription to '${result.key}' was already switched ${word}; nothing changed.`
            : result.dryRun
              ? `Nothing was written. Run the same command without '--dry-run' to switch '${result.key}' ${word}.`
              : `The subscription to '${result.key}' is now switched ${word}.${rebuilt(result) ? "" : " Run 'sous build' to bring the outputs in line."}`,
    );
    out.footer();

    return withFollowUps(
        out,
        result,
        view,
        `The subscription to '${result.key}' was switched ${word}, but the build that followed failed; fix what the build reported above and run 'sous build' again.`,
    );
}

// --- subscription.list --------------------------------------------------------------------------------

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
    const latestOf = (key: string, pinned: string) =>
        listing.latest === undefined ? (newer.get(key) ?? pinned) : (published.get(key) ?? "not in any index sous has read");

    if (listing.pinned.length === 1) {
        const only = listing.pinned[0]!;

        return latestOf(only.key, only.version);
    }

    return listing.pinned.map((pin) => `${pin.key} ${latestOf(pin.key, pin.version)}`).join(", ");
}

function describeOrigin(addedBy: string | undefined): string {
    if (addedBy === BUILT_IN_ADDED_BY) {
        return "built in";
    }

    return addedBy === undefined || addedBy === USER_ADDED_BY ? "user" : addedBy;
}

function subscriptionList(result: readonly SubscriptionListing[], view: CliViewContext): string {
    const out = view.printer();

    browsingVariables(out, view);
    const installed = view.input.installed === true;
    const listings = result.filter((entry) => !installed || entry.pinned.length > 0);

    out.heading("Subscriptions");
    out.blank();

    if (listings.length === 0) {
        out.paragraph(installed ? "No subscription of this project has installed anything yet." : "This project subscribes to nothing yet.");
        out.footer();

        return out.text();
    }

    const columns = SUBSCRIPTION_COLUMNS.map((column) =>
        installed && column.key === "pinned" ? { ...column, header: "Installed version" } : column,
    );

    out.table(
        columns,
        listings.map((entry) => ({
            key: entry.key,
            range: entry.range ?? "any version",
            pinned: describePinned(entry.pinned, entry.enabled),
            latest: describeLatest(entry),
            origin: describeOrigin(entry.addedBy),
            enabled: entry.enabled ? "yes" : "no",
        })),
        { indent: INDENT },
    );
    out.footer();

    return out.text();
}

/** The views of this domain, by intent. */
export const views: Record<string, CliViewEntity["render"]> = {
    "repo.add": repoAdd,
    "repo.remove": repoRemove,
    "repo.trust": repoTrust,
    "repo.gc": repoGc,
    "repo.link": repoLink,
    "repo.unlink": repoUnlink,
    "subscription.add": subscriptionAdd,
    "subscription.remove": subscriptionRemove,
    "subscription.enable": subscriptionToggle,
    "subscription.disable": subscriptionToggle,
    "subscription.list": subscriptionList,
};
