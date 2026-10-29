/**
 * `expressions.evaluator` (S6): evaluates every expression object in one config file's data,
 * inside that file's contributor and before its values go into its patch (S2, "Config expressions
 * are part of the same loop"). Every variable an expression reads is read through the
 * contributor's builder, so the file re-runs when one changes.
 */

import type {
    ConfigBuilder,
    EntityReader,
    EntityRecord,
    JsonObject,
    JsonValue,
    PathSegment,
    ProjectInfo,
    ServiceReader,
} from "@sous-io/plugin-api";
import type { ConfigLookup, VariableSourceEntity, VariablesResolver, VarScope } from "@sous-io/plugin-variables/types";
import { ExpressionError, formatPath } from "./errors.js";
import { hasExpressions, isExpressionObject, isPlainObject } from "./keys.js";
import { LIQUID_LANGUAGE } from "./liquid-language.js";
import { parseExpressionObject, type ExpressionSource, type Plan, type WrittenValue } from "./parse.js";
import type {
    EvaluatedExpression,
    EvaluatedLayer,
    EvaluateLayerOptions,
    ExpressionLanguageContext,
    ExpressionLanguageEntity,
    ExpressionOutcome,
    ExpressionsEvaluator,
    ExpressionUnknowns,
    UnsettledExpression,
} from "./types.js";

/** What the evaluator needs from the plugin that made it. */
export interface EvaluatorDeps {
    /** Services, as `sous.services` gives them (only singletons while the config is built). */
    readonly services: ServiceReader;
    /** Entities after the build, for {@link ExpressionsEvaluator.languages}. Never read while building. */
    readonly entities: EntityReader;
    readonly project: ProjectInfo | undefined;
    /** `host.platform`. Default: Node's `process.platform`. */
    readonly platform?: string;
}

/** The evaluator, plus the check the plugin runs once the config has settled. */
export interface Evaluator extends ExpressionsEvaluator {
    /**
     * Throws a `ConfigError` naming every expression still unknown once the config has settled
     * (S5, "Errors" 6; unknown filters too). The next layer evaluated starts a new build's records.
     */
    settle(): void;
}

/** Names an expression reads that are never variables. */
const BUILT_IN_NAMES = new Set(["host", "env"]);

/** Makes the evaluator. One lives for the whole process; it keeps the latest build's records. */
export function createEvaluator(deps: EvaluatorDeps): Evaluator {
    const byFile = new Map<string, { expressions: EvaluatedExpression[]; unsettled: UnsettledExpression[] }>();
    let stale = false;

    return {
        evaluateLayer(data, options) {
            if (stale) {
                byFile.clear();
                stale = false;
            }

            const run = new LayerRun(data, options, deps);
            const value = run.evaluate();

            byFile.set(options.file, { expressions: run.expressions, unsettled: run.unsettled });

            return { value, expressions: run.expressions, pending: run.unsettled.length > 0 } satisfies EvaluatedLayer;
        },
        isExpressionObject,
        hasExpressions,
        evaluations(file) {
            if (file !== undefined) {
                return [...(byFile.get(file)?.expressions ?? [])];
            }

            return [...byFile.values()].flatMap((entry) => entry.expressions);
        },
        unsettled() {
            return [...byFile.values()].flatMap((entry) => entry.unsettled);
        },
        languages() {
            return deps.entities.list("expression-language").map((language) => language.id);
        },
        settle() {
            const open = this.unsettled();

            stale = true;

            if (open.length > 0) {
                throw unsettledError(open);
            }
        },
    };
}

/** The `ConfigError` for expressions still unknown once the config settled. */
function unsettledError(open: readonly UnsettledExpression[]): ExpressionError {
    const [first, ...rest] = open;

    return new ExpressionError(first!.file, first!.path, `${describeUnknown(first!.unknown)}.`, {
        details: rest.map((entry) => `${entry.path} ${describeUnknown(entry.unknown)} (in ${entry.file})`),
    });
}

function describeUnknown(unknown: ExpressionUnknowns): string {
    const parts: string[] = [];

    if (unknown.variables.length > 0) {
        const one = unknown.variables.length === 1;

        parts.push(`reads ${names(unknown.variables)}, which ${one ? "is" : "are"} not set anywhere in the config`);
    }

    if (unknown.filters.length > 0) {
        const one = unknown.filters.length === 1;

        parts.push(`uses the Liquid filter${one ? "" : "s"} ${names(unknown.filters)}, which no plugin adds`);
    }

    return parts.join(", and ");
}

function names(list: readonly string[]): string {
    return list.join(", ");
}

/** A condition is true by Liquid's rules: only `false`, `undefined` and `null` are false (S5). */
export function isTruthy(value: unknown): boolean {
    return value !== false && value !== undefined && value !== null;
}

/** One evaluation of one file's data. */
class LayerRun {
    readonly expressions: EvaluatedExpression[] = [];
    readonly unsettled: UnsettledExpression[] = [];

    private readonly config: ConfigBuilder;
    private readonly file: string;
    private readonly entities: EntityReader;
    private readonly lookup: ConfigLookup;
    /** The reads of the outermost expression being evaluated; `undefined` outside one. */
    private reads: Record<string, JsonValue | undefined> | undefined;
    private unknown: ExpressionUnknowns | undefined;

