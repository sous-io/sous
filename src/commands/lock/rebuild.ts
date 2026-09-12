/**
 * `sous lock rebuild`.
 *
 * Recomputes the lockfile from scratch: every subscription this project
 * declares is resolved against the cached repository indexes, the whole
 * dependency closure beneath them is walked, and the result replaces the
 * lockfile outright. An entry nothing holds any more is dropped, which is what
 * makes this the repair for a lockfile that has drifted from the config: a
 * hand-edited file, a bad merge, or a subscription removed from the config by
 * hand rather than with `sous subscription remove`.
 *
 * It is an edge-case utility, so it is deliberately blunt. It never asks a
 * question and never grants trust: a subscription whose repository this project
 * has not added is an error naming the repository. It downloads nothing; a
 * repository whose index has not been fetched is named, and nothing in it can
 * be resolved.
 */

import { Flags } from "@oclif/core";
import { BaseCommand } from "../../base-command.js";
import { ConfigError } from "../../lib/errors.js";
import { subscriptionServiceFor } from "../../lib/repos/subscription-service.js";
import { recipeFilesDirectory } from "../../lib/repos/catalog-inputs.js";
import { readRecipeManifestIn } from "../../lib/repos/locked-recipes.js";
import { createEmptyLockfile } from "../../lib/repos/formats/lockfile.js";
import type { LockRepoInput } from "../../lib/repos/lock-service.js";
import { parseRef } from "../../lib/repos/ref.js";
import {
  PROJECT_REQUESTER,
  resolveRefs,
  type RefRequest,
  type ResolverRepo,
} from "../../lib/repos/resolver.js";
import type { IndexFile } from "../../lib/repos/formats/index-file.js";
import {
  blankLine,
  dryRunNotice,
  footer,
  heading,
  indent,
  log,
  paragraph,
  showCommandVars,
} from "../../utils/formatting.js";

/** How far every line of this command's output is indented. */
const INDENT = 2;

export default class LockRebuild extends BaseCommand {
  static description =
    "Rebuild this project's lockfile from its subscriptions and the cached repository indexes";

  /**
   * The other spelling of the topic. It lives under a hidden topic, so it is
   * typable everywhere without ever reaching the top-level listing.
   */
  static aliases = ["locks:rebuild"];

  static examples = [
    "<%= config.bin %> lock rebuild",
    "<%= config.bin %> lock rebuild --dry-run",
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    "dry-run": Flags.boolean({
      description: "Print what would change without writing the lockfile",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(LockRebuild);
    const dryRun = flags["dry-run"];

    showCommandVars({
      Project: this.projectLabel,
      Config: this.configContext.configPath,
      "Dry Run": dryRun,
    });

    heading("Rebuilding the lockfile");

    const service = subscriptionServiceFor({
      configContext: this.configContext,
      settings: this.settings,
      shellEnv: this.shellEnv,
    });

    const sousDir = this.configContext.sousDir;
    const trusted = service.currentRepos();

    const repos: Record<string, ResolverRepo> = {};
    const lockRepos: Record<string, LockRepoInput> = {};
    const indexes = new Map<string, IndexFile>();
    const notFetched: string[] = [];

    const before = service.lockService.read();

    for (const name of Object.keys(trusted).sort()) {
      const entry = trusted[name]!;
      const identity = service.identityForRepo(name);
      if (identity === undefined) continue;

      repos[name] = {
        url: entry.url,
        identity,
        ...(entry.provider === undefined ? {} : { provider: entry.provider }),
        ...(entry.alwaysPull === undefined ? {} : { alwaysPull: entry.alwaysPull }),
      };
      lockRepos[name] = {
        url: entry.url,
        identity,
        ...(entry.provider === undefined ? {} : { provider: entry.provider }),
        // The index a resolution was made against is recorded per repository.
        // A rebuild resolves against the same cached index the last one did, so
        // whatever the lockfile already recorded still holds.
        ...(before.repos[name]?.indexHash === undefined
          ? {}
          : { indexHash: before.repos[name]!.indexHash! }),
      };

      const index = service.cachedIndex(name);
      if (index === undefined) {
        notFetched.push(name);
        continue;
      }
      indexes.set(name, index);
    }

    const subscriptions = service.allSubscriptions();
    const requests: RefRequest[] = Object.keys(subscriptions)
      .sort()
      .map((key) => {
        const entry = subscriptions[key]!;
        const parsed = parseRef(key);
        return {
          ref: {
            ...parsed,
            ...(entry.range === undefined ? {} : { range: entry.range }),
          },
          requestedBy: PROJECT_REQUESTER,
          kind: "subscribes" as const,
          ...(entry.prerelease === true ? { prerelease: true } : {}),
        };
      });

    const result = await resolveRefs(requests, {
      indexes,
      repos,
      // A recipe's own manifest is what names its dependencies, and it is read
      // from the files this machine already holds. Nothing is fetched here, so a
      // recipe that is not in the store yet comes back under `missingManifests`.
      loadManifest: (recipe) => {
        const directory = recipeFilesDirectory({
          service,
          sousDir,
          repo: recipe.repo,
          key: recipe.key,
          namespace: recipe.namespace,
          name: recipe.name,
          version: recipe.version,
        });
        return directory === undefined ? undefined : readRecipeManifestIn(directory);
      },
    });

    if (result.missingRepos.length > 0) {
      throw new ConfigError(
        `This project's subscriptions need ${
          result.missingRepos.length === 1 ? "a repository" : "repositories"
        } it does not trust, so the lockfile cannot be rebuilt:\n` +
          result.missingRepos
            .map(
              (missing) =>
                `  ${missing.name}${missing.url === undefined ? "" : ` (${missing.url})`}, ` +
                `needed by ${missing.requiredBy.map((entry) => entry.ref).join(", ")}`
            )
            .join("\n") +
          `\n  Add ${
            result.missingRepos.length === 1 ? "it" : "them"
          } with 'sous repo add <url>', which is how a repository is trusted, then run ` +
          `this command again.`
      );
    }

    // The rebuild starts from an empty lockfile rather than the one on disk, so
    // an entry nothing in the resolution holds any more is gone rather than
    // carried through.
    const after = service.lockService.applyResolution(
      createEmptyLockfile(),
      result.resolved,
      lockRepos
    );
    const diff = service.lockService.diff(before, after);

    blankLine();
    for (const line of diff.lines) log(indent(line, INDENT));

    if (notFetched.length > 0) {
      blankLine();
      paragraph(
        `These repositories are trusted and their index has not been fetched yet, so ` +
          `nothing in them could be resolved: ${notFetched.join(", ")}.`
      );
    }

    if (result.missingManifests.length > 0) {
      blankLine();
      paragraph(
        `The files of these recipes are not on this machine, so their own ` +
          `dependencies could not be read and are not in the rebuilt lockfile: ` +
          `${result.missingManifests.join(", ")}.`
      );
    }

    for (const cycle of result.cycles) {
      blankLine();
      paragraph(`These recipes depend on each other in a circle: ${cycle.join(" -> ")}.`);
    }

    blankLine();

    if (dryRun) {
      dryRunNotice(`Nothing was written. The lockfile is ${service.lockService.filePath}.`);
      footer();
      return;
    }

    const written = service.lockService.write(after);
    paragraph(
      `The lockfile was rebuilt from ${requests.length} ${
        requests.length === 1 ? "subscription" : "subscriptions"
      } and now pins ${Object.keys(after.recipes).length} ${
        Object.keys(after.recipes).length === 1 ? "recipe" : "recipes"
      }: ${written}.`
    );

    footer();
  }
}
