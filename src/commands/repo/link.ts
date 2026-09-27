import fs from "node:fs";
import path from "node:path";
import { Args, Flags } from "@oclif/core";
import { BaseCommand } from "../../base-command.js";
import { ConfigError } from "../../lib/errors.js";
import {
  MANIFEST_EXTENSIONS,
  REPO_MANIFEST_BASENAME,
} from "../../lib/repos/formats/common.js";
import { findRepoManifest } from "../../lib/repos/load-manifest.js";
import { enabledRepos } from "../../lib/repos/defaults.js";
import { subscriptionServiceFor } from "../../lib/repos/subscription-service.js";
import type { LinkOrigin } from "../../lib/repos/formats/links-map.js";
import {
  assertBranchName,
  cloneRepo,
  compareWithUpstream,
  createBranch,
  currentBranch,
  defaultBranch,
  discardableWork,
  fetchBranch,
  generatedBranchName,
  isGitCheckout,
  lastFetchedAt,
  localBranchExists,
  looksLikeRepoUrl,
  remoteUrlOf,
  repoSlugFromUrl,
  resetBranchToUpstream,
  sameRemote,
  switchBranch,
  tryFetchUpstream,
  UPSTREAM_REMOTE,
  type DiscardableWork,
} from "../../lib/repos/git-clone.js";
import { isInteractive, nonInteractiveError } from "../../lib/interactive.js";
import { askYesNo } from "../../utils/prompts.js";
import {
  assertLocalRepoDirectory,
  expandHomePath,
  looksLikeLocalPath,
  resolveRepoArgument,
} from "../../lib/repos/providers/local.js";
import { readRepoManifestIn } from "../../lib/repos/locked-recipes.js";
import {
  ensureReposIgnoreFiles,
  globalReposDir,
  projectReposDir,
  readGlobalLinks,
  readProjectLinks,
  writeGlobalLinks,
  writeProjectLinks,
} from "../../lib/repos/links.js";
import {
  BULLET,
  blankLine,
  dryRunNotice,
  footer,
  heading,
  log,
  note,
  paragraph,
  showCommandVars,
  showVariable,
  showVariables,
  warning,
} from "../../utils/formatting.js";
import { confirmationFlag } from "../../utils/flags.js";
import {
  ensureGlobalReposDirectory,
  ensureProjectReposDirectory,
} from "../../utils/sous-directory.js";

/**
 * `sous repo link` points this project (or this machine) at a working copy of a
 * repository instead of at a published version, which is how a maintainer edits
 * recipes: edits happen in a checkout, never in the store.
 *
 * The command is written three ways. A path on its own links the checkout that
 * is already at that path, in place. A repository name (or URL) on its own
 * clones the repository into `.sous/repos/<owner>/<name>`, or into
 * `$SOUS_HOME/repos/<owner>/<name>` with --global, where two projects can share
 * one checkout. A name (or URL) followed by a path links the checkout at that
 * path to that repository, and clones nothing.
 *
 * A linked repository's recipes are read from the checkout with no version, no
 * lockfile and no hash check, so linking one is at least as consequential as
 * adding one. Naming a repository this project has not added therefore runs the
 * same trust ceremony `sous repo add` runs, rather than skipping it; there is no
 * way to read from a repository this project does not trust.
 *
 * A link says nothing about WHY a checkout is being read (authoring, running a
 * teammate's branch, a local fork, debugging), so the command never changes a
 * checkout on its own. A checkout that was already on disk is fetched and
 * compared with upstream, which changes none of its files or branches; every
 * change to it is an explicit flag (`--branch`, `--create-branch`,
 * `--generate-branch`, `--latest`), carried out by git, whose refusals are
 * passed through. `--latest` is the one place sous checks for itself, because
 * making a branch match upstream discards local work without git warning.
 */
