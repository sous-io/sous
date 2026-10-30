# Contributing

Pull requests are welcome. Bug reports and small fixes are the easiest place to start.

## Development setup

```bash
git clone git@github.com:sous-io/sous.git
cd sous
pnpm install
pnpm test
```

Node 22 is expected (see `.nvmrc`), and `package.json` requires `>=22`. Sous is a pnpm workspace:
a small engine (`packages/core`), the plugin interface (`packages/plugin-api`), one package per
built-in plugin (`packages/plugin-*`), and `packages/sous`, the published `@sous-io/sous`, which
esbuild bundles into one file. Read the [laws](docs/markdown/architecture/laws.md),
[goals](docs/markdown/architecture/goals.md) and
[specifications](docs/markdown/architecture/specifications/README.md) before changing how sous
is built; they rank above every other document.

- `pnpm test` runs every package's tests, including the end-to-end tests in
  `packages/sous/test/integration/`, which run the bundled `sous` as a process.
- `pnpm typecheck` type-checks every package (esbuild strips types without checking them).
- `pnpm build` builds `@sous-io/plugin-api` and the bundle, `packages/sous/dist/bin.js`.

Run the CLI from a clone with `./bin/sous <command>`: it rebuilds the bundle when a package's
source changed, then runs it. To get `sous` on your PATH, link that script (for example
`ln -s "$PWD/bin/sous" ~/.local/bin/sous`).

This repo configures its own agent skills with sous, from `.sous/sous.config.js`. Running
`./bin/sous build` compiles them into `.claude/skills/` (the skill target the built-in Claude
Code plugin adds), which is gitignored build output.
That is optional for contributing, but it is the fastest way to confirm a change to the
compiler or the shared prompts does what you expect.

## Before you open a PR

- Add or update tests for behavior you change.
- Run `pnpm test` and make sure it passes.
- Run `pnpm typecheck` so the change type-checks.
- Keep the change focused; one topic per PR.
- Describe what the change does and why in the PR body.

## Licensing of contributions

Read this part before you contribute.

- Contributions are accepted under the license the project currently uses (see `LICENSE`).
- By submitting a contribution, you agree the maintainer may release future versions of the
  project under a different license, without notice and without asking you again.
- Versions already published stay under the license they were published with. Relicensing
  applies going forward only, never retroactively.

If that is not acceptable to you, please do not submit a contribution.
