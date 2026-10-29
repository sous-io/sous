/**
 * Stand-ins for the tests: a builder over a fixed config, a `variables.resolver` that lays the
 * `_vars` levels over each other, and an evaluator wired to both.
 */

import type { ConfigBuilder, EntityReader, JsonValue, PathInput, ServiceReader } from "@sous-io/plugin-api";
import type { LiquidFilterEntity } from "@sous-io/plugin-liquid/types";
import type { ConfigLookup, ScopeRequest, VariableSourceEntity, VariablesResolver, VarScope } from "@sous-io/plugin-variables/types";
import { createEvaluator, type Evaluator } from "../src/evaluator.js";
import { createLiquidLanguage } from "../src/liquid-language.js";
import type { EvaluatedLayer, EvaluateLayerOptions, ExpressionLanguageEntity } from "../src/types.js";

/** What a fake builder recorded. */
export interface Recorded {
    /** Every config path read. */
    paths: string[];
    /** Every entity kind listed. */
    kinds: string[];
}

/** The entities a fake builder holds, by kind. */
export type EntityLists = Record<string, Array<{ id: string } & Record<string, unknown>>>;

/** A builder over a fixed config, recording every read. Only the reading parts work. */
export function fakeBuilder(config: JsonValue = {}, entities: EntityLists = {}, env: Record<string, string> = {}): { builder: ConfigBuilder; recorded: Recorded } {
    const recorded: Recorded = { paths: [], kinds: [] };
    const lists: EntityLists = { "expression-language": [createLiquidLanguage() as never], ...entities };

    const node = (path: PathInput) => ({
        get: () => {
            const text = typeof path === "string" ? path : path.join(".");

            recorded.paths.push(text);

            return text === "" ? config : text.split(".").reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], config);
        },
    });

    const builder = {
        root: () => node(""),
        atPath: (path: PathInput) => node(path),
        entities: (kind: string) => {
            recorded.kinds.push(kind);

            return lists[kind] ?? [];
        },
        entity: (kind: string, id: string) => {
            recorded.kinds.push(`${kind}:${id}`);

            return (lists[kind] ?? []).find((entry) => entry.id === id);
        },
        env,
        project: undefined,
    };

    return { builder: builder as unknown as ConfigBuilder, recorded };
}

/** A `variables.resolver` stand-in: root `_vars`, then `compilation._vars` for that level, then `extra`. */
export function standInResolver(): VariablesResolver {
    return {
        scopeIn(config: ConfigLookup | ConfigBuilder, request: ScopeRequest = {}): VarScope {
            const get = (path: string) => ("atPath" in config ? config.atPath(path).get() : config.get(path)) as Record<string, string> | undefined;
            const root = get("_vars") ?? {};
            const compilation = request.level && request.level !== "root" ? (get("compilation._vars") ?? {}) : {};

            return { ...root, ...compilation, ...request.extra };
        },
    } as unknown as VariablesResolver;
}

/** Services holding the stand-in resolver. */
export function standInServices(resolver: VariablesResolver | undefined = standInResolver()): ServiceReader {
    return {
        get: (name: string) => {
            if (name === "variables.resolver" && resolver) {
                return resolver;
            }

            throw new Error(`no service ${name}`);
        },
        has: (name: string) => name === "variables.resolver" && resolver !== undefined,
    } as ServiceReader;
}

const noEntities: EntityReader = { get: () => undefined, list: () => [], has: () => false, describe: () => [], kinds: () => [] };

/** An evaluator on the stand-ins, on Linux unless told otherwise. */
export function makeEvaluator(platform = "linux"): Evaluator {
    return createEvaluator({ services: standInServices(), entities: noEntities, project: undefined, platform });
}

/** What {@link evaluate} takes. */
export interface EvaluateOptions extends Partial<Omit<EvaluateLayerOptions, "config">> {
    platform?: string;
    config?: JsonValue;
    entities?: EntityLists;
    env?: Record<string, string>;
    evaluator?: Evaluator;
}

/** Evaluates one file's data with a fresh fake builder. */
export function evaluate(data: unknown, options: EvaluateOptions = {}): EvaluatedLayer & { recorded: Recorded; evaluator: Evaluator } {
    const evaluator = options.evaluator ?? makeEvaluator(options.platform);
    const { builder, recorded } = fakeBuilder(options.config ?? {}, options.entities ?? {}, options.env ?? {});
    const result = evaluator.evaluateLayer(data as JsonValue, {
        file: options.file ?? "conf.d/610-test.jsonc",
        config: builder,
        ...(options.ownVars ? { ownVars: options.ownVars } : {}),
        ...(options.fromRecipe ? { fromRecipe: true } : {}),
    });

    return { ...result, recorded, evaluator };
}

/** The value one file's data evaluates to. */
export function valueOf(data: unknown, options: EvaluateOptions = {}): JsonValue | undefined {
    return evaluate(data, options).value;
}

/** A Liquid filter entity. */
export function filterEntity(id: string, run: (value: unknown, ...args: unknown[]) => unknown): LiquidFilterEntity {
    return { id, filter: () => run as never };
}

/** A variable source like plugin-recipe-answers'. */
export function answersSource(values: Record<string, string>): VariableSourceEntity {
    return { id: "recipe-answers", description: "recipe answers", variables: () => values, forbiddenUnder: ["subscriptions", "repos"] };
}

/** A language that runs code, like a `js` language would. */
export function jsLanguage(): ExpressionLanguageEntity {
    return {
        id: "js",
        runsCode: true,
        variables: () => [],
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        evaluate: (expression, scope) => ({ value: new Function("host", `return (${expression});`)(scope.host) }),
    };
}
