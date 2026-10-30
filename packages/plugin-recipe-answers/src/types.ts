/**
 * The contract of plugin-recipe-answers (S6, "Recipe answers: plugin-recipe-answers"): which
 * variables the active recipes define, the answer ladder, the answers a build uses, asking for
 * missing answers, answers given up front (L4), variable mappings (`conf.d/520`), validating an
 * answer, and the ref lookups over variables.
 *
 * It adds the answers as a `variable-source` entity (id `recipe-answers`), so config expressions
 * can read them (S2) without plugin-variables knowing recipes exist.
 *
 * Other plugins import this file type-only.
 */

import type { Prompter, Reporter } from "@sous-io/plugin-api";
import type {} from "@sous-io/plugin-confd/types";
import type {} from "@sous-io/plugin-recipes/types";
import type { EnvFileKind } from "@sous-io/plugin-config-files/types";
import type { VariableDefinition, VariableScalar } from "@sous-io/plugin-formats/types";
import type { VariableRef } from "@sous-io/plugin-refs/types";
import type { VarScope } from "@sous-io/plugin-variables/types";

// ---------------------------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------------------------

/** The recipe that defines a variable. */
export interface DefiningRecipe {
    /** The repository's short name, or `local` for a definitions file. */
    readonly repo: string;
    readonly namespace: string;
    readonly name: string;
    readonly version: string;
    readonly url?: string;
    /** The repository's canonical identity, when known, so a ref written as a location matches it. */
    readonly identity?: string;
    /** True when the project subscribed to this recipe itself, not through another recipe. */
    readonly direct?: boolean;
    /** The recipe's path in its repository. */
    readonly path?: string;
    /** The directory holding its files. */
    readonly dir?: string;
}

/** One variable, with the recipe defining it. */
export interface DefinedVariable {
    readonly definition: VariableDefinition;
    readonly recipe: DefiningRecipe;
    /** Other recipes that define the same name and share the answer. */
    readonly requiredBy?: readonly DefiningRecipe[];
    /** The variable as a ref, `namespace/recipe.name`. */
    readonly ref: VariableRef;
    /** `namespace/recipe.name`. */
    readonly key: string;
}

/** Where definitions are read from besides the active recipes. */
export interface DefinitionOptions {
    /** A definitions file (`--file`), in the recipe manifest's `variables` form. */
    file?: string;
}

/** Which variables the active recipes define (S6, `recipe-answers.definitions`). Only active recipes count (S4, 3). */
export interface RecipeAnswersDefinitions {
    /** Every defined variable, in recipe order. */
    list(options?: DefinitionOptions): Promise<DefinedVariable[]>;
    /** The same, from what is already loaded. */
    listSync(): DefinedVariable[];
    /** The variables a written name or ref names; several when it is ambiguous. */
    find(nameOrRef: string, options?: DefinitionOptions): Promise<DefinedVariable[]>;
}

// ---------------------------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------------------------

/** A rung of the answer ladder, tried in this order. */
export type LadderRung = "mapping" | "recipe" | "namespace" | "shared" | "bare";

/** Where an answer was read: the shell, or one of the env files. */
export type AnswerSourceFile = "shell" | EnvFileKind;

/** One environment name the ladder tries. */
export interface LadderCandidate {
    readonly rung: LadderRung;
    readonly envName: string;
}

/** Where an answer came from. */
export interface AnswerSource extends LadderCandidate {
    readonly file: AnswerSourceFile;
}

/** An answer found on the ladder. */
export interface ResolvedAnswer {
    readonly value: string;
    readonly source: AnswerSource;
}

/** Everything the ladder knows about one variable, for `vars show`. */
export interface AnswerDiagnosis {
    readonly resolved?: ResolvedAnswer;
    /** Every name tried, in order. */
    readonly candidates: readonly LadderCandidate[];
}

/** The answer ladder: where an answer comes from, in order (S6, `recipe-answers.ladder`). */
export interface RecipeAnswersLadder {
    /** The names tried for a variable, in order. */
    candidates(variable: DefinedVariable): LadderCandidate[];
    /** The answer, or `undefined`. */
    resolve(variable: DefinedVariable): ResolvedAnswer | undefined;
    diagnose(variable: DefinedVariable): AnswerDiagnosis;
}

