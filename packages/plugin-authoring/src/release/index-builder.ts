/**
 * Regenerating a repository's `sous.index.json` from what it actually publishes. Three rules:
 *
 * 1. A published version never changes. An entry already in the index with a tag keeps the hash and
 *    dependencies it was published with; disagreement is an error, never written over.
 * 2. A version is published when a tag carries it, and every version the index records needs one —
 *    except the version a manifest declares right now, whose tag the release is about to cut on the
 *    very commit that carries this index.
 * 3. The tags are the backstop. A tagged version missing from the index is rebuilt from its tree, so
 *    deleting the index and regenerating it restores the same catalog.
 *
 * Each new version also records what it was released against (its dependencies resolved to exact
 * versions), how each was declared, and the variables it publishes. Those are frozen with the entry.
 */

import fs from "node:fs";
import path from "node:path";
import semver from "semver";
import type { DependencyKind, IndexDependency, IndexFile, IndexRecipe, IndexVersion } from "@sous-io/plugin-formats/types";
import type { ReleaseProblem } from "../types.js";
import type { AuthoringTools } from "../tools.js";
import type { RepoGit } from "../shared/git.js";
import { describeError } from "../shared/problems.js";
import {
    declarationFor,
    foldDeclaration,
    isNamedRef,
    keyOf,
    locationOf,
    rangeOf,
    readingsOf,
    type CoveringEntry,
    type GatheredDeclaration,
} from "../shared/refs.js";
import { INDEX_FILE, toPosix, validateRepo, type RepoValidation, type ValidatedRecipe } from "../shared/repository.js";
import type { SettledDependency } from "./settle.js";
import { groupTagsByKey, listRecipeTags, recipeTagKey, tagFor, type RecipeTag } from "./tags.js";

/** A version ready to publish with no tag yet. */
export interface PendingRelease {
    readonly key: string;
    readonly path: string;
    readonly version: string;
    readonly tag: string;
    readonly hash: string;
}

/** What one regeneration produced. */
export interface IndexBuildResult {
    readonly index: IndexFile;
    /** The index exactly as it would be written. */
    readonly text: string;
    /** True when the committed index differs from the regenerated one. */
    readonly stale: boolean;
    readonly pending: PendingRelease[];
    readonly problems: ReleaseProblem[];
    readonly tags: RecipeTag[];
}

/** What `buildIndex` needs. */
export interface BuildIndexOptions {
    readonly validation: RepoValidation;
    /** The committed index, when there is a readable one. */
    readonly existing?: IndexFile;
    /** Recorded as the generator. */
    readonly sousVersion: string;
    /** Default now. */
    readonly now?: Date;
    readonly tags?: RecipeTag[];
    /** The versions this run is about to publish, keyed `namespace/recipe`. Their tags do not exist yet. */
    readonly publishing?: Record<string, string>;
    /** The dependencies settled from several readings, keyed by the dependency as written. */
    readonly settled?: Map<string, SettledDependency>;
}

/** The index file's path in a repository. */
export function indexFilePath(rootDir: string): string {
    return path.join(rootDir, INDEX_FILE);
}

/**
 * Reads and checks the committed index, or `undefined` when there is none. A file present but
 * unreadable throws; the caller decides whether to fail or regenerate.
 */
export function readIndexFile(tools: AuthoringTools, rootDir: string): IndexFile | undefined {
    const filePath = indexFilePath(rootDir);

    if (!fs.existsSync(filePath)) {
        return undefined;
    }

    return tools.indexFile.parse(JSON.parse(fs.readFileSync(filePath, "utf8")), filePath);
}

