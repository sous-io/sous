/**
 * What a config file and a stored key have in common: only `namespace` or
 * `namespace/recipe`, lowercase, with nothing else attached. They differ in
 * what they tell a writer to do instead.
 */

import { makeInjectable } from "../injectable.js";
import { rangeOf, repoOf } from "../parts.js";
import { RefSource, SOURCE_LABELS } from "../source.js";
import { RuleRefPruner, type RefPruneRule } from "./ref-pruner.js";
import {
  hasLocation,
  hasRepoName,
  isStoredKind,
  KEBAB_REASON,
  shortKey,
} from "./rule-helpers.js";

/** A subscription key in a config layer. */
export class ConfigPruner extends RuleRefPruner {
  readonly source = RefSource.Config;
  readonly place = SOURCE_LABELS[RefSource.Config];

  protected rules(): RefPruneRule[] {
    return [
      {
        matches: hasLocation,
        action: "drop",
        message:
          "a config file names a subscription by its short form; the repository it lives in is " +
          "a separate entry under 'repos'.",
        instead: (_ref, input) =>
          `'namespace/recipe', or run 'sous subscribe ${input.trim()}', which adds the ` +
          "repository and writes the subscription in its short form",
      },
      {
        matches: (ref) => !isStoredKind(ref),
        action: "drop",
        message: KEBAB_REASON,
        instead: "'namespace/recipe'",
      },
      {
        matches: hasRepoName,
        action: "drop",
        message: (ref) =>
          "the repository a subscription resolves into is recorded in the lockfile, not in the " +
          "key. To choose between repositories, run " +
          `'sous subscribe ${repoOf(ref)?.name}:${shortKey(ref).toLowerCase()}', which records the choice.`,
        instead: (ref) => `'${shortKey(ref).toLowerCase()}'`,
      },
      {
        matches: (ref) => ref.glob === true,
        action: "drop",
        message: "a glob pattern is not a stored key; names here must be kebab-case.",
        instead: (ref) => `'${shortKey(ref).toLowerCase()}'`,
      },
      {
        matches: (ref) => rangeOf(ref) !== undefined,
        action: "drop",
        message: "a subscription's version range belongs in the entry's own 'range' field.",
        instead: (ref) => `'${shortKey(ref).toLowerCase()}': { range: '${rangeOf(ref)}' }`,
      },
      ...sharedStoredRules(),
    ];
  }
}

/** A key sous stored: the lockfile, the index and the store. */
export class LockfilePruner extends RuleRefPruner {
  readonly source = RefSource.Lockfile;
  readonly place = SOURCE_LABELS[RefSource.Lockfile];

  protected rules(): RefPruneRule[] {
    return [
      {
        matches: hasLocation,
        action: "drop",
        message: "a stored key never names a location.",
        instead: "'namespace/recipe'",
      },
      {
        matches: (ref) => !isStoredKind(ref),
        action: "drop",
        message: KEBAB_REASON,
        instead: "'namespace/recipe'",
      },
      {
        matches: hasRepoName,
        action: "drop",
        message: "a stored key never names a repository.",
        instead: (ref) => `'${shortKey(ref).toLowerCase()}'`,
      },
      {
        matches: (ref) => ref.glob === true,
        action: "drop",
        message: "a glob pattern is not a stored key; names here must be kebab-case.",
        instead: (ref) => `'${shortKey(ref).toLowerCase()}'`,
      },
      {
        matches: (ref) => rangeOf(ref) !== undefined,
        action: "drop",
        message: "a stored key carries no version range.",
        instead: (ref) => `'${shortKey(ref).toLowerCase()}'`,
      },
      ...sharedStoredRules(),
    ];
  }
}

/** The rules a config key and a stored key share, after their own. */
function sharedStoredRules(): RefPruneRule[] {
  return [
    {
      matches: (ref) => ref.kind === "namespace" && ref.wildcard === true,
      action: "drop",
      message: "a whole namespace is stored as its name alone.",
      instead: (ref) => `'${shortKey(ref).toLowerCase()}'`,
    },
    {
      matches: (ref) => ref.vars !== undefined,
      action: "drop",
      message: "a stored key carries no query values.",
      instead: (ref) => `'${shortKey(ref).toLowerCase()}'`,
    },
    {
      matches: (ref) => shortKey(ref) !== shortKey(ref).toLowerCase(),
      action: "drop",
      message: "stored names are lowercase.",
      instead: (ref) => `'${shortKey(ref).toLowerCase()}'`,
    },
  ];
}

makeInjectable(ConfigPruner);

makeInjectable(LockfilePruner);
