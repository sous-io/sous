/**
 * The ref resolver: parse a written ref, prune it by where it was written,
 * and, when the caller knows what exists, narrow it to what is there.
 *
 * It orchestrates three parts that know nothing of one another: a `RefParser`
 * (every reading of the text), a `RefPruner` per place (which readings that
 * place allows) and, per call, a `RefLookup` (which readings exist). What to do
 * about a ref that is still ambiguous, and how to find the ref inside the text
 * around it, are the caller's decisions; the helpers here and in
 * `ref-helpers.ts` assist with both.
 */

import { makeInjectable } from "./injectable.js";
import { REF_TOKENS } from "./tokens.js";
import { ConfigError } from "../../lib/errors.js";
import { refIdentity } from "./format.js";
import type { RefLookup, RefMatch, SyncRefLookup } from "./lookups/ref-lookup.js";
import { repoOf } from "./parts.js";
import type { RefParser } from "./parser/ref-parser.js";
import { DroppedRef, type RefPruner } from "./pruners/ref-pruner.js";
import { RefResolveArguments } from "./ref-resolve-arguments.js";
import { RefResolveResult } from "./ref-resolve-result.js";
import { RefSource } from "./source.js";
import { REF_KINDS, type SousRef } from "./types.js";

/** One ref found inside a longer text. */
export type RefInString = {
  /** The text that parsed, with the punctuation around it taken off. */
  text: string;
  /** Where it starts in the string. */
  index: number;
  /** What it resolved to. */
  result: RefResolveResult;
};

/**
 * How qualified the spelling that produced a candidate was. Lower is more
 * specific, and the listing order follows it: a fully qualified ref first, then
 * a partly qualified one, then a bare name, and an environment variable name
 * last (the least likely reading of a plain word).
 *
 * @param candidate - One reading of a written ref.
 */
export function qualificationOf(candidate: SousRef): number {
  if (candidate.kind === "envVar") return 3;
  if (candidate.kind === "repo" || repoOf(candidate) !== undefined) return 0;
  const partial =
    (candidate.kind === "recipe" && candidate.namespace !== undefined) ||
    candidate.kind === "recipeFile" ||
    (candidate.kind === "variable" && candidate.recipe !== undefined);
  return partial ? 1 : 2;
}

/** Resolves written refs. */
export class RefResolverService {
  /**
   * @param parser - Reads every way a text can be a ref.
   * @param pruners - Decide, one place each, which readings count there.
   */
  constructor(
    private readonly parser: RefParser,
    private readonly pruners: RefPruner[]
  ) {}

  /**
   * Parses a ref and prunes it by where it was written, with no lookup.
   *
   * @param input - The ref exactly as it was written.
   * @param from - Where it was written.
   * @throws A ConfigError listing every reason when the place refuses every reading.
   */
  parse(input: string, from: RefSource = RefSource.CommandLine): RefResolveResult {
    const { kept, dropped, warnings, place } = this.prune(input, from);
    if (kept.length === 0) throw this.refusal(input, place, dropped);
    return new RefResolveResult(input, this.order(kept.map((ref) => ({ ref, rank: ref }))), dropped, warnings, false);
  }

  /**
   * Parses a ref, prunes it by where it was written and, when a lookup is
   * given, narrows it to what exists. When `kinds` is given, readings of other
   * kinds are set aside first, and so are the matches of other kinds. A browser
   * URL is the one reading that is a repository until a lookup settles it into
   * the namespace or recipe it names, so it is kept for a caller that accepts
   * namespaces or recipes.
   *
   * With a lookup, every kept reading is asked; the exact-spelling matches are
   * kept when there are any, and the case-insensitive ones otherwise; matches
   * are de-duplicated and returned in the spelling they are published in. A
   * ref nothing knows comes back with no refs; that is for the caller to
   * report. A lookup that could not find out throws.
   *
   * @param args - The ref, where it was written, and what exists.
   * @throws A ConfigError listing every reason when the place refuses every reading.
   */
  async resolve(args: RefResolveArguments): Promise<RefResolveResult> {
    const early = this.beginResolve(args);
    if ("result" in early) return early.result;
    const found: Array<{ match: RefMatch; rank: SousRef }> = [];
    if (early.lookup !== undefined) {
      for (const candidate of early.kept) {
        for (const match of await early.lookup.find(candidate)) {
          found.push({ match, rank: candidate });
        }
      }
    }
    return this.finishResolve(args, early, found);
  }

