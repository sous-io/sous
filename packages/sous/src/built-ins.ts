import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import { cliPlugin } from "@sous-io/plugin-cli";
import { hostPlugin } from "@sous-io/plugin-host";
import { gitPlugin } from "@sous-io/plugin-git";
import { refsPlugin } from "@sous-io/plugin-refs";
import { variablesPlugin } from "@sous-io/plugin-variables";
import { liquidPlugin } from "@sous-io/plugin-liquid";
import { formatsPlugin } from "@sous-io/plugin-formats";
import { expressionsPlugin } from "@sous-io/plugin-expressions";
import { configFilesPlugin } from "@sous-io/plugin-config-files";
import { confdPlugin } from "@sous-io/plugin-confd";
import { compilerPlugin } from "@sous-io/plugin-compiler";
import { recipesPlugin } from "@sous-io/plugin-recipes";
import { recipeAnswersPlugin } from "@sous-io/plugin-recipe-answers";
import { skillsPlugin } from "@sous-io/plugin-skills";
import { memoriesPlugin } from "@sous-io/plugin-memories";
import { buildPlugin } from "@sous-io/plugin-build";
import { harnessesPlugin } from "@sous-io/plugin-harnesses";
import { authoringPlugin } from "@sous-io/plugin-authoring";
import { initPlugin } from "@sous-io/plugin-init";
import { updatePlugin } from "@sous-io/plugin-update";
import { inspectPlugin } from "@sous-io/plugin-inspect";
import { mcpPlugin } from "@sous-io/plugin-mcp";
import { npmPlugin } from "@sous-io/plugin-npm";
import { pnpmPlugin } from "@sous-io/plugin-pnpm";
import { yarnPlugin } from "@sous-io/plugin-yarn";
import { githubPlugin } from "@sous-io/plugin-github";
import { gitlabPlugin } from "@sous-io/plugin-gitlab";
import { localPlugin } from "@sous-io/plugin-local";
import { claudeCodePlugin } from "@sous-io/plugin-claude-code";

/**
 * Loads the plugins named in `SOUS_PLUGINS` (separated by commas), for one run, by adding them to
 * `plugins.load`. A stopgap until `plugin-config-files` owns the `SOUS_*` variables; a project's
 * files can list plugins the same way.
 */
export const envPluginsPlugin: PluginDefinition = definePlugin({
    name: "@sous-io/sous",
    version: "0.2.34",
    description: "Loads the plugins named in SOUS_PLUGINS.",

    register(sous) {
        sous.config.contribute({
            id: "sous/env-plugins",
            contribute(config) {
                const listed = (config.env.SOUS_PLUGINS ?? "")
                    .split(",")
                    .map((item) => item.trim())
                    .filter((item) => item !== "");

                for (const specifier of listed) {
                    config.atPath("plugins.load").append(specifier);
                }
            },
        });
    },
});

/**
 * The built-in plugins, loaded first and in this order unless the config disables them (S1,
 * "Built-in Plugins"; S6, "Packages"). Each comes after every plugin it depends on (S6,
 * "Dependency Direction").
 */
export const BUILT_IN_PLUGINS: readonly PluginDefinition[] = [
    hostPlugin,
    gitPlugin,
    refsPlugin,
    variablesPlugin,
    liquidPlugin,
    formatsPlugin,
    expressionsPlugin,
    configFilesPlugin,
    confdPlugin,
    compilerPlugin,
    recipesPlugin,
    recipeAnswersPlugin,
    skillsPlugin,
    memoriesPlugin,
    buildPlugin,
    harnessesPlugin,
    authoringPlugin,
    initPlugin,
    updatePlugin,
    cliPlugin,
    inspectPlugin,
    mcpPlugin,
    npmPlugin,
    pnpmPlugin,
    yarnPlugin,
    githubPlugin,
    gitlabPlugin,
    localPlugin,
    claudeCodePlugin,
    envPluginsPlugin,
];
