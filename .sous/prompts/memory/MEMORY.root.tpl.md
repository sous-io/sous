# Sous (xcv) — Agent Configuration Manager

Sous is a TypeScript toolchain that compiles markdown templates and manages output files for LLM/AI coding agents
(Claude, Codex, etc.). The user-facing entry point is a CLI binary named `xcv`.

Sous is a **pnpm monorepo**. All real code currently lives in `@sous/cli`; `@sous/core` and `@sous/mcp` are skeletons
that will be fleshed out in subsequent tasks (`core` will absorb shared internals; `mcp` will provide an MCP server).
Everything will continue to be launched through the CLI — other packages are encapsulation boundaries, not separate
public interfaces.

## Build & Development

Requires **pnpm ≥ 10** and **Node ≥ 18**.

```bash
pnpm install             # install all workspaces
pnpm build               # pnpm -r build → tsc in every package
pnpm clean               # pnpm -r clean
pnpm test                # root vitest — runs every package's tests
pnpm test:e2e            # cli e2e suite
pnpm lint                # eslint across the workspace
pnpm lint:fix            # eslint --fix across the workspace
```

Per-package scripts also work (`pnpm --filter @sous/cli build`, `pnpm --filter @sous/core test`, etc.), and every
package exposes `build`, `test`, `lint`, and `lint:fix`.

Run the CLI directly from source during development:
```bash
packages/cli/bin/xcv <command>
# or: pnpm --filter @sous/cli exec xcv <command>
```

TypeScript: strict mode, ES2022 target, Node16 module resolution. Each package extends the root `tsconfig.base.json`
and emits to its own `dist/`.

## Project Structure

```
package.json               # workspace root: delegating scripts, shared devDeps
pnpm-workspace.yaml        # packages/*
tsconfig.base.json         # shared compiler options
eslint.config.js           # shared flat config (very light rule set)
vitest.workspace.ts        # aggregates per-package vitest configs
.npmrc                     # link-workspace-packages=true

packages/
  cli/                     # @sous/cli — the xcv binary and all current functionality
    package.json           # bin: xcv, sous
    bin/
      xcv                  # bash wrapper that runs bin/run.js via tsx
      run.js               # oclif entry point
    src/
      base-command.ts      # oclif BaseCommand; bootstraps ~/.sous/, loads settings
      commands/
        build.ts           # compile + prune (main workflow command)
        compile.ts         # compile only
        prune.ts           # remove stale output files
        clear.ts           # delete all Sous-written files for a project
        launch.ts          # build + spawn a coding agent tool
        configure.ts       # interactive setup wizard
        config/
          get.ts / set.ts / show.ts
      lib/
        settings.ts        # config loader, var resolution, scope chain
        markdown-compiler.ts  # CompilationService; @-include, LiquidJS rendering
        build-service.ts   # orchestrates compile + prune; BuildService
        state.ts           # StateService; tracks written files/dirs per project
        user-settings.ts   # ~/.sous/ bootstrapping and profile management
        watch-service.ts   # chokidar watcher with debounce; WatchService
        pid-service.ts     # PidService; single-instance watcher enforcement via PID files
      templating/
        init-liquid-engine.ts # LiquidJS engine factory
        filters/, tags/    # custom LiquidJS filters + tags
      utils/
        formatting.ts      # console output helpers (heading, showVar, etc.)
        prompts.ts
      test/                # unit + integration + e2e tests live alongside src
    vitest.config.ts       # unit + integration
    vitest.e2e.config.ts   # e2e suite (longer timeouts)
    tsconfig.json / eslint.config.js

  core/                    # @sous/core — skeleton; shared internals will move here
    src/index.ts
    package.json / tsconfig.json / eslint.config.js / vitest.config.ts

  mcp/                     # @sous/mcp — skeleton for the future MCP server
    src/index.ts
    package.json / tsconfig.json / eslint.config.js / vitest.config.ts

shared/
  skills/                  # shared skill bundles; each subdirectory is a bundle
    sous-skills/           # built-in sous bundle, compiled + distributed to downstream projects
      about-sous/          # teaches downstream agents what Sous manages (never-edit rule)
      about-agent-skills/  # foundational skill knowledge for downstream agents
      about-liquid-templates/ # .tpl. convention + LiquidJS syntax for downstream agents
      create-skill/        # action skill: creating a skill in skillsRoot
    task-files/            # task file management bundle for downstream projects
docs/notes/                # planning docs and TODOs
.sous/                     # sous's own project config (self-compilation)
  config/
    sous.config.js         # entry point config (defaultProject, imports project config)
    project.config.js      # project config: paths, compilation targets, launch config
    .claude/               # source for Claude-specific files (settings.json)
  prompts/
    memory/
      MEMORY.root.tpl.md   # source template for this file (CLAUDE.md)
    skills/                # source templates for local skills (compiled → .claude/skills/)
    runtime-context/       # generated session-context files (gitignored)
  state/                   # sous state files for this project (gitignored)
  tasks/                   # task files for runtime context
```

