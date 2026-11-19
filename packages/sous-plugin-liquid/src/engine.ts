/**
 * `liquid.engine`: builds a LiquidJS engine with every tag and filter the `liquid-tag` and
 * `liquid-filter` entities add. Today's `src/templating/init-liquid-engine.ts` registered two
 * fixed lists; here the lists are whatever plugins add.
 */

import { Liquid, type LiquidOptions } from "liquidjs";
import {
    NotFoundError,
    PluginError,
    type EntityReader,
    type EntityRecord,
    type Environment,
    type ProjectInfo,
    type ServiceReader,
} from "@sous-io/sous-plugin-api";
import type {
    LiquidEngineOptions,
    LiquidEngines,
    LiquidExtensionContext,
    LiquidFilterEntity,
    LiquidPurpose,
    LiquidTagEntity,
} from "./types.js";

/** The purpose an engine is built for when the caller names none. */
export const DEFAULT_PURPOSE: LiquidPurpose = "template";

/** The purpose config expressions build their engines for. */
export const CONFIG_EXPRESSION_PURPOSE: LiquidPurpose = "config-expression";

/** What the engine builder reads: the parts of a service context it needs. */
export interface LiquidEngineDeps {
    readonly project: ProjectInfo | undefined;
    readonly env: Environment;
    readonly services: ServiceReader;
    readonly entities: EntityReader;
}

/** The part of `variables.secrets` this plugin reads, when sous-plugin-variables is active. */
interface DeclaredSecrets {
    declared(): ReadonlySet<string>;
}

/**
 * Whether a tag is registered for a purpose. With no `purposes`, a tag is registered everywhere but
 * in config expressions, which must give the same result for the same input.
 */
export function tagAllowed(tag: Pick<LiquidTagEntity, "purposes">, purpose: LiquidPurpose): boolean {
    return tag.purposes ? tag.purposes.includes(purpose) : purpose !== CONFIG_EXPRESSION_PURPOSE;
}

/** Whether a filter is registered for a purpose. With no `purposes`, a filter is registered everywhere. */
export function filterAllowed(filter: Pick<LiquidFilterEntity, "purposes">, purpose: LiquidPurpose): boolean {
    return filter.purposes ? filter.purposes.includes(purpose) : true;
}

/** The service object: one per `services.get("liquid.engine")`, since the service is a factory. */
export function createLiquidEngines(deps: LiquidEngineDeps): LiquidEngines {
    return {
        create: (options = {}) => buildEngine(deps, options),
        available(purpose = DEFAULT_PURPOSE) {
            return {
                tags: deps.entities.list("liquid-tag").filter((tag) => tagAllowed(tag, purpose)).map((tag) => tag.id),
                filters: deps.entities
                    .list("liquid-filter")
                    .filter((filter) => filterAllowed(filter, purpose))
                    .map((filter) => filter.id),
            };
        },
    };
}

/**
 * One configured engine. The settings match today's engine (`extname: ""`, lenient variables and
 * filters); `options.liquid` overrides any of them.
 */
function buildEngine(deps: LiquidEngineDeps, options: LiquidEngineOptions): Liquid {
    const purpose = options.purpose ?? DEFAULT_PURPOSE;
    const root = rootOf(options.root, deps.project);
    const liquidOptions: LiquidOptions = {
        extname: "",
        strictVariables: false,
        strictFilters: false,
        ...options.liquid,
        ...(root === undefined ? {} : { root }),
        ...(options.fs === undefined ? {} : { fs: options.fs }),
    };
    const engine = withBooleans(new Liquid(liquidOptions), options.booleanNames ?? declaredBooleans(deps.services));

    // The secret names stay in the context, never in the template scope, so no dump can print them.
    const ctx: LiquidExtensionContext = Object.freeze({
        project: deps.project,
        env: deps.env,
        services: deps.services,
        entities: deps.entities,
        purpose,
        secretNames: new Set(options.secretNames ?? declaredSecrets(deps.services)),
        data: Object.freeze({ ...options.data }),
    });

    const filters = pick(deps.entities.describe("liquid-filter"), options.only?.filters, (entry) => filterAllowed(entry, purpose), "Liquid filter");

    for (const record of filters) {
        engine.registerFilter(record.id, make(record, "filter", () => record.entry.filter(ctx)));
    }

    const tags = pick(deps.entities.describe("liquid-tag"), options.only?.tags, (entry) => tagAllowed(entry, purpose), "Liquid tag");

    for (const record of tags) {
        engine.registerTag(record.id, make(record, "tag", () => record.entry.tag(ctx)));
    }

    return engine;
}

