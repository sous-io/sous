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
# variables:
#   - name: apiBaseUrl
#     type: url
#     prompt: Which API base URL should this project use?
#     description: >-
#       Shown alongside the question and by 'sous vars'.
#     default: https://api.example.com
#     required: true
#
#   - name: serviceToken
#     type: string
#     # Name an environment variable explicitly to reuse a value the environment
#     # already carries. When omitted, 'sous repo release' derives one.
#     env: SERVICE_TOKEN
#     prompt: What is the service token for this project?
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

Raise a recipe's version in its \`${RECIPE_MANIFEST_BASENAME}.yaml\` (by hand, or
with \`sous repo release --bump patch\`), run \`sous repo release\` to regenerate
\`${INDEX_FILENAME}\`, and commit both. Merging to \`main\` then runs
\`sous repo release --tag --push\`, which cuts and pushes a git tag for each
version that does not have one. Tags are shaped \`namespace/recipe@version\`, and
a version is published when its tag exists.

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
#   index and the git tags agree with the versions in the recipe manifests. It
#   only reads; it never writes, commits or tags. That makes it the right thing
#   to run on a pull request.
#
#   'sous repo release --tag --push' does the same validation, then creates a
#   git tag (shaped 'namespace/recipe@version') for every recipe version that
#   does not have one yet, and pushes those tags. It refuses while anything is
#   uncommitted or the committed index is out of date, so a merge that skipped
#   the check above stops here rather than publishing something inconsistent.
#   Sous never commits for you; once the tags exist it rewrites the index to
#   record them, and the step after it commits that file.

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
      # Needed to push the regenerated index and the new tags.
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
      - name: Tag every new version and push the tags
        run: npx --yes @sous-io/sous repo release --tag --push
      - name: Commit the index, when tagging changed it
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          if git diff --quiet -- sous.index.json; then
            echo "The index already recorded every published version."
          else
            git add sous.index.json
            git commit -m "Record the newly tagged recipe versions in the index"
            git push
          fi
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
