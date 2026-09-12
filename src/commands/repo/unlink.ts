import { Args, Flags } from "@oclif/core";
import { BaseCommand } from "../../base-command.js";
import { ConfigError } from "../../lib/errors.js";
import {
  readGlobalLinks,
  readProjectLinks,
  writeGlobalLinks,
  writeProjectLinks,
} from "../../lib/repos/links.js";
import {
  blankLine,
  dryRunNotice,
  footer,
  log,
  section,
  showCommandVars,
  showVariables,
} from "../../utils/formatting.js";

/**
 * `sous repo unlink` stops reading a repository from a working copy and goes
 * back to published versions.
 *
 * It only ever removes a map entry. The checkout stays exactly where it is,
 * because sous did not necessarily put it there, and even when it did, deleting
 * a directory that may hold uncommitted work is not something a command like
 * this should decide on its own. The path is printed so the user can delete it
 * themselves if they want to.
 */
export default class RepoUnlink extends BaseCommand {
  static description =
    "Stop reading a repository from a working copy and go back to published versions";

  /**
   * The other spelling of the topic. It lives under a hidden topic, so it is
   * typable everywhere without ever reaching the top-level listing.
   */
  static aliases = ["repos:unlink"];

  static examples = [
    "<%= config.bin %> repo unlink sous-recipes",
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
      description:
        "Remove the machine-wide link rather than this project's link",
      default: false,
    }),
    "dry-run": Flags.boolean({
      description: "Print what would change without writing anything",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(RepoUnlink);
    const { sousDir } = this.configContext;
    const isGlobal = flags.global;
    const name = args.repo;

    showCommandVars({
      Project: this.projectLabel,
      Repository: name,
      Scope: isGlobal ? "this machine" : "this project",
      "Dry Run": flags["dry-run"],
    });

    section("Unlinking a repository");

    const map = isGlobal ? readGlobalLinks() : readProjectLinks(sousDir);
    const entry = map.links[name];

    if (entry === undefined) {
      throw new ConfigError(this.notLinkedMessage(name, isGlobal, sousDir));
    }

    if (flags["dry-run"]) {
      dryRunNotice(`would unlink '${name}', which points at ${entry.path}`);
      dryRunNotice("the checkout itself would be left where it is");
      footer();
      return;
    }

    delete map.links[name];
    const linksPath = isGlobal ? writeGlobalLinks(map) : writeProjectLinks(sousDir, map);

    showVariables({
      Repository: name,
      "Checkout left at": entry.path,
      "Updated": linksPath,
    });

    blankLine();
    log(`  '${name}' now resolves to its published versions again.`);
    log(
      entry.origin === "clone"
        ? "  sous cloned that checkout; it has been left in place, and you may delete it."
        : "  That checkout was yours to begin with, and has not been touched."
    );

    footer();
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