## User Configuration

Sous stores user config at `~/.sous/settings/`:
- `sous.config.json` — active profile name (defaults to `"default"`)
- `profiles/<name>.profile.json` — per-profile settings; `defaultConfigPath` points to a project settings file (`.js` or `.json`)

Initial setup: `xcv configure` or `xcv config set defaultConfigPath /path/to/sous.config.local.js`

## Project Settings File

A JS or JSON file (outside this repo) that defines projects. Example shape:

```js
export const config = {
  _env: { userHome: "HOME" },          // map config vars to env vars (top-level only)
  _vars: { codeBase: "${userHome}/Projects/my-project" },
  defaultProject: "myproject",
  projects: {
    myproject: {
      name: "My Project",
      _vars: { projectRoot: "${codeBase}" },
      compilation: {
        targets: [
          {
            entryPoint: "${projectRoot}/prompts/AGENTS.md",
            generateRuntimeContext: true,
            outputs: [{ destinationFile: "${projectRoot}/AGENTS.md" }],
          },
          {
            entryGlob: "${projectRoot}/configs/skills/**/*.md",
            outputs: [{ destinationDir: "${projectRoot}/.claude/skills" }],
          },
        ],
      },
      tools: {
        claude: { command: "claude", promptFile: "${projectRoot}/CLAUDE.md" },
      },
    },
  },
};
```

## The `.sous/` Convention (Recommended Project Layout)

Sous's config system is open-ended — users can organize files however they want. However, the
recommended approach is to use a `.sous/` directory in the project root for all project-specific
sous configuration, templates, and state. Cross-project shared content (skill bundles, partials,
configs reused across multiple projects) should live in separate repos or directories outside any
single project.

Recommended `.sous/` layout:

```
.sous/
  config/              # sous config files (sous.config.js, project.config.js)
  prompts/             # source templates for compiled output
    memory/            # root memory template(s) → CLAUDE.md, AGENTS.md, etc.
    skills/            # project-specific skill source templates → .claude/skills/
    runtime-context/   # generated session context (gitignored)
  state/               # sous state files (gitignored)
  tasks/               # task files for runtime context
```

**Sous itself follows this convention.** The `.sous/` directory in this repo contains sous's own
project config and source templates. `xcv build` compiles them into the output locations (`.claude/`,
`CLAUDE.md`). The `shared/` directory — which lives outside `.sous/` — contains skill bundles
distributed to downstream projects, not project-specific content.

The key distinction:
- **`.sous/`** — project-specific: templates, skills, state, and config for *this* project
- **`shared/`** (or a separate repo) — cross-project: skill bundles and partials distributed to *other* projects

## Variable Scoping

Resolution order (later overrides earlier):

```
auto-vars  →  _env scope  →  root _vars  →  project _vars  →  target _vars  →  output _vars
```

