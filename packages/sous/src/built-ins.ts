import { definePlugin, type PluginDefinition } from "@sous-io/sous-plugin-api";
import { cliPlugin } from "@sous-io/sous-plugin-cli";
import { hostPlugin } from "@sous-io/sous-plugin-host";
import { gitPlugin } from "@sous-io/sous-plugin-git";
import { refsPlugin } from "@sous-io/sous-plugin-refs";
import { variablesPlugin } from "@sous-io/sous-plugin-variables";
import { liquidPlugin } from "@sous-io/sous-plugin-liquid";
import { formatsPlugin } from "@sous-io/sous-plugin-formats";
import { expressionsPlugin } from "@sous-io/sous-plugin-expressions";
import { configFilesPlugin } from "@sous-io/sous-plugin-config-files";
import { confdPlugin } from "@sous-io/sous-plugin-confd";
import { compilerPlugin } from "@sous-io/sous-plugin-compiler";
import { recipesPlugin } from "@sous-io/sous-plugin-recipes";
import { recipeAnswersPlugin } from "@sous-io/sous-plugin-recipe-answers";
import { skillsPlugin } from "@sous-io/sous-plugin-skills";
import { memoriesPlugin } from "@sous-io/sous-plugin-memories";
import { handlersPlugin } from "@sous-io/sous-plugin-handlers";
import { buildPlugin } from "@sous-io/sous-plugin-build";
import { harnessesPlugin } from "@sous-io/sous-plugin-harnesses";
import { authoringPlugin } from "@sous-io/sous-plugin-authoring";
import { initPlugin } from "@sous-io/sous-plugin-init";
import { updatePlugin } from "@sous-io/sous-plugin-update";
import { doctorPlugin } from "@sous-io/sous-plugin-doctor";
import { migrationsPlugin } from "@sous-io/sous-plugin-migrations";
import { inspectPlugin } from "@sous-io/sous-plugin-inspect";
import { mcpPlugin } from "@sous-io/sous-plugin-mcp";
import { npmPlugin } from "@sous-io/sous-plugin-npm";
import { pnpmPlugin } from "@sous-io/sous-plugin-pnpm";
import { yarnPlugin } from "@sous-io/sous-plugin-yarn";
import { githubPlugin } from "@sous-io/sous-plugin-github";
import { gitlabPlugin } from "@sous-io/sous-plugin-gitlab";
import { localPlugin } from "@sous-io/sous-plugin-local";
import { claudeCodePlugin } from "@sous-io/sous-plugin-claude-code";
import { codexPlugin } from "@sous-io/sous-plugin-codex";
import { editorPlugin } from "@sous-io/sous-plugin-editor";
import packageJson from "../package.json" with { type: "json" };

/**
 * Loads the plugins named in `SOUS_PLUGINS` (separated by commas), for one run, by adding them to
 * `plugins.load`. A stopgap until `sous-plugin-config-files` owns the `SOUS_*` variables; a project's
 * files can list plugins the same way.
 */
export const envPluginsPlugin: PluginDefinition = definePlugin({
    name: "@sous-io/sous",
    version: packageJson.version,
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
 * The built-in plugins, loaded first and in this order unless the config disables them. Each comes after every plugin it depends on.
 */
export const BUILT_IN_PLUGINS: readonly PluginDefinition[] = [
    hostPlugin,
    doctorPlugin,
    migrationsPlugin,
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
    handlersPlugin,
    editorPlugin,
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
    codexPlugin,
    envPluginsPlugin,
];
