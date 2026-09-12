/**
 * The files `sous repo init` writes, as plain string builders.
 *
 * These are deliberately not templates run through a template engine. A
 * scaffolded repository is read by a person before it is read by a machine, so
 * every file here is written to be explained: the comments are the point, and a
 * rendering step would only stand between the author of the scaffold and the
 * author of the new repository.
 *
 * Every builder returns a complete file, ending in a newline.
 */

import {
  INDEX_FILENAME,
  RECIPE_MANIFEST_BASENAME,
  REPO_MANIFEST_BASENAME,
} from "../formats/common.js";
import { stringifyIndexFile, type IndexFile } from "../formats/index-file.js";

/** What every builder needs to know about the repository being scaffolded. */
export type ScaffoldContext = {
  /** The repository's short name, used as its suggested name and in the README. */
  name: string;
  /** The one namespace the scaffold declares. */
  namespace: string;
  /** The example recipe's name. */
  recipe: string;
  /** The version of sous doing the scaffolding, recorded in the index. */
  sousVersion: string;
  /** When the scaffold ran, recorded in the index. */
  generatedAt: string;
};

/** The path, relative to the repository root, of the example recipe's folder. */
export function exampleRecipePath(context: ScaffoldContext): string {
  return `recipes/${context.namespace}/${context.recipe}`;
}

/**
 * The repo manifest at the root: what the repository publishes, and where each
 * recipe folder lives.
 *
 * @param context - The repository being scaffolded.
 */
export function buildRepoManifest(context: ScaffoldContext): string {
  return `# The repo manifest: what this repository publishes.
#
# It is read before anything is downloaded, and it is never executable, so
# anyone deciding whether to trust this repository can read its whole surface
# without running any of its code.

formatVersion: 1

# A suggested short name. Each project chooses the name it actually uses when it
# runs 'sous repo add', so two repositories suggesting the same name never clash.
name: ${context.name}

description: >-
  One paragraph saying what this repository publishes and who it is for.

# Where to send a change. Shown to anyone whose provider cannot open a proposal
# for them, so a contributor is never left without a route.
# contribute: https://example.com/contributing

# Namespaces group recipes. They are not versioned, and a project may subscribe
# to a whole namespace, which means every recipe in it, including ones published
# later.
namespaces:
  ${context.namespace}:
    description: What the recipes in this namespace have in common.

# Every recipe folder in this repository, as a path relative to this file. Each
# folder holds one '${RECIPE_MANIFEST_BASENAME}.yaml'.
recipes:
  - ${exampleRecipePath(context)}
`;
}

/**
 * The example recipe manifest: one publishable unit, with the variables section
 * shown as commented-out example.
 *
 * @param context - The repository being scaffolded.
 */
export function buildRecipeManifest(context: ScaffoldContext): string {
  return `# A recipe manifest: one publishable unit, with its own version.
#
# Copy this folder to start a new recipe, then add its path to the 'recipes'
# list in the ${REPO_MANIFEST_BASENAME}.yaml at the root of this repository.

formatVersion: 1

namespace: ${context.namespace}
name: ${context.recipe}

# Recipe metadata is the source of truth for versions. 'sous repo release'
# bumps this field and keeps the matching git tag consistent with it.
version: 0.1.0

description: >-
  One paragraph saying what this recipe gives a project that subscribes to it.

# Build dependencies: fetched, pinned and addressable from this recipe's own
# files, but their files do NOT enter a subscriber's output.
# depends:
#   - core/shared-partials@^1.0.0

# Co-subscriptions: subscribing to this recipe subscribes the project to these
# as well, in full. Their questions run and their files DO enter the output.
# subscribes:
#   - workflow/task-files

# The files this recipe contributes, grouped by what they are. Paths are
# relative to this folder.
contents:
  - kind: skills
    include:
      - skills/**/*.md

# Variables this recipe needs answered. A definition is a specification, never a
# value: sous asks the question only when a subscribed recipe needs the variable
# and no valid answer is already in scope.
#
# Every definition must carry a 'description' and an 'example'. The description
# is the paragraph shown above the question and by 'sous vars show <name>'; it
# says, in full sentences, what the setting is for, what the default does, and
# what else is acceptable. The prompt is one plain question, nothing more. The
# example is a realistic sample answer, shown with the question so nobody has to
# guess what a good one looks like; it is documentation only and is never
# stored, so use 'default' for a value a project should actually start with.
#
# variables:
#   - name: apiBaseUrl
#     type: url
#     prompt: Which API should this project talk to?
#     description: >-
#       Every request this recipe generates is sent to one deployment of the API,
#       and this setting says which one. The default points at the public
#       production host, but any deployment you can reach works, including a
#       staging host or a service running on your own machine.
#     example: https://api.example.com
#     default: https://api.example.com
#     required: true
#
#   - name: serviceToken
#     type: string
#     # Name an environment variable explicitly to reuse a value the environment
#     # already carries. When omitted, 'sous repo release' derives one.
#     env: SERVICE_TOKEN
#     prompt: What is this project's service token?
#     description: >-
#       This recipe authenticates every call it makes with a service token, which
#       is issued per project and is not shared between them. Create one under
#       Settings, then Tokens, and give it read access to the project you are
#       configuring. There is no default; a token is always specific to you, and
#       it is stored in the gitignored env file so it never reaches git.
#     example: svc_0123456789abcdef0123
#     # A secret is always written to the gitignored '.sous/.env.local'.
#     secret: true
#     scope: local
#     validate:
#       minLength: 20
`;
}

