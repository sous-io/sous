/**
 * The `variables.resolver` service: `${var}` substitution, `_vars` resolution and the scope levels.
 */

import { parsePath } from "@sous-io/documents";
import type {
    BuiltConfig,
    ConfigBuilder,
    EngineHandle,
    EntityReader,
    Environment,
    JsonValue,
    PathInput,
    ProjectInfo,
    ServiceReader,
} from "@sous-io/plugin-api";
import type {} from "@sous-io/plugin-host/types";
import { buildAutoVariables, isAutoVariable } from "./auto.js";
import { resolveBlock } from "./resolve-block.js";
import { type BuiltScope, buildScope, type ScopeView } from "./scope.js";
import { normalizePath, references, substitute, substituteStrict, substituteValue, unresolved } from "./substitute.js";
import type {
    AutoVariableName,
    ConfigLookup,
    ScopeOrigin,
    ScopeRequest,
    VariableSourceEntity,
    VariablesResolver,
    VarScope,
} from "./types.js";

/** What the resolver reads besides the config. */
export interface ResolverDeps {
    /** Services, for `host.sous-home` and `host.package`. */
    readonly services: ServiceReader;
    /** The engine, for the latest built config. */
    readonly engine: Pick<EngineHandle, "config">;
    readonly env: Environment;
    readonly project: ProjectInfo | undefined;
}

/**
 * The resolver. It is a singleton (one per process), so contributors can use it while the config is
 * built: `scopeIn(builder)` reads through the builder, and `scope()` reads the latest built config.
 */
export class Resolver implements VariablesResolver {
    /** Scopes of built configs, which never change once built. */
    private readonly cache = new WeakMap<object, Map<string, BuiltScope>>();

    constructor(private readonly deps: ResolverDeps) {}

    substitute(text: string, scope: VarScope): string {
        return substitute(text, scope);
    }

    substituteStrict(text: string, scope: VarScope, context: string): string {
        return substituteStrict(text, scope, context);
    }

    substituteValue<T extends JsonValue>(value: T, scope: VarScope, context: string): T {
        return substituteValue(value, scope, context);
    }

    references(text: string): string[] {
        return references(text);
    }

    unresolved(text: string, scope?: VarScope): string[] {
        return unresolved(text, scope);
    }

    normalizePath(value: string): string {
        return normalizePath(value, this.deps.env.HOME ?? this.deps.env.USERPROFILE);
    }

    resolveBlock(block: Readonly<Record<string, string>>, inherited: VarScope, context: string): Record<string, string> {
        return resolveBlock(block, inherited, context).scope;
    }

    autoVariables(): Partial<Record<AutoVariableName, string>> {
        return this.autoFor(this.deps.env, this.deps.project);
    }

    isAutoVariable(name: string): name is AutoVariableName {
        return isAutoVariable(name);
    }

    scope(request: ScopeRequest = {}): VarScope {
        return this.build(this.deps.engine.config, request).scope;
    }

    scopeIn(config: ConfigLookup | ConfigBuilder, request: ScopeRequest = {}): VarScope {
        return this.build(config, request).scope;
    }

    origins(request: ScopeRequest = {}): Record<string, ScopeOrigin> {
        return this.build(this.deps.engine.config, request).origins;
    }

    originsIn(config: ConfigLookup | ConfigBuilder, request: ScopeRequest = {}): Record<string, ScopeOrigin> {
        return this.build(config, request).origins;
    }

    requestAt(path: PathInput): ScopeRequest {
        const segments = typeof path === "string" ? parsePath(path) : path;

        if (segments[0] !== "compilation") {
            return { level: "root" };
        }

        const target = segments[2];

        if (segments[1] !== "targets" || typeof target !== "number") {
            return { level: "compilation" };
        }

        const output = segments[4];

        if (segments[3] !== "outputs" || typeof output !== "number") {
            return { level: "target", target };
        }

        return { level: "output", target, output };
    }

    private build(config: ConfigLookup | ConfigBuilder, request: ScopeRequest): BuiltScope {
        if (isBuilder(config)) {
            const view = builderView(config);

            return buildScope(view, this.autoFor(view.env, view.project), request, request.partial ?? true);
        }

        const cacheable = isBuiltConfig(config);
        // Only a built config is finished; any other view may still be mid-build.
        const partial = request.partial ?? !cacheable;
        const key = JSON.stringify([request.level, request.target, request.output, request.scopeKey, request.extra, partial]);
        const cached = cacheable ? this.cache.get(config)?.get(key) : undefined;

        if (cached) {
            return cached;
        }

        const entities = cacheable ? config.entities : this.deps.engine.config.entities;
        const view = lookupView(config, entities, this.deps.env, this.deps.project);
        const built = buildScope(view, this.autoFor(view.env, view.project), request, partial);

        if (cacheable) {
            const forConfig = this.cache.get(config) ?? new Map<string, BuiltScope>();

            forConfig.set(key, built);
            this.cache.set(config, forConfig);
        }

        return built;
    }

    private autoFor(env: Environment, project: ProjectInfo | undefined): Partial<Record<AutoVariableName, string>> {
        const identity = this.deps.services.get("host.package").identity();

        return buildAutoVariables({
            project,
            sousHome: this.deps.services.get("host.sous-home").paths(env).root,
            packageRoot: identity.root,
            version: identity.version,
        });
    }
}

/** Whether a config view is a contributor's builder. */
function isBuilder(config: ConfigLookup | ConfigBuilder): config is ConfigBuilder {
    const candidate = config as Partial<ConfigBuilder>;

    return typeof candidate.atPath === "function" && typeof candidate.entities === "function";
}

/** Whether a config view is a built config, which has its own entities and never changes. */
function isBuiltConfig(config: ConfigLookup): config is BuiltConfig {
    const candidate = config as Partial<BuiltConfig>;

    return typeof candidate.hash === "string" && typeof candidate.entities?.list === "function";
}

/** Reads through a builder, so each read is recorded and the contributor re-runs when one changes. */
function builderView(builder: ConfigBuilder): ScopeView {
    const lookup: ConfigLookup = { get: <T>(path: PathInput) => builder.atPath(path).get<T>() };

    return {
        get: (path) => lookup.get(path),
        sources: () => builder.entities("variable-source") as VariableSourceEntity[],
        lookup,
        env: builder.env,
        project: builder.project,
    };
}

function lookupView(config: ConfigLookup, entities: EntityReader, env: Environment, project: ProjectInfo | undefined): ScopeView {
    return {
        get: (path) => config.get(path),
        sources: () => entities.list("variable-source") as VariableSourceEntity[],
        lookup: config,
        env,
        project,
    };
}
