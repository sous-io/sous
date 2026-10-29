import { createEngine } from "@sous-io/core";
import { BufferedReporter, definePlugin, type Environment, type PluginDefinition, type ProjectInfo, type Sous } from "@sous-io/plugin-api";
import { hostPlugin } from "../src/index.js";
import type { ServiceName, ServiceType } from "@sous-io/plugin-api";

/** A plugin from a register function. */
export function plugin(name: string, register: (sous: Sous) => void): PluginDefinition {
    return definePlugin({ name, version: "1.0.0", register });
}

/** A project rooted at a directory. */
export function projectAt(root: string): ProjectInfo {
    return { root, sousDir: `${root}/.sous`, configPath: undefined, confDir: `${root}/.sous/conf.d` };
}

/** Builds the config with plugin-host and the given plugins, and returns a service reader. */
export async function hostServices(plugins: PluginDefinition[] = [], options: { env?: Environment; project?: ProjectInfo } = {}) {
    const engine = createEngine({ builtIns: [hostPlugin, ...plugins], reporter: new BufferedReporter(), ...options });
    const built = await engine.buildConfig();

    return {
        get: <N extends ServiceName>(name: N): ServiceType<N> => built.services.get(name),
    };
}