/**
 * The placeholder skill the example recipe contributes.
 *
 * @param context - The repository being scaffolded.
 */
export function buildExampleSkill(context: ScaffoldContext): string {
  return `---
name: example-skill
description: >-
  Replace this with the sentence that tells an agent when to load the skill.
  Say what the skill covers and name the situations that should trigger it.
---

# Example skill

This file is a placeholder written by 'sous repo init'. Replace it with a real
skill, or delete it once the ${context.recipe} recipe has content of its own.

A skill is ordinary markdown. Everything under this recipe's 'contents' entry is
copied into a subscribing project's agent skill directory, so what you write
here is what an agent reads there.

## What to put here

Describe the concept the skill covers, then the rules an agent should follow
when it applies. Keep it short enough to be read in full, and point at reference
files for anything long.
`;
}

/**
 * The empty but valid index. `sous repo release` rewrites it; it exists from the
 * first commit so the repository is readable by sous before anything is
 * published.
 *
 * @param context - The repository being scaffolded.
 */
export function buildIndexFile(context: ScaffoldContext): string {
  const index: IndexFile = {
    formatVersion: 1,
    name: context.name,
    generatedAt: context.generatedAt,
    generator: context.sousVersion,
    namespaces: {
      [context.namespace]: {
        description: "What the recipes in this namespace have in common.",
      },
    },
    recipes: {},
  };
  return stringifyIndexFile(index);
}

/**
 * The README, explaining the layout in plain language to whoever opens the
 * repository next.
 *
 * @param context - The repository being scaffolded.
 */
