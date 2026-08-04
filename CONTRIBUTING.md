# Contributing

Pull requests are welcome. Bug reports and small fixes are the easiest place to start.

## Development setup

```bash
git clone git@github.com:sous-io/sous.git
cd sous
npm install
npm test
```

Node 22 is expected (see `.nvmrc`), and `package.json` requires `>=22`. `npm run build`
compiles TypeScript to `dist/` and is also the typecheck. `npm run test:watch` reruns tests
as you edit, and `npm run test:coverage` adds a coverage report.

`npm test` runs the unit and integration suites. The watch-mode end-to-end tests are
separate because they spawn real processes and watch real files: run them with
`npm run test:e2e`.

Run the CLI from a clone without installing it globally with `./bin/xcv <command>`, or run
`npm link` once to get `xcv` on your PATH.

This repo configures its own agent skills with sous, from `.sous/sous.config.js`. Running
`./bin/xcv build` compiles them into `.claude/skills/`, which is gitignored build output.
That is optional for contributing, but it is the fastest way to confirm a change to the
compiler or the shared prompts does what you expect.

## Before you open a PR

- Add or update tests for behavior you change.
- Run `npm test` and make sure it passes.
- Run `npm run build` so the change typechecks.
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
