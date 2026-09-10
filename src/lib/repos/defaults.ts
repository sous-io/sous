/**
 * The repository and subscription every project gets without asking.
 *
 * Sous ships one namespace, `core`, holding the skills that teach an agent what
 * sous is and how it works. Every project is subscribed to it, because an agent
 * that does not know sous manages a file will happily hand-edit it. The wiring
 * is deliberately ordinary: sous adds the same two config entries a person could
 * have written by hand, so they can be inspected with `sous config show` and
 * overridden or switched off in the config like anything else.
 *
 *   - The repository `sous-recipes`, pointing at the official public repository.
 *     Trust is not a question here: sous itself ships the recipe, pins the
 *     version to its own, and seeds it from the package, so trusting it adds
 *     nothing a person did not already accept by installing sous.
 *   - The subscription `core`, a whole-namespace subscription whose range is
 *     exactly the running sous version. Core therefore always matches the CLI,
 *     and upgrading sous upgrades core with it.
 *
 * Two ways out, both plain config:
 *
 *     subscriptions: { core: { enabled: false } }      // keep the repo, drop the skills
 *     repos: { "sous-recipes": { enabled: false } }    // drop the repository entirely
 *
 * A user-written entry under either key REPLACES the default outright, because
 * the defaults are applied underneath whatever the config layers produced. That
 * is what lets a project pin core to a different range, point the repository at
 * a mirror, or turn either off.
 */

import type { RepoEntry, Settings, SubscriptionEntry } from "../settings.js";
import { SOUS_VERSION } from "../package-info.js";
import {
  CORE_NAMESPACE,
  OFFICIAL_REPO_NAME,
  OFFICIAL_REPO_PROVIDER,
  OFFICIAL_REPO_URL,
} from "./core-recipe.js";

/**
 * The `addedBy` value on an entry sous provides itself. It is what tells
 * `sous repo list` to print "built in" rather than a date, and it is why these
 * entries are never written to a managed layer: they are recreated on every run
 * from the installed package.
 */
export const BUILT_IN_ADDED_BY = "sous";

/** The built-in repository entry, exactly as a person could have written it. */
export function builtInRepoEntry(): RepoEntry {
  return {
    url: OFFICIAL_REPO_URL,
    provider: OFFICIAL_REPO_PROVIDER,
    addedBy: BUILT_IN_ADDED_BY,
  };
}

/**
 * The built-in `core` subscription. Its range is the exact running version, not
 * a caret range: core is published in lockstep with the CLI and is meant to
 * match it exactly.
 *
 * @param version - The running sous version. Defaults to this installation's.
 */
export function builtInCoreSubscription(version: string = SOUS_VERSION): SubscriptionEntry {
  return { range: version, addedBy: BUILT_IN_ADDED_BY };
}

/**
 * Adds the built-in repository and subscription to a merged config, underneath
 * anything the config layers already said.
 *
 * The core subscription is added only when the built-in repository survives: a
 * project that switched the repository off would otherwise be left subscribed to
 * a namespace nothing can resolve.
 *
 * @param settings - The merged, validated config.
 * @param version - The running sous version. Defaults to this installation's.
 */
export function applyRepoDefaults(
  settings: Settings,
  version: string = SOUS_VERSION
): Settings {
  // Anything that is not a map of entries is left exactly as written, so schema
  // validation reports the real mistake rather than a symptom of this merge.
  if (!isEntryMap(settings.repos) || !isEntryMap(settings.subscriptions)) return settings;

  const repos: Record<string, RepoEntry> = {
    ...settings.repos,
    [OFFICIAL_REPO_NAME]: mergeOverDefault(
      builtInRepoEntry(),
      settings.repos?.[OFFICIAL_REPO_NAME]
    ),
  };

  const withRepos: Settings = { ...settings, repos };
  if (repos[OFFICIAL_REPO_NAME]?.enabled === false) return withRepos;

  return {
    ...withRepos,
    subscriptions: {
      ...settings.subscriptions,
      [CORE_NAMESPACE]: mergeOverDefault(
        builtInCoreSubscription(version),
        settings.subscriptions?.[CORE_NAMESPACE]
      ),
    },
  };
}

/**
 * Lays what a project wrote over the entry sous provides.
 *
 * The merge is per field, not per entry, which is the whole point: the shortest
 * possible opt-out, `{ enabled: false }`, is a complete entry once the built-in
 * URL and provider are underneath it. A project that wants to repoint the
 * repository writes a `url` and that field alone changes.
 *
 * @param fallback - The entry sous provides.
 * @param written - What the project's config layers produced, when anything did.
 */
function mergeOverDefault<T extends object>(fallback: T, written: T | undefined): T {
  if (written === undefined || typeof written !== "object" || Array.isArray(written)) {
    return fallback;
  }
  return { ...fallback, ...written };
}

/** True when a config value is absent or is a plain map of entries. */
function isEntryMap(value: unknown): boolean {
  return value === undefined || (typeof value === "object" && value !== null && !Array.isArray(value));
}

/**
 * True when an entry is one sous provided rather than one the project wrote.
 *
 * @param entry - A repository or subscription entry.
 */
export function isBuiltInEntry(entry: { addedBy?: string } | undefined): boolean {
  return entry?.addedBy === BUILT_IN_ADDED_BY;
}

/**
 * The repositories a project actually uses: everything in the config except the
 * entries switched off with `enabled: false`. A switched-off entry stays in the
 * config, and stays visible to `sous config show`, so the opt-out is legible;
 * it simply takes no part in resolving, fetching or trusting anything.
 *
 * @param settings - The merged config.
 */
export function enabledRepos(settings: Settings | undefined): Record<string, RepoEntry> {
  return withoutDisabled(settings?.repos);
}

/**
 * The subscriptions a project actually has, on the same terms as
 * `enabledRepos`.
 *
 * @param settings - The merged config.
 */
export function enabledSubscriptions(
  settings: Settings | undefined
): Record<string, SubscriptionEntry> {
  return withoutDisabled(settings?.subscriptions);
}

/** Drops every entry whose `enabled` field says false. */
function withoutDisabled<T extends { enabled?: boolean }>(
  entries: Record<string, T> | undefined
): Record<string, T> {
  const kept: Record<string, T> = {};
  for (const [key, entry] of Object.entries(entries ?? {})) {
    if (entry?.enabled === false) continue;
    kept[key] = entry;
  }
  return kept;
}
