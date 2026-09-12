/**
 * `sous vars ask [name]`.
 *
 * Asks the questions the project's variable definitions imply and stores the
 * answers in `.sous/.env` or `.sous/.env.local`. By default it asks only what
 * is unanswered or no longer fits; `--all` asks everything again.
 *
 * The optional name is a reference, resolved through `src/lib/refs/` exactly as
 * every other command resolves one. It may name a variable, an environment
 * variable that answers one, a recipe, a namespace or a repository, at any
 * level of qualification; naming anything larger than a variable asks every
 * question that thing publishes:
 *
 *     sous vars ask taskFileRoot                 one variable
 *     sous vars ask SOUS_VAR_TASK_FILE_ROOT      the variable that name answers
 *     sous vars ask task-files                   every question one recipe asks
 *     sous vars ask workflow                     every question one namespace asks
 *     sous vars ask sous-recipes                 every question one repository asks
 *
 * `--repo`, `--namespace` and `--var` say outright which kind of thing is
 * meant, and narrow the same way. A reference that means more than one thing is
 * offered as a list to choose between; `--accept-first` takes the first, and a
 * run with no terminal fails naming that flag.
 *
 * `--file` reads a standalone definitions file instead of the project's
 * recipes, which is how a project asks questions no recipe publishes yet.
 *
 * Answers can be supplied ahead of the questions with `--answer name=value` or
 * `--answers-file <path>`; whatever they answer is stored before anything is
 * asked, and only what is left over is asked for.
 *
 * Without a terminal the command never hangs waiting on a prompt: it fails and
 * names the exact environment variables that would answer each question.
 */

import path from "node:path";
import { Args, Flags } from "@oclif/core";
import { BaseCommand } from "../../base-command.js";
import { ConfigError } from "../../lib/errors.js";
import {
  ALL_SCOPES,
  SousScope,
  findNamespace,
  findReference,
  findRepository,
  findVariable,
  pickReference,
  referenceContextFromVariables,
  variableReferenceKey,
  type ReferenceMatch,
} from "../../lib/refs/index.js";
import {
  applyProvidedAnswers,
  askForMissing,
  collectProvidedAnswers,
  FileDefinitionSource,
  formatAskReport,
  loadLadderContext,
  loadProjectDefinitions,
  unknownAnswerError,
  type DefinedVariable,
} from "../../lib/vars/index.js";
import type { LadderContext } from "../../lib/vars/ladder.js";
import {
  blankLine,
  dryRunNotice,
  footer,
  heading,
  indent,
  log,
  showCommandVars,
} from "../../utils/formatting.js";
import { answerFlags } from "../../utils/flags.js";

/** What the caller said should be asked: the reference, and the three flags. */
type Selection = {
  /** The reference argument, when one was given. */
  name?: string;
  /** The repository named by `--repo`. */
  repo?: string;
  /** The namespace named by `--namespace`. */
  namespace?: string;
  /** Every variable named by `--var`. */
  vars?: string[];
  /** Take the first match rather than asking which was meant. */
  acceptFirst: boolean;
};

