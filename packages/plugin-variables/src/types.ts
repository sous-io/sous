/**
 * The contract of plugin-variables: `${var}`
 * substitution, the `_vars` loop, the four scope levels, auto-variables, variable names and which
 * values are secret. The config files and the compiler both use it, so it sits below both.
 *
 * Other plugins import this file type-only.
 */

import type { ConfigBuilder, Environment, JsonValue, PathInput, ProjectInfo } from "@sous-io/plugin-api";

/** A variable scope: names to string values. */
export type VarScope = Readonly<Record<string, string>>;

/**
 * The variables sous sets itself (`projectRoot` among them). Setting one in `_vars` or `_env` is
 * an error. `projectRoot`, `sousDir`, `sousConfigPath` and `sousConfDir` exist only inside a project.
 */
export type AutoVariableName =
    | "projectRoot"
    | "sousDir"
    | "sousConfigPath"
    | "sousConfDir"
    | "sousHome"
    | "sousRootPath"
    | "sousVersion";

/** The four levels `_vars` may be set at, each inheriting the ones above it. */
export type ScopeLevel = "root" | "compilation" | "target" | "output";

/**
 * Reading config values, by path: a `ConfigReader` after the build, or a builder's view while it is
 * built (each read then recorded).
 */
export interface ConfigLookup {
    get<T = JsonValue>(path: PathInput): T | undefined;
}

/** What a `variable-source` entity's methods get. */
export interface VariableSourceContext {
    readonly project: ProjectInfo | undefined;
    readonly env: Environment;
    /** The config as far as it is known: the built one, or the builder's view while building. */
    readonly config: ConfigLookup;
}

/**
 * A `variable-source` entity: an extra source of variables, such as recipe answers. Its values sit
 * between the auto-variables and `_env`, so the user's `_env` and `_vars` win.
 */
export interface VariableSourceEntity {
    id: string;
    /** What the variables are, for errors: `recipe answers`. */
    description: string;
    /** Values for the root scope, merged over the auto-variables in plugin order. */
    variables(ctx: VariableSourceContext): VarScope;
    /** Values for one named scope (a recipe's own outputs: `namespace/recipe`), laid over the root. */
    scoped?(scopeKey: string, ctx: VariableSourceContext): VarScope | undefined;
    /** The names of the values it gives that are secret. */
    secrets?(ctx: VariableSourceContext): readonly string[];
    /**
     * Top-level config keys under which an expression may not read these variables (recipe
     * answers: `subscriptions` and `repos`).
     */
    forbiddenUnder?: readonly string[];
}

/** Where a scope is asked for: a level, and the indexes that reach it. */
export interface ScopeRequest {
    /** Default `root`. */
    level?: ScopeLevel;
    /** The index into `compilation.targets`, for `target` and `output`. */
    target?: number;
    /** The index into the target's `outputs`, for `output`. */
    output?: number;
    /** A named scope from the `variable-source` entities (`namespace/recipe`), laid over the root. */
    scopeKey?: string;
    /** More values laid over the result, as an inner level would be: a `_vars` block, resolved over it. */
    extra?: VarScope;
    /**
     * Leaves out what cannot be resolved yet (a `${name}` no one sets, an unset `_env` variable)
     * instead of throwing, so it reads as `undefined` for this pass. Default: `false` for a
     * built config (`scope()`, or `scopeIn` given a `BuiltConfig`), `true` for any other view.
     */
    partial?: boolean;
}

/** Which variables a scope's value came from, for `--layers` and errors. */
export interface ScopeOrigin {
    /** `auto`, a `variable-source` id, `_env`, or the path of the `_vars` block. */
    readonly from: string;
    readonly value: string;
}

