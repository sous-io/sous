/**
 * The files `sous init` writes, as plain string builders.
 *
 * These are deliberately not templates run through a template engine. A scaffolded project is read
 * by a person before it is read by a machine, and the comments are what make the first config
 * legible; a rendering step would only stand between the author of the scaffold and the person who
 * has to live with the result.
 *
 * Every builder returns a complete file, ending in a newline. Neither config sets `projectRoot`:
 * sous sets it (and `sousDir`) itself, and a config that sets one is an error (S6).
 */

import type { InitConfigFormat } from "./types.js";

/** The `.sous/` directory's name. */
export const SOUS_DIR_NAME = ".sous";

/** The drop-in directory inside `.sous/`. */
export const CONFD_DIR_NAME = "conf.d";

/** The committed answers file inside `.sous/`. */
export const ENV_DEFAULTS_NAME = ".env";

/** The gitignored answers file inside `.sous/`. */
export const ENV_LOCAL_NAME = ".env.local";

/** The config formats `sous init` can write. The first one is the default. */
export const INIT_CONFIG_FORMATS = ["js", "json"] as const satisfies readonly InitConfigFormat[];

/** The file name each format is written under. */
export const CONFIG_FILE_NAMES: Readonly<Record<InitConfigFormat, string>> = {
    json: "sous.config.jsonc",
    js: "sous.config.js",
};

/**
 * The path, relative to `.sous/`, of the starter prompt the scaffolded config compiles. It lives
 * under `memories/`, the directory for what a build composes into an agent's always-loaded
 * instruction file, so the source and its compiled output are never mistaken for one another.
 */
export const STARTER_PROMPT_RELATIVE_PATH = "memories/AGENTS.tpl.md";

/** The name of the file the starter prompt is compiled into, at the project root. */
export const STARTER_OUTPUT_NAME = "AGENTS.md";

/** What every builder needs to know about the project being scaffolded. */
export interface ScaffoldContext {
    /** The project's display name, written into the config's `name`. */
    name: string;
    /** The version of sous doing the scaffolding, named in the generated files. */
    sousVersion: string;
}

/**
 * Where the JSON Schema for a config of this sous version is published. An editor resolving
 * `$schema` wants a URL, and the tagged copy on GitHub matches this version for as long as the tag
 * exists.
 */
export function configSchemaUrl(sousVersion: string): string {
    return `https://raw.githubusercontent.com/sous-io/sous/v${sousVersion}/sous.config.schema.json`;
}

/** The comment above the primary config, shared by both formats. */
function configIntro(context: ScaffoldContext): string[] {
    return [
        `The primary sous config for ${context.name}.`,
        "",
        `sous finds this file by walking up from the directory it was run in until it meets a`,
        `\`${SOUS_DIR_NAME}/\` directory holding a config. Everything a build needs starts here. Drop-in`,
        `layers under \`${SOUS_DIR_NAME}/${CONFD_DIR_NAME}/\` merge over it, and the layers sous writes for itself go`,
        `into that directory, never into this file. Written by \`sous init\` (sous ${context.sousVersion});`,
        `it is yours now.`,
    ];
}

/**
 * The primary config as JSON with comments, bound to the shipped schema through `$schema` so an
 * editor can validate and complete it.
 */
export function buildConfigJsonc(context: ScaffoldContext): string {
    const intro = configIntro(context).map((line) => (line === "" ? "//" : `// ${line}`));

    return `${intro.join("\n")}
{
    "$schema": ${JSON.stringify(configSchemaUrl(context.sousVersion))},

    // Shown in command output. Any string.
    "name": ${JSON.stringify(context.name)},

    // What to compile. Each target reads one source and writes it somewhere. The starter target
    // renders \`${SOUS_DIR_NAME}/${STARTER_PROMPT_RELATIVE_PATH}\` to the project root. \${sousDir} and \${projectRoot} are
    // set by sous, so nothing here depends on where the project is checked out. A line holding
    // only \`@path/to/file.md\` in a source pulls that file in, and a \`.tpl.\` in a file name turns
    // Liquid templating on for it. Compiled files are build output: ignore them or commit them,
    // as your team prefers.
    "compilation": {
        "targets": [
            {
                "entryPoint": "\${sousDir}/${STARTER_PROMPT_RELATIVE_PATH}",
                "outputs": [{ "destinationFile": "\${projectRoot}/${STARTER_OUTPUT_NAME}" }]
            }
        ]
    }

    // Every project subscribes to the \`core\` namespace on its own. The skills and memories the
    // recipes it subscribes to publish reach your agent's directories through the targets that
    // plugins add; \`sous recipe list\` shows what is available. The starter prompt pulls the
    // memories in with one include line.
}
`;
}

