import fs from "node:fs";
import { Command, Flags } from "@oclif/core";
import { ConfigError, isConfigError, SOUS_VERSION } from "../../lib/settings.js";
import { INDEX_FILENAME } from "../../lib/repos/formats/common.js";
import { isInteractive, nonInteractiveError, wantsHelp } from "../../lib/interactive.js";
import { askYesNo } from "../../utils/prompts.js";
import { printCommandHelpToStderr } from "../../utils/command-help.js";
import { confirmationFlag, nonInteractiveFlag } from "../../utils/flags.js";
import {
  BUMP_LEVELS,
  anythingToCommit,
  buildIndex,
  buildReleasePlan,
  bumpRecipeVersion,
  commitPaths,
  createAnnotatedTag,
  currentBranch,
  defaultBranch,
  describeIndexDrift,
  describeScope,
  errorsIn,
  findRepoRoot,
  hasErrors,
  indexFilePath,
  pushBranch,
  pushTags,
  readIndexFile,
  releaseScope,
  remoteUrl,
  scopeProblems,
  uncommittedChanges,
  validateRepo,
  warningsIn,
  type BumpLevel,
  type IndexBuildResult,
  type ReleasePlan,
  type ReleaseScope,
  type RepoValidation,
  type ValidationProblem,
} from "../../lib/repos/release/index.js";
import {
  blankLine,
  displayErrorBlock,
  dryRunNotice,
  footer,
  header,
  log,
  section,
  showCommandVars,
  showVariables,
  warning,
} from "../../utils/formatting.js";

/** The remote a release pushes to. Recipe repositories have exactly one. */
const RELEASE_REMOTE = "origin";

/**
 * `sous repo release` publishes new versions of the recipes in a repository.
 *
 * Like `sous repo init`, this command does NOT extend BaseCommand: it runs
 * inside a RECIPE repository, which is not a sous project and has no `.sous/`
 * directory of its own, so there is no project config to discover.
 *
 * One run does the whole job, in one order, after showing what it will do and
 * asking once:
 *
 *   1. Validate the repository.
 *   2. For every recipe in scope whose files have changed since the tag that
 *      last published it, raise the version (a patch step unless `--bump` says
 *      otherwise).
 *   3. Regenerate the index, with each new version's dependencies resolved to
 *      the exact versions it is being released against.
 *   4. Commit the manifests and the index together.
 *   5. Tag that commit, dependency-first, with an annotated tag per version.
 *   6. Push, but only when asked to.
 *
 * Two presets sit on top of it. `--check` is read-only and is what a pull
 * request runs; `--ci` is the non-interactive form a merge runs, which bumps
 * nothing because the version was raised in the change being merged.
 */
export default class RepoRelease extends Command {
  static description =
    "Publish new versions of this repository's recipes: bump, regenerate the index, commit and tag";

  /**
   * The other spelling of the topic. It lives under a hidden topic, so it is
   * typable everywhere without ever reaching the top-level listing.
   */
  static aliases = ["repos:release"];

  static examples = [
    "<%= config.bin %> repo release",
    "<%= config.bin %> repo release --dry-run",
    "<%= config.bin %> repo release --namespace workflow --bump minor",
    "<%= config.bin %> repo release --recipe workflow/task-files --yes --push",
    "<%= config.bin %> repo release --check",
    "<%= config.bin %> repo release --ci --push",
  ];

