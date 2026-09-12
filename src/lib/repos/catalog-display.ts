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
import { log, wrapColumns } from "../../utils/formatting.js";
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
    pinned: entry.pinned ?? "",
    subscribed: entry.subscribed ? "yes" : "no",
    description: entry.description ?? "no description published",
  }));
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
