/**
 * The `liquid` expression language, the default (S5, "Expression Languages"): an expression is
 * evaluated with LiquidJS `evalValueSync`, the way a `{% if %}` condition is, with every Liquid
 * filter plugins add.
 */

import { ConfigError, type EntityReader, type ServiceReader } from "@sous-io/plugin-api";
import { CONFIG_EXPRESSION_PURPOSE, createLiquidEngines } from "@sous-io/plugin-liquid";
import { Liquid, Tokenizer, toValue } from "liquidjs";
import { ExpressionError } from "./errors.js";
import type { ExpressionLanguageContext, ExpressionLanguageEntity, ExpressionOutcome, ExpressionScope } from "./types.js";

/** The default language's id. */
export const LIQUID_LANGUAGE = "liquid";

/** Output delimiters no expression contains, so an expression is wrapped safely for analysis. */
const LEFT = "\u0000<";
const RIGHT = ">\u0000";

/** An engine that only reads expressions, never runs them: lenient, so unknown filters still parse. */
const analyzer = new Liquid({ outputDelimiterLeft: LEFT, outputDelimiterRight: RIGHT });

/** The `liquid` expression language entity. */
export function createLiquidLanguage(): ExpressionLanguageEntity {
    return {
        id: LIQUID_LANGUAGE,
        description: "Liquid expressions, as in a {% if %} condition (the default).",
        runsCode: false,
        variables(expression, ctx) {
            return guard(expression, ctx, () => analyzer.globalVariablesSync(analyzer.parse(`${LEFT}${expression}${RIGHT}`)));
        },
        evaluate(expression, scope, ctx) {
            return evaluateLiquid(expression, scope, ctx);
        },
    };
}

function evaluateLiquid(expression: string, scope: ExpressionScope, ctx: ExpressionLanguageContext): ExpressionOutcome {
    const engine = engineFor(ctx);
    const used = guard(expression, ctx, () => new Tokenizer(expression).readFilteredValue().filters.map((filter) => filter.name));
    const missing = [...new Set(used.filter((name) => !(name in engine.filters)))];

    if (missing.length > 0) {
        return { unknown: { variables: [], filters: missing } };
    }

    const value = guard(expression, ctx, () =>
        engine.evalValueSync(expression, { ...scope.vars, host: scope.host, env: scope.env }),
    );

    return { value: toValue(value) };
}

/**
 * An engine with every `liquid-filter` entity the contributor sees (read through its builder, so a
 * filter added in a later pass re-runs the file), built by plugin-liquid.
 */
function engineFor(ctx: ExpressionLanguageContext): Liquid {
    const entities = ctx.entities ?? emptyEntities;
    const cached = engines.get(entities);

    if (cached) {
        return cached;
    }

    const engine = makeEngine(ctx, entities);

    engines.set(entities, engine);

    return engine;
}

/** One engine per entity view: a file evaluates many expressions against the same filters. */
const engines = new WeakMap<EntityReader, Liquid>();

function makeEngine(ctx: ExpressionLanguageContext, entities: EntityReader): Liquid {
    const services = ctx.services ?? noServices;

    return createLiquidEngines({ project: ctx.project, env: ctx.env ?? {}, services, entities }).create({
        purpose: CONFIG_EXPRESSION_PURPOSE,
        secretNames: [],
        liquid: { strictFilters: true },
    });
}

/** Turns LiquidJS's parse and run errors into a `ConfigError` naming the file and key path (S5, "Errors" 5). */
function guard<T>(expression: string, ctx: ExpressionLanguageContext, run: () => T): T {
    try {
        return run();
    } catch (error) {
        if (error instanceof ConfigError) {
            throw error;
        }

        const reason = error instanceof Error ? error.message : String(error);

        throw new ExpressionError(ctx.file, ctx.path, `holds the Liquid expression ${JSON.stringify(expression)}, which failed: ${reason}`, {
            cause: error,
        });
    }
}

const emptyEntities: EntityReader = {
    get: () => undefined,
    list: () => [],
    has: () => false,
    describe: () => [],
    kinds: () => [],
};

const noServices: ServiceReader = {
    get(name) {
        throw new ConfigError(`The service "${name}" is not available to config expressions.`);
    },
    has: () => false,
};
