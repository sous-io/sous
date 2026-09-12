/**
 * Settling on one of the things a reference could have meant.
 *
 * Finding is separate from choosing on purpose: `findReference` is pure and
 * tells the caller everything a word could have meant, and this is the one
 * place that decides which of them the run proceeds with. Every command that
 * takes a reference goes through it, so a word that means two things behaves
 * the same everywhere:
 *
 *   - one match proceeds, and what it resolved to is written as the facts about
 *     it followed by one sentence (`formatResolvedReference`), so the reader
 *     sees what the word they typed actually meant;
 *   - several matches are offered as a list to choose from;
 *   - `--accept-first` takes the first one in the documented listing order;
 *   - a run with no terminal fails, naming the question it could not ask and
 *     the flag that would have answered it (`src/lib/interactive.ts` holds that
 *     rule, and every prompt in sous is gated by it).
 */

import { ConfigError } from "../errors.js";
import { nonInteractiveError } from "../interactive.js";
import { formatParagraph, log } from "../../utils/formatting.js";
import { askChoice } from "../../utils/prompts.js";
import {
  formatResolvedReference,
  resolvedReferenceFacts,
} from "../repos/reference-report.js";
import { describeReference, type ReferenceMatch } from "./find.js";

/** The flag that answers "which one did you mean?" ahead of time. */
export const ACCEPT_FIRST_FLAG = "--accept-first";

/** How `pickReference` should behave. */
export type PickReferenceOptions = {
  /** The reference exactly as it was written, for every message. */
  search: string;
  /** Whether a question may be asked. A run that may not fails instead. */
  interactive: boolean;
  /** Take the first match rather than asking, because `--accept-first` was passed. */
  acceptFirst?: boolean;
  /** The question to ask when there is more than one match. */
  prompt?: string;
  /**
   * Write the facts about what the reference resolved to. On by default; a
   * caller that reports the resolution itself turns it off, and is still told
   * when `--accept-first` settled an ambiguous word.
   */
  announce?: boolean;
  /** Extra lines for the error a reference that matched nothing raises. */
  details?: string[];
  /** Where a resolution is reported. Defaults to the console. */
  write?: (message: string) => void;
  /** How the choice is asked. Defaults to the shared choice prompt. */
  choose?: (message: string, matches: ReferenceMatch[]) => Promise<ReferenceMatch>;
};

/**
 * The one match a reference proceeds with.
 *
 * @param matches - What the reference could have meant, in listing order.
 * @param options - What was searched for, and whether a question may be asked.
 * @returns The match the run proceeds with.
 */
export async function pickReference(
  matches: ReferenceMatch[],
  options: PickReferenceOptions
): Promise<ReferenceMatch> {
  const write = options.write ?? ((message: string) => log(message));

  if (matches.length === 0) {
    throw new ConfigError(
      [`Nothing called '${options.search}' was found.`, ...(options.details ?? [])].join("\n")
    );
  }

  const first = matches[0]!;

  if (matches.length === 1) {
    if (options.announce !== false) announce(write, first, options.search);
    return first;
  }

  if (options.acceptFirst === true) {
    const reason =
      `'${options.search}' named ${matches.length} things, and ` +
      `'${ACCEPT_FIRST_FLAG}' was passed, so the first one listed is being used.`;

    // A caller that reports the resolution itself still has to be told that the
    // word was ambiguous, so the sentence is written even when the facts are not.
    if (options.announce === false) {
      for (const line of formatParagraph(reason)) write(line);
    } else {
      announce(write, first, options.search, reason);
    }
    return first;
  }

  if (!options.interactive) {
    // The example is a spelling that says more than what was typed, so a
    // reference that is already its own fully qualified name is not offered
    // back unchanged.
    const example =
      matches.find((match) => match.key !== options.search)?.key ?? first.key;

    throw nonInteractiveError({
      prompt: `which '${options.search}' you meant`,
      remedy:
        `write the full reference (for example '${example}'), or pass ` +
        `'${ACCEPT_FIRST_FLAG}' to take the first candidate listed above.`,
      details: [
        `'${options.search}' matched ${matches.length} things:`,
        ...matches.map((match) => `  ${describeReference(match)}`),
      ],
    });
  }

  const choose =
    options.choose ??
    ((message: string, offered: ReferenceMatch[]) =>
      askChoice(
        message,
        offered.map((match) => ({ name: describeReference(match), value: match }))
      ));

  return choose(options.prompt ?? `Which '${options.search}' did you mean?`, matches);
}

/**
 * Writes what a reference resolved to, as the key and value list every other
 * set of facts in the CLI is written as, followed by one sentence saying why
 * that candidate won.
 *
 * @param write - Where the report goes.
 * @param match - The match the run proceeds with.
 * @param search - The reference exactly as it was written.
 * @param reason - The closing sentence, when it was not simply the only match.
 */
function announce(
  write: (message: string) => void,
  match: ReferenceMatch,
  search: string,
  reason?: string
): void {
  for (const line of formatResolvedReference(resolvedReferenceFacts(match, search, reason))) {
    write(line);
  }
}