/** Regenerates a repository's index from its manifests and its tags. */
export async function buildIndex(tools: AuthoringTools, git: RepoGit, options: BuildIndexOptions): Promise<IndexBuildResult> {
    const { validation, existing, sousVersion } = options;
    const rootDir = validation.rootDir;
    const now = options.now ?? new Date();
    const tags = options.tags ?? (await listRecipeTags(git));
    const tagsByKey = groupTagsByKey(tags);
    const problems: ReleaseProblem[] = [];
    const pending: PendingRelease[] = [];
    const namespaces: IndexFile["namespaces"] = {};

    for (const [name, declaration] of Object.entries(validation.manifest.namespaces)) {
        namespaces[name] = declaration.description === undefined ? {} : { description: declaration.description };
    }

    const recipes: IndexFile["recipes"] = {};
    const publishing = options.publishing ?? {};
    const current = siblingState(validation, tagsByKey, existing, publishing);

    for (const recipe of validation.recipes) {
        if (!Object.hasOwn(namespaces, recipe.manifest.namespace)) {
            continue;
        }

        const key = recipe.key;
        const existingVersions = existing?.recipes[key]?.versions ?? {};
        const versions: Record<string, IndexVersion> = { ...existingVersions };
        const recipeTags = tagsByKey.get(key) ?? [];
        const manifestName = path.basename(recipe.manifestPath);

        // Rule 3: every tagged version belongs in the index, resolved against the repository as it
        // stood at the tag.
        for (const tag of recipeTags) {
            if (Object.hasOwn(versions, tag.version)) {
                continue;
            }

            const rebuilt = await rebuildTaggedVersion(tools, git, tag, recipe, tagsByKey, existing, options.settled);

            problems.push(...rebuilt.problems);
            versions[tag.version] = {
                hash: rebuilt.hash as IndexVersion["hash"],
                tag: tag.tag,
                prerelease: semver.prerelease(tag.version) !== null,
                ...(await releasedAtOf(git, tag.tag)),
                ...rebuilt.description,
            };
        }

        const version = recipe.manifest.version;
        const tagName = tagFor(recipe.manifest.namespace, recipe.manifest.name, version);
        const hasTag = recipeTags.some((entry) => entry.tag === tagName);
        const workingHash = await tools.hash.hashDirectory(recipe.dir);
        const where = relativeTo(rootDir, recipe.manifestPath);
        const declared = declaredDependencies(tools, recipe, validation, options.settled);

        // History with a missing tag is a published version nothing can fetch.
        for (const [known, published] of Object.entries(existingVersions)) {
            if (known === version || recipeTags.some((entry) => entry.version === known)) {
                continue;
            }

            problems.push({
                level: "error",
                recipe: key,
                where: `${INDEX_FILE} recipes['${key}'].versions['${known}']`,
                message:
                    `the index publishes version ${known}, but the tag '${published.tag}' does not exist in this ` +
                    `repository. A missing tag must never hide a published version; restore the tag, or remove the ` +
                    `version from the index.`,
            });
        }

        if (hasTag) {
            problems.push(...(await checkTaggedMetadata(tools, git, tagName, recipe.path, manifestName, version, where, key)));

            const taggedHash = await git.withTree(tagName, recipe.path, (dir) => tools.hash.hashDirectory(dir));
            const published = existingVersions[version];
            const sameFiles = tools.hash.equal(taggedHash, workingHash);

            if (published !== undefined && !tools.hash.equal(published.hash, taggedHash)) {
                problems.push({
                    level: "error",
                    recipe: key,
                    where: `${INDEX_FILE} recipes['${key}'].versions['${version}']`,
                    message:
                        `the index records a different content hash from the one the tag '${tagName}' now carries. A ` +
                        `published version never changes, so either the tag was moved or the index was edited; restore ` +
                        `whichever is wrong before releasing again.`,
                });
            } else if (published !== undefined) {
                // Carried forward as it stands; only a missing release date is filled in.
                if (published.releasedAt === undefined) {
                    versions[version] = { ...published, ...(await releasedAtOf(git, tagName)) };
                }

                // An entry with no dependencies at all was published before sous recorded them.
                if (sameFiles && published.dependencies !== undefined) {
                    problems.push(...checkRecordedDependencies(key, version, published.dependencies, declared));
                }

                if (sameFiles) {
                    problems.push(...checkRecordedLists(key, version, published, recipe));
                }
            }

            if (!sameFiles) {
                // A scoped release leaves unpublished changes in recipes it is not publishing.
                const publishingThis = options.publishing === undefined || Object.hasOwn(publishing, key);

                problems.push({
                    level: publishingThis ? "error" : "warning",
                    recipe: key,
                    where,
                    message: publishingThis
                        ? `version ${version} was already published as the tag '${tagName}', and the files in this folder ` +
                          `no longer match what that tag carries. A published version never changes: bump the version in ` +
                          `this manifest, or with 'sous repo release --bump patch'.`
                        : `version ${version} is published as the tag '${tagName}', and this folder has changed since. Those ` +
                          `changes are outside this release, so they stay unpublished; release '${key}' to publish them.`,
                });
            }
        } else {
            // No tag yet: one this run is about to cut, or one a release commit recorded and CI will tag.
            const published = existingVersions[version];

            if (options.publishing?.[key] === version || published !== undefined) {
                versions[version] = {
                    hash: workingHash,
                    tag: tagName,
                    prerelease: semver.prerelease(version) !== null,
                    releasedAt: published?.releasedAt ?? now.toISOString(),
                    ...describeVersion(recipe, declared, current),
                };
            }

            pending.push({ key, path: recipe.path, version, tag: tagName, hash: workingHash });
        }

        if (Object.keys(versions).length > 0) {
            const entry: IndexRecipe = { path: recipe.path, versions };

            if (recipe.manifest.description !== undefined) {
                entry.description = recipe.manifest.description;
            }

            recipes[key] = entry;
        }
    }

    problems.push(...checkOrphanTags(validation, tags));

    const index: IndexFile = {
        formatVersion: 1,
        name: validation.manifest.name,
        generatedAt: now.toISOString(),
        generator: sousVersion,
        namespaces,
        recipes,
    };

    // The stamp changes every run, so it changes the file only when something else did too.
    if (existing !== undefined && sameExceptStamp(tools, existing, index)) {
        index.generatedAt = existing.generatedAt;
    }

    const text = tools.indexFile.stringify(index);
    const stale = existing === undefined || tools.indexFile.stringify(existing) !== text;

    return { index, text, stale, pending, problems, tags };
}

