/**
 * Trust.
 *
 * Added equals trusted: a repository sous reads from is one in the merged `repos` map, switched
 * on. Until a repository is trusted, sous downloads nothing from it, not even its index. A
 * resolution can turn up repositories a dependency needs; they are asked about in one question,
 * through the chain's prompter, and `--yes` answers it ahead of time.
 */

import { LogLevel, NonInteractiveError, SousError, type ConfigReader, type Reporter, type ServiceReader, type VariableEntry } from "@sous-io/plugin-api";
import type { ChainIo, ConfirmTrustOptions, ConfirmTrustResult, MissingRepo, RecipesTrust, RepoEntry } from "../types.js";
import { USER_ADDED_BY } from "./defaults.js";
import { trustedRepos, writeRepoEntry } from "./project.js";
import { compareBytewise, nowIso } from "./util.js";

/** `recipes.trust`, for one built config. */
export class Trust implements RecipesTrust {
    constructor(
        private readonly config: ConfigReader,
        private readonly services: ServiceReader,
    ) {}

    trusted(): Record<string, RepoEntry> {
        return trustedRepos(this.config);
    }

    isTrusted(repository: string): boolean {
        return this.nameOf(repository) !== undefined;
    }

    nameOf(repository: string): string | undefined {
        const trusted = this.trusted();

        if (Object.hasOwn(trusted, repository)) {
            return repository;
        }

        const wanted = this.identityOf(repository);

        if (wanted === undefined) {
            return undefined;
        }

        return Object.keys(trusted).find((name) => this.identityOf(trusted[name]!.url) === wanted);
    }

    async confirm(missing: readonly MissingRepo[], options: ConfirmTrustOptions, io: ChainIo): Promise<ConfirmTrustResult> {
        if (missing.length === 0) {
            return { accepted: [], added: [], needUrl: [] };
        }

        if (options.yes !== true && options.dryRun !== true) {
            if (!io.prompter.interactive) {
                throw new NonInteractiveError(trustQuestion(missing), "--yes", { details: nonInteractiveDetails(missing) });
            }

            reportTrustNotice(io.reporter, missing);

            const accepted = await io.prompter.confirm({ message: trustQuestion(missing), answeredBy: "--yes", default: false });

            if (!accepted) {
                throw new SousError(`Nothing was installed: trust was declined for ${missing.map((repo) => `'${repo.name}'`).join(", ")}.`, {
                    details: ["Sous installs a dependency closure whole or not at all, so declining any repository in it stops the install."],
                });
            }
        }

        const managed = this.services.get("confd.managed");
        const added: string[] = [];
        const needUrl: string[] = [];

        for (const repo of missing) {
            if (repo.url === undefined) {
                needUrl.push(repo.name);
                continue;
            }

            // Every requester is recorded, so removal can say why a repository is there.
            const requesters = [...new Set(repo.requiredBy.map((entry) => entry.requestedBy))].sort(compareBytewise);

            await writeRepoEntry(
                managed,
                repo.name,
                {
                    url: repo.url,
                    ...(repo.provider === undefined ? {} : { provider: repo.provider }),
                    addedAt: nowIso(),
                    addedBy: requesters.length > 0 ? requesters.join(", ") : USER_ADDED_BY,
                },
                options.dryRun === true,
            );
            added.push(repo.name);
        }

        return { accepted: [...missing], added, needUrl };
    }

    /** The canonical identity of a URL, locator or identity, or `undefined` when no host reads it. */
    private identityOf(repository: string): string | undefined {
        try {
            return this.services.get("refs.locations").identity(repository).toLowerCase();
        } catch {
            // Already an identity (`github.com/owner/name`), or nothing any host reads.
            return repository.includes("/") && !repository.includes("://") ? repository.toLowerCase() : undefined;
        }
    }
}

/** The one question asked about a round of repositories. */
export function trustQuestion(missing: readonly MissingRepo[]): string {
    return missing.length === 1 ? `Do you trust the repository '${missing[0]!.name}'?` : `Do you trust these ${missing.length} repositories?`;
}

/** Reports the notice before the question: every repository, its URL, and what trusting it means. */
export function reportTrustNotice(reporter: Reporter, missing: readonly MissingRepo[]): void {
    reporter.notice(
        missing.length === 1
            ? "One repository has to be trusted before this can continue."
            : `${missing.length} repositories have to be trusted before this can continue.`,
    );

    for (const repo of missing) {
        const entries: VariableEntry[] = [{ label: "Location", value: repo.url ?? "not known to sous; a ref named it by its short name only" }];

        if (repo.identity !== undefined) {
            entries.push({ label: "Identity", value: repo.identity });
        }

        for (const entry of repo.requiredBy) {
            entries.push({ label: "Required", value: `${entry.ref} (required by ${entry.requestedBy === "project" ? "this project" : `'${entry.requestedBy}'`})` });
        }

        reporter.variables(entries, repo.name, LogLevel.Notice);
    }

    reporter.note(
        "Trusting a repository trusts every namespace and every recipe in it, including ones published later. " +
            "Trusting on its own runs nothing; subscribing to something inside it can, and probably will, run scripts on this machine.",
    );
    reporter.note("Sous cannot tell you whether a repository deserves trust. Look at the location above, and at who publishes it, before answering.");
}

/** The details of the error a run that cannot ask gets: each repository, and the command that trusts it. */
export function nonInteractiveDetails(missing: readonly MissingRepo[]): string[] {
    const lines: string[] = [];

    for (const repo of missing) {
        const provenance = repo.requiredBy.map((entry) => `${entry.ref} (required by ${entry.requestedBy})`).join(", ");

        lines.push(`${repo.name}: ${repo.url ?? "URL not known to sous"}`, `  ${provenance}`);
    }

    lines.push(
        "Trusting a repository trusts every namespace and recipe in it, and subscribing to something inside it can run scripts on this machine.",
        "Add each repository deliberately, with its URL:",
        ...missing.map((repo) => `  sous repo add ${repo.url ?? "<url>"} --name ${repo.name} --yes`),
    );

    return lines;
}

/** The error raised when a recipe names a repository by short name only, so sous cannot add it. */
export function needUrlError(names: readonly string[]): SousError {
    return new SousError(
        names.length === 1
            ? `Sous does not know where the repository '${names[0]}' lives, so it cannot add it for you.`
            : `Sous does not know where these repositories live, so it cannot add them for you: ${names.map((name) => `'${name}'`).join(", ")}.`,
        {
            details: [
                "A recipe names the repository it depends on by its short name only; the URL has to come from you.",
                "Add each one with its URL, then run this command again:",
                ...names.map((name) => `  sous repo add <url> --name ${name}`),
            ],
        },
    );
}
