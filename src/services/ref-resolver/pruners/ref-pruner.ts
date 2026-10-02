/**
 * Pruners: the place a ref was written decides which readings of it count.
 *
 * The parser returns every reading. One pruner per `RefSource` then drops the
 * readings that place does not allow, each with the reason and what to write
 * there instead, so a refused ref is an error that tells the writer how to fix
 * it rather than a puzzle.
 */

import { ConfigError } from "../../../lib/errors.js";
import type { RefSource } from "../source.js";
import type { SousRef } from "../types.js";

/** One reading a pruner refused. */
export class DroppedRef {
  /**
   * @param ref - The reading.
   * @param reason - Why this place does not allow it, as a sentence.
   * @param instead - What to write there instead, as it would appear after "Write".
   */
  constructor(
    readonly ref: SousRef,
    readonly reason: string,
    readonly instead?: string
  ) {}

  /** The reason, with what to write instead on a line of its own. */
  describe(): string {
    return this.instead === undefined
      ? this.reason
      : `${this.reason}\n    Write ${this.instead} instead.`;
  }
}

/** What a pruner decided about a list of readings. */
export class RefPruneResult {
  /**
   * @param kept - The readings this place allows, in the order they came.
   * @param dropped - The readings it refuses, each with its reason.
   * @param warnings - Sentences about readings that were kept all the same.
   */
  constructor(
    readonly kept: SousRef[] = [],
    readonly dropped: DroppedRef[] = [],
    readonly warnings: string[] = []
  ) {}
}

/** Decides which readings of a ref count in one place. */
export interface RefPruner {
  /** The place this pruner speaks for. */
  readonly source: RefSource;
  /** What the place is called in a sentence, for the error. */
  readonly place: string;
  /**
   * Splits the readings into those the place allows and those it refuses.
   *
   * @param candidates - Every reading the parser returned.
   * @param input - The ref exactly as it was written, for messages.
   */
  prune(candidates: SousRef[], input: string): RefPruneResult;
}

/** What a rule does with a reading it matches. */
export type RefPruneAction = "drop" | "warn" | "throw";

/** The text of a rule's message: fixed, or made from the reading and what was written. */
export type RefRuleText = string | ((ref: SousRef, input: string) => string);

/** One rule of a pruner: when it matches a reading, what it does and why. */
export type RefPruneRule = {
  /** True when the rule applies to this reading. */
  matches: (ref: SousRef, input: string) => boolean;
  /** `drop` removes the reading, `warn` keeps it with a warning, `throw` fails at once. */
  action: RefPruneAction;
  /** The reason: why the place refuses the reading, or what is wrong with it. */
  message: RefRuleText;
  /** What to write instead, which makes the error say how to fix it. */
  instead?: RefRuleText;
};

/** Resolves a rule's text for one reading. */
function textOf(text: RefRuleText, ref: SousRef, input: string): string {
  return typeof text === "function" ? text(ref, input) : text;
}

/**
 * A pruner that applies an ordered list of rules. The first rule that matches
 * a reading decides; a reading no rule matches is kept. A subclass lists its
 * rules, and may rewrite a kept reading (a manifest stores lowercase names).
 */
export abstract class RuleRefPruner implements RefPruner {
  abstract readonly source: RefSource;
  abstract readonly place: string;

  /** The rules, in the order they are tried. */
  protected abstract rules(): RefPruneRule[];

  /**
   * Rewrites a reading this place keeps. Most places keep it as it is.
   *
   * @param ref - A kept reading.
   */
  protected normalize(ref: SousRef): SousRef {
    return ref;
  }

  prune(candidates: SousRef[], input: string): RefPruneResult {
    const rules = this.rules();
    const result = new RefPruneResult();

    for (const ref of candidates) {
      const rule = rules.find((entry) => entry.matches(ref, input));
      if (rule === undefined) {
        result.kept.push(this.normalize(ref));
        continue;
      }
      const message = textOf(rule.message, ref, input);
      if (rule.action === "throw") throw new ConfigError(message);
      if (rule.action === "warn") {
        result.kept.push(this.normalize(ref));
        result.warnings.push(message);
        continue;
      }
      result.dropped.push(
        new DroppedRef(
          ref,
          message,
          rule.instead === undefined ? undefined : textOf(rule.instead, ref, input)
        )
      );
    }
    return result;
  }
}
