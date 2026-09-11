import fs from "node:fs";
import { Command, Flags } from "@oclif/core";
import { ConfigError, isConfigError, SOUS_VERSION } from "../../lib/settings.js";
import { INDEX_FILENAME } from "../../lib/repos/formats/common.js";
import {
  BUMP_LEVELS,
  buildIndex,
  bumpRecipeVersion,
  createAnnotatedTag,
  describeIndexDrift,
  errorsIn,
  findRepoRoot,
  hasErrors,
  indexFilePath,
  isCommittedAndUnchanged,
  pushTags,
  readIndexFile,
  remoteUrl,
  uncommittedChanges,
  validateRepo,
  warningsIn,
  type BumpLevel,
  type IndexBuildResult,
  type RepoValidation,
  type ValidatedRecipe,
  type ValidationProblem,
} from "../../lib/repos/release/index.js";
import {
  blankLine,
  displayErrorBlock,
  dryRunNotice,
  footer,
  header,
  heading,
  log,
  showCommandVars,
  showVars,
  warning,
} from "../../utils/formatting.js";

/** The remote tags are pushed to. Recipe repositories have exactly one. */
const RELEASE_REMOTE = "origin";

/**
 * `sous repo release` validates a recipe repository, regenerates its index, and
 * cuts the git tags that publish new versions.
 *
 * Like `sous repo init`, this command does NOT extend BaseCommand: it runs
 * inside a RECIPE repository, which is not a sous project and has no `.sous/`
 * directory of its own, so there is no project config to discover.
 *
 * Sous never commits on an author's behalf here. A default run proposes the
 * release: it says what is pending, what would be tagged, and what to push.
 * `--check` is the read-only form a pull request runs, and `--tag` is the step
 * that publishes, once the author has committed everything.
 */
export default class RepoRelease extends Command {
  static description =
    "Validate a recipe repository, regenerate its index, and tag new recipe versions";

  /**
   * The other spelling of the topic. It lives under a hidden topic, so it is
   * typable everywhere without ever reaching the top-level listing.
   */
  static aliases = ["repos:release"];

  static examples = [
    "<%= config.bin %> repo release",
    "<%= config.bin %> repo release --check",
    "<%= config.bin %> repo release --bump minor --recipe workflow/task-files",
    "<%= config.bin %> repo release --tag",
    "<%= config.bin %> repo release --tag --push",
  ];

  static flags = {
    check: Flags.boolean({
      description:
        "Only check: fail when anything is wrong or the committed index is out of date",
      default: false,
    }),
    bump: Flags.string({
      description: "Raise a recipe's version before regenerating the index",
      options: [...BUMP_LEVELS],
    }),
    recipe: Flags.string({
      description: "Which recipe to bump, as 'namespace/name'",
    }),
    tag: Flags.boolean({
      description: "Create the release tag for every version that does not have one",
      default: false,
    }),
    push: Flags.boolean({
      description: "Push the tags that were created, and nothing else",
      default: false,
    }),
    "dry-run": Flags.boolean({
      description: "Print what would change without changing anything",
      default: false,
    }),
  };

  async init(): Promise<void> {
    await super.init();
    header();
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(RepoRelease);
    const dryRun = flags["dry-run"];
    assertFlagsAgree(flags);

    const rootDir = findRepoRoot(process.cwd());

    showCommandVars({
      Repository: rootDir,
      Mode: describeMode(flags),
      "Dry Run": dryRun,
    });

    // --- Validate ---------------------------------------------------------

    heading("Checking the repository");
    let validation = validateRepo(rootDir);
    reportProblems(validation.problems);
    if (hasErrors(validation.problems)) return this.stopForErrors(validation.problems);
    log(`  Read ${describeCount(validation.recipes.length, "recipe")}.`);

    // --- Bump -------------------------------------------------------------

    if (flags.bump !== undefined) {
      heading("Raising versions");
      const targets = pickBumpTargets(validation, flags.recipe);
      for (const recipe of targets) {
        if (dryRun) {
          dryRunNotice(
            `would raise ${recipe.key} from ${recipe.manifest.version} by a ` +
              `${flags.bump} step`
          );
          continue;
        }
        const bumped = bumpRecipeVersion(recipe.manifestPath, flags.bump as BumpLevel);
        log(`  ${recipe.key}: ${bumped.from} becomes ${bumped.to}`);
      }
      if (!dryRun) {
        log("");
        log("  The manifests keep their comments and their layout; only the version");
        log("  changed. A folded block of prose may be re-wrapped, and the spacing");
        log("  before a trailing comment is normalized to one space.");
        validation = validateRepo(rootDir);
        reportProblems(validation.problems);
        if (hasErrors(validation.problems)) return this.stopForErrors(validation.problems);
      }
    }

    // --- Regenerate the index --------------------------------------------

    heading("Regenerating the index");
    const existing = readExistingIndex(rootDir);
    const result = await buildIndex({
      validation,
      existing,
      sousVersion: SOUS_VERSION,
    });
    reportProblems(result.problems);
    if (hasErrors(result.problems)) return this.stopForErrors(result.problems);

    if (flags.check) return this.reportCheck(result, existing);

    if (flags.tag) return await this.reportTagging(rootDir, result, flags, dryRun);

    return this.reportPlan(rootDir, result, existing, dryRun);
  }

