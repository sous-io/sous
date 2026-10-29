/**
 * The changelog `repo submit` writes under a proposal's description: what merging it does to the
 * people who subscribe to the repository. Recipes that appear, disappear or change version, recipes
 * whose files changed without a version raise, namespaces that come and go, and variables that
 * change. All of it is read from the manifests: the change's, compared with the default branch's.
 *
 * The changelog explains; it never refuses.
 */

import path from "node:path";
import type { RecipeManifest, RepoManifest, VariableDefinition } from "@sous-io/plugin-formats/types";
import type { AuthoringTools } from "../tools.js";
import type { RepoGit } from "../shared/git.js";
import { MANIFEST_EXTENSIONS, type RepoValidation } from "../shared/repository.js";
import { pathsInside } from "../release/submissions.js";

/** The manifests as they stood at one commit. */
export interface ManifestSnapshot {
    readonly repo: RepoManifest;
    /** Every readable recipe manifest, by key. */
    readonly recipes: Map<string, { path: string; manifest: RecipeManifest }>;
}

export interface RecipeEntry {
    readonly key: string;
    readonly version: string;
}

export interface VersionChange {
    readonly key: string;
    readonly from: string;
    readonly to: string;
}

/** One variable added, removed or changed. */
export interface VariableChange {
    readonly recipe: string;
    readonly name: string;
    readonly change: "added" | "removed" | "changed";
    readonly fields?: string[];
    /** A removal, or a tighter rule: usually breaks a subscriber. */
    readonly breaking: boolean;
}

/** Everything merging a change would do, as the manifests describe it. */
export interface Changelog {
    readonly baseBranch: string;
    /** False when there was nothing to compare with; every list is then empty. */
    readonly compared: boolean;
    namespacesAdded: string[];
    namespacesRemoved: string[];
    readonly recipesAdded: RecipeEntry[];
    readonly recipesRemoved: RecipeEntry[];
    readonly versionChanges: VersionChange[];
    readonly unraised: RecipeEntry[];
    readonly variables: VariableChange[];
}

/** The repository manifest's and every recipe manifest's base names. */
const REPO_BASENAME = "sous.repo";
const RECIPE_BASENAME = "sous.recipe";

/**
 * The manifests at one commit, or `undefined` when it holds no readable repository manifest. A
 * recipe manifest that cannot be read is left out.
 */
export async function readManifestsAt(tools: AuthoringTools, git: RepoGit, commit: string): Promise<ManifestSnapshot | undefined> {
    const repoRaw = await readManifestAt(tools, git, commit, "", REPO_BASENAME);

    if (repoRaw === undefined) {
        return undefined;
    }

    let repo: RepoManifest;

    try {
        repo = tools.repoManifest.parse(repoRaw.value, `${repoRaw.file} at ${commit.slice(0, 12)}`);
    } catch {
        return undefined;
    }

    const recipes = new Map<string, { path: string; manifest: RecipeManifest }>();

    for (const recipePath of repo.recipes) {
        const raw = await readManifestAt(tools, git, commit, recipePath, RECIPE_BASENAME);

        if (raw === undefined) {
            continue;
        }

        try {
            const manifest = tools.recipeManifest.parse(raw.value, `${raw.file} at ${commit.slice(0, 12)}`);

            recipes.set(`${manifest.namespace}/${manifest.name}`, { path: recipePath, manifest });
        } catch {
            continue;
        }
    }

    return { repo, recipes };
}

/** The working tree's manifests, in the same shape. */
export function snapshotOf(validation: RepoValidation): ManifestSnapshot {
    const recipes = new Map<string, { path: string; manifest: RecipeManifest }>();

    for (const recipe of validation.recipes) {
        recipes.set(recipe.key, { path: recipe.path, manifest: recipe.manifest });
    }

    return { repo: validation.manifest, recipes };
}

