/**
 * Flags that more than one command shares, defined once.
 *
 * The confirmation flag is the reason this module exists. Several commands stop
 * and ask before they change anything (subscribing, trusting a repository,
 * deleting every file sous wrote), and a caller who wants to answer those
 * questions ahead of time should not have to remember which command spells it
 * `--yes`, which spells it `--force` and which spells it `--trust`. They are one
 * flag with several spellings, built here so the spellings cannot drift apart.
 *
 * Alternate spellings are real oclif flag aliases, not separate flags, so the
 * help screen lists the flag once. The alternates are named in a dim suffix on
 * the description, generated from the alias list rather than typed by hand.
 */

import { Flags } from "@oclif/core";
import { color } from "@oclif/color";
import type { AlphabetLowercase, AlphabetUppercase } from "@oclif/core/interfaces";

/** A short flag character, in the shape oclif wants it. */
export type FlagChar = AlphabetLowercase | AlphabetUppercase;

/** What the confirmation flag is called on a given command. */
export type ConfirmationPrimary = "yes" | "force";

/** How a command asks for the shared confirmation flag. */
export type ConfirmationFlagOptions = {
  /**
   * Which spelling is the primary one, which must match the key the flag is
   * filed under in the command's `flags` object. Defaults to `yes`; `clear` uses
   * `force`, because that is the spelling it has always had.
   */
  primary?: ConfirmationPrimary;
  /**
   * Extra long spellings to accept, on top of `--yes` and `--force`. The trust
   * ceremony reads naturally as `--trust`, so the commands that perform it pass
   * it here.
   */
  extraAliases?: string[];
  /** Replaces the default description, which the alias suffix is still added to. */
  description?: string;
};

/** What every confirmation flag says it does, before the alias suffix. */
export const CONFIRMATION_DESCRIPTION =
  "Answer yes to every confirmation this command would ask";

/** The long spelling that is not the primary one, keyed by the primary one. */
const OTHER_SPELLING: Record<ConfirmationPrimary, string> = {
  yes: "force",
  force: "yes",
};

/** The short character for each long spelling. */
const CHAR_FOR: Record<string, FlagChar> = { yes: "y", force: "f" };

/**
 * Renders the "(also -f, --force)" suffix that tells a reader every other way
 * to spell a flag, without giving each spelling a help line of its own.
 *
 * Short characters come first, then long names, in the order they were given.
 * The suffix is dim, so it sits behind the description rather than competing
 * with it; on a stream with no colors it is plain text.
 *
 * @param aliases - Long alternate spellings, without leading dashes.
 * @param charAliases - Short alternate characters, without leading dashes.
 * @returns The suffix, including its leading space, or an empty string when
 *   there is nothing to say.
 */
export function aliasSuffix(aliases: string[] = [], charAliases: FlagChar[] = []): string {
  const spellings = [
    ...charAliases.map((char) => `-${char}`),
    ...aliases.map((alias) => `--${alias}`),
  ];
  if (spellings.length === 0) return "";
  return ` ${color.dim(`(also ${spellings.join(", ")})`)}`;
}

/**
 * The shared confirmation flag: one boolean that answers every yes-or-no
 * question a command would otherwise stop and ask.
 *
 * File it under the key named by `primary`, so `--yes` is the flag's real name
 * on most commands and `--force` is its real name on `clear`. Either way both
 * long spellings, both short characters, and any extra alias are accepted and
 * behave identically.
 *
 * @param options - Which spelling is primary, and any extra aliases.
 */
export function confirmationFlag(options: ConfirmationFlagOptions = {}) {
  const primary = options.primary ?? "yes";
  const other = OTHER_SPELLING[primary];
  const aliases = [other, ...(options.extraAliases ?? [])];
  const charAliases: FlagChar[] = [CHAR_FOR[other]!];
  const description = options.description ?? CONFIRMATION_DESCRIPTION;

  return Flags.boolean({
    char: CHAR_FOR[primary]!,
    aliases,
    charAliases,
    description: `${description}${aliasSuffix(aliases, charAliases)}`,
    default: false,
  });
}

/**
 * The two flags that answer a recipe's questions ahead of time, on every
 * command that can ask one.
 *
 * They exist for callers with no terminal: a script, a continuous integration
 * job, or an agent that read the question plan out of a dry run and knows every
 * answer already. Both spellings are defined here so the commands that take
 * them cannot describe them differently. The semantics live in
 * `lib/vars/preanswers.ts`.
 */
export function answerFlags() {
  return {
    answer: Flags.string({
      description:
        "Answer one of the questions ahead of time, written as '<name>=<value>'. Repeat it for each answer",
      multiple: true,
    }),
    "answers-file": Flags.string({
      description:
        "Read answers from a YAML or JSON file of '<name>: <value>' pairs. An '--answer' wins over the file",
    }),
  };
}
