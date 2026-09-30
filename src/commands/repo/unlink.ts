import fs from "node:fs";
import path from "node:path";
import { Args, Flags } from "@oclif/core";
import { BaseCommand } from "../../base-command.js";
import { runProjectBuild } from "../../lib/build-service.js";
import { ConfigError, isConfigError } from "../../lib/errors.js";
import {
  NonInteractiveError,
  isInteractive,
  nonInteractiveError,
  wantsHelp,
} from "../../lib/interactive.js";
import {
  globalReposDir,
  projectReposDir,
  readGlobalLinks,
  readProjectLinks,
  writeGlobalLinks,
  writeProjectLinks,
} from "../../lib/repos/links.js";
import { hasNoUnsavedWork, unsavedWork, type UnsavedWork } from "../../lib/repos/git-clone.js";
import {
  subscriptionServiceFor,
  type SubscriptionService,
} from "../../lib/repos/subscription-service.js";
import type { RepoLink } from "../../lib/repos/formats/links-map.js";
import { collectProvidedAnswers } from "../../lib/vars/index.js";
import { formatAskReport } from "../../lib/vars/ask.js";
import {
  BULLET,
  blankLine,
  dryRunNotice,
  footer,
  heading,
  indent,
  log,
  note,
  paragraph,
  section,
  showCommandVars,
  showVariables,
  subheading,
  warning,
} from "../../utils/formatting.js";
import { askYesNo } from "../../utils/prompts.js";
import { answerFlags, confirmationFlag } from "../../utils/flags.js";

/**
 * `sous repo unlink` stops reading a repository from a working copy, goes back
 * to the versions the lockfile pins, and rebuilds the project.
 *
 * Linking never touches the lockfile, so unlinking returns to exactly the
 * versions pinned before the link. Three ways to finish, one per flag:
 *
 *   - On its own, it fetches the repository's index with a short timeout and
 *     reports, as a fact, any newer published version the ranges allow. Nothing
 *     moves.
 *   - `--update` runs the same code as `sous subscription update <repository>`,
 *     so the pins move to those newer versions before the rebuild.
 *   - `--remove` deletes the checkout, and only one sous cloned itself. A
 *     checkout linked by path belongs to its owner and is never deleted. Work
 *     that exists nowhere else is listed first and asked about.
 *
 * Without `--remove` the checkout stays exactly where it is, because `sous repo
 * submit` uses a leftover checkout to revise a proposal that is still open.
 */
export default class RepoUnlink extends BaseCommand {
  static description =
    "Stop reading a repository from a working copy and go back to its pinned versions";

  /**
   * The other spelling of the topic. It lives under a hidden topic, so it is
   * typable everywhere without ever reaching the top-level listing.
   */
  static aliases = ["repos:unlink"];

  static examples = [
    "<%= config.bin %> repo unlink sous-recipes",
    "<%= config.bin %> repo unlink sous-recipes --update",
    "<%= config.bin %> repo unlink sous-recipes --remove",
    "<%= config.bin %> repo unlink sous-recipes --global",
  ];

