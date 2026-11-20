/**
 * The CI pipeline a new recipe repository on GitLab gets (`repo.init`): validate every merge
 * request, publish on the default branch. The same two jobs as the GitHub Actions workflow.
 */

import type { ScaffoldFile, ScaffoldOptions } from "@sous-io/sous-plugin-recipes/types";

/** Where the pipeline is written. */
export const GITLAB_CI_PATH = ".gitlab-ci.yml";

/** The CI/CD variable the release job pushes with. */
export const RELEASE_TOKEN_VARIABLE = "SOUS_RELEASE_TOKEN";

/** What `repo init` warns about: the release job cannot push until the variable is set. */
export const RELEASE_TOKEN_WARNING =
    `The release job in ${GITLAB_CI_PATH} needs a masked CI/CD variable named ${RELEASE_TOKEN_VARIABLE}, holding a project access token ` +
    "with the write_repository scope and the Maintainer role. Until it is set, every release job fails before it commits or tags. " +
    "Set it in the GitLab project under Settings, CI/CD, Variables.";

/** The files a GitLab scaffold adds: `.gitlab-ci.yml`, with the warning about its token. */
export function gitlabCiFiles(_options: ScaffoldOptions): ScaffoldFile[] {
    return [{ path: GITLAB_CI_PATH, content: buildGitlabPipeline(), warning: RELEASE_TOKEN_WARNING }];
}

/** The pipeline's text. */
export function buildGitlabPipeline(): string {
    return `# Release automation for this sous recipe repository.
#
# Two jobs, both running the sous CLI straight from npm so nothing needs to be
# installed into this repository:
#
#   'sous repo release --check' validates every manifest, confirms each recipe
#   folder matches what the repo manifest lists, and reports how merging would
#   rewrite the committed index, which the release after a merge regenerates.
#   It only reads; it never writes, commits or tags. That makes it the right
#   thing to run on a merge request.
#
#   'sous repo release --ci --push --yes' does the same validation and then
#   publishes. '--ci' raises no versions, accepts the plan it prints, and asks
#   no questions: the version bump belongs in the change being merged. It cuts
#   an annotated tag for every version that does not have one yet,
#   dependency-first, and '--push' pushes the commit and those tags.
#
# Pushing needs a token: CI_JOB_TOKEN cannot push. Create a project access
# token with the 'write_repository' scope and the Maintainer role, and save it
# as a masked CI/CD variable named SOUS_RELEASE_TOKEN (Settings, CI/CD,
# Variables). The release job checks for it before it commits or tags.

stages:
  - check
  - release

default:
  image: node:22

variables:
  # The whole history, so the tags a version is checked against are visible.
  GIT_DEPTH: "0"

check:
  stage: check
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  script:
    - npx --yes @sous-io/sous repo release --check

release:
  stage: release
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE == "push"
  script:
    - |
      if [ -z "$SOUS_RELEASE_TOKEN" ]; then
        echo "Error: the CI/CD variable SOUS_RELEASE_TOKEN is not set, so this job cannot push a release." >&2
        echo "Create a project access token with the write_repository scope and the Maintainer role, and save it" >&2
        echo "as a masked CI/CD variable named SOUS_RELEASE_TOKEN in this project's Settings, CI/CD, Variables." >&2
        exit 1
      fi
    - git config user.name "sous release"
    - git config user.email "sous-release@noreply.$CI_SERVER_HOST"
    # GitLab checks out a detached commit; a release commit needs the branch.
    - git checkout -B "$CI_COMMIT_BRANCH"
    - git remote set-url origin "https://oauth2:$SOUS_RELEASE_TOKEN@$CI_SERVER_HOST/$CI_PROJECT_PATH.git"
    - npx --yes @sous-io/sous repo release --ci --push --yes
`;
}
