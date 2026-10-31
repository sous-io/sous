/**
 * Which working copy `repo submit` proposes from. Inside a recipe repository with no argument, that
 * repository. Inside a project, the argument names a repository the project links, and the submission
 * runs in its linked checkout; with no argument, the one linked repository, or a choice between
 * several. Nothing here writes anything.
 */

import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "@sous-io/plugin-api";
import type { RecipesLinks } from "@sous-io/plugin-recipes/types";
import type { AuthoringTools } from "../tools.js";
import { findRepoRoot, repoRootAround } from "../shared/repository.js";

/** The working copy a submission runs in, and how it was chosen. */
export interface SubmitCheckout {
    readonly rootDir: string;
    /** The project's short name for the repository, when a project named it. */
    readonly repo?: string;
    /** How it was found, in one sentence. */
    readonly reason: string;
}

/** Works out which checkout a submission runs in. */
export async function findSubmitCheckout(tools: AuthoringTools, cwd: string, repo: string | undefined, acceptFirst = false): Promise<SubmitCheckout> {
    const links = tools.links();

    if (repo === undefined) {
        const inside = repoRootAround(tools, cwd);

        if (inside !== undefined) {
            return { rootDir: inside, reason: "The working directory is inside it." };
        }

        if (links === undefined) {
            // Neither a recipe repository nor a project: this error says what to do.
            findRepoRoot(tools, cwd);
        }

        return chooseLinked(tools, links!);
    }

    if (links === undefined) {
        throw new ConfigError(
            `'${repo}' names a repository a project uses, but ${path.resolve(cwd)} is not inside a sous project.\n` +
                `  Run the command from inside the project that links the repository, or from inside the repository's ` +
                `own checkout with no argument.`,
        );
    }

    const { name, url } = await resolveRepoName(tools, links, repo, acceptFirst);
    const link = links.get(name);

    if (link === undefined) {
        const leftover = url === undefined ? undefined : await leftoverCheckout(tools, url);

        if (leftover !== undefined) {
            tools.reporter.note(
                `'${name}' is not linked in this project, so builds read its published versions; the checkout sous cloned ` +
                    `for it is still at ${leftover}, and the change is proposed from there.`,
            );

            return { rootDir: leftover, repo: name, reason: `Sous cloned '${name}' into this checkout earlier.` };
        }

        throw noWorkingCopy(name, `It is not linked in this project, and no checkout of it is where 'sous repo link' clones one.`);
    }

    if (!fs.existsSync(link.path)) {
        throw noWorkingCopy(name, `Its link points at ${link.path}, which does not exist.`);
    }

    return { rootDir: link.path, repo: name, reason: `'${name}' is linked to this checkout.` };
}

/** The short name a written repository ref means (a linked name as written, else what refs resolves), and its URL when known. */
async function resolveRepoName(
    tools: AuthoringTools,
    links: RecipesLinks,
    written: string,
    acceptFirst: boolean,
): Promise<{ readonly name: string; readonly url?: string }> {
    if (links.get(written) !== undefined) {
        return { name: written };
    }

    const { refs } = await tools.refs.resolve({ input: written, kinds: ["repo"], refusedIsEmpty: true });
    const linked = Object.keys(links.all()).sort();
    const picker = tools.picker();
    const details = [linked.length === 0 ? "  This project links no repositories." : `  This project links: ${linked.join(", ")}.`];
    const match =
        picker === undefined
            ? refs[0]
            : await picker.pick(refs, { search: written, acceptFirst, details }, { prompter: tools.prompter, reporter: tools.reporter });

    if (match === undefined || match.kind !== "repo" || match.name === undefined) {
        throw new ConfigError(`No repository this project uses is called '${written}'.\n${details.join("\n")}`);
    }

    const url = match.location?.url ?? configuredUrl(tools, match.name);

    return { name: match.name, ...(url === undefined ? {} : { url }) };
}

