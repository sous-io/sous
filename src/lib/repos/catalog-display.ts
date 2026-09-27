/**
 * Shared display helpers for the browsing commands.
 *
 * `sous namespace show` and `sous recipe list` both print a table of recipes,
 * and every one of the four commands turns the catalog's words into the ones a
 * person reads. One module holds them so the four never drift apart in wording.
 *
 * The labeled facts block is the one `sous vars show` prints; it is rendered by
 * `renderFacts`, which is already generic over a label and its lines.
 */

import { renderFacts, type LabeledFact } from "../vars/display.js";
import {
  blankLine,
  log,
  note,
  palette,
  paragraph,
  wrapColumns,
} from "../../utils/formatting.js";
import type { TableColumn } from "../../utils/table.js";
import type {
  NamespaceCoverage,
  RecipeListing,
  VersionStatus,
} from "./catalog.js";

/** How far every line of a browsing command's output is indented. */
export const INDENT = 2;

/**
 * The columns a recipe listing shows. The recipe and its versions are why
 * anybody ran the command, so they stay however narrow the terminal is; the
 * description takes the room that is left and wraps rather than being cut.
 */
export const RECIPE_COLUMNS: TableColumn[] = [
  { key: "key", header: "Recipe", kind: "path", overflow: "truncate", minWidth: 12 },
  { key: "repo", header: "Repository", overflow: "truncate", priority: "medium" },
  { key: "latest", header: "Latest", overflow: "truncate", minWidth: 6 },
  { key: "pinned", header: "Pinned", overflow: "truncate", minWidth: 6 },
  { key: "subscribed", header: "Subscribed", priority: "medium" },
  {
    key: "description",
    header: "What it is",
    overflow: "wrap",
    flex: 1,
    priority: "low",
    minWidth: 16,
  },
];

/**
 * The recipe columns for one run. Narrowed to what the project has installed,
 * the pinned column is the installed version, and is headed that way.
 *
 * @param options - Whether the listing is narrowed to installed recipes.
 */
export function recipeColumns(options: { installed?: boolean } = {}): TableColumn[] {
  if (options.installed !== true) return RECIPE_COLUMNS;
  return RECIPE_COLUMNS.map((column) =>
    column.key === "pinned" ? { ...column, header: "Installed" } : column
  );
}

/** One rendered recipe row, in the shape `RECIPE_COLUMNS` reads. */
export type RecipeRow = {
  key: string;
  repo: string;
  latest: string;
  pinned: string;
  subscribed: string;
  description: string;
};

/**
 * Turns recipe listings into table rows. A recipe the project does not pin
 * leaves the pinned column blank, because there is nothing to report there
 * rather than something worth a word.
 *
 * @param listings - What the catalog produced.
 */
export function recipeRows(listings: RecipeListing[]): RecipeRow[] {
  return listings.map((entry) => ({
    key: entry.key,
    repo: entry.repo,
    latest: entry.latest ?? "none published",
    pinned: pinnedCell(entry.pinned, entry.linkedPath),
    subscribed: entry.subscribed ? "yes" : "no",
    description: entry.description ?? "no description published",
  }));
}

/**
 * The pinned version as a cell: the version alone, or the version marked
 * `linked` in muted grey when builds read the recipe from a linked checkout.
 *
 * @param pinned - The version the lockfile pins, when it pins one.
 * @param linkedPath - The linked checkout, when the repository is linked.
 */
export function pinnedCell(pinned: string | undefined, linkedPath: string | undefined): string {
  if (pinned === undefined) return "";
  return linkedPath === undefined ? pinned : `${pinned} ${palette.muted("linked")}`;
}

/** What a listing says about the linked recipes it marked. */
export const LINKED_NOTE =
  "A recipe marked linked is pinned at the version shown, but builds currently read it " +
  "from the linked checkout of its repository.";

/** What a repository listing says when an installed repository is linked. */
export const LINKED_REPO_NOTE =
  "A recipe installed from a linked repository is pinned at the version shown, but " +
  "builds currently read it from the linked checkout.";

/**
 * Where a browsing command read the indexes from, in the words its opening
 * block shows.
 *
 * @param latest - Whether the latest was asked for.
 */
export function describeIndexSource(latest: boolean): string {
  return latest ? "each repository, upstream" : "the cached indexes";
}

/** What a browsing command could not read, and whether any row is linked. */
export type BrowsingNotes = {
  /** Trusted repositories with no index at all. */
  notFetched?: string[];
  /** Repositories upstream could not answer for, shown from the cache. */
  notChecked?: string[];
  /** True when some row was marked linked. */
  anyLinked?: boolean;
};

/**
 * Prints what a browsing command's rows could not say themselves: repositories
 * that were not listed at all, repositories shown from the cache because
 * upstream could not be reached, and what `linked` means when a row carries
 * it. Prints nothing when there is nothing to say.
 *
 * @param notes - What the command could not read, and whether a row was linked.
 */
export function printBrowsingNotes(notes: BrowsingNotes): void {
  const lines: Array<{ text: string; kind: "fact" | "note" }> = [];

  if ((notes.notFetched ?? []).length > 0) {
    lines.push({
      kind: "fact",
      text:
        `These repositories are trusted and their index has not been fetched yet, so ` +
        `nothing in them is listed: ${notes.notFetched!.join(", ")}.`,
    });
  }
  if ((notes.notChecked ?? []).length > 0) {
    lines.push({
      kind: "fact",
      text:
        `These repositories could not be reached, so they are shown from the cache and ` +
        `were not checked: ${notes.notChecked!.join(", ")}.`,
    });
  }
  if (notes.anyLinked === true) lines.push({ kind: "note", text: LINKED_NOTE });

  if (lines.length === 0) return;
  blankLine();
  for (const line of lines) {
    if (line.kind === "note") note(line.text);
    else paragraph(line.text);
  }
}

/**
 * Plain-language wording for how much of a namespace a project subscribes to.
 *
 * @param coverage - What the catalog worked out.
 */
export function describeCoverage(coverage: NamespaceCoverage): string {
  if (coverage === "whole namespace") return "the whole namespace";
  if (coverage === "some recipes") return "some recipes";
  return "no";
}

/**
 * Plain-language wording for what one published version is to this project.
 *
 * @param status - What the catalog worked out.
 */
export function describeVersionStatus(status: VersionStatus): string {
  if (status === "latest and pinned") return "the latest version, and the one pinned here";
  if (status === "latest") return "the latest version";
  if (status === "pinned") return "the version pinned here";
  return "an earlier version";
}

/**
 * Prints a labeled facts block, wrapped to the terminal. The renderer indents
 * the block itself, so every facts block in the CLI sits at the same depth
 * whichever command printed it.
 *
 * @param facts - The facts to print.
 */
export function printFacts(facts: LabeledFact[]): void {
  for (const line of renderFacts(facts, wrapColumns())) log(line);
}

/**
 * One labeled fact, when there is anything to say. Used to keep an absent field
 * out of a facts block rather than printing an empty line for it.
 *
 * @param label - The label to show.
 * @param value - The text beside it, or undefined to leave the fact out.
 */
export function factIf(label: string, value: string | undefined): LabeledFact[] {
  return value === undefined || value.length === 0 ? [] : [{ label, lines: [value] }];
}