// ---------------------------------------------------------------------------------------------
// Answers for a build
// ---------------------------------------------------------------------------------------------

/** The answers a build uses. */
export interface RecipeAnswers {
    /** Every answer, by variable name, merged over every recipe. */
    readonly merged: VarScope;
    /** Each recipe's own answers, by `namespace/recipe`, for that recipe's output scope. */
    readonly byRecipe: Readonly<Record<string, VarScope>>;
    /** Required variables with no answer. */
    readonly unanswered: readonly DefinedVariable[];
    /** The names declared secret. */
    readonly secrets: ReadonlySet<string>;
}

/** The answers a build uses, per recipe (S6, `recipe-answers.answers`). */
export interface RecipeAnswersAnswers {
    get(): RecipeAnswers;
    /** One recipe's scope: the merged answers with its own laid over. */
    forRecipe(key: string): VarScope;
}

// ---------------------------------------------------------------------------------------------
// Answers given up front, validation, mappings
// ---------------------------------------------------------------------------------------------

/** One answer given by flag or file. */
export interface ProvidedAnswer {
    /** As written: a bare name or `namespace/recipe.name`. */
    readonly name: string;
    readonly value: string;
    /** Where it was given: `--answer`, or the file's path. */
    readonly from: string;
}

/** The inputs that give answers up front (L4). */
export interface ProvidedAnswerInputs {
    /** `--answer <name>=<value>`, repeatable. */
    answer?: readonly string[];
    /** `--answers-file <path>`: YAML, JSON, JSONC or `.env`. */
    answersFile?: string;
}

/** A provided answer matched to the variable it answers. */
export interface ApplicableAnswer {
    readonly answer: ProvidedAnswer;
    readonly target: DefinedVariable;
    readonly value: string;
}

/** Answers given up front, by file or flag (S6, `recipe-answers.preanswers`). */
export interface RecipeAnswersPreanswers {
    /** Reads the flags and the file; throws an `InputError` for a malformed entry. */
    read(inputs: ProvidedAnswerInputs): Promise<ProvidedAnswer[]>;
    /** Matches answers to variables; throws an `InputError` naming any that answers nothing. */
    match(answers: readonly ProvidedAnswer[], variables: readonly DefinedVariable[]): ApplicableAnswer[];
}

/** An answer, checked. */
export type AnswerValidation = { readonly ok: true; readonly value: VariableScalar } | { readonly ok: false; readonly message: string };

/** Checking an answer against its definition, with a time-limited regex (S6, `recipe-answers.validator`). */
export interface RecipeAnswersValidator {
    validate(definition: VariableDefinition, answer: string, options?: { recipe?: string; patternBudgetMs?: number }): AnswerValidation;
}

/** The recipe variable a mapping binds an environment name to. */
export interface MappingTarget {
    readonly repo?: string;
    readonly namespace: string;
    readonly recipe: string;
    readonly variable: string;
}

/** Variable mapping records in `conf.d/520-var-mappings.jsonc` (S6, `recipe-answers.mappings`). */
export interface RecipeAnswersMappings {
    /** Every mapping, by environment name. */
    list(): Record<string, MappingTarget>;
    /** Parses `repo:namespace/recipe/variable`. */
    parseTarget(text: string): MappingTarget;
    formatTarget(target: MappingTarget): string;
    /** Writes one mapping surgically. */
    set(envName: string, target: MappingTarget, options?: { dryRun?: boolean }): Promise<{ file: string; changed: boolean }>;
    /** Removes one mapping. */
    remove(envName: string, options?: { dryRun?: boolean }): Promise<{ file: string; changed: boolean }>;
}

// ---------------------------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------------------------

/** `vars.ask`: asks for missing answers through the chain's `Prompter`, or takes them from flags (L4). */
export interface VarsAskInput extends ProvidedAnswerInputs {
    /** One variable, by name or ref. */
    name?: string;
    /** Asks every variable again, answered or not. */
    all?: boolean;
    /** Only the variables of this repository. */
    repo?: string;
    /** Only the variables of this namespace. */
    namespace?: string;
    /** Only the variables of this recipe (`namespace/recipe`), as `subscription.add` asks. */
    recipe?: string;
    /** Only these variables, by name or ref. */
    var?: string[];
    /**
     * Only the variables of these recipes (`namespace/recipe`), asked as a plain run asks them (what
     * is required and unanswered), not as naming them would (everything). `subscription.add` asks
     * this way for the recipes it installed, as before 1.0.
     */
    within?: string[];
    acceptFirst?: boolean;
    /** A definitions file. */
    file?: string;
    dryRun?: boolean;
}