/** Compares the manifests a change carries with the default branch's. */
export function buildChangelog(input: {
    baseBranch: string;
    base: ManifestSnapshot | undefined;
    head: ManifestSnapshot;
    changedPaths: readonly string[];
}): Changelog {
    const { baseBranch, base, head, changedPaths } = input;
    const changelog: Changelog = {
        baseBranch,
        compared: base !== undefined,
        namespacesAdded: [],
        namespacesRemoved: [],
        recipesAdded: [],
        recipesRemoved: [],
        versionChanges: [],
        unraised: [],
        variables: [],
    };

    if (base === undefined) {
        return changelog;
    }

    const baseNamespaces = Object.keys(base.repo.namespaces);
    const headNamespaces = Object.keys(head.repo.namespaces);

    changelog.namespacesAdded = headNamespaces.filter((name) => !baseNamespaces.includes(name)).sort();
    changelog.namespacesRemoved = baseNamespaces.filter((name) => !headNamespaces.includes(name)).sort();

    for (const [key, entry] of sortedEntries(head.recipes)) {
        const before = base.recipes.get(key);

        if (before === undefined) {
            changelog.recipesAdded.push({ key, version: entry.manifest.version });
            continue;
        }

        const from = before.manifest.version;
        const to = entry.manifest.version;

        if (from !== to) {
            changelog.versionChanges.push({ key, from, to });
        } else if (pathsInside(entry.path, changedPaths).length > 0) {
            changelog.unraised.push({ key, version: to });
        }

        changelog.variables.push(...compareVariables(key, before.manifest.variables ?? [], entry.manifest.variables ?? []));
    }

    for (const [key, entry] of sortedEntries(base.recipes)) {
        if (!head.recipes.has(key)) {
            changelog.recipesRemoved.push({ key, version: entry.manifest.version });
        }
    }

    return changelog;
}

/** True when merging changes nothing the manifests describe. */
export function changelogIsEmpty(changelog: Changelog): boolean {
    return (
        changelog.namespacesAdded.length === 0 &&
        changelog.namespacesRemoved.length === 0 &&
        changelog.recipesAdded.length === 0 &&
        changelog.recipesRemoved.length === 0 &&
        changelog.versionChanges.length === 0 &&
        changelog.unraised.length === 0 &&
        changelog.variables.length === 0
    );
}

/** The warning for a change without a version raise: a fact, never a refusal. */
export const UNRAISED_VERSION_WARNING =
    "A recipe listed above changed without raising its version. A release run with `--ci`, as the workflow " +
    "`sous repo init` scaffolds runs it after a merge, refuses a changed recipe whose version was not raised, so its " +
    "version has to be raised in its manifest before that release can publish it.";

/** The warning for a breaking variable change. */
export const BREAKING_VARIABLE_WARNING =
    "Removing a variable or tightening its validation is usually a major change: a subscriber's stored answer may no " +
    "longer be read, or no longer be accepted.";

/** The changelog as Markdown, as it goes under a proposal and into a commit message. */
export function renderChangelog(changelog: Changelog): string {
    const lines = ["## What merging this changes", ""];

    if (!changelog.compared) {
        lines.push(
            `Sous could not compare this change with the branch '${changelog.baseBranch}', because this checkout holds ` +
                "no copy of it, so no changelog was generated.",
        );

        return lines.join("\n");
    }

    lines.push(
        `Generated by \`sous repo submit\` from the manifests this change carries, compared with the branch '${changelog.baseBranch}'.`,
    );

    if (changelogIsEmpty(changelog)) {
        lines.push("", "Merging changes no recipe, namespace, version or variable.");

        return lines.join("\n");
    }

    const section = (title: string, entries: string[]) => {
        if (entries.length > 0) {
            lines.push("", `**${title}**`, "", ...entries.map((entry) => `- ${entry}`));
        }
    };

    section(
        "Recipes added",
        changelog.recipesAdded.map((entry) => `\`${entry.key}\`, at version ${entry.version}`),
    );
    section(
        "Recipes retired",
        changelog.recipesRemoved.map((entry) => `\`${entry.key}\`, last at version ${entry.version}`),
    );
    section(
        "Version changes",
        changelog.versionChanges.map((entry) => `\`${entry.key}\`: ${entry.from} becomes ${entry.to}`),
    );
    section(
        "Changed without a version raise",
        changelog.unraised.map((entry) => `\`${entry.key}\`: its files changed and its version is still ${entry.version}`),
    );

    if (changelog.unraised.length > 0) {
        lines.push("", `**Warning:** ${UNRAISED_VERSION_WARNING}`);
    }

    section(
        "Namespaces added",
        changelog.namespacesAdded.map((name) => `\`${name}\``),
    );
    section(
        "Namespaces removed",
        changelog.namespacesRemoved.map((name) => `\`${name}\``),
    );
    section("Variables", changelog.variables.map(describeVariableChange));

    if (changelog.variables.some((entry) => entry.breaking)) {
        lines.push("", `**Warning:** ${BREAKING_VARIABLE_WARNING}`);
    }

    return lines.join("\n");
}

