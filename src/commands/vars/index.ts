/**
 * `sous vars` and `sous vars <name>`.
 *
 * With no argument, prints every variable in play: what it is called, which
 * recipe published it, the environment variable that answered it, the value
 * (hidden when the definition says the variable is a secret), and where the
 * value came from. With a variable named, prints everything about that one,
 * including every environment variable name on the resolution ladder and which
 * rung actually answered.
 *
 * The optional argument sits on this command rather than in a `show.ts` of its
 * own, because oclif collates leading space-separated words into a command id
 * only while they keep matching a real command: `sous vars ask` finds the
 * `vars:ask` command, and `sous vars apiUrl` does not, so it lands here with
 * `apiUrl` as the argument. The one consequence is that a variable named `ask`
 * cannot be shown this way; `sous vars` lists it, and `sous vars ask` runs the
 * ask command.
 */

import path from "node:path";
import { Args, Flags } from "@oclif/core";
import { BaseCommand } from "../../base-command.js";
import { ConfigError } from "../../lib/errors.js";
import {
  definedVariableKey,
  definingRecipeKey,
  displayValue,
  diagnoseVariable,
  FileDefinitionSource,
  loadLadderContext,
  loadProjectDefinitions,
  renderTable,
  RUNG_LABELS,
  SOURCE_LABELS,
  truncate,
  validateAnswer,
  type DefinedVariable,
  type LadderContext,
} from "../../lib/vars/index.js";
import { constraintHints } from "../../lib/vars/validate.js";
import {
  blankLine,
  footer,
  heading,
  indent,
  log,
  showCommandVars,
  showVars,
  subheading,
} from "../../utils/formatting.js";

export default class Vars extends BaseCommand {
  static description =
    "List every variable in play, or show everything about one of them";

  static examples = [
    "<%= config.bin %> vars",
    "<%= config.bin %> vars apiUrl",
    "<%= config.bin %> vars --file ./questions.yaml",
  ];

  static args = {
    name: Args.string({
      description:
        "A variable's name (or its namespace/recipe.name key) to show in full",
      required: false,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    file: Flags.string({
      description:
        "Read the variable definitions from a standalone definitions file instead of the project's recipes",
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Vars);

    showCommandVars({
      Project: this.projectLabel,
      Config: this.configContext.configPath,
      Definitions: flags.file ?? "the project's subscribed recipes",
    });

    const source =
      flags.file === undefined
        ? loadProjectDefinitions(this.settings, this.configContext.sousDir)
        : new FileDefinitionSource(path.resolve(process.cwd(), flags.file));
    const defined = await source.load();

    const context = loadLadderContext({
      sousDir: this.configContext.sousDir,
      settings: this.settings,
      shellEnv: this.shellEnv,
    });

    if (args.name === undefined) this.listVariables(defined, context);
    else this.showVariable(defined, context, args.name);

    footer();
  }

  /** Prints the table of every variable in play, sorted by recipe then name. */
  private listVariables(defined: DefinedVariable[], context: LadderContext): void {
    heading("Variables in play");

    if (defined.length === 0) {
      blankLine();
      log(
        indent(
          "No recipe in this project defines any variables yet. Subscribe to a recipe " +
            "that publishes some, or read a definitions file with --file."
        )
      );
      return;
    }

    const rows = [...defined]
      .sort((left, right) => definedVariableKey(left).localeCompare(definedVariableKey(right)))
      .map((entry) => {
        const { resolved } = diagnoseVariable(entry, context);
        const value = displayValue(resolved?.value, entry.definition.secret);
        const source =
          resolved === undefined
            ? "nothing yet"
            : `${RUNG_LABELS[resolved.source.rung]}, ${
                SOURCE_LABELS[resolved.source.file] ?? resolved.source.file
              }`;
        return [
          entry.definition.name,
          definingRecipeKey(entry.recipe),
          resolved?.source.envName ?? "",
          truncate(value),
          source,
        ];
      });

    blankLine();
    for (const line of renderTable(
      ["Variable", "Recipe", "Answered by", "Value", "Source"],
      rows
    )) {
      log(indent(line));
    }
  }

  /** Prints everything about one variable, including every candidate name. */
  private showVariable(
    defined: DefinedVariable[],
    context: LadderContext,
    name: string
  ): void {
    const matches = defined.filter(
      (entry) => entry.definition.name === name || definedVariableKey(entry) === name
    );

    if (matches.length === 0) {
      throw new ConfigError(
        `No variable named '${name}' is in play.\n` +
          `  Run 'sous vars' to see every variable this project's recipes define.`
      );
    }

    for (const entry of matches) {
      const { definition } = entry;
      const { resolved, candidates } = diagnoseVariable(entry, context);
      const validity =
        resolved === undefined ? undefined : validateAnswer(definition, resolved.value);

      heading(`${definition.name} (${definingRecipeKey(entry.recipe)})`);
      blankLine();
      showVars({
        Question: definition.prompt,
        ...(definition.description === undefined ? {} : { About: definition.description }),
        Recipe: `${definingRecipeKey(entry.recipe)} version ${entry.recipe.version} from ${entry.recipe.repo}`,
        Constraints: constraintHints(definition).join("; "),
        "Stored in": definition.secret || definition.scope === "local" ? ".env.local" : ".env",
        Value: displayValue(resolved?.value, definition.secret),
        Answer:
          resolved === undefined
            ? "nothing in scope answers this variable yet"
            : validity?.ok === true
              ? "the value in scope fits this definition"
              : `the value in scope does not fit: ${validity?.ok === false ? validity.message : ""}`,
      });

      blankLine();
      subheading("Environment variables sous looks at, most specific first");
      blankLine();

      const rows = candidates.map((candidate) => [
        candidate.envName,
        RUNG_LABELS[candidate.rung],
        candidate.envName === resolved?.source.envName
          ? `answered it, from ${SOURCE_LABELS[resolved.source.file] ?? resolved.source.file}`
          : "not set",
      ]);
      for (const line of renderTable(["Environment variable", "Rung", "Status"], rows)) {
        log(indent(line));
      }
    }
  }
}