- `_vars` blocks use `${varName}` syntax (resolved by Sous internally, topological order)
- Template files use `{{ varName }}` syntax (resolved by LiquidJS at render time)
- `_env` is top-level only; maps `configVarName: "ENV_VAR_NAME"`
- Reserved `sous*` namespace — do not define vars starting with `sous`

Auto-injected vars always available:
- `sousRootPath` — absolute path to the Sous CLI install directory
- `sousVersion` — current CLI version
- `sousTemplatePath` — absolute path to the `.tpl.` file currently being rendered (render-time only)
- `sousTemplateDir` — directory of the `.tpl.` file currently being rendered (render-time only)

## The `.tpl.` Convention

- Files **without** `.tpl.` in their name are copied verbatim (no LiquidJS processing)
- Files **with** `.tpl.` are rendered through LiquidJS; `.tpl.` is stripped from output filename
  - e.g., `agent.tpl.md` → `agent.md`
- The `.tpl.` convention applies to both `entryPoint` and `entryGlob`/`destinationDir` targets

## Include Syntax (Markdown Compiler)

In any source `.md` file, `@path/to/file.md` on its own line includes that file's content:

```markdown
@ sections/context.md
@ ../shared/intro.md
```

(remove the extra spaces)

Paths are resolved relative to the including file's directory. Circular includes are detected and reported as errors.

## Skills System

Sous has two tiers of skills:

- **Local skills** — for working on sous itself. Source templates in `.sous/prompts/skills/`, compiled to `.claude/skills/` via `xcv build`.
- **Shared skills** — distributed to downstream projects. Organized into bundles under `shared/skills/` (e.g. `shared/skills/sous-skills/`).

Both tiers use `SKILL.tpl.md` as the main file (LiquidJS-rendered), with optional `references/`, `examples/`, and `scripts/` directories.

Two skill patterns:
- **Topic skills** (`about-*`) — reference material; `user-invocable: false`
- **Action skills** (verb-first) — lean, action-specific; reference their parent topic skill

## State Files

Sous tracks every file and directory it writes in a state file (default: `<configsRoot>/projects/<key>/sous.state.json`). 
This enables `xcv prune` (remove stale outputs) and `xcv clear` (delete all outputs) to work precisely.

## Key Commands

| Command | Description |
|---------|-------------|
| `xcv build` | Compile + prune (main workflow) |
| `xcv compile` | Compile only |
| `xcv prune` | Remove output files no longer in config |
| `xcv clear` | Delete all Sous-written files for a project |
| `xcv launch <tool>` | Build then spawn agent (e.g., `xcv launch claude`) |
| `xcv configure` | Interactive setup wizard |
| `xcv config set <key> <value>` | Set a config value (e.g., `defaultConfigPath`) |

Common flags: `--project <key>`, `--rebuild`, `--dry-run`, `--strict`, `--watch` / `-w`

## Important Patterns

- All commands extend `BaseCommand`, which bootstraps `~/.sous/` and loads settings on every run
- Commands that don't need project settings override `get requiresSettings() { return false; }`
- `CompilationService` (alias `MarkdownCompiler`) is the core compiler class
- `BuildService` orchestrates `CompilationService` + prune in one step
- Watch mode uses `WatchService` (chokidar + debounce, 300ms); ignores `*.sous.state.json` files
- `resolveScope()` in `settings.ts` performs topological sort for intra-block var dependencies
- Internal package deps use pnpm's `workspace:*` protocol (e.g., `@sous/cli` depends on `@sous/core`)
- ESLint runs as a shared flat config; each package's `eslint.config.js` imports the root config and can override

## Open TODOs

- Watch flag should watch the glob pattern itself (detect new files), not just initially matched files
- ~~Use `.pid` files to enforce single-instance watcher per project~~ — done; see `PidService`
- Create built-in Sous skills in `configs/skills/`: `using-sous`, `using-sous-skills`, `create-sous-skill`

## Important!

When working on `sous`, update this file immediately after any change. Ensure that this file ALWAYS describes
`sous`, its code, its configuration, and its usage ACCURATELY. It is VITAL that we keep this file up to date.