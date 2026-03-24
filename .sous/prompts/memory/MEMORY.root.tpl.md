# Sous CLI (xcv) — Agent Configuration Manager

Sous is a TypeScript CLI tool that compiles markdown templates and manages output files for LLM/AI coding agents 
(Claude, Codex, etc.). The binary is named `xcv`.

## Build & Development

```bash
npm run build    # compile TypeScript → dist/
npm run clean    # rm -rf dist/
```

Run directly from source during development:
```bash
node --import tsx/esm bin/run.js <command>
```

TypeScript: strict mode, ES2022 target, Node16 module resolution. Output goes to `dist/`.

## Project Structure

```
src/
  base-command.ts          # oclif BaseCommand; bootstraps ~/.sous/, loads settings
  commands/
    build.ts               # compile + prune (main workflow command)
    compile.ts             # compile only
    prune.ts               # remove stale output files
    clear.ts               # delete all Sous-written files for a project
    launch.ts              # build + spawn a coding agent tool
    configure.ts           # interactive setup wizard
    config/
      get.ts / set.ts / show.ts
  lib/
    settings.ts            # config loader, var resolution, scope chain
    markdown-compiler.ts   # CompilationService; @-include, LiquidJS rendering
    build-service.ts       # orchestrates compile + prune; BuildService
    liquid-engine.ts       # LiquidJS engine factory + filters
    state.ts               # StateService; tracks written files/dirs per project
    user-settings.ts       # ~/.sous/ bootstrapping and profile management
    watch-service.ts       # chokidar watcher with debounce; WatchService
    pid-service.ts         # PidService; single-instance watcher enforcement via PID files
  utils/
    formatting.ts          # console output helpers (heading, showVar, etc.)
    prompts.ts
shared-prompts/
  skills/                  # shared skill bundles; each subdirectory is a bundle
    sous-skills/           # built-in sous bundle, compiled + distributed to downstream projects
      about-sous/          # teaches downstream agents what Sous manages (never-edit rule)
      about-agent-skills/  # foundational skill knowledge for downstream agents
      about-liquid-templates/ # .tpl. convention + LiquidJS syntax for downstream agents
      create-skill/        # action skill: creating a skill in skillsRoot
deprecated/
  prompts/                 # archived — superseded by shared-prompts/skills/
  shared-prompts/          # archived — superseded by current shared-prompts/
docs/notes/                # planning docs and TODOs
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

Skills live in `configs/skills/<skill-name>/SKILL.md` (plus optional `scripts/`, `references/`). They are compiled to 
agent skill directories via `entryGlob` targets. See `prompts/skills/format.md` for the full `SKILL.md` frontmatter spec.

Two skill types:
- **Topic skills** — reference material and shared scripts for a concept
- **Action skills** — lean, action-specific; reference their parent topic skill

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

## Open TODOs

- Watch flag should watch the glob pattern itself (detect new files), not just initially matched files
- ~~Use `.pid` files to enforce single-instance watcher per project~~ — done; see `PidService`
- Create built-in Sous skills in `configs/skills/`: `using-sous`, `using-sous-skills`, `create-sous-skill`

## Important!

When working on `sous`, update this file immediately after any change. Ensure that this file ALWAYS describes
`sous`, its code, its configuration, and its usage ACCURATELY. It is VITAL that we keep this file up to date.