    constructor(
        private readonly data: JsonValue,
        private readonly options: EvaluateLayerOptions,
        private readonly deps: EvaluatorDeps,
    ) {
        this.config = options.config;
        this.file = options.file;
        this.entities = builderEntities(options.config);
        this.lookup = { get: (path) => options.config.atPath(path).get() as never };
    }

    evaluate(): JsonValue | undefined {
        return this.walk(this.data, [], {});
    }

    /** A value with every expression object in it evaluated; `undefined` values dropped, empty objects kept. */
    private walk(value: JsonValue, path: readonly PathSegment[], levelVars: VarScope): JsonValue | undefined {
        if (Array.isArray(value)) {
            const out: JsonValue[] = [];

            value.forEach((item, index) => {
                const result = this.walk(item, [...path, index], levelVars);

                if (result !== undefined) {
                    out.push(result);
                }
            });

            return out;
        }

        if (!isPlainObject(value)) {
            return value;
        }

        if (isExpressionObject(value)) {
            return this.expressionObject(value, path, levelVars);
        }

        const inner = isScopeLevel(path) ? { ...levelVars, ...this.ownVarsOf(value, path) } : levelVars;
        const out: JsonObject = {};

        for (const [key, child] of Object.entries(value)) {
            const result = this.walk(child, [...path, key], inner);

            if (result !== undefined) {
                out[key] = result;
            }
        }

        return out;
    }