/** One answer stored. */
export interface AnsweredVariable {
    readonly variable: DefinedVariable;
    readonly envName: string;
    readonly file: EnvFileKind;
    readonly filePath: string;
    /** The value, or the hidden marker for a secret. */
    readonly value: string;
    readonly outcome: "updated" | "appended" | "not written";
    readonly mapping?: { readonly envName: string; readonly target: string; readonly filePath: string };
    /** The value it replaced. */
    readonly replaced?: string;
    /** A higher rung that still wins over it. */
    readonly shadowedBy?: string;
}

/** The result of `vars.ask`. */
export interface VarsAskResult {
    readonly answered: readonly AnsweredVariable[];
    /** Variables already answered, left as they were. */
    readonly inherited: ReadonlyArray<{ readonly variable: DefinedVariable; readonly resolved: ResolvedAnswer }>;
    readonly skipped: ReadonlyArray<{ readonly variable: DefinedVariable; readonly reason: string }>;
    readonly dryRun: boolean;
}

/** `vars.list` (also `sous vars` with no name). */
export interface VarsListInput {
    /** One variable; `sous vars <name>` shows it. */
    name?: string;
    /** A definitions file. */
    file?: string;
}

/** One variable as `vars.list` and `vars.show` show it. */
export interface VariableListing {
    readonly variable: DefinedVariable;
    readonly answered: boolean;
    /** The answer, hidden when secret. */
    readonly value?: string;
    readonly source?: AnswerSource;
    /** Where an answer would be stored. */
    readonly storedAs: string;
    readonly storeIn: EnvFileKind;
}

/** `vars.show`. */
export interface VarsShowInput {
    name: string;
    file?: string;
    acceptFirst?: boolean;
}

/** What `vars.show` shows: one variable, with how it was answered. */
export interface VariableDetail extends VariableListing {
    readonly diagnosis: AnswerDiagnosis;
    /** One sentence per constraint, as `constraintBullets` writes them. */
    readonly constraints: readonly string[];
    /** Why the answer in scope does not fit the definition, when it does not. */
    readonly problem?: string;
    readonly mapping?: { readonly envName: string; readonly target: string };
}

/** `vars.map`: binds an environment name to one recipe variable. */
export interface VarsMapInput {
    /** UPPER_SNAKE. */
    envName: string;
    /** `namespace/recipe/variable`, optionally `repo:`-qualified. Leave out with `remove`. */
    target?: string;
    remove?: boolean;
    dryRun?: boolean;
}

/** The result of `vars.map`. */
export interface VarsMapResult {
    readonly envName: string;
    readonly target?: string;
    readonly file: string;
    readonly changed: boolean;
    readonly dryRun: boolean;
}

/** Where `vars.ask` asks and reports (the chain's own). */
export interface AskIo {
    readonly prompter: Prompter;
    readonly reporter: Reporter;
}

declare module "@sous-io/plugin-api" {
    interface SousServices {
        "recipe-answers.definitions": RecipeAnswersDefinitions;
        "recipe-answers.ladder": RecipeAnswersLadder;
        "recipe-answers.answers": RecipeAnswersAnswers;
        "recipe-answers.preanswers": RecipeAnswersPreanswers;
        "recipe-answers.mappings": RecipeAnswersMappings;
        "recipe-answers.validator": RecipeAnswersValidator;
    }

    interface SousIntents {
        "vars.ask": { input: VarsAskInput; result: VarsAskResult };
        "vars.list": { input: VarsListInput; result: VariableListing[] };
        "vars.show": { input: VarsShowInput; result: VariableDetail };
        "vars.map": { input: VarsMapInput; result: VarsMapResult };
    }

    interface SousConfig {
        /** Environment names bound to recipe variables (`conf.d/520`). */
        varMappings: Record<string, string>;
    }
}
