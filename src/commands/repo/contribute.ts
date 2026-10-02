import { Args, Flags } from "@oclif/core";
import { BaseCommand } from "../../base-command.js";
import { ConfigError } from "../../lib/errors.js";
import { nonInteractiveError } from "../../lib/interactive.js";
import {
  CatalogLookup,
  RefPickArguments,
  RefResolveArguments,
  repoOf,
  sharedRefPicker,
  sharedRefResolver,
  type CatalogRepo,
} from "../../services/ref-resolver/index.js";
import {
  assessPendingWork,
  assessProposal,
  commandLine,
  pendingWork,
  startStep,
  submitStep,
  unlinkStep,
  type ContributionStep,
  type FinishFlags,
  type LocatorFlags,
  type PendingVerdict,
  type PendingWork,
} from "../../lib/repos/contribute.js";
import { currentBranch, isGitCheckout } from "../../lib/repos/git-clone.js";
import { readGlobalLinks, readProjectLinks } from "../../lib/repos/links.js";
import type { RepoLink } from "../../lib/repos/formats/links-map.js";
import { submitRepo } from "../../lib/repos/release/submit-service.js";
import { subscriptionServiceFor } from "../../lib/repos/subscription-service.js";
import { isExitSignal } from "../../utils/command-errors.js";
import { confirmationFlag } from "../../utils/flags.js";
import {
  BULLET,
  blankLine,
  dryRunNotice,
  footer,
  heading,
  log,
  note,
  paragraph,
  section,
  showCommandVars,
  showVariables,
  subheading,
  withoutHeader,
} from "../../utils/formatting.js";
import { askYesNo } from "../../utils/prompts.js";

/**
 * `sous repo contribute` starts a contribution to a recipe repository in one
 * command, and `--finish` ends it.
 *
 * `sous repo link` is a general tool (authoring, running a teammate's branch, a
 * local fork, debugging), and contributing is one particular lifecycle built
 * from it: start on a fresh branch of an up-to-date checkout, edit, propose,
 * revise, and go back to the published versions once the change ships. This
 * command is that lifecycle's entry point. It CHAINS the existing commands and
 * adds no behavior they lack:
 *
 *   - Start runs `sous repo link <repo> --latest` on a new branch.
 *   - Finish looks at what the branch holds that no proposal carries yet, asks
 *     whether to submit it (`sous repo submit`), then runs `sous repo unlink
 *     <repo> --update`.
 *
 * Each step runs the real command in this same process, with the flags this
 * command was given passed through, so a step behaves exactly as it does when
 * it is typed on its own; the step prints as it runs, and a failure lists the
 * steps that had already completed. The reference may name a repository, or a
 * namespace or recipe, in which case the repository that publishes it is used.
 */
export default class RepoContribute extends BaseCommand {
  static description =
    "Start a contribution to a recipe repository on a fresh branch, or finish one with --finish";

  /**
   * The other spelling of the topic, plus the short spelling of the command.
   * Both hidden spellings live where the other hidden alternates do, so they are
   * typable everywhere without ever reaching a listing.
   */
  static aliases = ["repos:contribute"];

  static hiddenAliases = ["repo:contrib", "repos:contrib"];

  static examples = [
    "<%= config.bin %> repo contribute sous-recipes",
    "<%= config.bin %> repo contribute workflow/task-files",
    "<%= config.bin %> repo contribute sous-recipes --create-branch fix-a-typo",
    '<%= config.bin %> repo contribute sous-recipes --finish --title "Fix a typo" --body "Fixes it."',
    "<%= config.bin %> repo contribute sous-recipes --finish --no-submit --remove",
    "<%= config.bin %> repo contribute sous-recipes --finish --dry-run",
  ];