  /**
   * The same as `resolve`, for a caller that cannot wait: it asks the lookup's
   * `findSync`, so the lookup must have one. A template engine's path
   * resolution is synchronous, and is why this exists.
   *
   * @param args - The ref, where it was written, and what exists (a lookup with `findSync`).
   * @throws A ConfigError listing every reason when the place refuses every reading.
   */
  resolveSync(args: RefResolveArguments): RefResolveResult {
    const early = this.beginResolve(args);
    if ("result" in early) return early.result;
    const found: Array<{ match: RefMatch; rank: SousRef }> = [];
    if (early.lookup !== undefined) {
      const lookup = early.lookup as Partial<SyncRefLookup>;
      if (lookup.findSync === undefined) {
        throw new ConfigError("resolveSync needs a lookup that has a findSync method.");
      }
      for (const candidate of early.kept) {
        for (const match of lookup.findSync(candidate)) found.push({ match, rank: candidate });
      }
    }
    return this.finishResolve(args, early, found);
  }

  /**
   * Parses and prunes without refusing: the readings a place keeps and the
   * ones it drops, with the reason for each. For a caller that explains a
   * refusal in its own words.
   *
   * @param input - The ref exactly as it was written.
   * @param from - Where it was written.
   * @throws A ConfigError when the text is not a ref in any reading.
   */
  inspect(input: string, from: RefSource): { kept: SousRef[]; dropped: DroppedRef[] } {
    const { kept, dropped } = this.prune(input, from);
    return { kept, dropped };
  }

  /** Everything `resolve` does before it asks a lookup, or the answer when it needs none. */
  private beginResolve(
    args: RefResolveArguments
  ):
    | { result: RefResolveResult }
    | {
        kept: SousRef[];
        dropped: DroppedRef[];
        warnings: string[];
        lookup: RefLookup | undefined;
      } {
    let pruned;
    try {
      pruned = this.prune(args.input, args.from);
    } catch (error) {
      // A text no reading exists for (empty, say) is refused the same way.
      if (args.refusedIsEmpty) return { result: new RefResolveResult(args.input, [], [], [], true) };
      throw error;
    }
    const { dropped, warnings, place } = pruned;
    if (pruned.kept.length === 0) {
      if (args.refusedIsEmpty) {
        return { result: new RefResolveResult(args.input, [], dropped, warnings, true) };
      }
      throw this.refusal(args.input, place, dropped);
    }
    const kinds = args.kinds;
    const kept =
      kinds === undefined
        ? pruned.kept
        : pruned.kept.filter(
            (ref) =>
              kinds.includes(ref.kind) ||
              (ref.kind === "repo" &&
                ref.browsed !== undefined &&
                (kinds.includes("namespace") || kinds.includes("recipe")))
          );

    if (args.lookup === undefined) {
      return {
        result: new RefResolveResult(
          args.input,
          this.order(kept.map((ref) => ({ ref, rank: ref }))),
          dropped,
          warnings,
          false
        ),
      };
    }
    return { kept, dropped, warnings, lookup: args.lookup };
  }

  /** Everything `resolve` does with what a lookup found. */
  private finishResolve(
    args: RefResolveArguments,
    early: { dropped: DroppedRef[]; warnings: string[] },
    found: Array<{ match: RefMatch; rank: SousRef }>
  ): RefResolveResult {
    const kinds = args.kinds;
    const matching = found.filter(
      (entry) => kinds === undefined || kinds.includes(entry.match.ref.kind)
    );
    const exact = matching.filter((entry) => entry.match.exactSpelling);
    const chosen = exact.length > 0 ? exact : matching;

    return new RefResolveResult(
      args.input,
      this.order(chosen.map((entry) => ({ ref: entry.match.ref, rank: entry.rank }))),
      early.dropped,
      early.warnings,
      true
    );
  }