    /** The plain string `_vars` of an object at a scope level; the file's own root `_vars` at the root. */
    private ownVarsOf(object: JsonObject, path: readonly PathSegment[]): VarScope {
        if (path.length === 0 && this.options.ownVars) {
            return this.options.ownVars;
        }

        const block = object._vars;

        if (!isPlainObject(block)) {
            return {};
        }

        return Object.fromEntries(Object.entries(block).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    }

    /** Evaluates one expression object, recording it when it is the outermost one. */
    private expressionObject(object: JsonObject, path: readonly PathSegment[], levelVars: VarScope): JsonValue | undefined {
        const outermost = this.reads === undefined;

        if (outermost) {
            this.reads = {};
            this.unknown = undefined;
        }

        try {
            const plan = parseExpressionObject(object, path, this.file);
            const value = this.evaluatePlan(plan, path, levelVars);

            if (outermost) {
                this.expressions.push({
                    path: formatPath(path),
                    written: object,
                    value,
                    reads: this.reads!,
                    ...(this.unknown ? { unknown: this.unknown } : {}),
                });
            }

            return value;
        } finally {
            if (outermost) {
                this.reads = undefined;
                this.unknown = undefined;
            }
        }
    }

    private evaluatePlan(plan: Plan, path: readonly PathSegment[], levelVars: VarScope): JsonValue | undefined {
        if (plan.kind === "value") {
            const outcome = this.run(plan.expression, path, levelVars);

            return "unknown" in outcome ? this.pending(path, outcome.unknown) : toJson(outcome.value);
        }

        for (const branch of plan.branches) {
            if (branch.condition === undefined) {
                return this.chosen(branch.then!, path, levelVars);
            }

            const outcome = this.run(branch.condition, path, levelVars);

            if ("unknown" in outcome) {
                return this.pending(path, outcome.unknown);
            }

            if (isTruthy(outcome.value)) {
                return branch.then ? this.chosen(branch.then, path, levelVars) : true;
            }
        }

        return plan.otherwise ? this.chosen(plan.otherwise, path, levelVars) : undefined;
    }

    /** A chosen value, evaluated the same way: it may be, or hold, expression objects (S5, "Nesting"). */
    private chosen(written: WrittenValue, path: readonly PathSegment[], levelVars: VarScope): JsonValue | undefined {
        return this.walk(written.value, path, levelVars);
    }

    /** Records an expression that could not be known in this pass; it gives `undefined`. */
    private pending(path: readonly PathSegment[], unknown: ExpressionUnknowns): undefined {
        this.unknown = unknown;
        this.unsettled.push({ file: this.file, path: formatPath(path), unknown });

        return undefined;
    }

    /** Evaluates one expression string. */
    private run(expression: ExpressionSource, path: readonly PathSegment[], levelVars: VarScope): ExpressionOutcome {
        const language = this.language(expression);
        const ctx: ExpressionLanguageContext = {
            project: this.deps.project,
            file: this.file,
            path: formatPath(expression.path),
            env: this.config.env,
            entities: this.entities,
            services: this.deps.services,
        };
        const variables = [...new Set(language.variables(expression.source, ctx))].filter((name) => !BUILT_IN_NAMES.has(name));

        this.checkForbidden(variables, path);

        const vars = variables.length > 0 ? this.scope(path, levelVars) : levelVars;
        const missing: string[] = [];

        for (const name of variables) {
            const known = Object.hasOwn(vars, name);

            this.reads![name] = known ? vars[name] : undefined;

            if (!known) {
                missing.push(name);
            }
        }

        if (missing.length > 0) {
            return { unknown: { variables: missing, filters: [] } };
        }

        return language.evaluate(expression.source, { host: { platform: this.deps.platform ?? process.platform }, env: this.config.env, vars }, ctx);
    }

    /** The language an expression names, checked (S5, "Expression Languages" 4 and 5). */
    private language(expression: ExpressionSource): ExpressionLanguageEntity {
        const id = expression.language ?? LIQUID_LANGUAGE;
        const languages = this.config.entities("expression-language");
        const language = languages.find((entry) => entry.id === id);

        if (!language) {
            const known = languages.map((entry) => entry.id).join(", ") || "none";

            throw new ExpressionError(this.file, expression.path, `uses the expression language "${id}", which sous does not know. Known languages: ${known}.`);
        }

        if (this.options.fromRecipe && language.runsCode) {
            const allowed = languages.filter((entry) => !entry.runsCode).map((entry) => entry.id).join(", ") || "none";

            throw new ExpressionError(
                this.file,
                expression.path,
                `uses the expression language "${id}", which runs code. A recipe's config file may only use languages that do not (${allowed}).`,
            );
        }

        return language;
    }

    /**
     * The variables an expression sees: the root `_vars` (and `compilation._vars` under
     * `compilation`) of the config built so far, through `variables.resolver`, with the file's own
     * `_vars` of every level containing the expression laid over them (S2, "Variable scopes").
     */
    private scope(path: readonly PathSegment[], levelVars: VarScope): VarScope {
        if (!this.deps.services.has("variables.resolver")) {
            return levelVars;
        }

        const resolver: VariablesResolver = this.deps.services.get("variables.resolver");
        const level = path[0] === "compilation" ? "compilation" : "root";

        // The builder itself, so variable-source entities are read through it too (re-running the file).
        return resolver.scopeIn(this.config, { level, extra: levelVars });
    }

    /** Throws when an expression reads a variable its place forbids: recipe answers under `subscriptions` or `repos` (S2). */
    private checkForbidden(variables: readonly string[], path: readonly PathSegment[]): void {
        const top = path[0];

        if (variables.length === 0 || typeof top !== "string") {
            return;
        }

        for (const source of this.config.entities("variable-source")) {
            if (!source.forbiddenUnder?.includes(top)) {
                continue;
            }

            const given = source.variables({ project: this.deps.project, env: this.config.env, config: this.lookup });
            const read = variables.find((name) => Object.hasOwn(given, name));

            if (read !== undefined) {
                throw new ExpressionError(this.file, path, forbiddenProblem(read, source));
            }
        }
    }
}

function forbiddenProblem(name: string, source: VariableSourceEntity): string {
    const under = source.forbiddenUnder!.map((key) => `"${key}"`).join(" or ");

    if (source.description === "recipe answers") {
        return (
            `reads ${name}, which is an answer to a recipe. An expression that decides which recipes are subscribed ` +
            `or pinned (anything under ${under}) cannot read recipe answers.`
        );
    }

    return `reads ${name}, which comes from ${source.description}. An expression under ${under} cannot read ${source.description}.`;
}

/** Whether a path is one of the four `_vars` levels (S2): root, compilation, a target, an output. */
function isScopeLevel(path: readonly PathSegment[]): boolean {
    if (path.length === 0) {
        return true;
    }

    if (path[0] !== "compilation") {
        return false;
    }

    return (
        path.length === 1 ||
        (path.length === 3 && path[1] === "targets" && typeof path[2] === "number") ||
        (path.length === 5 && path[1] === "targets" && typeof path[2] === "number" && path[3] === "outputs" && typeof path[4] === "number")
    );
}

/** A computed value as plain JSON: `undefined` stays (the key is dropped), array items that are `undefined` go. */
export function toJson(value: unknown): JsonValue | undefined {
    if (value === undefined || value === null || typeof value === "string" || typeof value === "boolean") {
        return value as JsonValue | undefined;
    }

    if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
    }

    if (Array.isArray(value)) {
        return value.map(toJson).filter((item): item is JsonValue => item !== undefined);
    }

    if (isPlainObject(value) && Object.getPrototypeOf(value) === Object.prototype) {
        const out: JsonObject = {};

        for (const [key, item] of Object.entries(value)) {
            const json = toJson(item);

            if (json !== undefined) {
                out[key] = json;
            }
        }

        return out;
    }

    if (typeof value === "function" || typeof value === "symbol") {
        return undefined;
    }

    return String(value);
}

/**
 * Entities as a contributor sees them, read through its builder so each read is recorded (S2,
 * "The Builder" 6). It never reads `sous.entities`, which sous warns about during a build.
 */
function builderEntities(config: ConfigBuilder): EntityReader {
    const reader = {
        get: (kind: string, id: string) => config.entity(kind, id),
        list: (kind: string) => config.entities(kind),
        has: (kind: string, id: string) => config.entity(kind, id) !== undefined,
        describe: (kind: string): EntityRecord[] =>
            config.entities(kind).map((entry) => ({ kind, id: entry.id, entry, plugin: "a plugin" })),
        kinds: () => [],
    };

    return reader as unknown as EntityReader;
}