/** How a committed index differs from a regenerated one, in sentences an author can act on. */
export function describeIndexDrift(existing: IndexFile | undefined, rebuilt: IndexFile): string[] {
    if (existing === undefined) {
        return [`there is no ${INDEX_FILE} in this repository yet`];
    }

    const lines: string[] = [];

    if (existing.name !== rebuilt.name) {
        lines.push(`the index calls this repository '${existing.name}', and its manifest calls it '${rebuilt.name}'`);
    }

    if (existing.generator !== rebuilt.generator) {
        lines.push(`the index was generated by sous ${existing.generator}, and this is sous ${rebuilt.generator}`);
    }

    for (const name of Object.keys(rebuilt.namespaces)) {
        if (!Object.hasOwn(existing.namespaces, name)) {
            lines.push(`the namespace '${name}' is missing from the index`);
        }
    }

    for (const name of Object.keys(existing.namespaces)) {
        if (!Object.hasOwn(rebuilt.namespaces, name)) {
            lines.push(`the index still declares the namespace '${name}'`);
        }
    }

    for (const [key, recipe] of Object.entries(rebuilt.recipes)) {
        const before = existing.recipes[key];

        if (before === undefined) {
            lines.push(`the recipe '${key}' is missing from the index`);
            continue;
        }

        if (before.path !== recipe.path) {
            lines.push(`the recipe '${key}' is listed at '${before.path}' in the index and at '${recipe.path}' in the repository`);
        }

        if (before.description !== recipe.description) {
            lines.push(`the description of '${key}' has changed since the index was written`);
        }

        for (const version of Object.keys(recipe.versions)) {
            if (!Object.hasOwn(before.versions, version)) {
                lines.push(`version ${version} of '${key}' is missing from the index`);
            }
        }
    }

    for (const [key, recipe] of Object.entries(existing.recipes)) {
        const after = rebuilt.recipes[key];

        if (after === undefined) {
            lines.push(`the index still publishes '${key}', which this repository does not`);
            continue;
        }

        for (const version of Object.keys(recipe.versions)) {
            if (!Object.hasOwn(after.versions, version)) {
                lines.push(`the index still publishes version ${version} of '${key}'`);
            }
        }
    }

    if (lines.length === 0) {
        lines.push("the index differs from what this repository describes");
    }

    return lines;
}

// --- Dependencies ---------------------------------------------------------------------------