  static flags = {
    check: Flags.boolean({
      description:
        "Only check: validate, and fail when the committed index is out of date",
      default: false,
    }),
    ci: Flags.boolean({
      description:
        "Run the way a merge does: never bump, never ask, and fail on anything unbumped",
      default: false,
    }),
    namespace: Flags.string({
      description: "Release only this namespace. Repeat to name several",
      multiple: true,
    }),
    recipe: Flags.string({
      description: "Release only this recipe, as 'namespace/name'. Repeat to name several",
      multiple: true,
    }),
    bump: Flags.string({
      description: "How far to raise a changed recipe's version. Defaults to a patch step",
      options: [...BUMP_LEVELS],
    }),
    "no-bump": Flags.boolean({
      description: "Raise no versions; a changed recipe that was never raised is an error",
      default: false,
    }),
    "include-unchanged": Flags.boolean({
      description: "Release every recipe in scope, whether its files changed or not",
      default: false,
    }),
    tag: Flags.boolean({
      description: "Cut the tags even on a branch other than the default one",
      default: false,
    }),
    push: Flags.boolean({
      description: "Push the commit, and the tags this run created, to the remote",
      default: false,
    }),
    yes: confirmationFlag(),
    "dry-run": Flags.boolean({
      description: "Print the plan and stop, changing nothing",
      default: false,
    }),
    // This command does not extend BaseCommand, so it declares the global
    // non-interactive flag itself; the rule is the same everywhere.
    "non-interactive": nonInteractiveFlag(),
  };