/** The URL the project's config gives a repository, or `undefined`. */
function configuredUrl(tools: AuthoringTools, name: string): string | undefined {
    try {
        const repos = tools.hostContext().config?.get("repos") as Record<string, { url?: unknown } | undefined> | undefined;
        const url = repos?.[name]?.url;

        return typeof url === "string" ? url : undefined;
    } catch {
        return undefined;
    }
}

/**
 * A checkout `sous repo link` cloned for the repository and that is still on disk though the link is
 * gone: `<clone directory>/<owner>/<name>`, whose `origin` is the same repository.
 */
async function leftoverCheckout(tools: AuthoringTools, url: string): Promise<string | undefined> {
    const slug = repoSlugFromUrl(url);

    if (slug === undefined) {
        return undefined;
    }

    for (const base of tools.cloneDirectories()) {
        const directory = path.join(base, slug.owner, slug.name);

        if (!fs.existsSync(path.join(directory, ".git"))) {
            continue;
        }

        const remote = await tools.git.remoteUrl(directory, "origin").catch(() => undefined);

        if (remote !== undefined && normalizeRemoteUrl(remote) === normalizeRemoteUrl(url)) {
            return directory;
        }
    }

    return undefined;
}

/**
 * A remote URL without scheme, user, port, `.git` or trailing slashes, lowercased, so two spellings of
 * one repository compare equal. The same reading `sous repo link` uses to name its clones.
 *
 * ```ts
 * normalizeRemoteUrl("git@github.com:sous-io/sous.git"); // "github.com/sous-io/sous"
 * ```
 */
export function normalizeRemoteUrl(url: string): string {
    let value = url.trim();
    const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/\/)(.+)$/.exec(value);

    if (scp !== null) {
        value = `${scp[1]}/${scp[2]}`;
    } else {
        value = value
            .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "")
            .replace(/^[^/]*@/, "")
            .replace(/^([^/]+):\d+/, "$1");
    }

    return value.replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
}

/** The owner and name `sous repo link` clones a URL under, or `undefined` when the URL has too few parts. */
export function repoSlugFromUrl(url: string): { readonly owner: string; readonly name: string } | undefined {
    const segments = normalizeRemoteUrl(url)
        .split("/")
        .filter((segment) => segment.length > 0);

    if (segments.length < 2) {
        return undefined;
    }

    const sanitize = (segment: string) => {
        const cleaned = segment.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^\.+/, "");

        return cleaned.length > 0 ? cleaned : "repo";
    };

    return { owner: sanitize(segments.length >= 3 ? segments[segments.length - 2]! : "repos"), name: sanitize(segments[segments.length - 1]!) };
}

/** With no argument inside a project: the one linked repository, or a choice between several. */
async function chooseLinked(tools: AuthoringTools, links: RecipesLinks): Promise<SubmitCheckout> {
    const all = links.all();
    const names = Object.keys(all).sort();

    if (names.length === 0) {
        throw new ConfigError(
            "This project links no repository, so there is no working copy to propose from.\n" +
                "  Link one with 'sous repo link <repo>', make your change in its checkout, then run 'sous repo submit <repo>'.",
        );
    }

    let name: string;
    let reason: string;

    if (names.length === 1) {
        name = names[0]!;
        reason = "It is the only repository this project links.";
    } else {
        name = await tools.prompter.askChoice({
            message: "Which linked repository should the change be proposed from?",
            answeredBy: `<repo> (for example 'sous repo submit ${names[0]}')`,
            choices: names.map((entry) => ({ label: entry, value: entry, description: all[entry]!.path })),
        });
        reason = "You chose it.";
    }

    const link = all[name]!;

    if (!fs.existsSync(link.path)) {
        throw noWorkingCopy(name, `Its link points at ${link.path}, which does not exist.`);
    }

    return { rootDir: link.path, repo: name, reason };
}

function noWorkingCopy(name: string, why: string): ConfigError {
    return new ConfigError(
        `There is no working copy of '${name}' to propose a change from.\n` +
            `  ${why}\n` +
            `  Link it with 'sous repo link ${name}', make your change in its checkout, then run the command again.`,
    );
}