/** `${var}` substitution, `_vars` resolution and the scope levels. */
export interface VariablesResolver {
    /** Replaces every `${name}` it knows; unknown ones stay as written. */
    substitute(text: string, scope: VarScope): string;
    /** Replaces every `${name}`; throws a `ConfigError` naming `context` and each unknown name. */
    substituteStrict(text: string, scope: VarScope, context: string): string;
    /** Substitutes every string inside a JSON value, strictly. */
    substituteValue<T extends JsonValue>(value: T, scope: VarScope, context: string): T;
    /** The names of every `${name}` in text. */
    references(text: string): string[];
    /** The names a scope does not resolve. */
    unresolved(text: string, scope?: VarScope): string[];
    /** A substituted path with `~` expanded and separators normalized. */
    normalizePath(value: string): string;
    /** Resolves one `_vars` block over an inherited scope, values referring to each other in any order. */
    resolveBlock(block: Readonly<Record<string, string>>, inherited: VarScope, context: string): Record<string, string>;
    /** The auto-variables for this project and environment. The project ones are missing outside a project. */
    autoVariables(): Partial<Record<AutoVariableName, string>>;
    /** Whether sous sets this name itself, so no `_vars` or `_env` may. */
    isAutoVariable(name: string): name is AutoVariableName;
    /** The scope at a level of the latest built config. */
    scope(request?: ScopeRequest): VarScope;
    /**
     * The same, over any config view. While the config is built, pass the contributor's
     * `ConfigBuilder` itself: every `_vars`, `_env` and `variable-source` read then goes through it
     * and is recorded, so the contributor re-runs when a variable it read changes.
     */
    scopeIn(config: ConfigLookup | ConfigBuilder, request?: ScopeRequest): VarScope;
    /** Where each value of a scope came from. */
    origins(request?: ScopeRequest): Record<string, ScopeOrigin>;
    /** The same, over any config view. */
    originsIn(config: ConfigLookup | ConfigBuilder, request?: ScopeRequest): Record<string, ScopeOrigin>;
    /**
     * The scope request for a value at a config path: the levels that contain it. `compilation.targets[2].outputs[0].destinationDir` gives the output level; anything
     * outside `compilation` gives the root.
     */
    requestAt(path: PathInput): ScopeRequest;
}

/** Variable names and their spellings. */
export interface VariablesNames {
    /** `SOUS_VAR_`. */
    readonly envPrefix: string;
    /** `branchPattern` → `BRANCH_PATTERN`. */
    toUpperSnake(name: string): string;
    /** The shared environment name of a variable: `SOUS_VAR_BRANCH_PATTERN`. */
    sharedName(variable: string): string;
    /** `SOUS_VAR_WORKFLOW_TASK_FILES_BRANCH_PATTERN`. */
    recipeScopedName(namespace: string, recipe: string, variable: string): string;
    /** `SOUS_VAR_WORKFLOW_BRANCH_PATTERN`. */
    namespaceScopedName(namespace: string, variable: string): string;
    /** The name a definition is answered by with nothing else said: its `env`, or its shared name. */
    bareName(definition: { readonly name: string; readonly env?: string }): string;
    /** Whether text is a well-formed variable name (camelCase). */
    isVariableName(text: string): boolean;
    /** Whether text is a well-formed environment variable name. */
    isEnvName(text: string): boolean;
}

/** Which values are secret, and hiding them. */
export interface VariablesSecrets {
    /** What a hidden value prints as: `(hidden)`. */
    readonly hiddenValue: string;
    /** Every name declared secret in this config (by `variable-source` entities). */
    declared(): ReadonlySet<string>;
    /** Whether a name and value are secret: declared, or very probably a secret by name or value. */
    isSecret(name: string, value: unknown, declared?: ReadonlySet<string>): boolean;
    /** Whether a name sounds like a secret (`apiToken`). */
    hasSecretName(name: string): boolean;
    /** Whether a value looks like a secret (a known token prefix). */
    hasSecretValue(value: string): boolean;
    /** A copy of a scope with every secret value replaced by `hiddenValue`. */
    hide(scope: VarScope, declared?: ReadonlySet<string>): Record<string, string>;
}

/** The root `_vars` and `_env` keys this plugin owns. */
export interface VariablesConfig {
    /** Config variables, resolved in any order. Auto-variable names are refused. */
    _vars?: Record<string, string>;
    /** Config variable names mapped to the environment variables that give their values. */
    _env?: Record<string, string>;
}

declare module "@sous-io/plugin-api" {
    interface SousServices {
        /** `${var}` substitution and scopes. */
        "variables.resolver": VariablesResolver;
        /** Variable names and spellings. */
        "variables.names": VariablesNames;
        /** Secrets. */
        "variables.secrets": VariablesSecrets;
    }

    interface SousEntities {
        /** An extra source of variables. */
        "variable-source": VariableSourceEntity;
    }

    interface SousConfig {
        /** The root config variables. */
        _vars: Record<string, string>;
        /** Config variables read from the environment. */
        _env: Record<string, string>;
    }
}
