/**
 * Settling on one of the things a reference could have meant.
 *
 * Finding is separate from choosing on purpose: `findReference` is pure and
 * tells the caller everything a word could have meant, and this is the one
 * place that decides which of them the run proceeds with. Every command that
 * takes a reference goes through it, so a word that means two things behaves
 * the same everywhere:
 *
 *   - one match proceeds, and is reported so the reader sees what was chosen;
 *   - several matches are offered as a list to choose from;
 *   - `--accept-first` takes the first one in the documented listing order;
 *   - a run with no terminal fails, naming the question it could not ask and
 *     the flag that would have answered it (`src/lib/interactive.ts` holds that
 *     rule, and every prompt in sous is gated by it).
 */

import { ConfigError } from "../errors.js";
import { nonInteractiveError } from "../interactive.js";
import { indent, log } from "../../utils/formatting.js";
import { askChoice } from "../../utils/prompts.js";
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
  /** Say what a single match resolved to. On by default. */
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
    if (options.announce !== false) {
      write(indent(`'${options.search}' resolves to ${describeReference(first)}.`));
    }
    return first;
  }

  if (options.acceptFirst === true) {
    write(
      indent(
        `'${options.search}' matched ${matches.length} things; taking the first, ` +
          `because '${ACCEPT_FIRST_FLAG}' was passed.`
      )
    );
    if (options.announce !== false) {
      write(indent(`'${options.search}' resolves to ${describeReference(first)}.`));
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