  // --- The three ways a run ends -----------------------------------------------------------------

  /** `--check`: say whether the committed index is current, and fail when it is not. */
  private reportCheck(
    result: IndexBuildResult,
    existing: ReturnType<typeof readExistingIndex>
  ): void {
    if (!result.stale) {
      log(`  The committed ${INDEX_FILENAME} is current.`);
      reportPending(result, "These versions have no tag yet; they publish when this merges:");
      footer();
      return;
    }

    const lines = [
      `The committed ${INDEX_FILENAME} is out of date:`,
      "",
      ...describeIndexDrift(existing, result.index).map((line) => `  ${line}`),
      "",
      "Run 'sous repo release' to regenerate it, then commit the result.",
    ];
    displayErrorBlock(lines.join("\n"));
    this.exit(1);
  }

  /** The default run: write the regenerated index and propose the release. */
  private reportPlan(
    rootDir: string,
    result: IndexBuildResult,
    existing: ReturnType<typeof readExistingIndex>,
    dryRun: boolean
  ): void {
    if (result.stale) {
      if (dryRun) {
        dryRunNotice(`would write ${INDEX_FILENAME}`);
        for (const line of describeIndexDrift(existing, result.index)) {
          log(`    ${line}`);
        }
      } else {
        fs.writeFileSync(indexFilePath(rootDir), result.text, "utf8");
        log(`  Wrote ${INDEX_FILENAME}.`);
        for (const line of describeIndexDrift(existing, result.index)) {
          log(`    ${line}`);
        }
      }
    } else {
      log(`  The committed ${INDEX_FILENAME} was already current; nothing was written.`);
    }

    heading("The release this proposes");
    reportPending(result, "Versions with no tag yet:");

    if (result.pending.length === 0) {
      log("  Every version this repository declares is already published.");
      footer();
      return;
    }

    blankLine();
    log("  Nothing has been committed or tagged. To publish these versions:");
    log("");
    log(`    1. Commit your changes, including ${INDEX_FILENAME}.`);
    log("    2. Run 'sous repo release --tag' to create the tags.");
    log(`    3. Run 'sous repo release --tag --push', or push them yourself with`);
    log(`       'git push ${RELEASE_REMOTE} --tags'.`);
    footer();
  }