  static args = {
    ref: Args.string({
      description:
        "The repository to contribute to, or a namespace or recipe it publishes",
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    // No default, so `dependsOn: ["finish"]` below can tell whether it was given.
    finish: Flags.boolean({
      description:
        "Finish the contribution: submit what no proposal carries yet, then unlink and update the pins",
    }),
    branch: Flags.string({
      description:
        "The existing branch to work on when starting, or to submit from when finishing",
      helpValue: "<name>",
      exclusive: ["create-branch", "generate-branch"],
    }),
    "create-branch": Flags.string({
      description: "Start the contribution on a new branch with this name",
      helpValue: "<name>",
      exclusive: ["branch", "generate-branch", "finish"],
    }),
    "generate-branch": Flags.boolean({
      description:
        "Start the contribution on a new branch named sous/edit-<date>-<time>, which is what happens when no branch is named",
      exclusive: ["branch", "create-branch", "finish"],
    }),
    from: Flags.string({
      description:
        "Start the new branch from this branch instead of the repository's default branch",
      helpValue: "<branch>",
      exclusive: ["branch", "finish"],
    }),
    global: Flags.boolean({
      description:
        "Work with the machine-wide link, sharing one checkout, rather than this project's link",
      default: false,
    }),
    submit: Flags.boolean({
      description:
        "Submit what no proposal carries yet without asking, or with --no-submit, finish without submitting it",
      allowNo: true,
      dependsOn: ["finish"],
    }),
    title: Flags.string({
      description: "The proposal's title; required for a new proposal, and replaces an open one's",
      dependsOn: ["finish"],
    }),
    body: Flags.string({
      description:
        "The proposal's description; required for a new proposal, and replaces an open one's",
      dependsOn: ["finish"],
    }),
    draft: Flags.boolean({
      description: "Open a new proposal as a draft",
      dependsOn: ["finish"],
    }),
    commit: Flags.boolean({
      description: "Commit uncommitted changes for you when submitting, after listing them and asking once",
      dependsOn: ["finish"],
    }),
    remove: Flags.boolean({
      description: "Delete the checkout as well when unlinking, when sous cloned it",
      dependsOn: ["finish"],
    }),
    yes: confirmationFlag(),
    "accept-first": Flags.boolean({
      description: "When the reference matches several things, take the first one listed",
      default: false,
    }),
    "dry-run": Flags.boolean({
      description: "Print each step this would run without running any of them",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(RepoContribute);
    const finishing = flags.finish === true;
    const dryRun = flags["dry-run"];

    showCommandVars({
      Project: this.projectLabel,
      Reference: args.ref,
      Mode: finishing ? "Finish a contribution" : "Start a contribution",
      Scope: flags.global ? "this machine" : "this project",
      "Dry Run": dryRun,
    });

    blankLine();
    const repo = await this.resolveRepository(args.ref, flags["accept-first"]);

    // Every step discovers the project again, so it is pointed at the same one.
    const configFlag = flags.config ?? flags["sous-config"];
    const locator: LocatorFlags = {
      ...(configFlag === undefined ? {} : { config: configFlag }),
      ...(flags["sous-dir"] === undefined ? {} : { "sous-dir": flags["sous-dir"] }),
      ...(flags["sous-confd"] === undefined ? {} : { "sous-confd": flags["sous-confd"] }),
    };

    if (finishing) {
      await this.finish(repo, {
        ...(flags.title === undefined ? {} : { title: flags.title }),
        ...(flags.body === undefined ? {} : { body: flags.body }),
        ...(flags.branch === undefined ? {} : { branch: flags.branch }),
        draft: flags.draft === true,
        commit: flags.commit === true,
        remove: flags.remove === true,
        global: flags.global,
        yes: flags.yes,
      }, flags.submit, locator, dryRun);
    } else {
      await this.start(
        repo,
        startStep(
          repo,
          {
            ...(flags.branch === undefined ? {} : { branch: flags.branch }),
            ...(flags["create-branch"] === undefined
              ? {}
              : { createBranch: flags["create-branch"] }),
            generateBranch: flags["generate-branch"] === true,
            ...(flags.from === undefined ? {} : { from: flags.from }),
            global: flags.global,
            yes: flags.yes,
          },
          locator
        ),
        flags.global,
        dryRun
      );
    }

    footer();
  }

  /**
   * Starts a contribution: one step, the link.
   *
   * @param repo - The repository's short name.
   * @param step - The link step.
   * @param isGlobal - Whether the link is the machine-wide one.
   * @param dryRun - When true, the step is printed and not run.
   */
  private async start(
    repo: string,
    step: ContributionStep,
    isGlobal: boolean,
    dryRun: boolean
  ): Promise<void> {
    section("Starting a contribution");
    this.printPlan([step]);

    if (dryRun) {
      blankLine();
      dryRunNotice("no step was run");
      return;
    }

    const completed: string[] = [];
    await this.runStep(step, completed);

    section("The contribution");
    const link = this.linkMap(isGlobal).links[repo];
    const branch =
      link !== undefined && isGitCheckout(link.path) ? currentBranch(link.path) : undefined;
    showVariables({
      Repository: repo,
      ...(link === undefined ? {} : { Checkout: link.path }),
      ...(branch === undefined ? {} : { Branch: branch }),
    });
    blankLine();
    paragraph(
      `Builds read '${repo}' from this checkout until the contribution is finished, so an ` +
        `edit made there shows up in this project's next build.`
    );
    this.printCompleted(completed);
  }

  /**
   * Finishes a contribution: works out whether the branch holds anything no
   * proposal carries yet, submits it when the contributor says so, then
   * unlinks the repository and updates its pins.
   *
   * @param repo - The repository's short name.
   * @param flags - The finish flags, passed through.
   * @param submitFlag - `--submit` (true), `--no-submit` (false), or neither.
   * @param locator - The config-locating flags, passed through.
   * @param dryRun - When true, the steps are printed and none is run.
   */
  private async finish(
    repo: string,
    flags: FinishFlags,
    submitFlag: boolean | undefined,
    locator: LocatorFlags,
    dryRun: boolean
  ): Promise<void> {
    const isGlobal = flags.global === true;
    const link = this.requireLink(repo, isGlobal);

    section("Finishing a contribution");
    showVariables({ Repository: repo, Checkout: link.path });

    const completed: string[] = [];

    subheading("Looking for work no proposal carries yet");
    blankLine();
    const work = pendingWork(link.path, flags.branch);
    this.printPendingWork(work);

    let verdict = assessPendingWork(work);
    if (verdict.kind === "lookup" && !dryRun) {
      paragraph(verdict.reason);
      blankLine();
      verdict = await this.lookUpProposal(link.path, work.branch!);
      blankLine();
    }
    paragraph(verdict.reason);
    completed.push("Looked for work no proposal carries yet");

    const unlink = unlinkStep(repo, flags, locator);
    const submit = submitStep(repo, flags);

    if (dryRun) {
      blankLine();
      if (verdict.kind === "nothing") {
        dryRunNotice("would skip submitting, since there is nothing to submit");
        blankLine();
        this.printPlan([unlink]);
      } else {
        if (verdict.kind === "lookup") {
          dryRunNotice(
            "would look the branch's proposal up, and treat the branch as having work to " +
              "submit when none is open"
          );
        }
        dryRunNotice(this.describeSubmitDecision(submitFlag, flags.yes === true));
        blankLine();
        this.printPlan(submitFlag === false ? [unlink] : [submit, unlink]);
      }
      blankLine();
      dryRunNotice("no step was run");
      return;
    }

    const steps: ContributionStep[] = [];
    if (verdict.kind !== "nothing" && (await this.shouldSubmit(submitFlag, flags.yes === true))) {
      steps.push(submit);
    } else if (verdict.kind !== "nothing") {
      blankLine();
      paragraph("It is not submitted; the checkout keeps it.");
    }
    steps.push(unlink);

    blankLine();
    this.printPlan(steps);
    for (const step of steps) await this.runStep(step, completed);

    this.printCompleted(completed);
  }

  // --- Resolving the reference ------------------------------------------------------------------

  /**
   * The repository a reference names: the repository itself, or the one that
   * publishes a namespace or recipe. Resolved through the shared reference
   * module over every repository this project trusts; a repository whose index
   * has never been fetched can still be named, just not searched inside.
   *
   * @param ref - The reference as it was written.
   * @param acceptFirst - The `--accept-first` flag.
   */
  private async resolveRepository(ref: string, acceptFirst: boolean): Promise<string> {
    const service = subscriptionServiceFor({
      configContext: this.configContext,
      settings: this.settings,
      shellEnv: this.shellEnv,
    });

    const repos: CatalogRepo[] = service.cachedReferenceRepos();

    const { refs } = await sharedRefResolver().resolve(
      new RefResolveArguments({
        input: ref,
        lookup: new CatalogLookup(repos),
        kinds: ["repo", "namespace", "recipe"],
        refusedIsEmpty: true,
      })
    );

    const chosen = await sharedRefPicker().pick(
      refs,
      new RefPickArguments({
        search: ref,
        interactive: this.interactive,
        acceptFirst,
        prompt: `Which '${ref}' do you want to contribute to?`,
        details: [
          "  No trusted repository, namespace or recipe has that name.",
          repos.length === 0
            ? "  This project trusts no repositories."
            : `  This project trusts: ${repos.map((entry) => entry.name).join(", ")}.`,
        ],
      })
    );
    return chosen.kind === "repo" ? chosen.name! : repoOf(chosen)!.name!;
  }

  // --- The link ---------------------------------------------------------------------------------

  /**
   * The links map a scope reads.
   *
   * @param isGlobal - Whether it is the machine-wide map.
   */
  private linkMap(isGlobal: boolean) {
    return isGlobal ? readGlobalLinks() : readProjectLinks(this.configContext.sousDir);
  }

  /**
   * The link a contribution being finished runs on, or a ConfigError saying it
   * is not linked in the scope asked about (and where it is linked instead,
   * when it is linked in the other one).
   *
   * @param repo - The repository's short name.
   * @param isGlobal - Whether the machine-wide link was asked about.
   */
  private requireLink(repo: string, isGlobal: boolean): RepoLink {
    const link = this.linkMap(isGlobal).links[repo];
    if (link !== undefined) return link;

    const other = this.linkMap(!isGlobal).links[repo];
    const searched = isGlobal ? "the machine-wide links map" : "this project's links map";
    throw new ConfigError(
      `'${repo}' is not linked in ${searched}, so there is no contribution to finish.\n` +
        (other === undefined
          ? `  Nothing was changed.`
          : `  It is linked in the ${isGlobal ? "project" : "machine-wide"} map, at ` +
            `${other.path}; run the same command ${isGlobal ? "without" : "with"} --global ` +
            `to finish that one.`)
    );
  }

  // --- Deciding whether to submit ---------------------------------------------------------------

  /**
   * Looks the branch's proposal up, to judge a branch whose every commit was
   * pushed. A lookup that fails leaves the question open, which counts as work
   * to submit: the contributor is asked, and sous says why it could not tell.
   *
   * @param directory - The checkout.
   * @param branch - The branch.
   */
  private async lookUpProposal(directory: string, branch: string): Promise<PendingVerdict> {
    try {
      const result = await submitRepo({
        rootDir: directory,
        branch,
        statusOnly: true,
        onStep: (message) => log(`  ${message}`),
        onNotice: (message) => note(message),
      });
      return assessProposal(branch, result.previous, result.proposalNoun);
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).split("\n")[0]!;
      return {
        kind: "pending",
        reason:
          `Every commit on the branch '${branch}' was pushed, but sous could not look its ` +
          `proposal up, so it cannot tell whether one is open. ${reason.trim()}`,
      };
    }
  }

  /**
   * Whether to submit the work found: `--no-submit` says no, `--submit` or the
   * confirmation flag say yes, and otherwise the contributor is asked. A run
   * that cannot ask fails, naming the flags that answer the question.
   *
   * @param submitFlag - `--submit` (true), `--no-submit` (false), or neither.
   * @param yes - The confirmation flag.
   */
  private async shouldSubmit(submitFlag: boolean | undefined, yes: boolean): Promise<boolean> {
    if (submitFlag !== undefined) return submitFlag;
    if (yes) return true;

    if (!this.interactive) {
      throw nonInteractiveError({
        prompt: "whether to submit the work above before finishing",
        remedy:
          "pass '--submit' (or '--yes') to submit it, or '--no-submit' to finish without " +
          "submitting it.",
      });
    }
    return askYesNo("Submit it before finishing?", true);
  }

  /**
   * What a dry run says about the submit question.
   *
   * @param submitFlag - `--submit` (true), `--no-submit` (false), or neither.
   * @param yes - The confirmation flag.
   */
  private describeSubmitDecision(submitFlag: boolean | undefined, yes: boolean): string {
    if (submitFlag === false) return "would not submit it, because --no-submit was passed";
    if (submitFlag === true) return "would submit it without asking, because --submit was passed";
    if (yes) return "would submit it without asking, because --yes was passed";
    return "would ask whether to submit it";
  }

  // --- Running the steps ------------------------------------------------------------------------

  /**
   * Runs one step: the real command, in this process, without a second banner.
   * The command reports its own failure; this adds which steps had completed
   * before it, then ends the run with the command's exit code.
   *
   * @param step - The step to run.
   * @param completed - The steps completed so far; this one is added when it succeeds.
   */
  private async runStep(step: ContributionStep, completed: string[]): Promise<void> {
    heading(step.running);
    note(commandLine(step), { indent: 2 });

    try {
      await withoutHeader(() => this.config.runCommand(step.command, step.argv));
    } catch (error) {
      if (isExitSignal(error)) {
        // The command has already said what went wrong.
        this.printStopped(step, completed);
        throw error;
      }
      throw new ConfigError(
        `${step.running}: this step failed.\n\n` +
          `  ${error instanceof Error ? error.message : String(error)}\n\n` +
          `  What had already been done:\n` +
          (completed.length === 0
            ? "    nothing"
            : completed.map((entry) => `    ${entry}`).join("\n"))
      );
    }

    completed.push(step.done);
  }

  /**
   * The steps about to run, as the command lines that run them.
   *
   * @param steps - The steps.
   */
  private printPlan(steps: ContributionStep[]): void {
    paragraph(steps.length === 1 ? "This runs one step:" : `This runs ${steps.length} steps:`);
    blankLine();
    for (const step of steps) {
      paragraph(`${BULLET} ${commandLine(step)}`, { indent: 4, hangingIndent: 2 });
    }
  }

  /**
   * What the branch holds, as a key and value list.
   *
   * @param work - What `pendingWork` found.
   */
  private printPendingWork(work: PendingWork): void {
    const base = work.baseBranch === undefined ? "upstream" : `origin/${work.baseBranch}`;
    showVariables({
      Branch: work.branch ?? "(none; HEAD is detached)",
      "Uncommitted changes": work.uncommitted.length,
      [`Commits ${base} lacks`]: work.ahead.length,
      "Commits not pushed": work.unpushed.length,
      "Pushed to": work.pushedCopies.length === 0 ? "nowhere yet" : work.pushedCopies.join(", "),
    });
    blankLine();
  }

  /**
   * The steps that completed, after the run finished.
   *
   * @param completed - The steps, in order.
   */
  private printCompleted(completed: string[]): void {
    section("What this run did");
    for (const entry of completed) paragraph(`${BULLET} ${entry}`, { indent: 4, hangingIndent: 2 });
  }

  /**
   * After a step failed: which step it was, and which had completed before it.
   *
   * @param step - The step that failed.
   * @param completed - The steps completed before it.
   */
  private printStopped(step: ContributionStep, completed: string[]): void {
    section("The contribution stopped");
    showVariables({ "Failed step": step.running });
    blankLine();
    if (completed.length === 0) {
      paragraph("No step had completed before it, and no later step ran.");
    } else {
      paragraph("These steps had completed before it, and no later step ran:");
      blankLine();
      for (const entry of completed) paragraph(`${BULLET} ${entry}`, { indent: 4, hangingIndent: 2 });
    }
    footer();
  }
}