  static args = {
    repo: Args.string({
      description: "The repository's short name, as it appears in the links map",
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    global: Flags.boolean({
      description: "Remove the machine-wide link rather than this project's link",
      default: false,
    }),
    update: Flags.boolean({
      description:
        "Move this repository's pins to the newest versions their ranges allow before rebuilding",
      default: false,
    }),
    remove: Flags.boolean({
      description: "Delete the checkout as well, when sous cloned it",
      default: false,
    }),
    // One flag answers every question this command can ask: deleting a
    // checkout that holds work, the update plan, and the trust question for a
    // repository a newer version needs.
    yes: confirmationFlag({ extraAliases: ["trust"] }),
    "dry-run": Flags.boolean({
      description: "Print what would change without writing anything",
      default: false,
    }),
    "no-build": Flags.boolean({
      description: "Unlink without rebuilding the project",
      default: false,
    }),
    ...answerFlags(),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(RepoUnlink);
    const { sousDir } = this.configContext;
    const isGlobal = flags.global;
    const name = args.repo;
    const dryRun = flags["dry-run"];

    showCommandVars({
      Project: this.projectLabel,
      Repository: name,
      Scope: isGlobal ? "this machine" : "this project",
      "Dry Run": dryRun,
    });

    section("Unlinking a repository");

    const map = isGlobal ? readGlobalLinks() : readProjectLinks(sousDir);
    const entry = map.links[name];

    if (entry === undefined) {
      throw new ConfigError(this.notLinkedMessage(name, isGlobal, sousDir));
    }

    const service = subscriptionServiceFor({
      configContext: this.configContext,
      settings: this.settings,
      shellEnv: this.shellEnv,
    });

    // Everything that can refuse is settled before anything is written, so a
    // refusal leaves the link exactly as it was.
    if (flags.update && service.currentRepos()[name] === undefined) {
      throw new ConfigError(
        `'${name}' is linked, but this project does not trust a repository by that ` +
          `name, so it has no pins to update.\n` +
          `  Nothing was changed; the link is still in place.`
      );
    }
    if (flags.remove) this.assertRemovable(name, entry, isGlobal, sousDir);
    const work = flags.remove ? unsavedWork(entry.path) : undefined;

    if (dryRun) {
      dryRunNotice(`would unlink '${name}', which points at ${entry.path}`);
      dryRunNotice(
        flags.remove
          ? "the checkout would be deleted"
          : "the checkout itself would be left where it is"
      );
      if (work !== undefined && !hasNoUnsavedWork(work)) this.describeUnsavedWork(work);
      if (flags.update) await service.update({ repo: name, dryRun: true });
      footer();
      return;
    }

    if (work !== undefined) await this.confirmRemoval(entry.path, work, flags.yes);

    delete map.links[name];
    const linksPath = isGlobal ? writeGlobalLinks(map) : writeProjectLinks(sousDir, map);

    showVariables({
      Repository: name,
      Checkout: entry.path,
      Updated: linksPath,
    });

    blankLine();
    paragraph(`'${name}' is read from the versions the lockfile pins again.`);

    if (flags.update) {
      await this.updatePins(service, name, flags);
    } else {
      await this.reportNewerVersions(service, name);
    }

    if (flags.remove) {
      fs.rmSync(entry.path, { recursive: true, force: true });
      blankLine();
      paragraph(`The checkout sous cloned at ${entry.path} was deleted.`);
    } else {
      blankLine();
      paragraph(
        entry.origin === "clone"
          ? `The checkout sous cloned is still at ${entry.path}.`
          : `The checkout at ${entry.path} was yours to begin with, and has not been touched.`
      );
    }

    footer();

    if (!flags["no-build"]) await this.rebuildProject(name);
  }

  /**
   * Refuses to delete a checkout sous did not create, or one that is not where
   * sous clones to. The link records its origin; a path-linked checkout belongs
   * to whoever linked it.
   *
   * @param name - The repository's short name.
   * @param entry - The link being removed.
   * @param isGlobal - Whether it is the machine-wide link.
   * @param sousDir - The project's `.sous/` directory.
   */
  private assertRemovable(
    name: string,
    entry: RepoLink,
    isGlobal: boolean,
    sousDir: string
  ): void {
    if (entry.origin !== "clone") {
      throw new ConfigError(
        `Sous did not create the checkout at ${entry.path}, so it will not delete it.\n` +
          `  '${name}' was linked to a checkout that was already there. Nothing was ` +
          `changed; unlink without '--remove' to keep the checkout, and delete it ` +
          `yourself if you want it gone.`
      );
    }

    const root = isGlobal ? globalReposDir() : projectReposDir(sousDir);
    const relative = path.relative(root, entry.path);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new ConfigError(
        `The checkout at ${entry.path} is not inside ${root}, where sous clones ` +
          `checkouts, so sous will not delete it.\n` +
          `  Nothing was changed; unlink without '--remove' and delete it yourself if ` +
          `you want it gone.`
      );
    }
  }

  /**
   * Lists what deleting the checkout would lose, and asks before going on. A
   * checkout with nothing to lose is deleted without a question.
   *
   * @param checkout - The checkout's path.
   * @param work - What an inspection of it found.
   * @param yes - Whether the confirmation flag answered the question already.
   */
  private async confirmRemoval(
    checkout: string,
    work: UnsavedWork,
    yes: boolean
  ): Promise<void> {
    if (hasNoUnsavedWork(work)) return;

    this.describeUnsavedWork(work);
    if (yes) return;

    if (!isInteractive()) {
      throw nonInteractiveError({
        prompt: `whether to delete the checkout at ${checkout}, and the work listed above`,
        remedy:
          "pass '--yes' (spelled '-y', '--force' or '-f' if you prefer) to delete it " +
          "without being asked.",
      });
    }

    const proceed = await askYesNo("Delete the checkout, and this work with it?");
    if (!proceed) {
      throw new ConfigError(
        `Nothing was changed: the checkout at ${checkout} was not deleted, and the ` +
          `link is still in place.`
      );
    }
  }

  /**
   * Prints what exists only in the checkout, as a list.
   *
   * @param work - What an inspection of the checkout found.
   */
  private describeUnsavedWork(work: UnsavedWork): void {
    blankLine();
    warning("The checkout holds work that exists nowhere else, and deleting it loses that work.");
    blankLine();

    const group = (title: string, items: string[]): void => {
      if (items.length === 0) return;
      log(indent(title));
      for (const item of items) log(indent(`${BULLET} ${item}`, 4));
      blankLine();
    };

    if (work.unknown !== undefined) {
      group("Sous could not inspect it, so it may hold anything:", [work.unknown]);
    }
    group("Uncommitted changes:", work.uncommitted);
    group("Commits no remote has:", work.unpushed);
    group("Stashes:", work.stashes);
  }

  /**
   * Moves the repository's pins through the same code `sous subscription
   * update` runs. A failure there is reported with the fact that the link is
   * already gone, since that part has happened.
   *
   * @param service - The subscription service.
   * @param name - The repository's short name.
   * @param flags - The confirmation and answer flags.
   */
  private async updatePins(
    service: SubscriptionService,
    name: string,
    flags: { yes: boolean; answer?: string[]; "answers-file"?: string }
  ): Promise<void> {
    blankLine();
    subheading("Updating the pins");

    const provided = collectProvidedAnswers({
      ...(flags.answer === undefined ? {} : { answer: flags.answer }),
      ...(flags["answers-file"] === undefined ? {} : { answersFile: flags["answers-file"] }),
    });

    let outcome;
    try {
      outcome = await service.update({ repo: name, yes: flags.yes, answers: provided });
    } catch (error) {
      if (!isConfigError(error)) throw error;
      // The unlink has already happened, so the message says so before the
      // reason the update stopped. A blocked question keeps its kind, so the
      // command's help is still printed under it.
      const message =
        `'${name}' was unlinked, but its pins were not updated.\n` +
        `${(error as ConfigError).message}`;
      throw wantsHelp(error) ? new NonInteractiveError(message) : new ConfigError(message);
    }

    if (outcome.nothingToUpdate) return;

    blankLine();
    paragraph("The lockfile now pins the versions listed above.");

    if (outcome.answers !== undefined) {
      blankLine();
      subheading("Variables");
      for (const line of formatAskReport(outcome.answers)) log(line === "" ? "" : indent(line));
    }
  }

  /**
   * Says whether the repository publishes newer versions the ranges allow,
   * without moving anything. The index is fetched with a short timeout; when it
   * cannot be fetched, that is what is reported.
   *
   * @param service - The subscription service.
   * @param name - The repository's short name.
   */
  private async reportNewerVersions(service: SubscriptionService, name: string): Promise<void> {
    if (service.currentRepos()[name] === undefined) return;

    blankLine();
    subheading("Published versions");
    blankLine();

    const report = await service.newerPublishedVersions(name);
    if (!report.checked) {
      note(
        `Sous could not check '${name}' for newer published versions. ` +
          `${report.reason.split("\n")[0]!.trim()}`
      );
      return;
    }

    if (report.newer.length === 0) {
      paragraph(
        `Every pin from '${name}' is the newest published version its range allows.`
      );
      return;
    }

    paragraph(
      `'${name}' publishes newer versions within range. The lockfile still pins the ` +
        `older ones:`
    );
    blankLine();
    showVariables(
      report.newer.map((entry) => ({
        label: entry.key,
        value: `${entry.from} pinned, ${entry.to} published`,
      }))
    );
  }

  /**
   * Rebuilds the project, so its outputs come from the pinned versions rather
   * than the checkout when this command returns.
   *
   * @param name - The repository that was unlinked, for the failure message.
   */
  private async rebuildProject(name: string): Promise<void> {
    await this.reloadDiscoveredConfig();

    const succeeded = await runProjectBuild({
      settings: this.settings,
      configContext: this.configContext,
      shellEnv: this.shellEnv,
      heading: "Building the project",
    });

    if (!succeeded) {
      throw new ConfigError(
        `'${name}' was unlinked, but the build that followed failed, so this project's ` +
          `outputs may still hold what the checkout contributed. The unlink itself is ` +
          `recorded; fix what the build reported above and run 'sous build' again.`
      );
    }
  }

  /**
   * Explains that nothing was unlinked, and says where the link actually is
   * when the user asked about the wrong scope; getting the scope wrong is the
   * easiest mistake to make here.
   *
   * @param name - The repository's short name, as the user typed it.
   * @param isGlobal - Which map was searched.
   * @param sousDir - The project's discovered `.sous/` directory.
   */
  private notLinkedMessage(name: string, isGlobal: boolean, sousDir: string): string {
    const searched = isGlobal ? "the machine-wide links map" : "this project's links map";
    const other = isGlobal ? readProjectLinks(sousDir) : readGlobalLinks();

    if (other.links[name] !== undefined) {
      const flag = isGlobal ? "without --global" : "with --global";
      return (
        `'${name}' is not linked in ${searched}.\n` +
          `  It is linked in the ${isGlobal ? "project" : "machine-wide"} map, at ` +
          `${other.links[name]!.path}.\n` +
          `  Run the same command ${flag} to remove that one.`
      );
    }

    const map = isGlobal ? readGlobalLinks() : readProjectLinks(sousDir);
    const linked = Object.keys(map.links).sort();
    return (
      `'${name}' is not linked in ${searched}.\n` +
        (linked.length > 0
          ? `  Linked there: ${linked.join(", ")}.\n`
          : `  Nothing is linked there.\n`) +
        `  Run 'sous repo link ${name}' to link it.`
    );
  }
}
