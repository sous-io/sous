# @sous-io/plugin-authoring

Releasing, submitting and contributing to recipe repositories, and scaffolding one.

- **Specified in:** S6, "Authoring: plugin-authoring".
- **Capabilities (S7):** C46.
- **Depends on:** `plugin-recipes`, `plugin-formats`, `plugin-refs`, `plugin-variables`, `plugin-git`.
- **Contract:** `src/types.ts` declares every service, intent, event, entity kind and config key this
  plugin owns. Other plugins import it type-only: `import type {} from "@sous-io/plugin-authoring/types";`.

## Layout

- `src/index.ts`: the plugin; registers `repo.release`, `repo.submit`, `repo.contribute` and `repo.init`,
  each loading its handler only when it runs.
- `src/release/`: validate, plan, bump, settle, build the index, tag, push; `--check` and `--ci`.
- `src/submit/`: the checkout to propose from, the changelog, and the proposal sequencer.
- `src/contribute/`: start (`repo.link`) and finish (`repo.submit`, `repo.unlink`) a contribution.
- `src/scaffold/`: `repo init`; the CI workflow comes from the `repository-host` entity's `scaffoldFiles`.
- `src/shared/`: reading a repository, git through `git.runner`, refs through plugin-refs.
- `test/support/`: stand-ins for the plugins this one depends on, and real git repositories.

Events: `authoring.released` after a release that published something, `authoring.submitted` after a
proposal was opened or updated.