/** A proposal's body: the contributor's description, then the changelog. */
export function composeProposalBody(description: string, changelog: Changelog): string {
    return `${description.trim()}\n\n${renderChangelog(changelog)}\n`;
}

/** The message `--commit` commits with: title, description, changelog. */
export function commitMessage(title: string, description: string, changelog: Changelog): string {
    return `${title}\n\n${description}\n\n${renderChangelog(changelog)}\n`;
}

/** Compares one recipe's variable definitions before and after a change. */
export function compareVariables(recipe: string, before: readonly VariableDefinition[], after: readonly VariableDefinition[]): VariableChange[] {
    const changes: VariableChange[] = [];
    const beforeByName = new Map(before.map((definition) => [definition.name, definition]));
    const afterNames = new Set(after.map((definition) => definition.name));

    for (const definition of after) {
        const previous = beforeByName.get(definition.name);

        if (previous === undefined) {
            changes.push({ recipe, name: definition.name, change: "added", breaking: false });
            continue;
        }

        const fields = changedFields(previous, definition);

        if (fields.length > 0) {
            changes.push({ recipe, name: definition.name, change: "changed", fields, breaking: isTightened(previous, definition) });
        }
    }

    for (const definition of before) {
        if (!afterNames.has(definition.name)) {
            changes.push({ recipe, name: definition.name, change: "removed", breaking: true });
        }
    }

    return changes;
}

/**
 * Whether a changed definition accepts less than it did: a different type, a newly required answer,
 * or a rule that rejects something the old one accepted. A changed pattern counts.
 */
export function isTightened(before: VariableDefinition, after: VariableDefinition): boolean {
    if (before.type !== after.type || (!before.required && after.required)) {
        return true;
    }

    const was = before.validate ?? {};
    const now = after.validate ?? {};

    if (now.pattern !== undefined && now.pattern !== was.pattern) {
        return true;
    }

    if (raised(was.minLength, now.minLength) || lowered(was.maxLength, now.maxLength) || raised(was.min, now.min) || lowered(was.max, now.max)) {
        return true;
    }

    if (now.enum !== undefined) {
        return was.enum === undefined || was.enum.some((option) => !now.enum!.includes(option));
    }

    return false;
}

function raised(was: number | undefined, now: number | undefined): boolean {
    return now !== undefined && (was === undefined || now > was);
}

function lowered(was: number | undefined, now: number | undefined): boolean {
    return now !== undefined && (was === undefined || now < was);
}

function changedFields(before: VariableDefinition, after: VariableDefinition): string[] {
    const was = before as unknown as Record<string, unknown>;
    const now = after as unknown as Record<string, unknown>;
    const keys = new Set([...Object.keys(was), ...Object.keys(now)]);

    return [...keys].sort().filter((key) => JSON.stringify(was[key]) !== JSON.stringify(now[key]));
}

function describeVariableChange(entry: VariableChange): string {
    const subject = `\`${entry.recipe}\`: the variable \`${entry.name}\``;

    if (entry.change === "added") {
        return `${subject} was added`;
    }

    if (entry.change === "removed") {
        return `${subject} was removed (usually a major change)`;
    }

    const fields = (entry.fields ?? []).map((field) => `\`${field}\``).join(", ");

    return `${subject} changed its ${fields}${entry.breaking ? " and now accepts less than before (usually a major change)" : ""}`;
}

/** One manifest at a commit, trying each file name in turn. */
async function readManifestAt(
    tools: AuthoringTools,
    git: RepoGit,
    commit: string,
    folder: string,
    basename: string,
): Promise<{ file: string; value: unknown } | undefined> {
    for (const extension of MANIFEST_EXTENSIONS) {
        const file = folder.length === 0 ? `${basename}${extension}` : path.posix.join(folder, `${basename}${extension}`);
        const text = await git.readFileAt(commit, file);

        if (text === undefined) {
            continue;
        }

        try {
            return { file, value: tools.manifests.parseText(text, file) };
        } catch {
            return undefined;
        }
    }

    return undefined;
}

function sortedEntries<T>(map: Map<string, T>): Array<[string, T]> {
    return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