  async init(): Promise<void> {
    await super.init();
    header();
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(RepoRelease);
    const dryRun = flags["dry-run"];
    const ci = flags.ci;
    // The CI preset is exactly two settings: never raise a version, and never
    // ask. It deliberately does NOT imply --push; the workflow passes that
    // itself, so what gets pushed is visible in the workflow file.
    const noBump = flags["no-bump"] || ci;
    const interactive = ci ? false : isInteractive();

    assertFlagsAgree({ ...flags, noBump });

    const rootDir = findRepoRoot(process.cwd());
    const scope = releaseScope(flags.namespace ?? [], flags.recipe ?? []);

    showCommandVars({
      Repository: rootDir,
      Mode: describeMode(flags),
      Scope: describeScope(scope),
      ...(dryRun ? { "Dry Run": true } : {}),
    });

    // --- Validate ---------------------------------------------------------

    section("Checking the repository");
    let validation = validateRepo(rootDir);
    const scoping = scopeProblems(validation, scope);
    reportProblems([...validation.problems, ...scoping]);
    if (hasErrors([...validation.problems, ...scoping])) {
      return this.stopForErrors([...validation.problems, ...scoping]);
    }
    log(`  Read ${describeCount(validation.recipes.length, "recipe")}.`);

    if (flags.check) return await this.runCheck(rootDir, validation);

    // --- Plan -------------------------------------------------------------

    const branch = await currentBranch(rootDir);
    const mainBranch = await defaultBranch(rootDir);
    const onDefaultBranch =
      mainBranch === undefined || branch === undefined || branch === mainBranch;
    const willTag = onDefaultBranch || flags.tag;

    const plan = await buildReleasePlan({
      validation,
      scope,
      ...(flags.bump === undefined ? {} : { bump: flags.bump as BumpLevel }),
      noBump,
      includeUnchanged: flags["include-unchanged"],
    });

    reportProblems(plan.problems);
    if (hasErrors(plan.problems)) return this.stopForErrors(plan.problems);

    this.reportPlan(plan, { willTag, onDefaultBranch, branch, push: flags.push });

    if (plan.releases.length === 0) {
      footer();
      return;
    }

    if (dryRun) {
      blankLine();
      dryRunNotice("Nothing was written; this was a dry run.");
      footer();
      return;
    }

    // --- Confirm ----------------------------------------------------------

    if (!flags.yes) {
      if (!interactive) {
        throw nonInteractiveError({
          prompt: "whether to publish the versions listed above",
          remedy:
            "pass '--yes' (spelled '-y' or '--force' if you prefer) to accept the plan " +
            "above without being asked.",
        });
      }
      blankLine();
      const accepted = await askYesNo("Publish these versions?");
      if (!accepted) {
        blankLine();
        log("  Nothing was written.");
        footer();
        return;
      }
    }

    // --- Carry it out -----------------------------------------------------

    await this.assertNothingUncommitted(rootDir);

    section("Publishing");

    const changedPaths: string[] = [];
    for (const release of plan.releases) {
      if (release.bump === undefined) {
        log(`  ${release.key}: publishing version ${release.to}.`);
        continue;
      }
      const bumped = bumpRecipeVersion(release.manifestPath, release.bump);
      log(`  ${release.key}: ${bumped.from} becomes ${bumped.to}.`);
      changedPaths.push(release.manifestPath);
    }

    // The manifests changed, so the repository is read again; everything after
    // this point works from what the files now say.
    validation = validateRepo(rootDir);
    reportProblems(validation.problems);
    if (hasErrors(validation.problems)) return this.stopForErrors(validation.problems);

    const publishing: Record<string, string> = {};
    for (const release of plan.releases) publishing[release.key] = release.to;

    const existing = readExistingIndex(rootDir);
    const rebuilt = await buildIndex({
      validation,
      existing,
      sousVersion: SOUS_VERSION,
      publishing,
    });
    reportProblems(rebuilt.problems);
    if (hasErrors(rebuilt.problems)) return this.stopForErrors(rebuilt.problems);

    if (rebuilt.stale) {
      fs.writeFileSync(indexFilePath(rootDir), rebuilt.text, "utf8");
      log(`  Wrote ${INDEX_FILENAME}.`);
      changedPaths.push(indexFilePath(rootDir));
    } else {
      log(`  The committed ${INDEX_FILENAME} was already current.`);
    }

    const message = `Release ${plan.releases
      .map((release) => `${release.key}@${release.to}`)
      .join(", ")}`;

    if (await anythingToCommit(rootDir, changedPaths)) {
      await commitPaths(rootDir, changedPaths, message);
      log(`  Committed: ${message}`);
    } else {
      log("  Nothing to commit; the manifests and the index were already current.");
    }

    const created: string[] = [];
    if (willTag) {
      for (const release of plan.releases) {
        await createAnnotatedTag(
          rootDir,
          release.tag,
          `Release ${release.key} version ${release.to}`
        );
        created.push(release.tag);
        log(`  Created the tag ${release.tag}.`);
      }
    } else {
      blankLine();
      log(`  No tags were cut: this is the branch '${branch}', and tags are cut on the`);
      log(`  default branch '${mainBranch}'. Continuous integration does that after the`);
      log("  merge, or pass '--tag' to cut them here.");
    }

    // --- Push -------------------------------------------------------------

    if (flags.push) {
      if ((await remoteUrl(rootDir, RELEASE_REMOTE)) === undefined) {
        throw new ConfigError(
          `The release was made, but this repository has no '${RELEASE_REMOTE}' remote to ` +
            `push it to.\n` +
            `  Add one with 'git remote add ${RELEASE_REMOTE} <url>', then push the commit ` +
            `and its tags yourself.`
        );
      }
      if (branch !== undefined) {
        await pushBranch(rootDir, RELEASE_REMOTE, branch);
        log(`  Pushed the branch '${branch}' to ${RELEASE_REMOTE}.`);
      }
      if (created.length > 0) {
        await pushTags(rootDir, RELEASE_REMOTE, created);
        log(`  Pushed ${describeCount(created.length, "tag")} to ${RELEASE_REMOTE}.`);
      }
    } else {
      section("What to do next");
      log(`  Push the commit with 'git push ${RELEASE_REMOTE} ${branch ?? "<branch>"}'.`);
      if (created.length > 0) {
        log(`  Push the tags with 'git push ${RELEASE_REMOTE} --tags'.`);
      }
      log("  Or run this command again with '--push', which does both.");
    }

    footer();
  }

  // --- The read-only form -------------------------------------------------------------------------

