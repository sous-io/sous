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

/**
 * The file name `sous init` writes the primary config under: a data file, so sous can edit it
 * (`sous config set`, migrations), with comments, which JSONC allows and the editor keeps. A
 * project may still write a `sous.config.js` by hand.
 */
export const CONFIG_FILE_NAME = "sous.config.jsonc";

/**
 * The source of the memories file, relative to `.sous/`. The plugin for each coding tool compiles
 * it into the file that tool reads in every session. `sous init` writes it with the two default
 * lines, so a project sees how to change what is included and in what order.
 */
export const MEMORIES_SOURCE_RELATIVE_PATH = "MEMORIES.tpl.md";

/** The two default lines of the memories source: the project's own memories, then the recipes'. */
export const MEMORIES_DEFAULT_LINES: readonly string[] = ["@memories/**/*.md", "@#memories/**/*.md"];

/**
 * The starter memory, relative to `.sous/`: the project's own text, with no include line, written
 * when there was nothing to import. In a recipe repository it says it is a Sous Repo.
 */
export const STARTER_MEMORY_RELATIVE_PATH = "memories/project.tpl.md";

/**
 * The project-root `.gitignore` lines for what a build writes outside `.sous/`. `sous init` writes
 * them once; no build keeps them current. The skills and agents folders are ignored whole, because
 * sous writes one entry per recipe item there and cannot list them by name at init time; a project
 * that commits its own skills or agents removes that line.
 */
export const ROOT_IGNORE_LINES: readonly string[] = ["/.claude/rules/SOUS-MEMORIES.md", "/.claude/skills/", "/.claude/agents/", "/AGENTS.override.md"];

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
        `it is yours now. It is JSON with comments, and \`sous config set\` keeps the comments.`,
    ];
}

/** Where the project's own skills live, relative to the project root: the `skillsRoot` answer. */
export const PROJECT_SKILLS_ROOT = `${SOUS_DIR_NAME}/skills`;

/**
 * Where the config's `$schema` points: the schema published on GitHub with the running version
 * of sous, so an editor can complete and check the file. Sous itself ignores the key.
 *
 * ```ts
 * configSchemaUrl("1.0.19"); // "https://raw.githubusercontent.com/sous-io/sous/v1.0.19/sous.config.schema.json"
 * ```
 */
export function configSchemaUrl(sousVersion: string): string {
    return `https://raw.githubusercontent.com/sous-io/sous/v${sousVersion}/sous.config.schema.json`;
}

/**
 * The primary config, as JSON with comments. Its one target compiles the project's own skills;
 * the memories need none, because the plugin for each coding tool compiles
 * `.sous/MEMORIES.tpl.md` on its own.
 */
export function buildConfigJsonc(context: ScaffoldContext): string {
    const intro = configIntro(context).map((line) => (line === "" ? "//" : `// ${line}`));

    return `${intro.join("\n")}
{
  // Lets an editor complete and check this file. Sous ignores it.
  "$schema": ${JSON.stringify(configSchemaUrl(context.sousVersion))},

  // Shown in command output. Any string.
  "name": ${JSON.stringify(context.name)},

  // What to compile, beside what plugins and recipes add. Each target reads one source and writes
  // it somewhere. \${sousDir} and \${projectRoot} are set by sous, so nothing here depends on where
  // the project is checked out. A line holding only \`@path/to/file.md\` in a source pulls that file
  // in, and a \`.tpl.\` in a file name turns Liquid templating on for it.
  //
  // The memories need no target here: the plugin for each coding tool compiles
  // \`${SOUS_DIR_NAME}/${MEMORIES_SOURCE_RELATIVE_PATH}\` into the file that tool reads in every session
  // (\`.claude/rules/SOUS-MEMORIES.md\` for Claude Code), and that file says what is included and in
  // what order. What a build writes is build output: edit the sources under \`${SOUS_DIR_NAME}/\`, never
  // the compiled copies, and run \`sous build\` after cloning.
  "compilation": {
    "targets": [
      // The project's own skills: every folder in \`${PROJECT_SKILLS_ROOT}/\` (where the
      // create-skill skill writes them), compiled into \`.claude/skills/\` beside the skills the
      // subscribed recipes publish. A project skill with the same name as a recipe skill wins.
      // Until the project has a skill, the folder is missing and this compiles nothing.
      {
        "entryGlob": "\${sousDir}/skills/**/*",
        "globBase": "\${sousDir}/skills",
        "outputs": [{ "destinationDir": "\${projectRoot}/.claude/skills" }]
      }
    ]
  }

  // Every project subscribes to the \`core\` namespace on its own. \`sous recipe list\` shows what
  // else is available, and \`sous subscription add\` subscribes.
}
`;
}

/**
 * The source of the memories file: the two default lines, each on its own line, under a comment
 * saying what each one includes. A project drops a part by removing its line.
 */
export function buildMemoriesSource(): string {
    const [project, recipes] = MEMORIES_DEFAULT_LINES;

    return `{% comment %}
Sous compiles this file into the memories file your coding tool reads in every session
(\`.claude/rules/SOUS-MEMORIES.md\` for Claude Code). Each line below includes one part:

  ${project}    this project's own memories: every markdown file under \`${SOUS_DIR_NAME}/memories/\`
  ${recipes}   the memories of every recipe this project subscribes to

Removing a line removes that part, and moving a line changes the order. Run \`sous build\` after
a change.
{% endcomment -%}
${project}
${recipes}
`;
}

/** The comment in a starter memory, stripped from the output because the file is a `.tpl.`. */
function starterMemoryNote(): string {
    return `{% comment %}
Sous compiles this file, and every other file under \`${SOUS_DIR_NAME}/memories/\`, into the
instructions your coding tool reads in every session. Edit it and run \`sous build\`.
{% endcomment -%}`;
}

/** The starter memory for a project that had no instructions to import. */
export function buildStarterMemory(context: ScaffoldContext): string {
    return `# ${context.name}

${starterMemoryNote()}

## Working in this project

- Describe the project here: what it is, how it is built, and how it is tested.
- Add more files under \`${SOUS_DIR_NAME}/memories/\` for longer topics. Each one is included
  automatically, in name order.
- The memories of the recipes this project subscribes to are added after these files.
  \`${SOUS_DIR_NAME}/${MEMORIES_SOURCE_RELATIVE_PATH}\` controls what is included and in what order.
`;
}

/** The starter memory for a sous recipe repository that had no instructions to import. */
export function buildRepoStarterMemory(context: ScaffoldContext): string {
    return `# ${context.name}

${starterMemoryNote()}

## This Is a Sous Repo

This is a sous recipe repository: it publishes recipes, versioned bundles of agent skills,
memories and partials that sous installs into the projects that subscribe to them. It is also a
sous project, so the memories file and \`.claude/skills/\` are build output: edit their sources
under \`${SOUS_DIR_NAME}/\` and run \`sous build\`, never the compiled copies.

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
