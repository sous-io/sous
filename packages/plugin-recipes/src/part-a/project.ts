/**
 * Reading the project's repositories and subscriptions from the built config, and writing the
 * managed `conf.d/500` and `conf.d/510` files key by key.
 *
 * Sous always reads the merged config (S2, "Sous always reads the built config"): no code here
 * re-reads a managed file to learn what is subscribed. A managed file is read only to know whether
 * sous wrote an entry, and so may remove it.
 */

import type { BuiltConfig, ConfigReader } from "@sous-io/plugin-api";
import type { ConfdManaged, ManagedEditResult } from "@sous-io/plugin-confd/types";
import type { RepoEntry, SubscriptionEntry } from "../types.js";
import { withoutDisabled } from "./defaults.js";
import { entryMap } from "./util.js";

/** The managed file of repositories. */
export const REPOS_LAYER = "500-repos.jsonc";

/** The managed file of subscriptions. */
export const SUBSCRIPTIONS_LAYER = "510-subscriptions.jsonc";

const REPOS_HEADER = [
    "The recipe repositories this project trusts, written by `sous repo add`.",
    "Sous edits this file key by key; your own edits outside the keys it touches are kept.",
];

const SUBSCRIPTIONS_HEADER = [
    "What this project subscribes to, written by `sous subscription add`.",
    "Sous edits this file key by key; your own edits outside the keys it touches are kept.",
];

/** Every repository the config names, switched-off ones included. */
export function configuredRepos(config: ConfigReader): Record<string, RepoEntry> {
    return entryMap<RepoEntry>(config.get("repos"));
}

/** Every repository the project trusts: those not switched off. */
export function trustedRepos(config: ConfigReader): Record<string, RepoEntry> {
    return withoutDisabled<RepoEntry>(config.get("repos"));
}

/** Every subscription the config declares, switched-off ones included. */
export function configuredSubscriptions(config: ConfigReader): Record<string, SubscriptionEntry> {
    return entryMap<SubscriptionEntry>(config.get("subscriptions"));
}

/** Every subscription switched on on this machine. */
export function enabledSubscriptions(config: ConfigReader): Record<string, SubscriptionEntry> {
    return withoutDisabled<SubscriptionEntry>(config.get("subscriptions"));
}

/**
 * The file that last set a value, as a person names it (`conf.d/610-mac.jsonc`), or the contributor
 * when it is not a file.
 */
export function setBy(config: BuiltConfig, path: readonly string[]): string | undefined {
    const layers = config.layers([...path]);
    const last = layers[layers.length - 1];

    return last === undefined ? undefined : contributorLabel(last.contributor);
}

/** A contributor id as a person reads it: `confd/610-mac.jsonc` → `conf.d/610-mac.jsonc`. */
export function contributorLabel(contributor: string): string {
    return contributor.startsWith("confd/") ? `conf.d/${contributor.slice("confd/".length)}` : contributor;
}

/** The contributor that applies a managed file. */
export function managedContributor(file: string): string {
    return `confd/${file}`;
}

/** The managed file's entries under one top-level key, as written. */
export async function managedEntries<T>(managed: ConfdManaged, file: string, key: string): Promise<Record<string, T>> {
    const data = await managed.read(file);

    return entryMap<T>(data?.[key]);
}

/** Writes one repository entry whole into `conf.d/500-repos.jsonc`. */
export function writeRepoEntry(managed: ConfdManaged, name: string, entry: RepoEntry | { enabled: false }, dryRun = false): Promise<ManagedEditResult> {
    return managed.edit(REPOS_LAYER, (root) => root.atPath(["repos", name]).set(entry), { description: REPOS_HEADER, dryRun });
}

/** Deletes one repository entry from `conf.d/500-repos.jsonc`. */
export function deleteRepoEntry(managed: ConfdManaged, name: string, dryRun = false): Promise<ManagedEditResult> {
    return managed.edit(REPOS_LAYER, (root) => root.atPath(["repos", name]).delete(), { description: REPOS_HEADER, dryRun });
}

/** Writes one subscription entry whole into `conf.d/510-subscriptions.jsonc`. */
export function writeSubscriptionEntry(managed: ConfdManaged, key: string, entry: SubscriptionEntry, dryRun = false): Promise<ManagedEditResult> {
    return managed.edit(SUBSCRIPTIONS_LAYER, (root) => root.atPath(["subscriptions", key]).set(entry), {
        description: SUBSCRIPTIONS_HEADER,
        dryRun,
    });
}

/** Deletes one subscription entry from `conf.d/510-subscriptions.jsonc`. */
export function deleteSubscriptionEntry(managed: ConfdManaged, key: string, dryRun = false): Promise<ManagedEditResult> {
    return managed.edit(SUBSCRIPTIONS_LAYER, (root) => root.atPath(["subscriptions", key]).delete(), {
        description: SUBSCRIPTIONS_HEADER,
        dryRun,
    });
}

/** Overwrites only `enabled` of one subscription, keeping every other field (S2). */
export function setSubscriptionEnabled(managed: ConfdManaged, key: string, enabled: boolean, dryRun = false): Promise<ManagedEditResult> {
    return managed.edit(SUBSCRIPTIONS_LAYER, (root) => root.atPath(["subscriptions", key, "enabled"]).set(enabled), {
        description: SUBSCRIPTIONS_HEADER,
        dryRun,
    });
}
