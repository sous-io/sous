/**
 * plugin-authoring: releasing, submitting and contributing to recipe repositories, and scaffolding
 * one. The contract other plugins code against is `./types.ts`.
 *
 * Each handler is loaded only when its intent runs, so `--help` never imports release code.
 * Everything a host does differently (proposals, the CI workflow) comes from its `repository-host`
 * entity; nothing host-specific lives here.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import { contributeInput, initInput, releaseInput, submitInput } from "./schemas.js";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-authoring";

/** The yes flag every intent shares: `-y`, also spelled `--force` (today's CLI). */
const yesFlag = { yes: { short: "y", aliases: ["force"] } };

/** The plugin. */
export const authoringPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "Releasing, submitting and contributing to recipe repositories, and scaffolding one.",
    dependsOn: {
        "@sous-io/plugin-recipes": "^0.2.34",
        "@sous-io/plugin-formats": "^0.2.34",
        "@sous-io/plugin-refs": "^0.2.34",
        "@sous-io/plugin-variables": "^0.2.34",
        "@sous-io/plugin-git": "^0.2.34",
    },

    register(sous) {
        sous.intents.add({
            intent: "repo.release",
            summary: "Publish new versions of this repository's recipes: bump, regenerate the index, commit and tag",
            description:
                "Runs inside a recipe repository. Validates it, raises the version of every changed recipe, regenerates " +
                "sous.index.json, commits the manifests and the index, and tags each version. --check only reads (for a " +
                "pull request); --ci runs the way a merge does.",
            input: releaseInput,
            cli: {
                aliases: [["repos", "release"]],
                flags: { ...yesFlag, directory: { hidden: true } },
                examples: [
                    "sous repo release",
                    "sous repo release --dry-run",
                    "sous repo release --namespace workflow --bump minor",
                    "sous repo release --recipe workflow/task-files --yes --push",
                    "sous repo release --check",
                    "sous repo release --ci --push",
                ],
            },
            agent: {
                usage: "Call this inside a recipe repository to publish its changed recipes. Use check: true to validate without writing.",
                whenNotToUse: "Not for a sous project; it releases the recipe repository it runs in.",
            },
            load: async () => (await import("./release/release.js")).handleRelease,
        });

        sous.intents.add({
            intent: "repo.submit",
            summary: "Propose a recipe repository's changes to its maintainers, and follow the proposal through",
            description:
                "Validates the checkout, then pushes its branch and opens or updates a proposal through the repository " +
                "host. Needs the host's command line tool (gh, glab) signed in.",
            input: submitInput,
            cli: {
                aliases: [["repos", "submit"]],
                positional: ["repo"],
                flags: { ...yesFlag, directory: { hidden: true } },
                examples: [
                    'sous repo submit --title "Add a linting recipe" --body "Adds lint rules."',
                    "sous repo submit sous-recipes",
                    "sous repo submit --status",
                    'sous repo submit --commit --yes --title "Fix a typo" --body "Fixes it."',
                    "sous repo submit --dry-run",
                ],
            },
            agent: {
                usage: "Call this to propose committed changes in a recipe repository checkout. A new proposal needs title and body.",
            },
            load: async () => (await import("./submit/submit.js")).handleSubmit,
        });

        sous.intents.add({
            intent: "repo.contribute",
            summary: "Start a contribution to a recipe repository on a fresh branch, or finish one with --finish",
            description:
                "Starting links the repository on a new branch (repo link --latest). Finishing submits what no proposal " +
                "carries yet (repo submit), then unlinks and updates the pins (repo unlink --update).",
            input: contributeInput,
            changesConfig: true,
            // It links and unlinks in a project, so it needs one.
            requiresProject: true,
            cli: {
                aliases: [
                    ["repos", "contribute"],
                    ["repo", "contrib"],
                    ["repos", "contrib"],
                ],
                positional: ["ref"],
                flags: yesFlag,
                examples: [
                    "sous repo contribute sous-recipes",
                    "sous repo contribute workflow/task-files",
                    "sous repo contribute sous-recipes --create-branch fix-a-typo",
                    'sous repo contribute sous-recipes --finish --title "Fix a typo" --body "Fixes it."',
                    "sous repo contribute sous-recipes --finish --no-submit --remove",
                    "sous repo contribute sous-recipes --finish --dry-run",
                ],
            },
            agent: {
                usage: "Call this to start editing a recipe repository from a project, and again with finish: true to propose and unlink.",
            },
            load: async () => (await import("./contribute/contribute.js")).handleContribute,
        });

        sous.intents.add({
            intent: "repo.init",
            summary: "Create a new sous recipe repository in a directory",
            input: initInput,
            cli: {
                aliases: [["repos", "init"]],
                positional: ["directory"],
                examples: [
                    "sous repo init",
                    "sous repo init ./my-recipes",
                    "sous repo init ./my-recipes --name team-recipes --namespace workflow",
                    "sous repo init ./my-recipes --host github",
                    "sous repo init ./my-recipes --dry-run",
                ],
            },
            agent: { usage: "Call this to scaffold a new recipe repository." },
            load: async () => (await import("./scaffold/scaffold.js")).handleInit,
        });
    },
});

export default authoringPlugin;

export type * from "./types.js";
