/**
 * The contract of plugin-recipe-answers: which
 * variables the active recipes define, the answer ladder, the answers a build uses, asking for
 * missing answers, answers given up front, variable mappings (`conf.d/520`), validating an
 * answer, and the ref lookups over variables.
 *
 * It adds the answers as a `variable-source` entity (id `recipe-answers`), so config expressions
 * can read them without plugin-variables knowing recipes exist.
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
    /**
     * The recipes holding this version (`project` for a subscription the project made itself), when
     * known. Messages about two versions of one recipe name them.
     */
    readonly holders?: readonly string[];
    /** True for a version pinned for some holders alone (ADR 0023, decision 4), not the shared one. */
    readonly pinned?: boolean;
}

/**
 * A definition as answers are asked and checked with it. When several definitions of one name were
 * combined (`combineDefinitions`), an answer must match every one of `patterns`; otherwise only
 * `validate.pattern` applies.
 */
export interface AnswerDefinition extends VariableDefinition {
    /** Every pattern an answer must match, when combining left more than one. */
    readonly patterns?: readonly string[];
}

/** One variable, with the recipe defining it. */
export interface DefinedVariable {
    /**
     * The definition answers are asked and checked with: the recipe's own, or, when other recipes
     * (or other versions of it) define the same name, the strictest combination of them all.
     */
    readonly definition: AnswerDefinition;
    readonly recipe: DefiningRecipe;
    /** Other recipes that define the same name. They share the answer unless `separate` is set. */
    readonly requiredBy?: readonly DefiningRecipe[];
    /** The definition the recipe published, when combining it with the others of its name changed it. */
    readonly published?: VariableDefinition;
    /**
     * Why this definition could not be combined with the others of its name, naming them. It is then
     * asked for on its own, and its answer stored under its recipe-scoped name.
     */
    readonly separate?: string;
    /**
     * Set when this version of a recipe defines the name in a way that cannot be combined with
     * another version of the same recipe: the warning saying so, naming both versions, their
     * holders and why. Such a definition is never asked, and gets no answer (not even its default),
     * so it renders empty where this version is used.
     */
    readonly unanswerable?: string;
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

/** Which variables the active recipes define. Only active recipes count. */
export interface RecipeAnswersDefinitions {
    /** Every defined variable, in recipe order. */
    list(options?: DefinitionOptions): Promise<DefinedVariable[]>;
    /** The same, from what is already loaded. */
    listSync(): DefinedVariable[];
    /** The variables a written name or ref names; several when it is ambiguous. */
    find(nameOrRef: string, options?: DefinitionOptions): Promise<DefinedVariable[]>;
    /**
     * Settles every name several of the given definitions share, the way `list` does (ADR 0023,
     * decision 6): each such variable comes back with the strictest combination as its
     * `definition`, or with `separate` set when they cannot be combined. For a caller holding
     * definitions of recipes that are not active yet, such as a dry-run preview.
     */
    combine(variables: readonly DefinedVariable[]): DefinedVariable[];
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

/** The answer ladder: where an answer comes from, in order. */
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
    /** Definitions that get no answer, because another version of their recipe is asked instead (`unanswerable`). */
    readonly unanswerable: readonly DefinedVariable[];
    /** The names declared secret. */
    readonly secrets: ReadonlySet<string>;
}

/** The answers a build uses, per recipe. */
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

/** The inputs that give answers up front. */
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

/** Answers given up front, by file or flag. */
export interface RecipeAnswersPreanswers {
    /** Reads the flags and the file; throws an `InputError` for a malformed entry. */
    read(inputs: ProvidedAnswerInputs): Promise<ProvidedAnswer[]>;
    /** Matches answers to variables; throws an `InputError` naming any that answers nothing. */
    match(answers: readonly ProvidedAnswer[], variables: readonly DefinedVariable[]): ApplicableAnswer[];
}

/** An answer, checked. */
export type AnswerValidation = { readonly ok: true; readonly value: VariableScalar } | { readonly ok: false; readonly message: string };

/** Checking an answer against its definition, with a time-limited regex. */
export interface RecipeAnswersValidator {
    validate(definition: AnswerDefinition, answer: string, options?: { recipe?: string; patternBudgetMs?: number }): AnswerValidation;
}

/** The recipe variable a mapping binds an environment name to. */
export interface MappingTarget {
    readonly repo?: string;
    readonly namespace: string;
    readonly recipe: string;
    readonly variable: string;
}

/** Variable mapping records in `conf.d/520-var-mappings.jsonc`. */
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

/** `vars.ask`: asks for missing answers through the chain's `Prompter`, or takes them from flags. */
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
    /** The env file every answer of this run is written to, as the person spelled it. */
    envFile?: string;
    /** Answers yes to storing a secret or machine-specific answer in the committed env file. */
    yes?: boolean;
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
    /** On a dry run with no terminal: the variables a terminal would be asked about. */
    readonly wouldAsk?: ReadonlyArray<{ readonly variable: DefinedVariable; readonly current?: string }>;
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
    /** Nothing answers it, so its default is the value in use (`value` holds it). */
    readonly usesDefault?: boolean;
    /** Where an answer would be stored. */
    readonly storedAs: string;
    readonly storeIn: EnvFileKind;
}

/** The result of `vars.list`: every variable in play, or the ones a name matched, in full. */
export interface VarsListResult {
    readonly variables: readonly VariableListing[];
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
        "vars.list": { input: VarsListInput; result: VarsListResult };
        "vars.show": { input: VarsShowInput; result: VariableDetail };
        "vars.map": { input: VarsMapInput; result: VarsMapResult };
    }

    interface SousConfig {
        /** Environment names bound to recipe variables (`conf.d/520`). */
        varMappings: Record<string, string>;
    }
}
