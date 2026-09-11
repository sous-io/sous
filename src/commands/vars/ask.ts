/**
 * `sous vars ask [name]`.
 *
 * Asks the questions the project's variable definitions imply and stores the
 * answers in `.sous/.env` or `.sous/.env.local`. By default it asks only what
 * is unanswered or no longer fits; `--all` asks everything again, and naming a
 * variable asks just that one. `--file` reads a standalone definitions file
 * instead of the project's recipes, which is how a project asks questions no
 * recipe publishes yet.
 *
 * Without a terminal the command never hangs waiting on a prompt: it fails and
 * names the exact environment variables that would answer each question.
 */

import path from "node:path";
import { Args, Flags } from "@oclif/core";
import { BaseCommand } from "../../base-command.js";
import { ConfigError } from "../../lib/errors.js";
import {
  askForMissing,
  definedVariableKey,
  FileDefinitionSource,
  formatAskReport,
  loadLadderContext,
  loadProjectDefinitions,
  type DefinedVariable,
} from "../../lib/vars/index.js";
import {
  blankLine,
  dryRunNotice,
  footer,
  heading,
  indent,
  log,
  showCommandVars,
} from "../../utils/formatting.js";

/** True when a name (bare, or the full namespace/recipe.name key) names this variable. */
function matchesName(defined: DefinedVariable, name: string): boolean {
  return defined.definition.name === name || definedVariableKey(defined) === name;
}

export default class VarsAsk extends BaseCommand {
  static description =
    "Answer the variables this project's recipes define, storing the answers in the .sous env files";

  /**
   * The other spelling of the topic. It lives under a hidden topic, so it is
   * typable everywhere without ever reaching the top-level listing.
   */
  static aliases = ["var:ask"];

  static examples = [
    "<%= config.bin %> vars ask",
    "<%= config.bin %> vars ask apiUrl",
    "<%= config.bin %> vars ask --all",
    "<%= config.bin %> vars ask --file ./questions.yaml",
  ];

  static args = {
    name: Args.string({
      description: "Answer only this variable (by name, or by namespace/recipe.name key)",
      required: false,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    all: Flags.boolean({
      description: "Ask every variable again, including the ones already answered",
      default: false,
    }),
    file: Flags.string({
      description:
        "Read the variable definitions from a standalone definitions file instead of the project's recipes",
    }),
    "dry-run": Flags.boolean({
      description: "Report what would be asked and written, without writing anything",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(VarsAsk);
    const dryRun = flags["dry-run"];

    showCommandVars({
      Project: this.projectLabel,
      Config: this.configContext.configPath,
      Definitions: flags.file ?? "the project's subscribed recipes",
      Asking: args.name ?? (flags.all ? "every variable" : "everything unanswered"),
    });

    if (dryRun) dryRunNotice("No answers will be written.");

    const source =
      flags.file === undefined
        ? loadProjectDefinitions(this.settings, this.configContext.sousDir)
        : new FileDefinitionSource(path.resolve(process.cwd(), flags.file));
    const defined = await source.load();

    heading("Answering variables");
    blankLine();

    if (defined.length === 0) {
      log(
        indent(
          "No recipe in this project defines any variables yet, so there is nothing " +
            "to ask. Subscribe to a recipe that publishes some, or read a definitions " +
            "file with --file."
        )
      );
      footer();
      return;
    }

    if (args.name !== undefined && !defined.some((entry) => matchesName(entry, args.name!))) {
      throw new ConfigError(
        `No variable named '${args.name}' is in play.\n` +
          `  Run 'sous vars' to see every variable this project's recipes define.`
      );
    }

    const context = loadLadderContext({
      sousDir: this.configContext.sousDir,
      settings: this.settings,
      shellEnv: this.shellEnv,
    });

    const report = await askForMissing(defined, context, {
      sousDir: this.configContext.sousDir,
      // A project whose conf.d directory has never existed still gets one when
      // a mapping record needs writing; the writer creates it.
      confDir:
        this.configContext.confDir ?? path.join(this.configContext.sousDir, "conf.d"),
      interactive: this.interactive,
      ...(args.name === undefined ? {} : { only: [args.name] }),
      reask: flags.all,
      dryRun,
    });

    blankLine();
    for (const line of formatAskReport(report, dryRun)) {
      log(line === "" ? "" : indent(line));
    }

    footer();
  }
}
