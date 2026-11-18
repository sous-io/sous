/**
 * Building a scope: the auto-variables, then the `variable-source` entities, then `_env`, then the
 * `_vars` of each level down to the one asked for:
 *
 * ```text
 * auto-variables → variable sources → _env → root _vars
 * └── compilation._vars
 *     └── compilation.targets[]._vars
 *         └── targets[].outputs[]._vars
 * ```
 */

import { ConfigError, type Environment, type ProjectInfo, SousError } from "@sous-io/plugin-api";
import { autoVariableError, resolveBlock } from "./resolve-block.js";
import { isAutoVariable } from "./auto.js";
import type { ConfigLookup, ScopeOrigin, ScopeRequest, VariableSourceContext, VariableSourceEntity } from "./types.js";

/** What a scope is built from: a config view, with every read going through it. */
export interface ScopeView {
    /** The value at a config path. While the config is built, this is a recorded read. */
    get(path: string): unknown;
    /** The `variable-source` entities. While the config is built, a recorded read of the list. */
    sources(): readonly VariableSourceEntity[];
    /** The view as a `ConfigLookup`, for the sources. */
    readonly lookup: ConfigLookup;
    readonly env: Environment;
    readonly project: ProjectInfo | undefined;
}

/** A built scope, and where each value came from. */
export interface BuiltScope {
    readonly scope: Record<string, string>;
    readonly origins: Record<string, ScopeOrigin>;
}

/** The names of the env files, for the message when an `_env` variable is unset. */
const ENV_LOCAL_NAME = ".env.local";
const ENV_DEFAULTS_NAME = ".env";

/**
 * Builds the scope a request asks for. `partial` leaves out what cannot be resolved yet instead of
 * throwing (a variable unknown during a pass reads as `undefined`).
 */
export function buildScope(
    view: ScopeView,
    autoVariables: Readonly<Record<string, string | undefined>>,
    request: ScopeRequest,
    partial: boolean,
): BuiltScope {
    const scope: Record<string, string> = {};
    const origins: Record<string, ScopeOrigin> = {};
    const lay = (values: Readonly<Record<string, unknown>> | undefined, from: string, skipAuto: boolean): void => {
        for (const [name, value] of Object.entries(values ?? {})) {
            if (typeof value !== "string" || (skipAuto && isAutoVariable(name))) {
                continue;
            }

            scope[name] = value;
            origins[name] = { from, value };
        }
    };

    lay(autoVariables, "auto", false);

    const sources = view.sources();
    const context: VariableSourceContext = { project: view.project, env: view.env, config: view.lookup };

    for (const source of sources) {
        lay(source.variables(context), source.id, true);
    }

    if (request.scopeKey !== undefined) {
        for (const source of sources) {
            lay(source.scoped?.(request.scopeKey, context), source.id, true);
        }
    }

    lay(envScope(view, partial), "_env", false);

    let current: Record<string, string> = scope;
    const block = (path: string, values: unknown): void => {
        if (!isRecord(values)) {
            return;
        }

        const result = resolveBlock(values, current, path, { partial });

        for (const name of result.resolved) {
            origins[name] = { from: path, value: result.scope[name]! };
        }

        current = result.scope;
    };

    block("_vars", view.get("_vars"));

    const level = request.level ?? "root";

    if (level !== "root") {
        block("compilation._vars", view.get("compilation._vars"));
    }

    if (level === "target" || level === "output") {
        const target = requireIndex(request.target, "target", level);
        const targetPath = `compilation.targets[${target}]`;

        block(`${targetPath}._vars`, view.get(`${targetPath}._vars`));

        if (level === "output") {
            const output = requireIndex(request.output, "output", level);
            const outputPath = `${targetPath}.outputs[${output}]`;

            block(`${outputPath}._vars`, view.get(`${outputPath}._vars`));
        }
    }

    if (request.extra !== undefined) {
        block("extra", request.extra);
    }

    const kept: Record<string, ScopeOrigin> = {};

    for (const name of Object.keys(current)) {
        kept[name] = origins[name]!;
    }

    return { scope: current, origins: kept };
}

/**
 * The root `_env` block: config variable names mapped to the environment variables that hold their
 * values. An unset variable is an error naming the env files it can be set in.
 */
function envScope(view: ScopeView, partial: boolean): Record<string, string> {
    const mapping = view.get("_env");
    const scope: Record<string, string> = {};

    if (!isRecord(mapping)) {
        return scope;
    }

    for (const [name, envName] of Object.entries(mapping)) {
        if (typeof envName !== "string") {
            continue;
        }

        if (isAutoVariable(name)) {
            if (partial) {
                continue;
            }

            throw autoVariableError(name, "_env");
        }

        const value = view.env[envName];

        if (value === undefined) {
            if (partial) {
                continue;
            }

            throw unsetEnvError(name, envName, view.project);
        }

        scope[name] = value;
    }

    return scope;
}

function unsetEnvError(name: string, envName: string, project: ProjectInfo | undefined): ConfigError {
    const sousDir = project?.sousDir;
    const local = sousDir ? `${sousDir}/${ENV_LOCAL_NAME}` : `.sous/${ENV_LOCAL_NAME}`;
    const defaults = sousDir ? `${sousDir}/${ENV_DEFAULTS_NAME}` : `.sous/${ENV_DEFAULTS_NAME}`;

    return new ConfigError(
        `_env resolution failed: environment variable '${envName}' (mapped to config var '${name}') is not set.`,
        {
            details: [
                `Define it in ${local} as:`,
                `  ${envName}=<value>`,
                `...or, if the value is shared by the whole team and is not a secret, in ${defaults} (committed).`,
                "...or export it in your shell before running sous.",
            ],
        },
    );
}

function requireIndex(index: number | undefined, what: string, level: string): number {
    if (index === undefined || !Number.isInteger(index) || index < 0) {
        throw new SousError(`A scope at the ${level} level needs the ${what} index.`);
    }

    return index;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