type DeclaredLocation =
    | { readonly where: "remote"; readonly repo: string; readonly range: string }
    | {
          readonly where: "sibling";
          readonly range?: string;
          /** True when the manifest names this recipe itself, not only its namespace. */
          readonly named: boolean;
      };

type DeclaredDependency = DeclaredLocation & { readonly declared: string; readonly kind: DependencyKind };

interface DeclaredDependencies {
    /** Keyed `namespace/recipe`; a later declaration wins. */
    readonly byKey: Map<string, DeclaredDependency>;
    /** The namespaces of this repository the manifest declares whole. */
    readonly namespaces: Set<string>;
}

interface SiblingState {
    /** The version each recipe is released at: what "released alongside me" means. */
    readonly settled: Map<string, string>;
    /** Every version each recipe publishes, for resolving a range. */
    readonly published: Map<string, string[]>;
}

/** The dependencies a manifest declares, a whole-namespace one expanded into its recipes. */
function declaredDependencies(
    tools: AuthoringTools,
    recipe: ValidatedRecipe,
    validation: RepoValidation,
    settled: Map<string, SettledDependency> = new Map(),
): DeclaredDependencies {
    const byKey = new Map<string, DeclaredLocation>();
    const namespaces = new Set<string>();
    const gathered = new Map<string, GatheredDeclaration>();
    const declared: ReadonlyArray<readonly [DependencyKind, string]> = [
        ...(recipe.manifest.depends ?? []).map((written) => ["depends", written] as const),
        ...(recipe.manifest.subscribes ?? []).map((written) => ["subscribes", written] as const),
    ];
    const cover = (key: string, entry: CoveringEntry): void => {
        gathered.set(key, foldDeclaration(gathered.get(key), entry));
    };
    const addSibling = (key: string, range: string | undefined, named: boolean): void => {
        const before = byKey.get(key);
        const namedBefore = before?.where === "sibling" && before.named;

        byKey.set(key, { where: "sibling", ...(range === undefined ? {} : { range }), named: named || namedBefore });
    };

    for (const [kind, written] of declared) {
        const answer = settled.get(written.trim());

        if (answer !== undefined) {
            for (const key of answer.keys) {
                byKey.set(key, { where: "remote", repo: answer.identity, range: answer.range ?? "*" });
                cover(key, { written, kind, named: answer.keys.length === 1 });
            }

            continue;
        }

        const readings = readingsOf(tools, written);
        const parsed = readings?.[0];

        // Several readings, or a browser path, are settled above or reported by settling.
        if (readings === undefined || readings.length !== 1 || parsed === undefined || !isNamedRef(parsed)) {
            continue;
        }

        const location = locationOf(tools, parsed);

        if (location !== undefined) {
            // A whole namespace elsewhere is read from that repository's own index by the consumer.
            if (parsed.kind === "recipe") {
                byKey.set(keyOf(tools, parsed), { where: "remote", repo: location.identity, range: rangeOf(tools, parsed) ?? "*" });
                cover(keyOf(tools, parsed), { written, kind, named: true });
            }

            continue;
        }

        if (parsed.kind === "recipe") {
            addSibling(keyOf(tools, parsed), rangeOf(tools, parsed), true);
            cover(keyOf(tools, parsed), { written, kind, named: true });
            continue;
        }

        namespaces.add(parsed.name);

        for (const entry of validation.recipes) {
            if (entry.manifest.namespace === parsed.name && entry.key !== recipe.key) {
                addSibling(entry.key, undefined, false);
                cover(entry.key, { written, kind, named: false });
            }
        }
    }

    const described = new Map<string, DeclaredDependency>();
    const source = { depends: recipe.manifest.depends ?? [], subscribes: recipe.manifest.subscribes ?? [] };
    // An entry settled from several readings is known only here; otherwise the owner says.
    const usesSettled = [...source.depends, ...source.subscribes].some((entry) => settled.has(entry.trim()));

    for (const [key, dependency] of byKey) {
        const fold = gathered.get(key)!;
        const how = (usesSettled ? undefined : declarationFor(tools, source, key, fold)) ?? fold;

        described.set(key, { ...dependency, declared: how.declared, kind: how.kind });
    }

    return { byKey: described, namespaces };
}

/**
 * What each recipe is published at for one resolution. A new version resolves against the repository
 * as it stands, counting this run's versions; a version rebuilt from its tag resolves against the
 * repository at that tag, counting only versions up to the declared one.
 */