/** The line every "this matched nothing" error ends with. */
const SEE_ALL = "  Run 'sous vars' to see every variable this project's recipes define.";

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
    "<%= config.bin %> vars ask SOUS_VAR_API_URL",
    "<%= config.bin %> vars ask workflow/task-files",
    "<%= config.bin %> vars ask workflow --accept-first",
    "<%= config.bin %> vars ask --namespace workflow --var apiUrl",
    "<%= config.bin %> vars ask --all",
    "<%= config.bin %> vars ask --file ./questions.yaml",
    "<%= config.bin %> vars ask --answer apiUrl=https://api.example.com",
    "<%= config.bin %> vars ask --answers-file ./answers.yaml",
  ];

  static args = {
    name: Args.string({
      description:
        "What to ask about: a variable, an environment variable name, a recipe, a namespace or a repository",
      required: false,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    all: Flags.boolean({
      description: "Ask every variable again, including the ones already answered",
      default: false,
    }),
    repo: Flags.string({
      description: "Ask only the variables published by this repository",
    }),
    namespace: Flags.string({
      description: "Ask only the variables published in this namespace",
    }),
    var: Flags.string({
      description: "Ask only this variable. Repeat it for each variable",
      multiple: true,
    }),
    "accept-first": Flags.boolean({
      description: "When a name matches several things, take the first one listed",
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
    ...answerFlags(),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(VarsAsk);
    const dryRun = flags["dry-run"];

    const selection: Selection = {
      ...(args.name === undefined ? {} : { name: args.name }),
      ...(flags.repo === undefined ? {} : { repo: flags.repo }),
      ...(flags.namespace === undefined ? {} : { namespace: flags.namespace }),
      ...(flags.var === undefined ? {} : { vars: flags.var }),
      acceptFirst: flags["accept-first"],
    };

    showCommandVars({
      Project: this.projectLabel,
      Config: this.configContext.configPath,
      Definitions: flags.file ?? "the project's subscribed recipes",
      Asking: describeSelection(selection, flags.all),
    });

    if (dryRun) dryRunNotice("No answers will be written.");

    const provided = collectProvidedAnswers({
      ...(flags.answer === undefined ? {} : { answer: flags.answer }),
      ...(flags["answers-file"] === undefined
        ? {}
        : { answersFile: flags["answers-file"] }),
    });

    const source =
      flags.file === undefined
        ? loadProjectDefinitions(this.settings, this.configContext.sousDir)
        : new FileDefinitionSource(path.resolve(process.cwd(), flags.file));
    const defined = await source.load();

    heading("Answering variables");
    blankLine();

    if (defined.length === 0) {
      // A supplied answer names a variable nothing declares, which is a typo
      // until proven otherwise; it fails rather than passing unnoticed.
      if (provided[0] !== undefined) throw unknownAnswerError(provided[0], defined);

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

    const context = loadLadderContext({
      sousDir: this.configContext.sousDir,
      settings: this.settings,
      shellEnv: this.shellEnv,
    });

    // What the reference and the flags name, as the fully qualified reference of
    // every variable to ask. Undefined means everything the usual rules pick.
    const only = await this.resolveSelection(defined, context, selection);

    const askOptions = {
      sousDir: this.configContext.sousDir,
      // A project whose conf.d directory has never existed still gets one when
      // a mapping record needs writing; the writer creates it.
      confDir:
        this.configContext.confDir ?? path.join(this.configContext.sousDir, "conf.d"),
      interactive: this.interactive,
      dryRun,
    };

    // Answers supplied on the command line are validated and stored before any
    // question is asked, so what is left is exactly what nobody answered.
    const supplied = applyProvidedAnswers(defined, provided, context, askOptions);

    const report = await askForMissing(defined, context, {
      ...askOptions,
      ...(only === undefined ? {} : { only }),
      skip: supplied.keys,
      reask: flags.all,
    });
    report.answered.unshift(...supplied.stored);

    blankLine();
    for (const line of formatAskReport(report, dryRun)) {
      log(line === "" ? "" : indent(line));
    }

    footer();
  }

  /**
   * Turns the reference and the three narrowing flags into the exact set of
   * variables to ask, as fully qualified references.
   *
   * Each step narrows the pool and the next step resolves against what is left,
   * so `--namespace workflow apiUrl` asks about the `apiUrl` of that namespace
   * even when another namespace declares one too. A step that narrows the pool
   * to nothing is an error naming what did it, rather than a run that silently
   * asks no questions.
   *
   * @param defined - Every variable definition in play.
   * @param ladder - The environment layers, for resolving environment variable names.
   * @param selection - The reference and the flags, as the caller wrote them.
   * @returns The variables to ask, or undefined when nothing narrowed anything.
   */
  private async resolveSelection(
    defined: DefinedVariable[],
    ladder: LadderContext,
    selection: Selection
  ): Promise<string[] | undefined> {
    const { name, repo, namespace, vars } = selection;
    if (name === undefined && repo === undefined && namespace === undefined && vars === undefined) {
      return undefined;
    }

    let pool = defined;

    if (repo !== undefined) {
      const match = await this.pick(findRepository(repo, contextOf(pool, ladder)), repo, selection);
      pool = pool.filter((entry) => entry.recipe.repo === match.repo);
    }

    if (namespace !== undefined) {
      const match = await this.pick(
        findNamespace(namespace, contextOf(pool, ladder)),
        namespace,
        selection
      );
      pool = narrowTo(pool, match);
    }

    if (name !== undefined) {
      const match = await this.pick(
        findReference(name, ALL_SCOPES, contextOf(pool, ladder)),
        name,
        selection
      );
      pool = narrowTo(pool, match);
    }

    if (vars !== undefined) {
      const chosen: DefinedVariable[] = [];
      for (const wanted of vars) {
        const match = await this.pick(
          findVariable(wanted, contextOf(pool, ladder)),
          wanted,
          selection
        );
        chosen.push(...narrowTo(pool, match));
      }
      pool = chosen;
    }

    if (pool.length === 0) {
      throw new ConfigError(
        `Nothing is left to ask: ${describeSelection(selection, false)} names no ` +
          `variable this project holds.\n${SEE_ALL}`
      );
    }

    return [...new Set(pool.map(variableReferenceKey))];
  }

  /**
   * Settles which of the things a reference could have meant this run proceeds
   * with, through the rule every command shares.
   *
   * @param matches - What the reference could have meant, in listing order.
   * @param search - The reference exactly as it was written.
   * @param selection - The selection, read for `--accept-first`.
   */
  private async pick(
    matches: ReferenceMatch[],
    search: string,
    selection: Selection
  ): Promise<ReferenceMatch> {
    return pickReference(matches, {
      search,
      interactive: this.interactive,
      acceptFirst: selection.acceptFirst,
      announce: false,
      details: [SEE_ALL],
    });
  }
}

/** The variables one match covers: a whole repository, namespace, recipe, or one variable. */
function narrowTo(pool: DefinedVariable[], match: ReferenceMatch): DefinedVariable[] {
  return pool.filter((entry) => {
    if (match.repo !== undefined && entry.recipe.repo !== match.repo) return false;
    if (match.scope === SousScope.Repository) return true;

    if (match.namespace !== undefined && entry.recipe.namespace !== match.namespace) return false;
    if (match.scope === SousScope.Namespace) return true;

    if (match.recipe !== undefined && entry.recipe.name !== match.recipe) return false;
    if (match.scope === SousScope.Recipe) return true;

    return entry.definition.name === match.variable;
  });
}

/** The reference context for the variables still in the running. */
function contextOf(pool: DefinedVariable[], ladder: LadderContext) {
  return referenceContextFromVariables(pool, ladder);
}

/** What this run is asking about, in the words the header shows. */
function describeSelection(selection: Selection, all: boolean): string {
  const parts: string[] = [];
  if (selection.repo !== undefined) parts.push(`the repository '${selection.repo}'`);
  if (selection.namespace !== undefined) parts.push(`the namespace '${selection.namespace}'`);
  if (selection.name !== undefined) parts.push(`'${selection.name}'`);
  for (const wanted of selection.vars ?? []) parts.push(`the variable '${wanted}'`);

  if (parts.length === 0) return all ? "every variable" : "everything unanswered";
  return parts.join(", ");
}