/** The primary config as a JavaScript module, commented the same way. */
export function buildConfigJs(context: ScaffoldContext): string {
    const intro = configIntro(context).map((line) => (line === "" ? "//" : `// ${line}`));

    return `${intro.join("\n")}

export const config = {
  // Shown in command output. Any string.
  name: ${JSON.stringify(context.name)},

  // What to compile. Each target reads one source and writes it somewhere. The starter target
  // renders \`${SOUS_DIR_NAME}/${STARTER_PROMPT_RELATIVE_PATH}\` to the project root. \${sousDir} and \${projectRoot} are
  // set by sous, so nothing here depends on where the project is checked out. A line holding
  // only \`@path/to/file.md\` in a source pulls that file in, and a \`.tpl.\` in a file name turns
  // Liquid templating on for it. Compiled files are build output: ignore them or commit them,
  // as your team prefers.
  compilation: {
    targets: [
      {
        entryPoint: "\${sousDir}/${STARTER_PROMPT_RELATIVE_PATH}",
        outputs: [{ destinationFile: "\${projectRoot}/${STARTER_OUTPUT_NAME}" }],
      },
    ],
  },

  // Every project subscribes to the \`core\` namespace on its own. The skills and memories the
  // recipes it subscribes to publish reach your agent's directories through the targets that
  // plugins add; \`sous recipe list\` shows what is available. The starter prompt pulls the
  // memories in with one include line.
};
`;
}

/** The primary config in a format. */
export function buildConfig(format: InitConfigFormat, context: ScaffoldContext): string {
    return format === "json" ? buildConfigJsonc(context) : buildConfigJs(context);
}

/**
 * The starter prompt the config compiles: a short, real instruction file, so the first build
 * produces something worth reading rather than a placeholder.
 */
export function buildStarterPrompt(context: ScaffoldContext): string {
    return `# ${context.name}

This file is compiled by sous into \`${STARTER_OUTPUT_NAME}\` at the project root. Edit this
source, run \`sous build\`, and the compiled copy follows; never edit the compiled copy.

## Working in this project

- Describe the project here: what it is, how it is built, and how it is tested.
- Split long sections into their own files under \`${SOUS_DIR_NAME}/memories/\` and pull
  each one in with a line holding only \`@sections/name.md\`.
- The skills your agent reads are written by sous from the recipes this project subscribes to.
  \`sous recipe list\` shows what is available.

{% comment %}This line pulls in the memories of every recipe this project subscribes to.{% endcomment %}
@#memories/**/*.md
`;
}

/** The committed answers file: the layer for what the whole team shares. */
export function buildEnvDefaults(context: ScaffoldContext): string {
    return `# ${SOUS_DIR_NAME}/${ENV_DEFAULTS_NAME}
#
# Answers to recipe variables that the whole team shares. Commit this file.
#
# A recipe this project subscribes to may ask questions (a board name, a
# ticket prefix, where task files go), and the answers live here as
# \`KEY=VALUE\` lines. \`sous vars ask\` writes them one question at a time, and
# \`sous vars list\` shows every variable in play with where its answer came from.
#
# Never put a secret, a login or a machine-specific path here. Those belong in
# \`${SOUS_DIR_NAME}/${ENV_LOCAL_NAME}\`, which is gitignored and overrides this file
# key for key. Precedence, highest first: your shell, then \`${ENV_LOCAL_NAME}\`,
# then this file.
#
# Written by \`sous init\` (sous ${context.sousVersion}).
`;
}

/** The example for the gitignored answers file, explaining what belongs in the local layer. */
export function buildEnvLocalExample(context: ScaffoldContext): string {
    return `# ${SOUS_DIR_NAME}/${ENV_LOCAL_NAME}.example
#
# Copy this file to \`${SOUS_DIR_NAME}/${ENV_LOCAL_NAME}\` and fill in your own values:
#
#     cp ${SOUS_DIR_NAME}/${ENV_LOCAL_NAME}.example ${SOUS_DIR_NAME}/${ENV_LOCAL_NAME}
#
# ...or let sous write it for you, one question at a time:
#
#     sous vars ask
#
# \`${SOUS_DIR_NAME}/${ENV_LOCAL_NAME}\` is gitignored. It is the layer for anything that
# differs between people or machines, or must not be committed: your own login
# and name, absolute paths outside the repository, API tokens.
#
# The COMMITTED layer is \`${SOUS_DIR_NAME}/${ENV_DEFAULTS_NAME}\`. Same syntax, but it holds
# the answers the whole team shares. Never put a secret there.
#
# How both files are loaded:
#   - \`KEY=VALUE\` per line. \`#\` starts a comment. \`export KEY=VALUE\` also works.
#   - Loaded into the environment before the config resolves any variables.
#   - Precedence, highest first: your shell, then \`${ENV_LOCAL_NAME}\`, then \`${ENV_DEFAULTS_NAME}\`.
#     So \`FOO=bar sous build\` overrides \`FOO\` from either file for that one run,
#     and a key in \`${ENV_LOCAL_NAME}\` overrides the same key in \`${ENV_DEFAULTS_NAME}\`.
#   - A recipe's variable answers reach its templates on their own. \`sous vars
#     list\` shows each one, with the environment variable that supplied it.
#   - The config's own \`_env\` block still works for anything a recipe does not
#     ask about: \`_env: { myPath: "MY_PATH" }\` makes \`\${myPath}\` available
#     throughout the config from \`MY_PATH\` in either file.
#
# NOT here: the config-location variables \`SOUS_CONFIG\`, \`SOUS_DIR\` and
# \`SOUS_CONFD\`. Those decide where sous looks for \`${SOUS_DIR_NAME}/\`, so they are
# read from the real shell environment only; this file is not found until
# discovery has already run.
#
# Written by \`sous init\` (sous ${context.sousVersion}). Add a line per answer below,
# with a comment saying what it is for.
`;
}