function siblingState(
    validation: RepoValidation,
    tagsByKey: Map<string, RecipeTag[]>,
    existing: IndexFile | undefined,
    publishing?: Record<string, string>,
): SiblingState {
    const settled = new Map<string, string>();
    const published = new Map<string, string[]>();

    for (const recipe of validation.recipes) {
        const version = publishing?.[recipe.key] ?? recipe.manifest.version;

        settled.set(recipe.key, version);

        const known = new Set((tagsByKey.get(recipe.key) ?? []).map((tag) => tag.version));

        for (const other of Object.keys(existing?.recipes[recipe.key]?.versions ?? {})) {
            known.add(other);
        }

        known.add(version);

        const all = [...known];

        published.set(recipe.key, publishing === undefined ? all.filter((other) => semver.valid(other) !== null && semver.lte(other, version)) : all);
    }

    return { settled, published };
}

/**
 * A recipe's declared dependencies as the exact versions its entry publishes. A sibling with no range
 * is the version released alongside it; one with a range resolves against what this repository
 * publishes; one in another repository records that repository and the range.
 */
function resolveIndexDependencies(declared: DeclaredDependencies, siblings: SiblingState): Record<string, IndexDependency> {
    const resolved: Record<string, IndexDependency> = {};

    for (const [key, dependency] of declared.byKey) {
        const how = { declared: dependency.declared, kind: dependency.kind };

        if (dependency.where === "remote") {
            resolved[key] = { repo: dependency.repo, range: dependency.range, ...how };
            continue;
        }

        if (dependency.range === undefined) {
            const settled = siblings.settled.get(key);

            resolved[key] = { ...(settled === undefined ? { range: "*" } : { version: settled }), ...how };
            continue;
        }

        const best = semver.maxSatisfying(siblings.published.get(key) ?? [], dependency.range);

        resolved[key] = { ...(best === null ? { range: dependency.range } : { version: best }), ...how };
    }

    return resolved;
}

type VersionDescription = Pick<IndexVersion, "dependencies" | "depends" | "subscribes" | "variables">;

/** What a version records beyond its hash, tag and date; recorded even when empty. */
function describeVersion(recipe: ValidatedRecipe, declared: DeclaredDependencies, siblings: SiblingState): VersionDescription {
    return {
        dependencies: resolveIndexDependencies(declared, siblings),
        depends: (recipe.manifest.depends ?? []).map((written) => written.trim()),
        subscribes: (recipe.manifest.subscribes ?? []).map((written) => written.trim()),
        variables: recipe.manifest.variables ?? [],
    };
}

/** The lists the index records for a published version must still equal its manifest's. */
function checkRecordedLists(key: string, version: string, published: IndexVersion, recipe: ValidatedRecipe): ReleaseProblem[] {
    const differences: string[] = [];

    for (const list of ["depends", "subscribes"] as const) {
        const recorded = published[list];

        if (recorded === undefined) {
            continue;
        }

        const declared = (recipe.manifest[list] ?? []).map((written) => written.trim());

        if (JSON.stringify(recorded) !== JSON.stringify(declared)) {
            differences.push(`'${list}': the index records [${recorded.join(", ")}], and the manifest declares [${declared.join(", ")}]`);
        }
    }

    if (differences.length === 0) {
        return [];
    }

    return [
        {
            level: "error",
            recipe: key,
            where: `${INDEX_FILE} recipes['${key}'].versions['${version}']`,
            message:
                `version ${version} of '${key}' is already published, and the lists the index records for it disagree ` +
                `with its manifest:\n` +
                differences.map((line) => `    - ${line}\n`).join("") +
                `  A published version never changes. If the index was edited, restore the entry; to publish different ` +
                `lists, bump the version in this manifest, or with 'sous repo release --bump patch'.`,
        },
    ];
}

/**
 * The recorded dependencies of a published version must honour its manifest: every recipe named is
 * there, nothing undeclared is, a sibling sits inside its range, a remote one carries its repository
 * and range. They are frozen, so they are never compared with a fresh resolution.
 */
