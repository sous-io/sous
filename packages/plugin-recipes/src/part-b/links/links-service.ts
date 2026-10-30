/**
 * Links: a link points one repository at a working copy on disk instead of
 * the store, which is how a maintainer edits recipes. The project's `.sous/sous.links.json` covers
 * one project; `$SOUS_HOME/sous.links.json` covers every project on the machine. A project link
 * wins. Neither map is committed: a link bypasses versions and the lockfile on one machine only.
 */

import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "@sous-io/plugin-api";
import type { LinkOrigin, LinksMap, WritableFormatParser } from "@sous-io/plugin-formats/types";
import type { HostDirectories, HostGitignore } from "@sous-io/plugin-host/types";
import type { LinkScope, RecipesLinks, ResolvedLink } from "../../types.js";
import { LINKS_FILE_NAME, PROJECT_REPOS_DIRNAME } from "../constants.js";
import { messageOf } from "../support.js";

/** The machine-local files sous keeps in `.sous/.gitignore`'s managed block. */
export const IGNORED_LOCAL_FILES = [LINKS_FILE_NAME, "sous.state.json", "sous.pid", ".env.local", `${PROJECT_REPOS_DIRNAME}/`] as const;

/** Where the two maps are, and how they are read. */
export interface LinksFilesOptions {
    /** The project's `.sous/`, or `undefined` outside a project. */
    readonly sousDir: string | undefined;
    /** `$SOUS_HOME/sous.links.json`. */
    readonly globalFile: string;
    readonly parser: WritableFormatParser<LinksMap>;
    readonly now?: () => Date;
}

/** Reading and writing both links maps. */
export class LinksFiles implements RecipesLinks {
    constructor(private readonly options: LinksFilesOptions) {}

    path(scope: LinkScope): string {
        if (scope === "global") {
            return this.options.globalFile;
        }

        if (this.options.sousDir === undefined) {
            throw new ConfigError("There is no sous project here, so there is no project links map.", {
                details: ["Link with --global to link for every project on this machine, or run sous from inside a project."],
            });
        }

        return path.join(this.options.sousDir, LINKS_FILE_NAME);
    }

    /** One map as written; an absent file is an empty map, an unreadable one an error naming it. */
    read(scope: LinkScope): LinksMap {
        if (scope === "project" && this.options.sousDir === undefined) {
            return this.options.parser.empty();
        }

        const file = this.path(scope);

        if (!fs.existsSync(file)) {
            return this.options.parser.empty();
        }

        let parsed: unknown;

        try {
            parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch (error) {
            throw new ConfigError(`Sous could not read the links map at ${file}.`, {
                details: [messageOf(error), "A link changes what a build produces, so sous will not ignore a damaged links map. Fix or delete the file."],
            });
        }

        return this.options.parser.parse(parsed, file);
    }

    all(): Record<string, ResolvedLink> {
        const merged: Record<string, ResolvedLink> = {};

        for (const scope of ["global", "project"] as const) {
            for (const [repo, link] of Object.entries(this.read(scope).links)) {
                merged[repo] = { repo, path: link.path, origin: link.origin, linkedAt: link.linkedAt, scope };
            }
        }

        return merged;
    }

    get(repo: string): ResolvedLink | undefined {
        return this.all()[repo];
    }

    /** The link of one scope only. */
    getIn(repo: string, scope: LinkScope): ResolvedLink | undefined {
        const link = this.read(scope).links[repo];

        return link === undefined ? undefined : { repo, path: link.path, origin: link.origin, linkedAt: link.linkedAt, scope };
    }

    async set(repo: string, link: { path: string; origin: LinkOrigin }, scope: LinkScope, options: { dryRun?: boolean } = {}): Promise<ResolvedLink> {
        const map = this.read(scope);
        const linkedAt = (this.options.now ?? (() => new Date()))().toISOString();
        const resolved = path.resolve(link.path);

        map.links[repo] = { path: resolved, linkedAt, origin: link.origin };

        if (!options.dryRun) {
            this.write(scope, map);
        }

        return { repo, path: resolved, origin: link.origin, linkedAt, scope };
    }

    async remove(repo: string, scope: LinkScope, options: { dryRun?: boolean } = {}): Promise<ResolvedLink | undefined> {
        const map = this.read(scope);
        const link = map.links[repo];

        if (link === undefined) {
            return undefined;
        }

        delete map.links[repo];

        if (!options.dryRun) {
            this.write(scope, map);
        }

        return { repo, path: link.path, origin: link.origin, linkedAt: link.linkedAt, scope };
    }

    private write(scope: LinkScope, map: LinksMap): void {
        const file = this.path(scope);

        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, this.options.parser.stringify(map), "utf8");
    }
}

/**
 * Keeps git from seeing what sous keeps in `.sous/` for one machine: `.sous/repos/.gitignore`
 * holding `*`, and sous's managed block in `.sous/.gitignore`. Both are safe to write again.
 * Given `directories`, `.sous/repos/` also gets the README (and pointer files) that explain it.
 */
export async function ensureLocalFilesIgnored(sousDir: string, gitignore: HostGitignore, directories?: HostDirectories): Promise<void> {
    const reposDir = path.join(sousDir, PROJECT_REPOS_DIRNAME);
    const inner = path.join(reposDir, ".gitignore");

    if (directories === undefined) {
        fs.mkdirSync(reposDir, { recursive: true });
    } else {
        await directories.ensureKnown("project-repos", reposDir);
    }

    if (!fs.existsSync(inner) || fs.readFileSync(inner, "utf8") !== "*\n") {
        fs.writeFileSync(inner, "*\n", "utf8");
    }

    await gitignore.add(path.join(sousDir, ".gitignore"), IGNORED_LOCAL_FILES);
}

/** The lines a build prints when anything is linked, so a checkout standing in for a release is never silent. */
export function describeLinkedRepos(links: Record<string, ResolvedLink>): string[] {
    const names = Object.keys(links).sort();

    if (names.length === 0) {
        return [];
    }

    return [
        names.length === 1 ? "One repository is LINKED to a working copy on this machine." : `${names.length} repositories are LINKED to working copies on this machine.`,
        "Their recipes are read from those checkouts, so versions, the lockfile and freshness checks do not apply to them.",
        "",
        ...names.map((name) => `${name} -> ${links[name].path}`),
        "",
        "Run 'sous repo unlink <name>' to go back to the published versions.",
    ];
}