export function buildReadme(context: ScaffoldContext): string {
  const recipeDir = exampleRecipePath(context);
  return `# ${context.name}

A sous recipe repository. It publishes **recipes**, grouped into
**namespaces**, that other projects subscribe to.

## Layout

\`\`\`
${REPO_MANIFEST_BASENAME}.yaml                 what this repository publishes
${INDEX_FILENAME}                 the published catalog, written by sous
${recipeDir}/
  ${RECIPE_MANIFEST_BASENAME}.yaml               one recipe: its version, contents and variables
  skills/                        the files that recipe contributes
\`\`\`

## The three files

**\`${REPO_MANIFEST_BASENAME}.yaml\`** declares the namespaces this repository
publishes and lists every recipe folder in it. It is hand-written, and it is the
first thing sous reads.

**\`${RECIPE_MANIFEST_BASENAME}.yaml\`** describes one recipe: which namespace it
belongs to, what version it is at, what it depends on, which of its files a
subscriber receives, and which variables it needs answered. It is hand-written
too, and its \`version\` field is the source of truth for versions.

**\`${INDEX_FILENAME}\`** is the catalog: every recipe, every published version,
and a content hash for each one. It is written by \`sous repo release\` and
committed. Do not edit it by hand.

## Adding a recipe

1. Copy \`${recipeDir}\` to a new folder under \`recipes/\`.
2. Edit its \`${RECIPE_MANIFEST_BASENAME}.yaml\`: set the namespace, the name, the
   version and the contents.
3. Add the new folder's path to the \`recipes\` list in
   \`${REPO_MANIFEST_BASENAME}.yaml\`.
4. Open a pull request. The workflow in \`.github/workflows/sous-release.yml\`
   checks that everything is consistent before it can be merged.

## Publishing

Commit your recipe changes, then run \`sous repo release\`. It shows you what it
would publish and asks once, then raises the version of every recipe whose files
changed since the tag that last published it, regenerates \`${INDEX_FILENAME}\`,
commits both, and cuts an annotated tag for each version. Add \`--push\` to push
the commit and the tags, or push them yourself.

Useful ways to narrow or steer it:

\`\`\`bash
sous repo release --dry-run                    # show the plan and stop
sous repo release --namespace ${context.namespace}            # only this namespace
sous repo release --recipe ${context.namespace}/${context.recipe}   # only this recipe
sous repo release --bump minor                 # a minor step instead of a patch
sous repo release --include-unchanged          # release everything in scope anyway
\`\`\`

On a branch other than \`main\`, a release bumps and commits but cuts no tags:
tags are cut on the default branch, by the workflow in
\`.github/workflows/sous-release.yml\` after the merge. Pass \`--tag\` to cut them
anyway. Tags are shaped \`namespace/recipe@version\`, and a version is published
when its tag exists.

To propose a change to a repository you do not maintain, commit it and run
\`sous repo submit\`, which validates everything first and then opens a pull
request through your provider's own command line tool.

## Using it

In any project that has a sous config:

\`\`\`bash
sous repo add <the URL of this repository>
sous subscribe ${context.namespace}/${context.recipe}
sous build
\`\`\`

Adding a repository is what trusts it, so read a repository before you add it.

## Working on it

\`sous repo link\` points a project at a working copy of this repository instead
of at a published version, so you can edit a recipe and rebuild without
releasing anything:

\`\`\`bash
sous repo link ${context.name} /path/to/this/checkout
\`\`\`

Builds say loudly when a repository is linked. Run \`sous repo unlink ${context.name}\`
to go back to published versions.
`;
}

/** The release workflow: validate every pull request, publish on merge. */
export function buildReleaseWorkflow(): string {
  return `# Release automation for this sous recipe repository.
#
# Two jobs, both running the sous CLI straight from npm so nothing needs to be
# installed into this repository:
#
#   'sous repo release --check' validates every manifest, confirms each recipe
#   folder matches what the repo manifest lists, and confirms the committed
#   index agrees with the versions and dependencies the recipe manifests
#   declare. It only reads; it never writes, commits or tags. That makes it the
#   right thing to run on a pull request.
#
#   'sous repo release --ci --push' does the same validation and then publishes.
#   '--ci' raises no versions and asks no questions: the version bump belongs in
#   the change being merged, so a recipe that changed without one fails here
#   rather than being given a version nobody reviewed. It cuts an annotated tag
#   for every version that does not have one yet, dependency-first, and '--push'
#   pushes the commit and those tags.

name: sous release

on:
  pull_request:
  push:
    branches:
      - main

jobs:
  check:
    name: Validate recipes
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          # The whole history, so the tags a version is checked against are
          # visible.
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Validate every manifest, the index and the tags
        run: npx --yes @sous-io/sous repo release --check

  release:
    name: Publish recipes
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    permissions:
      # Needed to push the release commit and the new tags.
      contents: write
    steps:
      - uses: actions/checkout@v4
        with:
          # The whole history, so existing tags are visible and versions that
          # were already published are not cut a second time.
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Identify the committer, in case the index has to be rewritten
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
      - name: Publish every new version
        run: npx --yes @sous-io/sous repo release --ci --push
`;
}

/**
 * The repository's `.gitignore`. A recipe repository holds text, so this stays
 * short: editor and operating system leftovers, and the machine-local files
 * sous writes when the repository is linked into a project.
 */
export function buildGitignore(): string {
  return `# Operating system and editor leftovers
.DS_Store
Thumbs.db
*.swp

# Dependencies, if a recipe ever needs any
node_modules/

# Machine-local sous files, written when this repository is used from a project
.sous/sous.state.json
.sous/sous.pid
.sous/sous.links.json
.sous/repos/
.sous/.env.local
`;
}
