import { BufferedReporter, definePlugin, type PluginDefinition, type ProjectInfo, type Sous } from "@sous-io/plugin-api";
import { createEngine } from "@sous-io/core";
import { liquidPlugin } from "../src/index.js";
import type { LiquidEngines } from "../src/types.js";
import packageJson from "../package.json" with { type: "json" };

/** A stand-in for plugin-host, which plugin-liquid depends on but does not call. */
export const hostStandIn: PluginDefinition = definePlugin({
    name: "@sous-io/plugin-host",
    version: packageJson.version,
    register() {},
});

/** A plugin from a register function. */
export function plugin(name: string, register: (sous: Sous) => void): PluginDefinition {
    return definePlugin({ name, version: "1.0.0", register });
}

/** A project rooted at a directory. */
export function projectAt(root: string): ProjectInfo {
    return { root, sousDir: `${root}/.sous`, configPath: undefined, confDir: `${root}/.sous/conf.d` };
}

/** Builds the config with plugin-liquid and the given plugins, and returns `liquid.engine`. */
export async function engines(
    plugins: PluginDefinition[] = [],
    options: { project?: ProjectInfo } = {},
): Promise<LiquidEngines> {
    const engine = createEngine({ builtIns: [hostStandIn, liquidPlugin, ...plugins], reporter: new BufferedReporter(), ...options });
    const built = await engine.buildConfig();

    return built.services.get("liquid.engine");
}