/** The roots partials are looked up in: the caller's, else the project root, else LiquidJS's default. */
function rootOf(root: LiquidEngineOptions["root"], project: ProjectInfo | undefined): string | string[] | undefined {
    if (root !== undefined) {
        return typeof root === "string" ? root : [...root];
    }

    return project ? [project.root] : undefined;
}

/**
 * A scope with the values of the boolean variables as booleans: `"true"` becomes `true` and
 * `"false"` becomes `false`, so `{% if name %}` takes the false branch for an answer of `false`
 * (ADR 0038). Any other value, and every other name, is left as it is.
 *
 * ```ts
 * liquidValues({ jiraEnabled: "false", mode: "false" }, new Set(["jiraEnabled"]));
 * // -> { jiraEnabled: false, mode: "false" }
 * ```
 */
export function liquidValues<T extends Readonly<Record<string, unknown>>>(scope: T, booleanNames: ReadonlySet<string>): T {
    let out: Record<string, unknown> | undefined;

    for (const name of booleanNames) {
        const value = scope[name];

        if (value === "true" || value === "false") {
            out ??= { ...scope };
            out[name] = value === "true";
        }
    }

    return (out ?? scope) as T;
}

/** An engine whose every render and evaluation sees the boolean variables as booleans. */
function withBooleans(engine: Liquid, names: Iterable<string>): Liquid {
    const booleanNames = new Set(names);

    if (booleanNames.size === 0) {
        return engine;
    }

    const convert = (scope: unknown): unknown =>
        scope !== null && typeof scope === "object" && Object.getPrototypeOf(scope) === Object.prototype
            ? liquidValues(scope as Record<string, unknown>, booleanNames)
            : scope;
    const internal = engine as unknown as Record<"_render" | "_renderFile" | "_evalValue", (first: unknown, scope: unknown, ...rest: unknown[]) => unknown>;

    for (const method of ["_render", "_renderFile", "_evalValue"] as const) {
        const original = internal[method].bind(engine);

        internal[method] = (first, scope, ...rest) => original(first, convert(scope), ...rest);
    }

    return engine;
}

/** The names `variables.booleans` declares, when sous-plugin-variables is active and the config is built; none otherwise. */
function declaredBooleans(services: ServiceReader): Iterable<string> {
    try {
        return services.has("variables.booleans") ? (services.get("variables.booleans") as unknown as { declared(): ReadonlySet<string> }).declared() : [];
    } catch {
        // A `config` service does not exist while the config is built.
        return [];
    }
}

/** The names `variables.secrets` declares, when sous-plugin-variables is active; none otherwise. */
function declaredSecrets(services: ServiceReader): Iterable<string> {
    if (!services.has("variables.secrets")) {
        return [];
    }

    return (services.get("variables.secrets") as DeclaredSecrets).declared();
}

/**
 * The entities an engine gets: those named in `only` (whatever their purposes, since the caller
 * asked for them by name), or else every one its purpose allows.
 */
function pick<E extends { id: string }>(
    records: EntityRecord<E>[],
    only: readonly string[] | undefined,
    allowed: (entry: E) => boolean,
    thing: string,
): EntityRecord<E>[] {
    if (only === undefined) {
        return records.filter((record) => allowed(record.entry));
    }

    return only.map((id) => {
        const record = records.find((candidate) => candidate.id === id);

        if (!record) {
            throw new NotFoundError(thing, id);
        }

        return record;
    });
}

/** Calls a tag's or filter's factory, naming its plugin when it throws. */
function make<T>(record: EntityRecord<{ id: string }>, what: "tag" | "filter", factory: () => T): T {
    try {
        return factory();
    } catch (error) {
        throw new PluginError(record.plugin, `The Liquid ${what} "${record.id}" from ${record.plugin} could not be made.`, {
            cause: error,
            details: [error instanceof Error ? error.message : String(error)],
        });
    }
}
