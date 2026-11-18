/**
 * The auto-variables: the values sous sets itself, beneath every source, `_env` and `_vars`. This is
 * the one list (before the refactor, `config-kernel.mjs` kept a second, smaller one).
 */

import type { ProjectInfo } from "@sous-io/plugin-api";
import type { AutoVariableName } from "./types.js";

/** Every auto-variable name. */
export const AUTO_VARIABLE_NAMES: readonly AutoVariableName[] = [
    "projectRoot",
    "sousDir",
    "sousConfigPath",
    "sousConfDir",
    "sousHome",
    "sousRootPath",
    "sousVersion",
];

const NAMES: ReadonlySet<string> = new Set(AUTO_VARIABLE_NAMES);

/** Whether sous sets this name itself. */
export function isAutoVariable(name: string): name is AutoVariableName {
    return NAMES.has(name);
}

/** What the auto-variables are made from. */
export interface AutoVariableInputs {
    /** The project, when there is one. */
    readonly project: ProjectInfo | undefined;
    /** The sous home root (`host.sous-home`). */
    readonly sousHome: string;
    /** The installed package's root directory (`host.package`). */
    readonly packageRoot: string;
    /** The installed sous version (`host.package`). */
    readonly version: string;
}

/**
 * The auto-variables. The project ones (`projectRoot`, `sousDir`, `sousConfigPath`, `sousConfDir`)
 * are present only inside a project, and `sousConfigPath` only when a config file was found.
 */
export function buildAutoVariables(inputs: AutoVariableInputs): Partial<Record<AutoVariableName, string>> {
    const vars: Partial<Record<AutoVariableName, string>> = {
        sousRootPath: inputs.packageRoot,
        sousVersion: inputs.version,
        sousHome: inputs.sousHome,
    };
    const project = inputs.project;

    if (project) {
        vars.projectRoot = project.root;
        vars.sousDir = project.sousDir;
        vars.sousConfDir = project.confDir;

        if (project.configPath !== undefined) {
            vars.sousConfigPath = project.configPath;
        }
    }

    return vars;
}
