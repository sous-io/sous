/**
 * Settling on one of the things a ref could have meant.
 *
 * Resolving is separate from choosing on purpose: the resolver is pure and
 * tells the caller everything a ref could have meant, and this is the one place
 * that decides which of them the run proceeds with. Every command that takes a
 * ref goes through it, so a word that means two things behaves the same
 * everywhere:
 *
 *   - one match proceeds, and what it resolved to is written as the facts about
 *     it followed by one sentence, so the reader sees what the word they typed
 *     actually meant;
 *   - several matches are offered as a list to choose from;
 *   - `--accept-first` takes the first one in the documented listing order;
 *   - a run with no terminal fails, naming the question it could not ask and
 *     the flag that would have answered it (`src/lib/interactive.ts` holds that
 *     rule, and every prompt in sous is gated by it).
 */

import { makeInjectable } from "./injectable.js";
import { ConfigError } from "../../lib/errors.js";
import { nonInteractiveError } from "../../lib/interactive.js";
import {
  formatResolvedReference,
  type ResolvedReferenceFacts,
} from "../../lib/repos/reference-report.js";
import { formatParagraph, log } from "../../utils/formatting.js";
import { askChoice } from "../../utils/prompts.js";
import { describeRef, refKey, refKindLabel } from "./format.js";
import { namespaceOf, recipeOf, repoOf } from "./parts.js";
import type { SousRef } from "./types.js";

/** The flag that answers "which one did you mean?" ahead of time. */
export const ACCEPT_FIRST_FLAG = "--accept-first";

/** How `RefPickerService.pick` should behave. */
export class RefPickArguments {
  /** The ref exactly as it was written, for every message. */
  readonly search: string;
  /** Whether a question may be asked. A run that may not fails instead. */
  readonly interactive: boolean;
  /** Take the first match rather than asking, because `--accept-first` was passed. */
  readonly acceptFirst: boolean;
  /** The question to ask when there is more than one match. */
  readonly prompt?: string;
  /**
   * Write the facts about what the ref resolved to. On by default; a caller
   * that reports the resolution itself turns it off, and is still told when
   * `--accept-first` settled an ambiguous word.
   */
  readonly announce: boolean;
  /** Extra lines for the error a ref that matched nothing raises. */
  readonly details: string[];
  /** Where a resolution is reported. Defaults to the console. */
  readonly write: (message: string) => void;
  /** How the choice is asked. Defaults to the shared choice prompt. */
  readonly choose?: (message: string, matches: SousRef[]) => Promise<SousRef>;

  /**
   * @param init - What was searched for, and whether a question may be asked.
   */
  constructor(init: {
    search: string;
    interactive: boolean;
    acceptFirst?: boolean;
    prompt?: string;
    announce?: boolean;
    details?: string[];
    write?: (message: string) => void;
    choose?: (message: string, matches: SousRef[]) => Promise<SousRef>;
  }) {
    this.search = init.search;
    this.interactive = init.interactive;
    this.acceptFirst = init.acceptFirst ?? false;
    if (init.prompt !== undefined) this.prompt = init.prompt;
    this.announce = init.announce ?? true;
    this.details = init.details ?? [];
    this.write = init.write ?? ((message: string) => log(message));
    if (init.choose !== undefined) this.choose = init.choose;
  }
}

/**
 * The facts one resolved ref carries, ready for `formatResolvedReference`.
 *
 * The ref knows what it is; this decides which of its fields are facts worth
 * showing. A repository's own name is already the resolved spelling, so it is
 * not repeated as a line of its own. What a ref resolves to is always its
 * fully qualified key; for an environment variable name that is the key of the
 * variable it answers, because that is what the rest of the run proceeds with.
 *
 * @param ref - The ref the run proceeds with.
 * @param search - The ref exactly as it was written.
 * @param reason - The closing sentence, when the caller has one of its own.
 */
export function resolvedRefFacts(
  ref: SousRef,
  search: string,
  reason?: string
): ResolvedReferenceFacts {
  const subject = ref.kind === "envVar" ? (ref.variables?.[0] ?? ref) : ref;
  const resolvedTo = refKey(subject);
  const repoName = repoOf(subject)?.name;
  const recipe = recipeOf(subject);
  const namespace = namespaceOf(subject);

  return {
    search,
    resolvedTo,
    kind: refKindLabel(ref),
    ...(subject.kind === "variable" ? { variable: subject.name } : {}),
    ...(recipe === undefined || subject.kind === "namespace" ? {} : { recipe: recipe.name }),
    ...(namespace === undefined ? {} : { namespace: namespace.name }),
    ...(repoName === undefined || repoName === resolvedTo ? {} : { repository: repoName }),
    ...(ref.kind === "repo" && ref.location !== undefined ? { location: ref.location.url } : {}),
    ...(ref.kind !== "repo" && subject.description !== undefined
      ? { description: subject.description }
      : {}),
    ...(reason === undefined ? {} : { reason }),
  };
}

/** Chooses the one ref a run proceeds with. */
export class RefPickerService {
  /**
   * The one ref a run proceeds with.
   *
   * @param matches - What the ref could have meant, in listing order.
   * @param args - What was searched for, and whether a question may be asked.
   * @returns The ref the run proceeds with.
   */
  async pick(matches: SousRef[], args: RefPickArguments): Promise<SousRef> {
    if (matches.length === 0) {
      throw new ConfigError(
        [`Nothing called '${args.search}' was found.`, ...args.details].join("\n")
      );
    }

    const first = matches[0]!;

    if (matches.length === 1) {
      if (args.announce) this.announce(args, first);
      return first;
    }

    if (args.acceptFirst) {
      const reason =
        `'${args.search}' named ${matches.length} things, and ` +
        `'${ACCEPT_FIRST_FLAG}' was passed, so the first one listed is being used.`;

      // A caller that reports the resolution itself still has to be told that the
      // word was ambiguous, so the sentence is written even when the facts are not.
      if (args.announce) {
        this.announce(args, first, reason);
      } else {
        for (const line of formatParagraph(reason)) args.write(line);
      }
      return first;
    }

    if (!args.interactive) {
      // The example is a spelling that says more than what was typed, so a
      // ref that is already its own fully qualified name is not offered back
      // unchanged.
      const example = refKey(matches.find((match) => refKey(match) !== args.search) ?? first);

      throw nonInteractiveError({
        prompt: `which '${args.search}' you meant`,
        remedy:
          `write the full reference (for example '${example}'), or pass ` +
          `'${ACCEPT_FIRST_FLAG}' to take the first candidate listed above.`,
        details: [
          `'${args.search}' matched ${matches.length} things:`,
          ...matches.map((match) => `  ${describeRef(match)}`),
        ],
      });
    }

    const choose =
      args.choose ??
      ((message: string, offered: SousRef[]) =>
        askChoice(
          message,
          offered.map((match) => ({ name: describeRef(match), value: match }))
        ));

    return choose(args.prompt ?? `Which '${args.search}' did you mean?`, matches);
  }

  /**
   * Writes what a ref resolved to, as the key and value list every other set
   * of facts in the CLI is written as, followed by one sentence saying why that
   * candidate won.
   */
  private announce(args: RefPickArguments, ref: SousRef, reason?: string): void {
    for (const line of formatResolvedReference(resolvedRefFacts(ref, args.search, reason))) {
      args.write(line);
    }
  }
}

makeInjectable(RefPickerService);
