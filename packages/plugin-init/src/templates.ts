/**
 * The files `sous init` writes, as plain string builders.
 *
 * These are deliberately not templates run through a template engine. A scaffolded project is read
 * by a person before it is read by a machine, and the comments are what make the first config
 * legible; a rendering step would only stand between the author of the scaffold and the person who
 * has to live with the result.
 *
 * Every builder returns a complete file, ending in a newline. The config does not set `projectRoot`:
 * sous sets it (and `sousDir`) itself, and a config that sets one is an error.
 */

/** The `.sous/` directory's name. */
export const SOUS_DIR_NAME = ".sous";

/** The drop-in directory inside `.sous/`. */
export const CONFD_DIR_NAME = "conf.d";

/** The committed answers file inside `.sous/`. */
export const ENV_DEFAULTS_NAME = ".env";

/** The gitignored answers file inside `.sous/`. */
export const ENV_LOCAL_NAME = ".env.local";

/** The file name `sous init` writes the primary config under. */
export const CONFIG_FILE_NAME = "sous.config.js";

/**
 * The path, relative to `.sous/`, of the source the scaffolded config compiles into both instruction
 * files. It lives under `memories/`, the directory for what a build composes into an agent's
 * always-loaded instruction file, so the source and its compiled outputs are never mistaken for
 * one another.
 */
export const STARTER_PROMPT_RELATIVE_PATH = "memories/instructions.tpl.md";

/** The files the starter source is compiled into, at the project root. */
export const STARTER_OUTPUT_NAMES = ["CLAUDE.md", "AGENTS.md"] as const;

/** The starter memory, relative to `.sous/`, written when there was nothing to import. */
export const STARTER_MEMORY_RELATIVE_PATH = "memories/project/overview.tpl.md";

/** The starter memory for a sous recipe repository, relative to `.sous/`. */
export const REPO_STARTER_MEMORY_RELATIVE_PATH = "memories/project/sous-repo.tpl.md";

/** The project-root `.gitignore` lines for the files a build writes there. */
export const ROOT_IGNORE_LINES: readonly string[] = ["/CLAUDE.md", "/AGENTS.md", "/.claude/skills/"];

/** What every builder needs to know about the project being scaffolded. */
export interface ScaffoldContext {
    /** The project's display name, written into the config's `name`. */
    name: string;
    /** The version of sous doing the scaffolding, named in the generated files. */
    sousVersion: string;
}

/** The comment above the primary config. */
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

/** Where the project's own skills live, relative to the project root: the `skillsRoot` answer. */
export const PROJECT_SKILLS_ROOT = `${SOUS_DIR_NAME}/skills`;

/** The project-skills target. Until the project has a skill, its folder is missing and it compiles nothing. */
function projectSkillsTarget(): string {
    return `
      // The project's own skills: every folder in \`${PROJECT_SKILLS_ROOT}/\` (where the
      // create-skill skill writes them), compiled into \`.claude/skills/\` beside the skills the
      // subscribed recipes publish. A project skill with the same name as a recipe skill wins.
      {
        entryGlob: "\${sousDir}/skills/**/*",
        globBase: "\${sousDir}/skills",
        outputs: [{ destinationDir: "\${projectRoot}/.claude/skills" }],
      },`;
}

/** The primary config as a JavaScript module. */
export function buildConfigJs(context: ScaffoldContext): string {
    const intro = configIntro(context).map((line) => (line === "" ? "//" : `// ${line}`));
    const outputs = STARTER_OUTPUT_NAMES.map((name) => `{ destinationFile: "\${projectRoot}/${name}" }`).join(",\n          ");

    return `${intro.join("\n")}

export const config = {
  // Shown in command output. Any string.
  name: ${JSON.stringify(context.name)},

  // What to compile. Each target reads one source and writes it somewhere. \${sousDir} and
  // \${projectRoot} are set by sous, so nothing here depends on where the project is checked out.
  // A line holding only \`@path/to/file.md\` in a source pulls that file in, and a \`.tpl.\` in a
  // file name turns Liquid templating on for it.
  //
  // Everything this config writes is build output, gitignored by \`sous init\`: edit the sources
  // under \`${SOUS_DIR_NAME}/\`, never the compiled copies, and run \`sous build\` after cloning.
  compilation: {
    targets: [
      // The agent instructions: \`${SOUS_DIR_NAME}/${STARTER_PROMPT_RELATIVE_PATH}\` compiled into
      // both files agents read at the project root.
      {
        entryPoint: "\${sousDir}/${STARTER_PROMPT_RELATIVE_PATH}",
        outputs: [
          ${outputs},
        ],
      },${projectSkillsTarget()}
    ],
  },

  // Every project subscribes to the \`core\` namespace on its own. The skills the recipes it
  // subscribes to publish reach your agent's directories through the targets that plugins add;
  // \`sous recipe list\` shows what is available, and \`sous subscription add\` subscribes.
};
`;
}