function checkRecordedDependencies(
    key: string,
    version: string,
    recorded: Record<string, IndexDependency> | undefined,
    declared: DeclaredDependencies,
): ReleaseProblem[] {
    const differences: string[] = [];
    const entries = recorded ?? {};

    for (const [name, dependency] of declared.byKey) {
        const entry = entries[name];

        if (entry === undefined) {
            if (dependency.where === "remote" || dependency.named) {
                differences.push(`'${name}': the manifest declares ${describeDeclared(dependency)}, and the index records nothing for it`);
            }

            continue;
        }

        if (!recordedSatisfies(entry, dependency)) {
            differences.push(`'${name}': the index records ${describeRecorded(entry)}, and the manifest declares ${describeDeclared(dependency)}`);
        }
    }

    for (const [name, entry] of Object.entries(entries)) {
        if (declared.byKey.has(name)) {
            continue;
        }

        // A recipe the declared namespace held at release time, and no longer does, is history.
        const namespace = name.slice(0, name.indexOf("/"));

        if (entry.repo === undefined && declared.namespaces.has(namespace)) {
            continue;
        }

        differences.push(`'${name}': the index records ${describeRecorded(entry)}, and the manifest does not declare it`);
    }

    if (differences.length === 0) {
        return [];
    }

    return [
        {
            level: "error",
            recipe: key,
            where: `${INDEX_FILE} recipes['${key}'].versions['${version}'].dependencies`,
            message:
                `version ${version} of '${key}' is already published, and the dependencies the index records for it ` +
                `disagree with what its manifest declares:\n` +
                differences.map((line) => `    - ${line}\n`).join("") +
                `  A published version never changes, so a release carries its dependencies forward exactly as they ` +
                `were published. If the index was edited, restore the entry. To publish different dependencies, bump the ` +
                `version in this manifest, or with 'sous repo release --bump patch'.`,
        },
    ];
}

function recordedSatisfies(entry: IndexDependency, dependency: DeclaredDependency): boolean {
    if (entry.declared !== undefined && entry.declared !== dependency.declared) {
        return false;
    }

    if (entry.kind !== undefined && entry.kind !== dependency.kind) {
        return false;
    }

    if (dependency.where === "remote") {
        return entry.repo === dependency.repo && entry.range === dependency.range && entry.version === undefined;
    }

    if (entry.repo !== undefined) {
        return false;
    }

    if (dependency.range === undefined) {
        return true;
    }

    if (entry.version !== undefined) {
        return semver.satisfies(entry.version, dependency.range);
    }

    return entry.range === dependency.range;
}

/** `build dependency`, `co-subscription`. */
export function describeDependencyKind(kind: DependencyKind | undefined): string {
    if (kind === "depends") {
        return "build dependency";
    }

    return kind === "subscribes" ? "co-subscription" : "not recorded";
}

function describeRecorded(entry: IndexDependency): string {
    const what = entry.version !== undefined ? `version ${entry.version}` : `the range '${entry.range}'`;
    const from = entry.repo === undefined ? what : `${what} from ${entry.repo}`;

    return entry.declared === undefined || entry.kind === undefined
        ? from
        : `${from}, through the entry '${entry.declared}' as a ${describeDependencyKind(entry.kind)}`;
}

function describeDeclared(dependency: DeclaredDependency): string {
    const how = `, through the entry '${dependency.declared}' as a ${describeDependencyKind(dependency.kind)}`;

    if (dependency.where === "remote") {
        return `the range '${dependency.range}' from ${dependency.repo}${how}`;
    }

    return dependency.range === undefined ? `it with no range${how}` : `the range '${dependency.range}'${how}`;
}

// --- Tags --------------------------------------------------------------------------------------

interface RebuiltVersion {
    readonly hash: string;
    readonly description: VersionDescription;
    readonly problems: ReleaseProblem[];
}

