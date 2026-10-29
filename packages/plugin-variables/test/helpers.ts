import { createEngine, type Engine } from "@sous-io/core";
import {
    BufferedReporter,
    type ConfigBuilder,
    type ContributorDefinition,
    definePlugin,
    jsonSchema,
    type PluginDefinition,
    type ProjectInfo,
    type Sous,
} from "@sous-io/plugin-api";
import type { HostPackage, HostSousHome } from "@sous-io/plugin-host/types";
import { variablesPlugin } from "../src/index.js";
import type { VariableSourceEntity } from "../src/types.js";

/** The project the tests run in. */
export const PROJECT: ProjectInfo = {
    root: "/work/app",
    sousDir: "/work/app/.sous",
    configPath: "/work/app/.sous/sous.config.jsonc",
    confDir: "/work/app/.sous/conf.d",
};

/** A stand-in for plugin-host: the two services the auto-variables read. */
export const hostStandIn: PluginDefinition = definePlugin({
    name: "@sous-io/plugin-host",
    version: "0.2.34",

    register(sous) {
        const pkg: HostPackage = {
            identity: () => ({ name: "@sous-io/sous", version: "9.8.7", root: "/opt/sous", realRoot: "/opt/sous", bin: undefined }),
        };
        const home: HostSousHome = {
            paths: (env = sous.env) => {
                const root = env.SOUS_HOME ?? "/home/me/.sous";

                return {
                    root,
                    store: `${root}/cache`,
                    indexCache: `${root}/cache/_indexes`,
                    repos: `${root}/repos`,
                    links: `${root}/sous.links.json`,
                    readStrategies: `${root}/cache/read-strategies.json`,
                };
            },
            resolve: (...segments) => ["/home/me/.sous", ...segments].join("/"),
        };

        sous.services.add("host.package", () => pkg, { lifetime: "singleton" });
        sous.services.add("host.sous-home", () => home, { lifetime: "singleton" });
    },
});

/** What a test plugin adds. */
export interface TestPluginOptions {
    /** Contributors, each run as a config file or a plugin would; a function gets `register`'s `sous`. */
    contributors?: readonly ContributorDefinition[] | ((sous: Sous) => readonly ContributorDefinition[]);
    /** Variable sources. */
    sources?: readonly VariableSourceEntity[];
}

/** A plugin that owns the `compilation` and `out` keys (loosely) and adds the given contributors and sources. */
export function testPlugin(options: TestPluginOptions = {}): PluginDefinition {
    return definePlugin({
        name: "test-plugin",
        version: "1.0.0",

        register(sous) {
            sous.entities.add("config-key", { id: "compilation", schema: jsonSchema({ type: "object" }) });
            sous.entities.add("config-key", { id: "out", schema: jsonSchema({ type: "object" }) });

            for (const source of options.sources ?? []) {
                sous.entities.add("variable-source", source);
            }

            const contributors = typeof options.contributors === "function" ? options.contributors(sous) : (options.contributors ?? []);

            for (const contributor of contributors) {
                sous.config.contribute(contributor);
            }
        },
    });
}

/** A contributor that merges data at the root, as a config file does. */
export function file(id: string, data: Record<string, unknown>): ContributorDefinition {
    return { id, contribute: (config: ConfigBuilder) => config.root().merge(data) };
}

/** An engine with plugin-host's stand-in, plugin-variables and a test plugin. */
export function engineWith(
    options: TestPluginOptions & { env?: Record<string, string>; project?: ProjectInfo | null } = {},
): { engine: Engine; reporter: BufferedReporter } {
    const reporter = new BufferedReporter();
    const engine = createEngine({
        builtIns: [hostStandIn, variablesPlugin, testPlugin(options)],
        env: options.env ?? { HOME: "/home/me" },
        project: options.project === null ? undefined : (options.project ?? PROJECT),
        reporter,
        app: { name: "sous", version: "9.8.7" },
    });

    return { engine, reporter };
}

/** The text of an error: its message and every detail line. */
export function errorText(error: unknown): string {
    const sous = error as { message: string; details?: readonly string[] };

    return [sous.message, ...(sous.details ?? [])].join("\n");
}

/** A contributor that sets values by path without reading anything, as a plugin would. */
export function setter(id: string, values: Record<string, unknown>): ContributorDefinition {
    return {
        id,
        contribute(config: ConfigBuilder) {
            for (const [path, value] of Object.entries(values)) {
                config.atPath(path).set(value);
            }
        },
    };
}
