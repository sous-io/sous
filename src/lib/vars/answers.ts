/**
 * The answers a build renders with.
 *
 * A recipe publishes variable DEFINITIONS; the project's env files and shell
 * hold the ANSWERS; the ladder (`ladder.ts`) says which answer a definition
 * gets. This module is the one place that turns all of that into the variable
 * scope a template renders from, so a `{{ variable }}` in a recipe's own skill
 * sees the answer to its own question without the project mapping the name by
 * hand through `_env`.
 *
 * Three views come out of one walk over the definitions:
 *
 *   - `merged`, what the project's own templates render: one value per
 *     variable name. Two recipes may publish the same name (the shared rung of
 *     the ladder exists for exactly that), so the first definition in lockfile
 *     order wins the merged view, and a project that wants something else says
 *     so in `_vars`, which sits above every answer.
 *   - `byRecipe`, what a recipe's own files render: the answers resolved for
 *     that recipe's definitions, which the recipe-scoped rung of the ladder can
 *     make different from the merged view.
 *   - `unanswered`, every required definition that no rung and no default
 *     answered. A build reports those and carries on, because a missing answer
 *     is something to tell the user about, not a reason to refuse to build the
 *     rest of the project.
 *
 * A definition's `default` counts as an answer of last resort: the
 * description a publisher writes promises what the default does, and a
 * template rendering an empty string instead would break that promise.
 *
 * Values are laid in exactly as the ladder found them. Nothing here resolves a
 * path or coerces a number; the answer is the string the user stored, the same
 * string an `_env` mapping would deliver.
 */

import type { Settings, VarScope } from "../settings.js";
import { BULLET } from "../../utils/formatting.js";
import {
  ProjectDefinitionSource,
  definingRecipeKey,
  type DefinedVariable,
} from "./definition-source.js";
import { loadLadderContext, resolveVariable, type LadderContext } from "./ladder.js";

/** The answers in play for a project, in the three views a build needs. */
export interface RecipeAnswers {
  /** One value per variable name; the first definition in lockfile order wins a name. */
  merged: VarScope;
  /** The answers resolved for each recipe's own definitions, keyed `namespace/recipe`. */
  byRecipe: Map<string, VarScope>;
  /** Every required definition that nothing answered and that has no default. */
  unanswered: DefinedVariable[];
}

/** How the answers are resolved. */
export interface RecipeAnswerOptions {
  /** The merged project config, read for its `varMappings` block. */
  settings: Settings;
  /** The project's `.sous/` directory, which holds the lockfile and both env files. */
  sousDir: string;
  /**
   * The definitions to answer. Defaults to every definition the project's
   * lockfile pins; tests hand in a fixed list.
   */
  definitions?: DefinedVariable[];
  /**
   * The environment the ladder treats as the shell. A build passes nothing and
   * gets `process.env`, which already holds every env-file value in precedence
   * order (the files are loaded first-writer-wins, shell first), so the value
   * that comes back is the right one; only the layer it is attributed to would
   * differ, and a build does not report that.
   */
  shellEnv?: NodeJS.ProcessEnv;
  /** The environment that decides where the store is; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** The empty result, for a project that locks nothing. */
export function noRecipeAnswers(): RecipeAnswers {
  return { merged: {}, byRecipe: new Map(), unanswered: [] };
}

/**
 * Resolves every definition in play through the ladder and lays the answers
 * out in the three views a build renders and reports with.
 *
 * @param options - The project's config, its `.sous/` directory, and optionally
 *   the definitions and environment to use instead of the real ones.
 */
export function resolveRecipeAnswers(options: RecipeAnswerOptions): RecipeAnswers {
  const definitions =
    options.definitions ??
    new ProjectDefinitionSource(options.settings, options.sousDir, options.env).loadSync();
  if (definitions.length === 0) return noRecipeAnswers();

  const context: LadderContext = loadLadderContext({
    sousDir: options.sousDir,
    settings: options.settings,
    ...(options.shellEnv === undefined ? {} : { shellEnv: options.shellEnv }),
  });

  const result = noRecipeAnswers();

  for (const defined of definitions) {
    const value = answerFor(defined, context);
    const name = defined.definition.name;

    if (value === undefined) {
      if (defined.definition.required) result.unanswered.push(defined);
      continue;
    }

    if (!(name in result.merged)) result.merged[name] = value;

    const recipeKey = definingRecipeKey(defined.recipe);
    const own = result.byRecipe.get(recipeKey) ?? {};
    own[name] = value;
    result.byRecipe.set(recipeKey, own);
  }

  return result;
}

/**
 * The answer one definition renders with: what the ladder found, else the
 * definition's own default, else nothing.
 *
 * @param defined - The definition and the recipe that published it.
 * @param context - The environment layers and mapping records.
 */
function answerFor(defined: DefinedVariable, context: LadderContext): string | undefined {
  const resolved = resolveVariable(defined, context);
  if (resolved !== undefined) return resolved.value;
  const fallback = defined.definition.default;
  return fallback === undefined ? undefined : String(fallback);
}

/**
 * The scope a recipe's own files render with: the merged view, with that
 * recipe's own answers laid over it.
 *
 * @param answers - The resolved answers.
 * @param recipeKey - The recipe, as `namespace/recipe`.
 */
export function answersForRecipe(answers: RecipeAnswers, recipeKey: string): VarScope {
  return { ...answers.merged, ...(answers.byRecipe.get(recipeKey) ?? {}) };
}

/**
 * The one warning a build prints when required variables are unanswered: every
 * variable named with the recipe that asks for it, and the command that answers
 * them. Undefined when nothing is missing.
 *
 * A variable the project's config defines itself, in `_vars` or through
 * `_env`, is not missing: the template renders that value, whatever the ladder
 * found. So the check is made against the scope the templates actually render
 * with, not against the ladder alone.
 *
 * @param answers - The resolved answers.
 * @param renderScope - The scope the project's templates render with.
 */
export function unansweredWarning(
  answers: RecipeAnswers,
  renderScope: VarScope = {}
): string | undefined {
  const missing = answers.unanswered.filter(
    (defined) => renderScope[defined.definition.name] === undefined
  );
  if (missing.length === 0) return undefined;

  const lines = missing.map(
    (defined) =>
      `  ${BULLET} ${defined.definition.name} (asked by ${definingRecipeKey(defined.recipe)})`
  );
  const count = missing.length;
  const noun = count === 1 ? "variable" : "variables";
  const pronoun = count === 1 ? "it" : "them";

  return (
    `${count} required recipe ${noun} ${count === 1 ? "has" : "have"} no answer, so the ` +
    `templates that use ${pronoun} render an empty value:\n` +
    `${lines.join("\n")}\n` +
    `Run 'sous vars ask' to answer ${pronoun}.`
  );
}
