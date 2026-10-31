# @sous-io/sous

sous compiles AI coding agent configuration (`CLAUDE.md`, skills, memories) from LiquidJS templates, so you write your rules once and every project gets its own rendered copy.

## Install

```bash
npm install -g @sous-io/sous
sous --help
```

Or add it to one project:

```bash
npm install --save-dev @sous-io/sous
npx sous --help
```

Requires Node.js 22 or later.

## Learn more

Guides, the command reference and the config reference are at [sous.io](https://sous.io). Source and issues: [github.com/sous-io/sous](https://github.com/sous-io/sous).

## For contributors

This package is the thin shell that starts the engine with the built-in plugins and hands the command line to them. The code lives in the other packages of the monorepo; see the root README.

```bash
pnpm --filter @sous-io/sous test
```