/**
 * The source both instruction files are compiled from. It holds no instructions itself: it pulls
 * in this project's memories (every markdown file in a folder beside it), then the subscribed
 * recipes' memories. The folders beside it are never empty, because `sous init` writes either the
 * imported instructions or a starter memory there, and an include that matches nothing stops a
 * build.
 */
export function buildStarterPrompt(): string {
    const outputs = STARTER_OUTPUT_NAMES.map((name) => `\`${name}\``).join(" and ");

    return `{% comment %}
This file is compiled by sous into ${outputs} at the project root. Never edit
the compiled copies: edit the memories this file includes, then run \`sous build\`.

This project's own memories are the markdown files in the folders beside this file, such as
\`imported/\` (what \`sous init\` imported) and \`conventions/\`. Add a file to one of them, or a
new folder, and the next build includes it. Keep at least one file there: an include that
matches nothing stops the build.
{% endcomment -%}
@*/**/*.md

{% comment %}This line pulls in the memories of every recipe this project subscribes to.{% endcomment %}
@#memories/**/*.md
`;
}

/** The comment at the top of a starter memory. */
function starterMemoryNote(context: ScaffoldContext, kind: string): string {
    return `{% comment %}
Written by \`sous init\` (sous ${context.sousVersion}) for ${kind}. Every markdown file in the
folders beside \`${SOUS_DIR_NAME}/${STARTER_PROMPT_RELATIVE_PATH}\` is compiled into \`CLAUDE.md\` and
\`AGENTS.md\`; edit this one, or add more beside it.
{% endcomment -%}`;
}

/** The starter memory for a project that had no instructions to import. */
export function buildStarterMemory(context: ScaffoldContext): string {
    return `${starterMemoryNote(context, "a project with no instructions to import")}
# ${context.name}

This project uses sous to build its agent instructions and skills. \`CLAUDE.md\`, \`AGENTS.md\` and
\`.claude/skills/\` are build output: edit their sources under \`${SOUS_DIR_NAME}/\` and run
\`sous build\`, never the compiled copies. The \`about-sous\` skill says where each managed file
comes from.

- Describe the project here: what it is, how it is built, and how it is tested.
`;
}

/** The starter memory for a sous recipe repository that had no instructions to import. */
export function buildRepoStarterMemory(context: ScaffoldContext): string {
    return `${starterMemoryNote(context, "a sous recipe repository with no instructions to import")}
# ${context.name}

## This Is a Sous Repo

This is a sous recipe repository: it publishes recipes, versioned bundles of agent skills,
memories and partials that sous installs into the projects that subscribe to them. It is also a
sous project, so \`CLAUDE.md\`, \`AGENTS.md\` and \`.claude/skills/\` are build output: edit their
sources under \`${SOUS_DIR_NAME}/\` and run \`sous build\`, never the compiled copies.

How a recipe repository works is part of sous itself, and the core skills are the source of truth
for it. The agent MUST load these before changing anything here:

- \`about-sous-repos\`: the repository as a whole; the repo manifest, namespaces, the index,
  release tags, what happens to a pull request and a merge, and proposing a change.
- \`about-sous-recipes\`: one recipe; its manifest, how its version is raised, its variables, its
  contents, its dependencies and its partials.
- \`about-agent-skills\`: how a skill is written.
- \`about-liquid-templates\`: the template syntax in \`.tpl.\` files.

\`sous-io/sous-recipes\`, the official recipe repository, is the model every recipe repository
follows; its files show a complete repository in use: https://github.com/sous-io/sous-recipes
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

# Where this project's own skills are kept: the create-skill skill writes new ones
# there, and the config compiles them into .claude/skills/.
SKILLS_ROOT=${PROJECT_SKILLS_ROOT}
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
