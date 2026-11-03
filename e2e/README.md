# sous end-to-end suite

Runs the published `@sous-io/sous` package in clean Docker containers and checks what a user sees:
exit codes, standard output against standard error, the files written, and the `--json` shapes.
It is run by hand and is **not part of CI** (nothing under `.github/` calls it).

## Run it

```bash
pnpm e2e                                  # newest published version, Node 22 and Node 24
pnpm e2e --version 1.0.2                  # an exact version, a dist-tag or a range
pnpm e2e --node 24                        # one Node version
pnpm e2e --only basics,config             # some scenarios, by name or file prefix (01, 02, ...)
pnpm e2e --verbose                        # also print the container's own output
```

Needs Docker (the images are `node:22` and `node:24`, Debian based, so git, bash and Corepack for
pnpm and Yarn exist). The runner builds `e2e/Dockerfile` for each Node version, then runs one
container per version, one after the other. A run takes a few minutes. The exit code is 1 when any
step fails.

## What runs where

- Each scenario gets its own throwaway `HOME` and `SOUS_HOME` inside the container. The only host
  files the container sees are `e2e/` itself, mounted read-only.
- `npm i @sous-io/sous@<version>` runs inside the container. The version is resolved to one exact
  number first, so every install in the run is the same release. Scenario 08 also installs sous with
  pnpm and with Yarn Plug'n'Play.
- A scenario is `e2e/scenarios/NN-name.mjs`, a module with a default export `{ name, title, run(t) }`.
  `t.step(name, fn)` records one check; a failing step does not stop the scenario.
  `t.skip(reason)` marks a step skipped with its reason.

| Scenario | Covers |
| --- | --- |
| 01 basics | version, help, completion, `init`, `build`, `compile`, `prune`, `clear`, dry runs, repeat builds, Node warnings, the `(~N tokens)` size on written files |
| 02 config | `config show/get/set/validate`, `--layers`, conf.d layer order, duplicate base names, JSONC, CommonJS and ES module configs |
| 03 recipes | `repo`, `recipe`, `namespace`, `subscription`, `lock` against the default public repository |
| 04 variables | `vars list/show/ask/map`, answers files, env files |
| 05 authoring | `repo init`, `repo release`, publishing to the four test repositories, `repo add` (public and private), `repo contribute`, `repo submit` |
| 06 plugins | `plugins show/install`, an outside plugin that adds a command, a plugin shipped by a recipe |
| 07 frontends | `sous mcp` over stdio with the MCP SDK client, `launch` and `harness run-headless` with a fake `claude` |
| 08 update | `init` and `update` through npm, pnpm and Yarn Plug'n'Play |

A step is marked skipped only when it cannot run, with the reason printed in the summary (for
example, a real Claude account is not available, so the fake `claude` checks the arguments sous passes).

## Credentials

The runner passes `GITHUB_TOKEN` and `GITLAB_TOKEN` into the container as environment variables.
When they are not set, it takes them from `gh auth token` and `glab config get token --host gitlab.com`.
A token is never written to a file in this repository, to an image layer or to the output (the runner
and the harness replace it with `***`). Inside the container, git reads the token through credential
helpers that look at the environment when git asks. A GitLab login made with `glab auth login` is an
OAuth token, which only works as a Bearer token; the container then writes glab's config file in the
throwaway `HOME` (mode 600) so `glab` and sous can use it.

## Safety: where the suite may write

Scenarios may push and open pull or merge requests only in these four repositories (the list lives in
`e2e/lib/allowlist.mjs`):

- GitHub: `sous-io/public-github-test-repo`, `sous-io/private-github-test-repo`
- GitLab: `sous-io/public-gitlab-test-repo`, `sous-io/Test-Repo` (private)

Two checks enforce it. Every remote-writing step in a scenario calls `assertWritable`, and the image
sets a system-wide git `pre-push` hook (`e2e/hooks/pre-push`) that refuses any push, including one
sous makes itself, to another repository. Reading other public repositories, such as the default
recipe repository, is fine.

The suite leaves things behind on the test repositories on purpose: a recipe, a tag and a commit on
`main` per run, and a pull request or merge request per public repository. Branch names and recipe
names carry the run id.

## Not covered yet

- `harness run-headless` against a real Claude account.
- Writing to the private repositories through `repo submit` (only the public ones get a proposal).