export default class RepoLink extends BaseCommand {
  static description = [
    "Point a repository at a working copy on this machine instead of a published version",
    "",
    "'sous repo link <path>' links the checkout already at that path, where it is, " +
      "adding the repository to this project first if it has not been added yet.",
    "'sous repo link <name-or-url>' clones the repository into .sous/repos and links " +
      "that clone.",
    "'sous repo link <name-or-url> <path>' links the checkout at that path to that " +
      "repository, and clones nothing.",
    "A checkout that was already on disk is fetched and compared with upstream; " +
      "only the branch flags and --latest change it.",
  ].join("\n");

  /**
   * The other spelling of the topic. It lives under a hidden topic, so it is
   * typable everywhere without ever reaching the top-level listing.
   */
  static aliases = ["repos:link"];

  static examples = [
    "<%= config.bin %> repo link ../sous-recipes",
    "<%= config.bin %> repo link sous-recipes",
    "<%= config.bin %> repo link sous-recipes ~/Projects/sous-recipes",
    "<%= config.bin %> repo link https://github.com/sous-io/sous-recipes",
    "<%= config.bin %> repo link sous-recipes --global",
    "<%= config.bin %> repo link sous-recipes --latest",
    "<%= config.bin %> repo link sous-recipes --generate-branch",
    "<%= config.bin %> repo link sous-recipes --branch my-change --latest",
  ];