  /**
   * `--check`: validate, regenerate the index in memory, and fail when the
   * committed one is out of date. This is what a pull request runs, so it
   * writes nothing, asks nothing and tags nothing.
   *
   * @param rootDir - The repository's root directory.
   * @param validation - The validated repository.
   */
  private async runCheck(
    rootDir: string,
    validation: RepoValidation
  ): Promise<void> {
    section("Checking the index");

    const existing = readExistingIndex(rootDir);
    const result = await buildIndex({ validation, existing, sousVersion: SOUS_VERSION });
    reportProblems(result.problems);
    if (hasErrors(result.problems)) return this.stopForErrors(result.problems);

    if (!result.stale) {
      log(`  The committed ${INDEX_FILENAME} is current, and so are the dependencies it`);
      log("  records for every version it publishes.");
      reportPending(result, "These versions have no tag yet; they publish when this merges:");
      footer();
      return;
    }

    const lines = [
      `The committed ${INDEX_FILENAME} is out of date:`,
      "",
      ...describeIndexDrift(existing, result.index).map((line) => `  ${line}`),
      "",
      "Run 'sous repo release' to regenerate it, and commit what it writes.",
    ];
    displayErrorBlock(lines.join("\n"));
    this.exit(1);
  }

  // --- Output ---------------------------------------------------------------------------------

  /**
   * Prints the whole plan before anything happens: what is released, what is
   * left alone, whether tags are cut, and what is pushed.
   *
   * @param plan - The plan to describe.
   * @param context - The branch rule's outcome and the push flag.
   */
  private reportPlan(
    plan: ReleasePlan,
    context: {
      willTag: boolean;
      onDefaultBranch: boolean;
      branch: string | undefined;
      push: boolean;
    }
  ): void {
    section("The release this would make");

    if (plan.releases.length === 0) {
      log("  Nothing in scope has changed since the tag that last published it.");
      if (plan.skipped.length > 0) {
        blankLine();
        for (const entry of plan.skipped) log(`  ${entry.key}: ${entry.reason}`);
      }
      blankLine();
      log("  Pass '--include-unchanged' to release everything in scope anyway.");
      return;
    }

    const rows: Record<string, string> = {};
    for (const release of plan.releases) {
      rows[release.key] =
        release.bump === undefined
          ? `${release.to}  (already raised; the tag would be ${release.tag})`
          : `${release.from} becomes ${release.to}  (a ${release.bump} step; the tag would be ${release.tag})`;
    }
    showVariables(rows);

    if (plan.skipped.length > 0) {
      blankLine();
      log("  Left alone:");
      for (const entry of plan.skipped) log(`    ${entry.key}: ${entry.reason}`);
    }

    blankLine();
    log("  This run would:");
    log("    Raise the versions listed above, in the manifests that declare them.");
    log(`    Regenerate ${INDEX_FILENAME}, with each version's dependencies resolved.`);
    log("    Commit the manifests and the index together.");
    if (context.willTag) {
      log("    Cut one annotated tag per version, dependency-first.");
    } else {
      log(
        `    Cut no tags: this is the branch '${context.branch}', not the default one.`
      );
    }
    log(
      context.push
        ? `    Push the commit${context.willTag ? " and the tags" : ""} to ${RELEASE_REMOTE}.`
        : "    Push nothing; pass '--push' to push what it makes."
    );
  }

  /** Ends the run after printing why the repository cannot be released. */
  private stopForErrors(problems: ReadonlyArray<ValidationProblem>): void {
    const count = errorsIn(problems).length;
    displayErrorBlock(
      `This repository cannot be released yet: ${describeCount(count, "problem")} ` +
        `${count === 1 ? "is" : "are"} listed above.\n` +
        `  Fix them and run the command again.`
    );
    this.exit(1);
  }

  /**
   * Refuses to release while anything is uncommitted.
   *
   * A tag names one commit, and the index this run writes records the content
   * hash of every recipe folder as it stands, so an uncommitted edit would be
   * published by hash and absent from the tag. Sous commits its own version
   * bumps and its own index, and nothing else.
   *
   * @param rootDir - The repository's root directory.
   */
  private async assertNothingUncommitted(rootDir: string): Promise<void> {
    const changed = await uncommittedChanges(rootDir);
    if (changed.length === 0) return;

    const listed = changed.map((entry) => `  ${entry.path}`).join("\n");
    throw new ConfigError(
      "Cannot release while the working tree has uncommitted changes.\n\n" +
        `${listed}\n\n` +
        "  A tag names one commit, and the index this writes records what each recipe " +
        "folder holds right now, so everything being published has to be committed " +
        "first.\n" +
        "  Commit these, then run the command again; sous commits the version bumps and " +
        "the index itself."
    );
  }