  /**
   * True when the ref parses and the place allows at least one reading of it.
   *
   * @param input - The ref exactly as it was written.
   * @param from - Where it was written.
   */
  isValidRef(input: string, from: RefSource = RefSource.CommandLine): boolean {
    try {
      this.parse(input, from);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Every ref found in a longer text, one per whitespace-separated word that
   * is a valid ref where it was written, with the quotes, brackets and
   * sentence punctuation around the word taken off. Words that are not refs
   * are left out.
   *
   * getRefsInString("see 'workflow/task-files', then run it.");
   * // -> workflow/task-files, and the other words that happen to read as a ref
   *
   * @param text - The text to search.
   * @param from - Where the text was written.
   */
  getRefsInString(text: string, from: RefSource = RefSource.CommandLine): RefInString[] {
    const found: RefInString[] = [];
    for (const word of text.matchAll(/\S+/g)) {
      const bare = word[0].replace(/^[`"'([<{]+/, "").replace(/[`"')\]>},.;:!]+$/, "");
      if (bare.length === 0) continue;
      const start = word.index + word[0].indexOf(bare);
      try {
        found.push({ text: bare, index: start, result: this.parse(bare, from) });
      } catch {
        // Not a ref; the words around it may be.
      }
    }
    return found;
  }

  /** Parses and prunes, and says where the ref was written in words. */
  private prune(
    input: string,
    from: RefSource
  ): { kept: SousRef[]; dropped: DroppedRef[]; warnings: string[]; place: string } {
    const pruners = this.pruners.filter((pruner) => pruner.source === from);
    if (pruners.length === 0) {
      throw new ConfigError(`No pruner is registered for a ref written as '${from}'.`);
    }

    let kept = this.parser.parse(input);
    const dropped: DroppedRef[] = [];
    const warnings: string[] = [];
    for (const pruner of pruners) {
      const result = pruner.prune(kept, input.trim());
      kept = result.kept;
      dropped.push(...result.dropped);
      warnings.push(...result.warnings);
    }
    return { kept, dropped, warnings, place: pruners[0]!.place };
  }

  /** The error for a ref the place refuses in every reading. */
  private refusal(input: string, place: string, dropped: DroppedRef[]): ConfigError {
    const reasons = [...new Set(dropped.map((entry) => entry.describe()))];
    if (reasons.length === 1) {
      return new ConfigError(`The ref '${input.trim()}' cannot be written ${place}: ${reasons[0]}`);
    }
    return new ConfigError(
      `The ref '${input.trim()}' cannot be written ${place}. Every way it reads is refused:\n` +
        reasons.map((reason) => `  - ${reason}`).join("\n")
    );
  }

  /**
   * Sorts refs into the documented listing order and drops any the same
   * search found twice: by how qualified the spelling that produced each was,
   * then by kind, then in the order they came (a lookup lists repositories in
   * the order the project searches them).
   */
  private order(entries: Array<{ ref: SousRef; rank: SousRef }>): SousRef[] {
    const indexed = entries.map((entry, position) => ({ ...entry, position }));
    indexed.sort(
      (left, right) =>
        qualificationOf(left.rank) - qualificationOf(right.rank) ||
        REF_KINDS.indexOf(left.ref.kind) - REF_KINDS.indexOf(right.ref.kind) ||
        left.position - right.position
    );
    const seen = new Set<string>();
    return indexed
      .map((entry) => entry.ref)
      .filter((ref) => {
        const identity = `${refIdentity(ref)} ${JSON.stringify(ref.vars ?? {})}`;
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
      });
  }
}

makeInjectable(RefResolverService, [REF_TOKENS.Parser, { multi: REF_TOKENS.Pruner }]);
