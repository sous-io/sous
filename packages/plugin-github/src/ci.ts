/**
 * The GitHub Actions workflow a new recipe repository on GitHub gets (`repo.init`): validate every
 * pull request, publish on merge.
 */

import type { ScaffoldFile, ScaffoldOptions } from "@sous-io/plugin-recipes/types";

/** Where the workflow is written. */
export const GITHUB_WORKFLOW_PATH = ".github/workflows/sous-release.yml";

/** The files a GitHub scaffold adds: the release workflow. */
export function githubWorkflowFiles(_options: ScaffoldOptions): ScaffoldFile[] {
    return [{ path: GITHUB_WORKFLOW_PATH, content: buildReleaseWorkflow() }];
}

/** The release workflow: validate every pull request, publish on merge. */
export function buildReleaseWorkflow(): string {
    return `# Release automation for this sous recipe repository.
#
# Two jobs, both running the sous CLI straight from npm so nothing needs to be
# installed into this repository:
#
#   'sous repo release --check' validates every manifest, confirms each recipe
#   folder matches what the repo manifest lists, and reports how merging would
#   rewrite the committed index, which the release after a merge regenerates.
#   It only reads; it never writes, commits or tags. That makes it the right
#   thing to run on a pull request.
#
#   'sous repo release --ci --push --yes' does the same validation and then
#   publishes. '--ci' raises no versions, accepts the plan it prints, and asks
#   no questions: the version bump belongs in the change being merged, so a
#   recipe that changed without one fails here rather than being given a version
#   nobody reviewed. It cuts an annotated tag for every version that does not
#   have one yet, dependency-first, and '--push' pushes the commit and those
#   tags. '--ci' implies '--yes'; passing it as well keeps this workflow working
#   with a sous old enough that it did not.

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
        run: npx --yes @sous-io/sous repo release --ci --push --yes
`;
}
