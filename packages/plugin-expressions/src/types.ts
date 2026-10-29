/**
 * The contract of plugin-expressions (S5; S6, "Shared building blocks"): config expressions
 * (`$expr`, `$if`, `$elseif`, `$else`) and the expression languages plugins add, Liquid first.
 * Expressions are evaluated inside each config file's contributor, before its values go into its
 * patch (S2, "Config expressions are part of the same loop").
 *
 * Other plugins import this file type-only.
 */

import type { ConfigBuilder, EntityReader, Environment, JsonValue, ProjectInfo, ServiceReader } from "@sous-io/plugin-api";
import type { VarScope } from "@sous-io/plugin-variables/types";

/** What an expression can read (S5, "What an Expression Can Read"). */
export interface ExpressionScope {
    /** `host.platform`: Node's `process.platform`. */
    readonly host: { readonly platform: string };
    /** `env.<NAME>`, after the env files load. */
    readonly env: Environment;
    /** Variables by bare name: the `_vars` of every level containing the expression, recipe answers where allowed. */
    readonly vars: VarScope;
}

/** What an expression could not know yet in this pass; it gives `undefined` and is tried again. */
export interface ExpressionUnknowns {
    /** Variables still unknown. */
    readonly variables: readonly string[];
    /** Filters no plugin has added yet. */
    readonly filters: readonly string[];
}

/** What evaluating one expression gave. */
export type ExpressionOutcome = { readonly value: unknown } | { readonly unknown: ExpressionUnknowns };

/** What a language's methods get. */
export interface ExpressionLanguageContext {
    readonly project: ProjectInfo | undefined;
    /** The file the expression came from, for errors. */
    readonly file: string;
    /** The key path of the expression, for errors. */
    readonly path: string;
    /** The environment, as the contributor sees it. */
    readonly env?: Environment;
    /**
     * Entities as the contributor sees them: reads go through the builder, so the file is
     * evaluated again when they change (a Liquid filter added in a later pass).
     */
    readonly entities?: EntityReader;
    /** Services usable while the config is built (singletons). */
    readonly services?: ServiceReader;
}

/** An `expression-language` entity (S5, "Expression Languages"): Liquid is the default and the first. */
export interface ExpressionLanguageEntity {
    /** The qualifier after `$expr:` or `expr:`: `liquid`. */
    id: string;
    description?: string;
    /** True for a language that runs code; such a language is refused in a recipe's config file (S5). */
    runsCode?: boolean;
    /** The variables an expression reads, found without running it, so each is recorded as a read (S2). */
    variables(expression: string, ctx: ExpressionLanguageContext): string[];
    /** Evaluates an expression; throws a `ConfigError` when it cannot parse or fails while running. */
    evaluate(expression: string, scope: ExpressionScope, ctx: ExpressionLanguageContext): ExpressionOutcome;
}

/** One expression a layer held, as `config get --layers` shows it. */
export interface EvaluatedExpression {
    /** The key path, such as `subscriptions."x/y".enabled`. */
    readonly path: string;
    /** The expression object as written. */
    readonly written: JsonValue;
    /** What it evaluated to; `undefined` means the key was dropped. */
    readonly value: JsonValue | undefined;
    /** Each variable it read, with the value it saw. */
    readonly reads: Readonly<Record<string, JsonValue | undefined>>;
    /** What it could not know yet, when it gave `undefined` for that reason. */
    readonly unknown?: ExpressionUnknowns;
}

/** How to evaluate one config file's data. */
export interface EvaluateLayerOptions {
    /** The file, for errors: `conf.d/610-mac.jsonc`. */
    file: string;
    /** The contributor's builder: every variable read goes through it, so the contributor re-runs when one changes. */
    config: ConfigBuilder;
    /** The file's own plain root `_vars`, which its expressions also see (S2, rule 1). */
    ownVars?: Readonly<Record<string, string>>;
    /** True for a recipe's config file: languages that run code are refused (S5). */
    fromRecipe?: boolean;
}

/** What evaluating a layer gave. */
export interface EvaluatedLayer {
    /** The data with every expression replaced by its value, `undefined` values dropped. */
    readonly value: JsonValue | undefined;
    /** Every expression evaluated, for `--layers`. */
    readonly expressions: readonly EvaluatedExpression[];
    /** True when some expression could not be known yet in this pass. */
    readonly pending: boolean;
}

/** One expression still unknown once the config settled: an error naming it (S5, "Errors" 6). */
export interface UnsettledExpression {
    readonly file: string;
    readonly path: string;
    readonly unknown: ExpressionUnknowns;
}

/** Evaluating config expressions inside each layer, before it merges (S6, `expressions.evaluator`). */
export interface ExpressionsEvaluator {
    /** Evaluates every expression object in a file's data. Throws a `ConfigError` for S5's errors 1 to 5 and 8. */
    evaluateLayer(data: JsonValue, options: EvaluateLayerOptions): EvaluatedLayer;
    /** Whether a value is an expression object (holds one of S5's reserved keys). */
    isExpressionObject(value: unknown): boolean;
    /** Whether a value holds an expression object at any depth. */
    hasExpressions(value: unknown): boolean;
    /** The expressions of the latest build, for one file or every file. */
    evaluations(file?: string): EvaluatedExpression[];
    /** Expressions still unknown in the latest pass; non-empty once the config settles means an error. */
    unsettled(): UnsettledExpression[];
    /** The languages known, in plugin order. */
    languages(): string[];
}

declare module "@sous-io/plugin-api" {
    interface SousServices {
        /** Evaluating config expressions. */
        "expressions.evaluator": ExpressionsEvaluator;
    }

    interface SousEntities {
        /** An expression language. */
        "expression-language": ExpressionLanguageEntity;
    }
}
