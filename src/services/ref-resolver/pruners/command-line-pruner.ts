import { RefSource, SOURCE_LABELS } from "../source.js";
import { makeInjectable } from "../injectable.js";
import { isLocal } from "./rule-helpers.js";
import { RuleRefPruner, type RefPruneRule } from "./ref-pruner.js";

/**
 * The command line allows every form a ref has: a bare name, a namespace and
 * recipe, a `repo:` qualifier, a range, a location, a browser URL, a variable
 * and an environment variable name. It refuses a repository on this machine
 * written as a location (it is added by its path), a file inside a recipe (a
 * folder in a repository is a URL copied from the browser) and a glob.
 */
export class CommandLinePruner extends RuleRefPruner {
  readonly source = RefSource.CommandLine;
  readonly place = SOURCE_LABELS[RefSource.CommandLine];

  protected rules(): RefPruneRule[] {
    return [
      {
        matches: isLocal,
        action: "drop",
        message:
          "a repository on this machine is added by its path, and its recipes are then named " +
          "by their short form.",
        instead: "'sous repo add <path>', then 'namespace/recipe'",
      },
      {
        matches: (ref) => ref.kind === "recipeFile",
        action: "drop",
        message:
          "a short ref has at most two path segments, a namespace and a recipe. A folder path " +
          "inside a repository is written as a URL copied from the browser instead.",
        instead: "'namespace/recipe', or the URL copied from the browser",
      },
      {
        matches: (ref) => ref.glob === true,
        action: "drop",
        message:
          "a name here must be kebab-case (a letter, then letters, digits or hyphens), so a " +
          "glob pattern is not accepted.",
        instead: "the name itself",
      },
    ];
  }
}

makeInjectable(CommandLinePruner);