/** Rebuilds a tagged version the index lacks, from the tree its tag carries. */
async function rebuildTaggedVersion(
    tools: AuthoringTools,
    git: RepoGit,
    tag: RecipeTag,
    recipe: ValidatedRecipe,
    tagsByKey: Map<string, RecipeTag[]>,
    existing: IndexFile | undefined,
    settled?: Map<string, SettledDependency>,
): Promise<RebuiltVersion> {
    return git.withTree(tag.tag, ".", async (treeDir) => {
        const hash = await tools.hash.hashDirectory(path.join(treeDir, ...recipe.path.split("/")));
        let reason: string;

        try {
            const snapshot = await validateRepo(tools, treeDir);
            const tagged = snapshot.recipes.find((entry) => entry.key === recipe.key);

            if (tagged !== undefined) {
                const description = describeVersion(
                    tagged,
                    declaredDependencies(tools, tagged, snapshot, settled),
                    siblingState(snapshot, tagsByKey, existing),
                );

                return { hash, description, problems: [] };
            }

            reason = `The repository manifest at that tag does not list '${recipe.key}'.`;
        } catch (error) {
            reason = describeError(error);
        }

        return {
            hash,
            description: {},
            problems: [
                {
                    level: "warning",
                    recipe: recipe.key,
                    where: `${INDEX_FILE} recipes['${recipe.key}'].versions['${tag.version}']`,
                    message:
                        `version ${tag.version} was rebuilt from the tag '${tag.tag}' without its dependencies, because sous ` +
                        `could not read the recipe at that tag.\n  ${reason}`,
                },
            ],
        };
    });
}

async function releasedAtOf(git: RepoGit, tag: string): Promise<{ releasedAt?: string }> {
    const date = await git.commitDate(tag);

    return date === undefined ? {} : { releasedAt: date };
}

/** The manifest a tag carries must declare the version the tag names. */
async function checkTaggedMetadata(
    tools: AuthoringTools,
    git: RepoGit,
    tag: string,
    recipePath: string,
    manifestName: string,
    version: string,
    where: string,
    key: string,
): Promise<ReleaseProblem[]> {
    const file = `${recipePath}/${manifestName}`;
    const text = await git.readFileAt(tag, file);

    if (text === undefined) {
        return [
            {
                level: "error",
                recipe: key,
                where,
                message: `the tag '${tag}' does not carry a '${manifestName}' at '${recipePath}'. The tag and the recipe metadata must agree about what was published.`,
            },
        ];
    }

    let taggedVersion: string;

    try {
        taggedVersion = tools.recipeManifest.parse(tools.manifests.parseText(text, manifestName), `${tag}:${file}`).version;
    } catch (error) {
        return [
            {
                level: "warning",
                recipe: key,
                where,
                message: `the recipe manifest at the tag '${tag}' could not be read, so sous cannot confirm the tag and the metadata agree.\n  ${describeError(error)}`,
            },
        ];
    }

    if (taggedVersion !== version) {
        return [
            {
                level: "error",
                recipe: key,
                where,
                message:
                    `the tag '${tag}' carries a manifest declaring version ${taggedVersion}, not ${version}. Recipe metadata ` +
                    `is the source of truth for versions, so the tag is wrong; delete it and let 'sous repo release' cut it again.`,
            },
        ];
    }

    return [];
}

/** Tags of recipes no longer published: normal after a rename, so a warning. */
function checkOrphanTags(validation: RepoValidation, tags: readonly RecipeTag[]): ReleaseProblem[] {
    const known = new Set(validation.recipes.map((recipe) => recipe.key));
    const orphaned = new Map<string, string[]>();

    for (const tag of tags) {
        const key = recipeTagKey(tag);

        if (known.has(key)) {
            continue;
        }

        const list = orphaned.get(key);

        if (list === undefined) {
            orphaned.set(key, [tag.tag]);
        } else {
            list.push(tag.tag);
        }
    }

    return [...orphaned.entries()].map(([key, tagNames]) => ({
        level: "warning" as const,
        where: `tags for '${key}'`,
        message:
            `this repository carries ${tagNames.length} release ${tagNames.length === 1 ? "tag" : "tags"} for '${key}' ` +
            `(${tagNames.join(", ")}), which it no longer publishes. That is normal after a recipe is renamed or retired; ` +
            `the tags are left alone.`,
    }));
}

function sameExceptStamp(tools: AuthoringTools, left: IndexFile, right: IndexFile): boolean {
    const strip = (index: IndexFile) => tools.indexFile.stringify({ ...index, generatedAt: "" });

    return strip(left) === strip(right);
}

function relativeTo(rootDir: string, target: string): string {
    return toPosix(path.relative(rootDir, target));
}