  static args = {
    repo: Args.string({
      description:
        "The repository's short name from this project's config, its full URL, or the " +
        "path of a checkout to link in place",
      required: true,
    }),
    path: Args.string({
      description:
        "An existing checkout to link. Without it, the repository is cloned.",
      required: false,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    global: Flags.boolean({
      description:
        "Link for every project on this machine, sharing one checkout, rather than for this project",
      default: false,
    }),
    // Linking a repository this project has not added yet asks the trust
    // question first; the shared confirmation flag answers it, under `--trust`
    // as well as the usual spellings.
    yes: confirmationFlag({ extraAliases: ["trust"] }),
    "dry-run": Flags.boolean({
      description: "Print what would change without cloning or writing anything",
      default: false,
    }),
    branch: Flags.string({
      description: "Switch the checkout to this existing branch, fetching it from upstream first",
      helpValue: "<name>",
      exclusive: ["create-branch", "generate-branch"],
    }),
    "create-branch": Flags.string({
      description: "Create this new branch in the checkout and switch to it",
      helpValue: "<name>",
      exclusive: ["branch", "generate-branch"],
    }),
    "generate-branch": Flags.boolean({
      description: "Create a new branch named sous/edit-<date>-<time> in the checkout and switch to it",
      exclusive: ["branch", "create-branch"],
    }),
    from: Flags.string({
      description:
        "Start the new branch from this branch instead of the repository's default branch",
      helpValue: "<branch>",
      // oclif's `dependsOn` wants every listed flag, and these two exclude each
      // other; `some` is its spelling of "at least one of".
      relationships: [{ type: "some", flags: ["create-branch", "generate-branch"] }],
    }),
    latest: Flags.boolean({
      description:
        "Make the branch being worked from match upstream's, after listing any local work that would be discarded",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(RepoLink);
    const { sousDir } = this.configContext;
    const isGlobal = flags.global;
    const dryRun = flags["dry-run"];

    // A path in the REPO slot means "link the checkout that is already here",
    // so it settles both what is being linked and where it lives; a second path
    // would have to contradict one of the two.
    const checkout = this.checkoutInRepoSlot(args.repo);
    if (checkout !== undefined && args.path !== undefined) {
      throw new ConfigError(
        `'${args.repo}' is the path of a checkout on this machine, so it already says ` +
          `which checkout to link, and a second path cannot say it again.\n` +
          `  Link a checkout where it already is:  sous repo link ${args.repo}\n` +
          `  Link a checkout to a named repository: sous repo link <name-or-url> ` +
          `${args.path}\n` +
          `  Drop whichever of the two paths you did not mean.`
      );
    }

    const { name, url } = await this.resolveRepo(
      args.repo,
      flags.yes,
      dryRun,
      checkout
    );

    showCommandVars({
      Project: this.projectLabel,
      Repository: name,
      Location: url ?? "(not needed; an existing checkout was given)",
      Scope: isGlobal ? "this machine" : "this project",
      "Dry Run": dryRun,
    });

    // The heading is not followed by a blank line here: the block that comes
    // next opens with one of its own, and the trust ceremony this may run
    // prints in between.
    heading("Linking a repository");

    // Both written forms that name a checkout link it exactly where it is; only
    // a repository named on its own is cloned.
    const existingCheckout = checkout ?? args.path;
    const plan =
      existingCheckout !== undefined
        ? this.planLinkToPath(existingCheckout)
        : this.planClone(name, url, isGlobal, dryRun);

    const request = branchRequestFrom(flags);

    if (dryRun) {
      blankLine();
      dryRunNotice(`would link '${name}' to ${plan.directory}`);
      for (const line of describeBranchRequest(request)) dryRunNotice(line);
      dryRunNotice(
        `would record it in ${isGlobal ? "the machine-wide" : "this project's"} links map`
      );
      footer();
      return;
    }

    // Branch work happens before the link is recorded, so a step git refuses
    // leaves no link pointing at a checkout in a state nobody asked for.
    if (hasBranchWork(request)) {
      if (isGlobal) {
        warning(
          `This checkout is SHARED by every project on this machine that links '${name}' ` +
            `with --global.\n` +
            `Changing its branch changes what all of them build from.`
        );
      }
      plan.notes.push(...(await this.applyBranchRequest(plan.directory, request, flags.yes)));
    }

    const map = isGlobal ? readGlobalLinks() : readProjectLinks(sousDir);
    const previous = map.links[name];
    map.links[name] = {
      path: plan.directory,
      linkedAt: new Date().toISOString(),
      origin: plan.origin,
    };

    const linksPath = isGlobal ? writeGlobalLinks(map) : writeProjectLinks(sousDir, map);

    // Ignore hygiene runs for both scopes. Both files are idempotent, and a
    // project that links anything at all wants its machine-local sous files kept
    // out of version control whichever scope the link was recorded in.
    ensureReposIgnoreFiles(sousDir);

    blankLine();
    for (const line of plan.notes) log(`  ${line}`);
    if (plan.notes.length > 0) blankLine();

    const branch = isGitCheckout(plan.directory) ? currentBranch(plan.directory) : undefined;
    showVariables({
      Repository: name,
      Checkout: plan.directory,
      ...(branch === undefined ? {} : { Branch: branch }),
      "Recorded in": linksPath,
    });

    if (previous !== undefined && previous.path !== plan.directory) {
      blankLine();
      log(`  This replaces an earlier link to ${previous.path}, which is untouched.`);
    }

    // A checkout sous has just cloned is as current as upstream by definition;
    // any other one may be days or months old, so say how it compares.
    if (plan.kind !== "cloned") this.reportUpstream(plan.directory);

    warning(
      `The repository '${name}' is now LINKED.\n` +
        `Its recipes are read from the checkout above, so versions, the lockfile\n` +
        `and freshness checks no longer apply to it. Builds say so every time.\n` +
        `\n` +
        `Run 'sous repo unlink ${name}${isGlobal ? " --global" : ""}' to go back to ` +
        `published versions.`
    );

    footer();
  }

  /**
   * Carries out the branch flags on the checkout, in order: `--latest` first
   * (which switches to the branch being worked from and makes it match
   * upstream's), then `--branch` when `--latest` did not already switch to it,
   * then the new branch. Git decides whether each step may happen; the one
   * thing checked here is what `--latest` would discard, because making a
   * branch match upstream discards work without git warning about it.
   *
   * @param directory - The checkout.
   * @param request - What the flags asked for.
   * @param yes - The confirmation flag, which answers the discard question.
   * @returns Lines describing what was done, for the notes block.
   */
  private async applyBranchRequest(
    directory: string,
    request: BranchRequest,
    yes: boolean
  ): Promise<string[]> {
    if (!isGitCheckout(directory)) {
      throw new ConfigError(
        `${directory} is not a git checkout, so it has no branches to switch or create.\n` +
          `  Link it without the branch flags, or turn it into a git repository first.`
      );
    }

    for (const name of [request.switchTo, request.create, request.from]) {
      if (name !== undefined) assertBranchName(directory, name);
    }

    const hasUpstream = remoteUrlOf(directory) !== undefined;
    const needsDefault =
      (request.create !== undefined && request.from === undefined) ||
      (request.latest && request.switchTo === undefined && request.from === undefined);
    const fallback = needsDefault ? this.requireDefaultBranch(directory) : undefined;
    const notes: string[] = [];

    if (request.latest) {
      const target = (request.switchTo ?? request.from ?? fallback)!;
      if (!hasUpstream) {
        throw new ConfigError(
          `--latest makes '${target}' match upstream's, and this checkout has no ` +
            `'${UPSTREAM_REMOTE}' remote to be upstream.\n` +
            `  Add one with 'git remote add ${UPSTREAM_REMOTE} <url>' in ${directory}, or ` +
            `link without --latest.`
        );
      }
      fetchBranch(directory, target);
      const work = discardableWork(directory, target);
      await this.confirmDiscard(target, work, yes);
      resetBranchToUpstream(directory, target);
      notes.push(`Made the branch '${target}' match ${UPSTREAM_REMOTE}/${target}.`);
    } else if (request.switchTo !== undefined) {
      // A branch that exists locally is switched to as it is; one that does not
      // is fetched first, since a single-branch clone cannot see it otherwise.
      if (hasUpstream && !localBranchExists(directory, request.switchTo)) {
        fetchBranch(directory, request.switchTo);
      }
      switchBranch(directory, request.switchTo);
      notes.push(`Switched to the branch '${request.switchTo}'.`);
    }

    if (request.create !== undefined) {
      const base = (request.from ?? fallback)!;
      let startPoint = base;
      if (hasUpstream) {
        // With --latest the base was fetched a moment ago.
        if (!request.latest) fetchBranch(directory, base);
        startPoint = `${UPSTREAM_REMOTE}/${base}`;
      }
      createBranch(directory, request.create, startPoint);
      notes.push(
        request.generated
          ? `Created the branch '${request.create}' (a generated name) from ${startPoint}, ` +
              `and switched to it.`
          : `Created the branch '${request.create}' from ${startPoint}, and switched to it.`
      );
    }

    return notes;
  }

  /**
   * The upstream default branch, or a ConfigError saying it could not be
   * worked out and which flag names a branch instead.
   *
   * @param directory - The checkout.
   */
  private requireDefaultBranch(directory: string): string {
    const found = defaultBranch(directory);
    if (found !== undefined) return found;
    throw new ConfigError(
      `Could not work out the default branch of the repository checked out at ${directory}.\n` +
        `  git records it as '${UPSTREAM_REMOTE}/HEAD' when it clones, and this checkout ` +
        `has no such record, nor could '${UPSTREAM_REMOTE}' be asked for it.\n` +
        `  Name the branch to work from with --from, or with --branch.`
    );
  }

  /**
   * Lists what `--latest` would discard and asks once before going on. Nothing
   * is asked when there is nothing to discard, and the confirmation flag
   * answers the question ahead of time.
   *
   * @param branch - The branch being made to match upstream's.
   * @param work - What would be discarded.
   * @param yes - The confirmation flag.
   */
  private async confirmDiscard(
    branch: string,
    work: DiscardableWork,
    yes: boolean
  ): Promise<void> {
    if (work.uncommitted.length === 0 && work.localCommits.length === 0) return;

    blankLine();
    paragraph(
      `Making '${branch}' match ${UPSTREAM_REMOTE}/${branch} discards the local work below.`,
      { indent: 2 }
    );
    if (work.uncommitted.length > 0) {
      blankLine();
      showVariable("Uncommitted changes", work.uncommitted.length);
      for (const line of work.uncommitted) log(`      ${BULLET} ${line}`);
    }
    if (work.localCommits.length > 0) {
      blankLine();
      showVariable(`Commits ${UPSTREAM_REMOTE} does not have`, work.localCommits.length);
      for (const line of work.localCommits) log(`      ${BULLET} ${line}`);
    }

    if (yes) return;

    if (!isInteractive()) {
      throw nonInteractiveError({
        prompt: `whether to discard the local work on '${branch}' listed above`,
        remedy:
          "pass '--yes' (spelled '-y', '--force' or '--trust' if you prefer) to discard it " +
          "without being asked.",
      });
    }

    const proceed = await askYesNo("Discard it?");
    if (!proceed) {
      throw new ConfigError(
        `Nothing was changed: the local work on '${branch}' was kept.\n` +
          `  The checkout is on the branch it was on before, and no link was recorded.`
      );
    }
  }

  /**
   * Says how a checkout that was already on disk compares with upstream. A
   * short fetch comes first; it updates only the remote-tracking refs, never
   * the user's files or branches. When upstream cannot be reached, the link
   * still stands and the warning says since when the checkout may have
   * diverged.
   *
   * @param directory - The checkout.
   */
  private reportUpstream(directory: string): void {
    if (!isGitCheckout(directory)) return;

    blankLine();
    if (remoteUrlOf(directory) === undefined) {
      note(
        `The checkout has no '${UPSTREAM_REMOTE}' remote, so there is no upstream to ` +
          `compare it with.`,
        { indent: 2 }
      );
      return;
    }

    const fetched = tryFetchUpstream(directory);
    const branch = defaultBranch(directory);

    if (!fetched.ok) {
      const since = lastFetchedAt(directory, branch);
      warning(
        `Could not reach upstream; the checkout may have diverged since ` +
          (since === undefined
            ? `it was last fetched, and git has no record of when that was.`
            : `${formatWhen(since)}, when it was last fetched.`) +
          `\n\nGit said:\n${fetched.reason}\n\n` +
          `The link was recorded all the same, and nothing in the checkout was changed.`
      );
      return;
    }

    if (branch === undefined) {
      note(
        `Upstream was fetched, but its default branch could not be worked out, so there ` +
          `is nothing to compare the checkout with.`,
        { indent: 2 }
      );
      return;
    }

    const comparison = compareWithUpstream(directory, branch);
    const upstream = `${UPSTREAM_REMOTE}/${branch}`;
    const yesNo = (value: boolean | undefined) =>
      value === undefined ? "unknown" : value ? "yes" : "no";

    // The branch is already in the summary above; a detached HEAD has none
    // there, so it is named here instead.
    showVariables({
      ...(comparison.branch === undefined
        ? { "Checked out": `no branch; HEAD is detached at ${comparison.commit ?? "an unknown commit"}` }
        : {}),
      "Compared with": upstream,
      [`Merged into ${upstream}`]: yesNo(comparison.merged),
      [`Behind ${upstream}`]:
        comparison.behind === undefined
          ? "unknown"
          : `${comparison.behind} ${comparison.behind === 1 ? "commit" : "commits"}`,
    });
    blankLine();
    note(`Upstream was fetched just now; nothing in the checkout was changed.`, {
      indent: 2,
    });
  }

  /**
   * The checkout a REPO argument names outright, as an absolute path, or
   * undefined when the argument is a short name or a URL instead.
   *
   * A repository this project has already added wins, because a short name is
   * what a person types most often and a directory of the same name sitting in
   * the working directory must not quietly take its place. Anything else that
   * reads as a path is checked here rather than later: the directory has to
   * exist and hold a repo manifest, and the message explains the path itself
   * when it does not.
   *
   * @param input - The repo argument as the user typed it.
   */
  private checkoutInRepoSlot(input: string): string | undefined {
    if (enabledRepos(this.settings)[input] !== undefined) return undefined;
    if (!looksLikeLocalPath(input)) return undefined;

    const resolved = resolveRepoArgument(input);
    assertLocalRepoDirectory(input, resolved);
    return resolved;
  }

  /**
   * Works out which repository is being linked and where it lives. A short name
   * is looked up in the project's `repos:` config, which is where `sous repo
   * add` records a trusted repository.
   *
   * Neither a URL nor a path is taken on its own. Linking reads recipes straight
   * out of a checkout, so either one, for a repository this project has not
   * added, goes through `addRepo`, which is the trust ceremony: it asks (or
   * requires `--trust`), writes the repository into the managed layer, and
   * refuses outright when the short name it derives already belongs to a
   * different repository. Only then is anything linked or cloned.
   *
   * @param input - The repo argument as the user typed it.
   * @param trustFlag - The `--trust` flag, passed through to the ceremony.
   * @param dryRun - When true, nothing is trusted, written or downloaded.
   * @param checkout - The checkout the repo argument named, when it named one.
   */
  private async resolveRepo(
    input: string,
    trustFlag: boolean,
    dryRun: boolean,
    checkout?: string
  ): Promise<{ name: string; url?: string }> {
    const configured = enabledRepos(this.settings)[input];
    if (configured !== undefined) {
      return { name: input, url: configured.url };
    }

    // A checkout named in the REPO slot is registered from where it already is;
    // its own manifest suggests the short name, falling back to the directory's
    // name, which is what `addRepo` uses when it is given none.
    if (checkout !== undefined) {
      const suggested = suggestedShortName(checkout);
      const outcome = await this.addThroughCeremony(
        checkout,
        trustFlag,
        dryRun,
        suggested === undefined ? {} : { name: suggested }
      );
      return { name: outcome.name, url: outcome.url };
    }

    if (looksLikeRepoUrl(input)) {
      const outcome = await this.addThroughCeremony(input, trustFlag, dryRun, {});
      return { name: outcome.name, url: outcome.url };
    }

    const known = Object.keys(enabledRepos(this.settings)).sort();
    const knownList =
      known.length > 0
        ? `  This project knows about: ${known.join(", ")}.\n`
        : "  This project has no repositories configured yet.\n";

    throw new ConfigError(
      `'${input}' is not a repository this project knows about, and it is neither a URL ` +
        `nor the path of a checkout on this machine.\n` +
        knownList +
        `  Add the repository first with 'sous repo add <url>', then link it by its ` +
        `short name.`
    );
  }

  /**
   * Runs the trust ceremony for a repository this project has not added, and
   * reports the name and location it was recorded under. Nothing is trusted,
   * written or downloaded on a dry run.
   *
   * @param location - The repository's URL, or the absolute path of one on this machine.
   * @param trustFlag - The `--trust` flag, passed through to the ceremony.
   * @param dryRun - When true, work out what would happen and write nothing.
   * @param naming - The short name to record it under, when one has been worked out.
   */
  private async addThroughCeremony(
    location: string,
    trustFlag: boolean,
    dryRun: boolean,
    naming: { name?: string }
  ): Promise<{ name: string; url: string }> {
    const service = subscriptionServiceFor({
      configContext: this.configContext,
      settings: this.settings,
      shellEnv: this.shellEnv,
    });

    const outcome = await service.addRepo({
      url: location,
      ...naming,
      trust: trustFlag,
      dryRun,
    });

    return { name: outcome.name, url: outcome.url };
  }

  /**
   * Plans a link to a checkout that already exists. The directory must be there
   * and must hold a repo manifest, because a directory without one is not a
   * repository and linking it would fail later, further from the mistake.
   *
   * @param given - The path as the user typed it, resolved against the working directory.
   */
  private planLinkToPath(given: string): LinkPlan {
    const directory = path.resolve(process.cwd(), expandHomePath(given));

    if (!fs.existsSync(directory)) {
      throw new ConfigError(
        `There is no directory at ${directory}.\n` +
          `  Pass the path of a checkout that already exists, or leave the path off ` +
          `to have sous clone the repository for you.`
      );
    }

    if (!fs.statSync(directory).isDirectory()) {
      throw new ConfigError(
        `${directory} is a file, not a directory.\n` +
          `  Pass the root directory of a repository checkout.`
      );
    }

    const manifest = findRepoManifest(directory);
    if (manifest === undefined) {
      throw new ConfigError(
        `${directory} is not a sous repository.\n` +
          `  A repository declares itself with a '${REPO_MANIFEST_BASENAME}` +
          `${MANIFEST_EXTENSIONS[0]}' file at its root, and there is none there.\n` +
          `  Check the path, or create a repository with 'sous repo init'.`
      );
    }

    return {
      directory,
      origin: "path",
      kind: "path",
      notes: [`Linked the checkout already at ${directory}.`],
    };
  }

  /**
   * Plans a link backed by a clone. A directory that is already a checkout of
   * the same repository is reused rather than re-cloned, so running the command
   * twice is harmless; a checkout of a different repository in the same place is
   * an error, because silently reading the wrong recipes would be worse than
   * stopping.
   *
   * @param name - The repository's short name.
   * @param url - Where the repository lives.
   * @param isGlobal - Whether the checkout is shared by every project on the machine.
   * @param dryRun - When true, work the plan out but clone nothing.
   */
  private planClone(
    name: string,
    url: string | undefined,
    isGlobal: boolean,
    dryRun: boolean
  ): LinkPlan {
    if (url === undefined) {
      throw new ConfigError(
        `sous does not know where the repository '${name}' lives, so it cannot clone it.\n` +
          `  Add it with 'sous repo add <url>', or pass the path of a checkout that ` +
          `already exists.`
      );
    }

    const slug = repoSlugFromUrl(url);
    const base = isGlobal ? globalReposDir() : projectReposDir(this.configContext.sousDir);
    const directory = path.join(base, slug.owner, slug.name);

    if (isGitCheckout(directory)) {
      const existing = remoteUrlOf(directory);
      if (existing !== undefined && !sameRemote(existing, url)) {
        throw new ConfigError(
          `${directory} is already a checkout of a different repository.\n` +
            `  It points at ${existing}, but '${name}' is ${url}.\n` +
            `  Move or delete that directory, or pass an explicit path to link the ` +
            `checkout you meant.`
        );
      }

      return {
        directory,
        origin: "clone",
        kind: "reused",
        notes: [
          `Reused the checkout already at ${directory}; nothing was cloned.`,
        ],
      };
    }

    if (dryRun) {
      return {
        directory,
        origin: "clone",
        kind: "cloned",
        notes: [`Would clone ${url} into ${directory}.`],
      };
    }

    // The directory holding the checkouts gets its README before the clone puts
    // anything in it, whichever scope the link is for.
    if (isGlobal) ensureGlobalReposDirectory(base);
    else ensureProjectReposDirectory(base);

    log(`  Cloning ${url} into ${directory} ...`);
    const clone = cloneRepo(url, directory);

    const manifest = findRepoManifest(directory);
    if (manifest === undefined) {
      throw new ConfigError(
        `${url} was cloned into ${directory}, but it is not a sous repository.\n` +
          `  A repository declares itself with a '${REPO_MANIFEST_BASENAME}` +
          `${MANIFEST_EXTENSIONS[0]}' file at its root, and there is none there.\n` +
          `  The checkout has been left in place so you can look at it.`
      );
    }

    const notes = [`Cloned ${url} into ${directory}.`];
    if (clone.fellBackToFullClone) {
      notes.push(
        "That remote would not serve a shallow clone, so the full history was fetched."
      );
    }

    return { directory, origin: "clone", kind: "cloned", notes };
  }
}

/**
 * The short name a checkout suggests for itself: the `name` its repo manifest
 * declares. Undefined when the manifest cannot be read or validated, which
 * leaves the caller with the directory's own name; a working copy is edited by
 * hand and is allowed to be mid-change, so an unreadable manifest is not a
 * reason to refuse the link.
 *
 * @param directory - The checkout's root directory.
 */
function suggestedShortName(directory: string): string | undefined {
  try {
    return readRepoManifestIn(directory)?.name;
  } catch {
    return undefined;
  }
}

/** Where a link will point, how the working copy got there, and what to report. */
type LinkPlan = {
  /** Absolute path to the working copy. */
  directory: string;
  /** Whether sous cloned it or was pointed at it. */
  origin: LinkOrigin;
  /**
   * What this run did to get the checkout: cloned it just now, reused a clone
   * already in place, or was given the path of one.
   */
  kind: "cloned" | "reused" | "path";
  /** Lines describing what happened, printed before the summary. */
  notes: string[];
};

/** What the branch flags asked for, with a generated name already chosen. */
type BranchRequest = {
  /** `--branch`: the existing branch to switch to. */
  switchTo?: string;
  /** `--create-branch` or `--generate-branch`: the branch to create. */
  create?: string;
  /** True when the name to create was generated rather than typed. */
  generated: boolean;
  /** `--from`: the base of the new branch; the default branch when unset. */
  from?: string;
  /** `--latest`: make the branch being worked from match upstream's. */
  latest: boolean;
};

/**
 * Reads the branch flags into one request. The generated name is chosen here,
 * once, so the dry run and the real run would print the same thing.
 *
 * @param flags - The parsed flags.
 */
function branchRequestFrom(flags: {
  branch?: string;
  "create-branch"?: string;
  "generate-branch"?: boolean;
  from?: string;
  latest: boolean;
}): BranchRequest {
  const generated = flags["generate-branch"] === true;
  const create = generated ? generatedBranchName() : flags["create-branch"];
  return {
    ...(flags.branch === undefined ? {} : { switchTo: flags.branch }),
    ...(create === undefined ? {} : { create }),
    generated,
    ...(flags.from === undefined ? {} : { from: flags.from }),
    latest: flags.latest,
  };
}

/** True when the request asks for anything to be done to the checkout. */
function hasBranchWork(request: BranchRequest): boolean {
  return request.switchTo !== undefined || request.create !== undefined || request.latest;
}

/**
 * What a dry run says the branch flags would do, one line per step, in the
 * order the real run takes them.
 *
 * @param request - The branch request.
 */
function describeBranchRequest(request: BranchRequest): string[] {
  const lines: string[] = [];
  const workingFrom = request.switchTo ?? request.from ?? "the default branch";
  const quoted = (name: string) => (name === "the default branch" ? name : `'${name}'`);

  if (request.latest) {
    lines.push(
      `would fetch ${quoted(workingFrom)}, list any local work on it that would be ` +
        `discarded, and make it match upstream's`
    );
  } else if (request.switchTo !== undefined) {
    lines.push(`would switch the checkout to the branch '${request.switchTo}'`);
  }

  if (request.create !== undefined) {
    lines.push(
      `would create the branch '${request.create}' from upstream's ` +
        `${quoted(request.from ?? "the default branch")} and switch to it`
    );
  }
  return lines;
}

/**
 * Renders a moment as `YYYY-MM-DD HH:MM` in local time, which is what a person
 * reads a "since when" as.
 *
 * @param when - The moment to render.
 */
function formatWhen(when: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ` +
    `${pad(when.getHours())}:${pad(when.getMinutes())}`
  );
}