  /** `--tag`: publish the pending versions, once everything is committed. */
  private async reportTagging(
    rootDir: string,
    result: IndexBuildResult,
    flags: { push: boolean },
    dryRun: boolean
  ): Promise<void> {
    heading("Publishing");

    const changed = await uncommittedChanges(rootDir);
    if (changed.length > 0) {
      const listed = changed.map((entry) => `  ${entry.path}`).join("\n");
      throw new ConfigError(
        "Cannot tag a release while the working tree has uncommitted changes.\n\n" +
          `${listed}\n\n` +
          "  A tag names one commit, so everything the release publishes has to be in " +
          "that commit.\n" +
          "  Sous does not commit for you: commit these, then run the command again."
      );
    }

    if (!(await isCommittedAndUnchanged(rootDir, INDEX_FILENAME))) {
      throw new ConfigError(
        `Cannot tag a release before ${INDEX_FILENAME} is committed.\n` +
          `  The index is what every subscriber reads, so it is committed alongside the ` +
          `recipes it describes.\n` +
          `  Run 'sous repo release', commit the result, then run this command again.`
      );
    }

    if (result.stale) {
      throw new ConfigError(
        `Cannot tag a release while the committed ${INDEX_FILENAME} is out of date.\n` +
          `  Run 'sous repo release' to regenerate it, commit the result, then run this ` +
          `command again.`
      );
    }

    if (result.pending.length === 0) {
      log("  Every version this repository declares is already published.");
      footer();
      return;
    }

    const created: string[] = [];
    for (const entry of result.pending) {
      if (dryRun) {
        dryRunNotice(`would create the tag ${entry.tag}`);
        continue;
      }
      await createAnnotatedTag(
        rootDir,
        entry.tag,
        `Release ${entry.key} version ${entry.version}`
      );
      created.push(entry.tag);
      log(`  Created the tag ${entry.tag}.`);
    }

    if (!dryRun) {
      // Every pending version now has a tag, so the index can record it. This
      // run writes the file; committing it stays the author's decision.
      const republished = await buildIndex({
        validation: validateRepo(rootDir),
        existing: readExistingIndex(rootDir),
        sousVersion: SOUS_VERSION,
      });
      if (republished.stale) {
        fs.writeFileSync(indexFilePath(rootDir), republished.text, "utf8");
        log(`  Rewrote ${INDEX_FILENAME} to record the versions that were just tagged.`);
      }
    }

    if (flags.push) {
      if (dryRun) {
        dryRunNotice(`would push ${describeCount(result.pending.length, "tag")}`);
      } else if ((await remoteUrl(rootDir, RELEASE_REMOTE)) === undefined) {
        throw new ConfigError(
          `The tags were created, but this repository has no '${RELEASE_REMOTE}' remote to ` +
            `push them to.\n` +
            `  Add one with 'git remote add ${RELEASE_REMOTE} <url>', then push them with ` +
            `'git push ${RELEASE_REMOTE} --tags'.`
        );
      } else {
        await pushTags(rootDir, RELEASE_REMOTE, created);
        log(`  Pushed ${describeCount(created.length, "tag")} to ${RELEASE_REMOTE}.`);
      }
    }

    heading("What to do next");
    if (dryRun) {
      log("  Nothing was created; this was a dry run.");
    } else {
      log(`  Commit the regenerated ${INDEX_FILENAME}, so subscribers can see the new`);
      log("  versions, and push it.");
      if (!flags.push) {
        log(`  Push the tags with 'git push ${RELEASE_REMOTE} --tags', or run this command`);
        log("  again with --push.");
      }
    }
    footer();
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
   * Renders a configuration error as a plain, readable message rather than an
   * oclif stack trace, matching what BaseCommand does for every other command.
   */
  protected async catch(error: Error & { exitCode?: number }): Promise<unknown> {
    if (isConfigError(error)) {
      displayErrorBlock((error as ConfigError).message);
      return this.exit(1);
    }
    return super.catch(error);
  }
}

// --- Helpers ------------------------------------------------------------------------------------

/** Refuses flag combinations that would mean two different things at once. */
function assertFlagsAgree(flags: {
  check: boolean;
  tag: boolean;
  push: boolean;
  bump?: string;
}): void {
  if (flags.check && flags.tag) {
    throw new ConfigError(
      "'--check' and '--tag' cannot be used together.\n" +
        "  '--check' only reads, and reports whether a release is needed; '--tag' publishes " +
        "one.\n  Run them one after the other."
    );
  }
  if (flags.check && flags.bump !== undefined) {
    throw new ConfigError(
      "'--check' and '--bump' cannot be used together.\n" +
        "  '--check' never changes a file, and '--bump' rewrites a recipe manifest."
    );
  }
  if (flags.push && !flags.tag) {
    throw new ConfigError(
      "'--push' only has an effect alongside '--tag'.\n" +
        "  It pushes the tags this command creates, and nothing else. Run " +
        "'sous repo release --tag --push'."
    );
  }
}

/** The plain-language name of what this run is doing, for the preamble. */
function describeMode(flags: { check: boolean; tag: boolean; bump?: string }): string {
  if (flags.check) return "Check only";
  if (flags.tag) return "Publish (create tags)";
  if (flags.bump !== undefined) return `Raise the version by a ${flags.bump} step`;
  return "Propose a release";
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
  showVars(pending);
}

/** Which recipes a `--bump` applies to, refusing to guess when there is a choice. */
function pickBumpTargets(
  validation: RepoValidation,
  recipeKey: string | undefined
): ValidatedRecipe[] {
  if (recipeKey !== undefined) {
    const found = validation.recipes.find((recipe) => recipe.key === recipeKey);
    if (found === undefined) {
      const known = validation.recipes.map((recipe) => `    ${recipe.key}`).join("\n");
      throw new ConfigError(
        `This repository does not publish a recipe called '${recipeKey}'.\n\n` +
          `  It publishes:\n${known}`
      );
    }
    return [found];
  }

  if (validation.recipes.length === 1) return validation.recipes;

  const known = validation.recipes.map((recipe) => `    ${recipe.key}`).join("\n");
  throw new ConfigError(
    `This repository publishes more than one recipe, so '--bump' needs to know which one ` +
      `to raise.\n\n  Name it with '--recipe', for example ` +
      `'--recipe ${validation.recipes[0]?.key ?? "namespace/name"}'.\n\n` +
      `  It publishes:\n${known}`
  );
}

/** Renders a count with its noun, singular or plural, in words a person reads. */
function describeCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