  /**
   * Renders a configuration error as a plain, readable message rather than an
   * oclif stack trace, matching what BaseCommand does for every other command.
   * An error raised because a question could not be asked also gets this
   * command's own help underneath it, so every flag that would have answered it
   * is visible without going looking.
   */
  protected async catch(error: Error & { exitCode?: number }): Promise<unknown> {
    if (isConfigError(error)) {
      displayErrorBlock((error as ConfigError).message);
      if (wantsHelp(error)) await printCommandHelpToStderr(this);
      return this.exit(1);
    }
    return super.catch(error);
  }
}

// --- Helpers ------------------------------------------------------------------------------------

/** Refuses flag combinations that would mean two different things at once. */
function assertFlagsAgree(flags: {
  check: boolean;
  ci: boolean;
  noBump: boolean;
  push: boolean;
  tag: boolean;
  bump?: string;
  "include-unchanged": boolean;
}): void {
  if (flags.check && flags.ci) {
    throw new ConfigError(
      "'--check' and '--ci' cannot be used together.\n" +
        "  '--check' only reads, and reports whether a release is needed; '--ci' makes " +
        "one.\n  A pull request runs 'sous repo release --check'; a merge runs " +
        "'sous repo release --ci --push'."
    );
  }
  if (flags.check && (flags.bump !== undefined || flags.push || flags.tag)) {
    throw new ConfigError(
      "'--check' changes nothing, so it cannot be combined with '--bump', '--tag' or " +
        "'--push'.\n" +
        "  Run 'sous repo release --check' on its own, or drop '--check' to make a release."
    );
  }
  if (flags.bump !== undefined && flags.noBump) {
    throw new ConfigError(
      "'--bump' and '--no-bump' cannot be used together.\n" +
        "  '--bump' says how far to raise a version; '--no-bump' says to raise none. " +
        "'--ci' implies '--no-bump'."
    );
  }
}

/** The plain-language name of what this run is doing, for the preamble. */
function describeMode(flags: { check: boolean; ci: boolean; "dry-run": boolean }): string {
  if (flags.check) return "Check only";
  if (flags["dry-run"]) return "Plan only";
  if (flags.ci) return "Publish (continuous integration)";
  return "Publish";
}

/** Reads the committed index, warning and starting fresh when it cannot be read. */
function readExistingIndex(rootDir: string) {
  try {
    return readIndexFile(rootDir);
  } catch (error) {
    warning(
      `The committed ${INDEX_FILENAME} could not be read, so it will be regenerated from ` +
        `the recipe manifests and the release tags.\n` +
        `${isConfigError(error) ? (error as Error).message : String(error)}`
    );
    return undefined;
  }
}

/** Prints every problem, errors first, each with where it was found. */
function reportProblems(problems: ReadonlyArray<ValidationProblem>): void {
  for (const problem of errorsIn(problems)) {
    displayErrorBlock(`${problem.where}:\n  ${problem.message}`);
  }
  for (const problem of warningsIn(problems)) {
    warning(`${problem.where}:\n${problem.message}`);
  }
}

/** Lists the versions that have no tag yet, when there are any. */
function reportPending(result: IndexBuildResult, headline: string): void {
  if (result.pending.length === 0) return;
  log(`  ${headline}`);
  const pending: Record<string, string> = {};
  for (const entry of result.pending) {
    pending[entry.key] = `${entry.version}  (the tag would be ${entry.tag})`;
  }
  showVariables(pending);
}

/** Renders a count with its noun, singular or plural, in words a person reads. */
function describeCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Re-exported so the scope type is nameable from a test. */
export type { ReleaseScope };
