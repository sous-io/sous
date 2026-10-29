# S6: Concerns and Owners

**Status:** Accepted on 2026-10-29. From now on, a
change to this specification is recorded under "Changes".

**Serves:** G1 (encapsulation), G2 (a plugin system), G3 (versatility, always), G5
(boundaries obvious and enforceable), G6 (testability), G7 (the plugin interface is the only outside
promise), G8 (features for one agent tool are additions).

**Shaped by:** L1 (one owner per concern), L2 (one implementation), L3 (services never print, prompt
or exit), L4 (no prompt without a flag), L5 (everything timed).

## What This Specifies

Every concern sous handles, the one owner of each, and the package the owner lives in. Sous is a
small engine, `core`, and a set of plugins; nearly every concern lives in a plugin. For each plugin
this specification names the services, intents, entities and events it defines, and the plugins it
depends on. It also says where each concern's code lives before the refactor, so the one-sweep
refactor (S3) knows what each owner replaces, and how the new boundaries remove the import cycles
and misfiled modules the code has today.

## What Is Settled and What Is Not

Ruled by the user:

- Core holds only the engine (see "Core"). The CLI, MCP, skills, recipes, repositories, package
  managers and Claude Code are all plugins (2026-10-28).
- The rules for owners below, with rule 7 now about intents, since an intent is written once and
  every front end calls it (2026-10-25, 2026-10-28).
- Every package is kept, one per concern (2026-10-25).
- Today's `src/lib/vars/` becomes two packages, `plugin-variables` and `plugin-recipe-answers`
  (2026-10-25).
- The one definition of the project root, with no override (2026-10-25).
- Pointer files come from plugins, and each file is written once (2026-10-25).
- Only `plugin-compiler` writes build outputs; it overwrites by default and takes ownership, and
  `compilation.overwriteUntracked: false` opts out (2026-10-29).
- One `harness` entity per tool, a `memory-target` entity with an optional `filter()` and
  `format()`, and a `skill-target` entity (2026-10-29).
- What removing a repository deletes is read from the compiler's state file (2026-10-29).

The agents doing the refactor may rename an owner or move a small concern without asking, and record
each change under "Changes". Everything else marked "agent suggestion" waits for a ruling.

## Words Used Here

- **Concern**: one thing sous has to get right, such as "what the lockfile says" or "how a `${var}`
  is replaced".
- **Owner**: the one service, intent or entity kind that handles a concern. Other code asks the
  owner; it never redoes the work or reads the owner's files itself.
- **Contributor, intent, event, service, entity**: the five kinds of things the engine knows (S1):
  - a **contributor** changes the config while it is built;
  - an **intent** is a step a user or another plugin asks for, with a typed input and a result;
  - an **event** lets plugins react to anything;
  - a **service** is a shared object that does work;
  - an **entity** is a thing sous knows about, of a kind a plugin defines.
- **Depends on**: a plugin's `dependsOn`, the plugins that must be loaded for it to work.

## Names

Ruled 2026-10-29:

```text
services   <plugin>.<thing>        git.runner   variables.resolver
intents    <plugin>.<verb>         diagrams.render   subscription.add   mcp.serve
events     <intent>.before/.after/.error, or <plugin>.<past tense>     build.after   compiler.wrote
entities   a kind in kebab case    harness   skill-target   memory-target
```

- The first part names the plugin that owns it.
- Custom events use the past tense, so an event is never confused with an intent.
- A name starting with another plugin's prefix is allowed; sous warns once, naming both plugins.

In the tables below, a plugin's prefix is its package name without `plugin-` (`compiler.state` is
owned by `plugin-compiler`). A few intents keep the name users already type, such as `build` and
`subscription.add`.

## Rules for Owners

Accepted by the user (2026-10-25), with rules 1 to 3 and 7 restated for the engine:

1. **Owners are registered through the engine.** A service is registered with `sous.services.add`
   and a lifetime (`singleton`, `config` or `factory`, S1); `core` may build its service registry on
   Inversify. An intent is registered with `sous.intents.add`, and an entity kind with
   `sous.entities.define`.
2. **Each plugin declares its own types.** A plugin adds its services, intents, events and entity
   kinds to the empty interfaces in `@sous-io/plugin-api`, in its own package's `types` entry. A
   plugin that uses them imports those types only, and lists the owner in `dependsOn`. This is what
   lets `plugin-compiler` use a namespace resolver that `plugin-recipes` implements, without either
   importing the other's code.
3. **The plugin that owns a concept defines its entity kind.** Any plugin may add entities of that
   kind; contributors read them through the config builder (S1).
4. **A sub-concern lives in its parent's package**, unless another package uses it on its own. Then
   it moves down to a package both can depend on.
5. **No plugin depends on a tool-specific or host-specific plugin** (G8). A fact about Claude Code,
   GitHub, GitLab, npm, pnpm or Yarn lives only in that plugin, reached through an entity.
6. **Services never print, prompt, exit or read `process.env` or `process.cwd()` directly.** They
   report through a `Reporter`, ask through a `Prompter`, read the environment through `ctx.env`
   and the project through `ctx.project`.
7. **A user-facing operation is written once, as an intent.** `plugin-cli` generates its commands
   and flags from each intent's input schema, and `plugin-mcp` its tools, so neither holds the
   operation itself.

```ts
// plugin-recipes: registers its owners through the engine
export default definePlugin({
    name: "@sous-io/plugin-recipes",
    dependsOn: {
        "@sous-io/plugin-config-files": "^1.0.0",
        "@sous-io/plugin-refs": "^1.0.0",
    },

    register(sous) {
        sous.services.add("recipes.lock", (config) => new LockService(config), { lifetime: "config" });

        // Implements a service type plugin-compiler declares; neither imports the other's code.
        sous.services.add("compiler.namespace-resolver", (config) => new LockedNamespaceResolver(config), {
            lifetime: "config",
        });

        sous.entities.define("repository-host", repositoryHostSchema);

        sous.intents.add({
            intent: "subscription.add",
            summary: "Subscribe the project to a recipe",
            input: z.object({ ref: z.string() }),
            handle: async (input, ctx) => { /* ... */ },
        });
    },
});
```

## Packages

Four packages are not plugins. Every other package is a built-in plugin, private and bundled into
`@sous-io/sous` (S3). Agent suggestions are marked.

| Package | Holds |
| --- | --- |
| `core` | the engine (see "Core") |
| `documents` | surgical editing of JSON, JSONC and YAML documents, keeping comments, key order and formatting (S2, "The Document-Editing Package"); the config builder is built on it, and plugins reach it through the `documents.editor` service |
| `plugin-api` | `definePlugin`, the empty `SousServices`, `SousIntents`, `SousEvents` and `SousEntities` interfaces, the `Reporter` and `Prompter` interfaces, the error classes |
| `sous` | the published package: the bin, the hand-off to a project's own sous, finding the project, the list of built-in plugins, the bundle |
| `plugin-host` (agent decision, which the user may overrule) | the machine sous runs on: running processes, HTTP, globs and paths, sous home, sous's own self-describing directories, the sous block in `.gitignore`, package identity |
| `plugin-git` | the one git runner |
| `plugin-refs` | parsing and resolving refs, picking among matches, `#` names, repository locations and identity |
| `plugin-formats` | one parser per on-disk format, and the recipe content hash |
| `plugin-variables` | `${var}` substitution, `_vars` resolution, auto-variables (`projectRoot` among them), variable names, which values are secret |
| `plugin-liquid` | building a configured LiquidJS engine, and the Liquid tags and filters plugins add |
| `plugin-expressions` | config expressions (S5) and the expression languages plugins add |
| `plugin-config-files` | `sous.config.*` as a contributor, setting one value from the command line, the `.env` files |
| `plugin-confd` | the `conf.d` files, one contributor per file, and surgical edits to the managed `conf.d/5xx` files |
| `plugin-recipes` | repositories, trust, subscriptions, the lockfile, the store, the index cache, freshness, links and checkouts, the core recipe, the catalog, downloading during config building, recipe config layers, loading plugins recipes ship |
| `plugin-recipe-answers` | recipe variable definitions, the answer ladder, asking for answers, answer files, variable mappings |
| `plugin-compiler` | compiling templates, includes, aliases, compilation settings, the built-in tags and filters, the state file, writing every build output, pruning |
| `plugin-build` | the `build`, `prune` and `clear` intents, preparing for a build, watch mode, the PID file, the runtime context file |
| `plugin-skills` | skills: where they come from, the `skill-target` entity, the compilation targets for them |
| `plugin-memories` | memories: selecting them, the `memory-target` entity, the compilation targets for them, the `#memories` name |
| `plugin-harnesses` | the `harness` entity, launching a harness, headless runs, the `tools` settings |
| `plugin-authoring` | releasing, submitting and contributing to recipe repositories, scaffolding one |
| `plugin-init` | scaffolding a project's `.sous/` (`sous init`) |
| `plugin-update` | updating sous itself, installing plugins a recipe requires, the `package-manager` entity, scanning for installed plugins |
| `plugin-inspect` (agent decision, which the user may overrule) | showing the engine's state: `config show`, `config get`, `plugins show`, timings |
| `plugin-cli` | the CLI front end: commands generated from intents, terminal output and prompts, error messages and exit codes |
| `plugin-mcp` | the `sous mcp` front end: tools generated from intents, MCP logging and elicitation |
| `plugin-npm`, `plugin-pnpm`, `plugin-yarn` | a `package-manager` entity each |
| `plugin-github`, `plugin-gitlab`, `plugin-local` | a `repository-host` entity each |
| `plugin-claude-code` | everything sous knows about Claude Code: its `harness`, `skill-target` and `memory-target` entities |

Codex, and every other agent tool, is a separately installed plugin. A web front end, such as the
one `sous serve` would start, is a plugin of the same shape as `plugin-mcp` (S1, "Front ends").

`plugin-claude-code` is the Sous plugin that teaches sous about Claude Code. It is not the
Sous-provided Claude Code plugin S3 describes, which is a Claude Code plugin that defers to the
installed `sous`.

## Dependency Direction

Plugins reach each other only through the engine, by name; at compile time they import each other's
types only. What orders them is `dependsOn`, which sous checks at load (S1). The `dependsOn` graph
has no cycles: a plugin depends only on plugins on lower rows (agent suggestion):

```text
top      plugin-claude-code   plugin-github  plugin-gitlab  plugin-local   plugin-npm  plugin-pnpm  plugin-yarn
           │
         plugin-cli   plugin-mcp   plugin-inspect          (depend on nothing: they use intents by name)
           │
         plugin-init   plugin-harnesses   plugin-authoring   plugin-update
           │
         plugin-build
           │
         plugin-skills   plugin-memories
           │
         plugin-compiler   plugin-recipe-answers
           │
         plugin-recipes
           │
         plugin-config-files   plugin-confd
           │
         plugin-expressions   plugin-formats
           │
         plugin-liquid   plugin-variables   plugin-refs   plugin-git
           │
         plugin-host
           │
         plugin-api   core   sous           (not plugins; every plugin uses plugin-api's types)
           │
         documents                  (not a plugin; core's config builder is built on it)
```

| Plugin | Depends on |
| --- | --- |
| `plugin-host` | nothing |
| `plugin-git`, `plugin-refs`, `plugin-variables`, `plugin-liquid` | `plugin-host` |
| `plugin-formats` | `plugin-refs` |
| `plugin-expressions` | `plugin-liquid`, `plugin-variables` |
| `plugin-config-files` | `plugin-expressions`, `plugin-variables`, `plugin-host` |
| `plugin-confd` | `plugin-expressions`, `plugin-variables`, `plugin-host` |
| `plugin-recipes` | `plugin-confd`, `plugin-formats`, `plugin-refs`, `plugin-variables`, `plugin-git` |
| `plugin-recipe-answers` | `plugin-recipes`, `plugin-confd`, `plugin-formats`, `plugin-refs`, `plugin-variables` |
| `plugin-compiler` | `plugin-liquid`, `plugin-refs`, `plugin-variables`, `plugin-host` |
| `plugin-skills` | `plugin-compiler`, `plugin-recipes` |
| `plugin-memories` | `plugin-compiler`, `plugin-recipes`, `plugin-refs` |
| `plugin-build` | `plugin-compiler`, `plugin-recipes`, `plugin-recipe-answers`, `plugin-git` |
| `plugin-harnesses` | `plugin-build`, `plugin-host` |
| `plugin-authoring` | `plugin-recipes`, `plugin-formats`, `plugin-refs`, `plugin-variables`, `plugin-git` |
| `plugin-init` | `plugin-build`, `plugin-config-files` |
| `plugin-update` | `plugin-host` |
| `plugin-cli`, `plugin-mcp`, `plugin-inspect` | nothing |
| `plugin-npm`, `plugin-pnpm`, `plugin-yarn` | `plugin-update` |
| `plugin-github`, `plugin-gitlab`, `plugin-local` | `plugin-recipes` |
| `plugin-claude-code` | `plugin-skills`, `plugin-memories`, `plugin-harnesses` |

Reading the diagram:

- `plugin-compiler` does not depend on `plugin-recipes`, `plugin-recipe-answers` or
  `plugin-config-files`. It compiles whatever compilation targets the config holds, with a scope and
  a namespace resolver, so a front end can render with it alone (G7).
- `plugin-config-files` does not depend on the features above it. They change the config through
  their own contributors, and add their keys as `config-key` entities.
- `plugin-refs` depends on nothing but `plugin-host`.
- `plugin-recipe-answers` depends on `plugin-recipes`, never the other way.
- `plugin-skills` and `plugin-memories` only add compilation targets; they write nothing.
- `plugin-claude-code` sits on top: nothing depends on it (G8).

A test in the workspace checks `dependsOn` against the type imports on every run, so an undeclared
dependency fails the build (G5).

## The Concerns

Grouped by package. Each table names the owner of each concern and its kind (service, intent,
entity kind, or a contributor). Intents shown are examples of the full set, which follows from
today's commands.

### The engine: `core`

Ruled 2026-10-28: core holds only the engine. The details of each part are in S1.

| Concern | Owner |
| --- | --- |
| Loading plugins, as part of the config-building loop; `dependsOn` checks | the plugin loader |
| Building the config: contributors, the builder, patches, re-running only what changed, "what if" builds | the config builder |
| Checking the built config against every `config-key` entity (core defines the `config-key` kind, since it runs the check; agent decision, which the user may overrule) | the config builder |
| Running chains: series by default, parallel when declared, background intents | the chain scheduler |
| Events: `on`, `once`, `off`, `emit`, wildcards, regular expressions, priorities | the event bus |
| Services: lifetimes, wrapping, replacing, and `services.replace` | the service registry |
| Entities: defining kinds, adding entries, reads through the builder | the entity registry |
| Finding loops, and the time budgets (L5) | the engine's monitors |
| What each plugin registered, wrapped or replaced, for `plugins show` | the ledger |
| The project and the environment, handed to every `ctx` | `ctx.project`, `ctx.env` |

When two plugins replace the same service, sous stops with an error unless the config picks one
(ruled 2026-10-28):

```text
Error: two plugins replace "git.runner": sous-plugin-fast-git and sous-plugin-git-lfs.
  Choose one in the config:  services.replace."git.runner": "sous-plugin-fast-git"
```

The user's warning about that escape hatch: picking one "will likely have unintended side-effects",
so sous warns on every run that the other plugin may not work as expected.

### The published package: `sous`

| Concern | Owner | Kind |
| --- | --- | --- |
| Handing off to the project's own installed sous | `ProjectInstallHandoff` | runs in the bin, before the engine starts |
| Finding the project's config file, and the project root | `ProjectLocator` | runs in the bin; the result becomes `ctx.project` |
| The list of built-in plugins | the bin | |

The project root has one definition (ruled 2026-10-25): **the directory that holds the `.sous/`
directory the config file was found in.** When `--config` names a file outside any `.sous/`, the
root is the parent of the directory holding that file, as `sousDir` is defined today.

- A project cannot set its root anywhere else.
- `ctx.project` carries `root`, `sousDir`, `configPath` and `confDir`.
- `plugin-variables` publishes the root as the auto-variable `projectRoot`, so a config no longer
  writes `projectRoot: "${sousDir}/.."` by hand, and every existing `${projectRoot}` keeps working.
- Setting `projectRoot` in any `_vars` is an error saying that sous sets it.

### `plugin-api`

| Concern | Owner |
| --- | --- |
| Declaring a plugin | `definePlugin` |
| The interfaces plugins add their types to | `SousServices`, `SousIntents`, `SousEvents`, `SousEntities` |
| Reporting progress, notes and warnings (L3) | the `Reporter` interface |
| Asking a question (L3, L4) | the `Prompter` interface |
| The error classes every plugin throws | `SousError`, `ConfigError`, `NonInteractiveError` |

```ts
export interface Reporter {
    progress(event: ProgressEvent): void;
    note(message: string): void;
    warning(message: string): void;
}

export interface Prompter {
    // Each question names the flag or argument that answers it without a prompt (L4).
    // A prompter that cannot ask throws NonInteractiveError naming that flag.
    askValue(question: ValueQuestion): Promise<string>;
    askChoice<T>(question: ChoiceQuestion<T>): Promise<T>;
    confirm(question: ConfirmQuestion): Promise<boolean>;
}
```

A front end hands its own `Reporter` and `Prompter` over with each chain it submits (S1).

### The machine: `plugin-host`

Agent suggestion: these small services have one shared reason to exist, the machine sous runs on,
so they share one plugin rather than one each.

| Concern | Owner | Kind |
| --- | --- | --- |
| Running a subprocess, timed | `host.processes` | service, singleton |
| HTTP requests, timed | `host.http` | service, singleton |
| Globs and paths: matching, the static base of a pattern, bytewise order, "is this path inside that one" | `host.globs` | service, singleton |
| Sous home: where machine-wide data lives (`SOUS_HOME`, the store, global repos, global links) | `host.sous-home` | service, singleton |
| Creating the self-describing directories sous makes | `host.directories` | service, singleton |
| The names of the pointer files written into those directories | `pointer-file` | entity kind |
| The sous-managed block in a `.gitignore` file | `host.gitignore` | service, singleton |
| Package identity: where the installed sous is, and its version | `host.package` | service, singleton |

Pointer files (ruled 2026-10-25): in each directory it creates, `host.directories` writes only a
`README.md` of its own. Every pointer file (a one-line file such as `CLAUDE.md` or `AGENTS.md` that
tells an agent to read the README) comes from a `pointer-file` entity another plugin adds. Several
plugins may name the same file; sous writes each file once. A file that already exists is never
overwritten.

Agent decision, which the user may overrule: `plugin-memories` adds a `pointer-file` entity for every `memory-target` whose
harness reads it in any directory, so a harness plugin declares its memory file once:

```ts
// plugin-memories, in its config contributor
for (const target of config.entities("memory-target")) {
    if (target.readIn === "any-directory") {
        config.addEntity("pointer-file", { id: target.id, fileName: target.fileName });
    }
}

// With plugin-claude-code (CLAUDE.md) and sous-plugin-codex (AGENTS.md),
// host.directories writes README.md, CLAUDE.md and AGENTS.md, each once.
```

### Shared building blocks

| Concern | Owner | Package | Kind |
| --- | --- | --- | --- |
| Running git, one runner for every caller | `git.runner` | `plugin-git` | service, singleton |
| Parsing a written ref into every reading it could have | `refs.parser` | `plugin-refs` | service; readings come from `ref-splitter` entities |
| Which readings count in each place a ref is written | `refs.resolver` | `plugin-refs` | service; uses `ref-pruner` and `ref-lookup` entities |
| Settling which of several matches a run proceeds with | `refs.picker` | `plugin-refs` | service; asks through the chain's `Prompter` |
| `#` names (`#project`, `#memories`) and what each stands for | `hash-name` | `plugin-refs` | entity kind |
| Repository locations (`github://...`) and canonical identity | `refs.locations` | `plugin-refs` | service; reads `repository-host` entities |
| One parser per on-disk format: lockfile, recipe manifest, repo manifest, index file, links map, store entry, variable definition | `formats.<name>` | `plugin-formats` | service each, singleton |
| Reading a manifest file from disk | `formats.manifests` | `plugin-formats` | service, singleton |
| The content hash a release writes and the store checks | `formats.recipe-hash` | `plugin-formats` | service, singleton |
| `${var}` substitution, the `_vars` loop, the four scope levels, auto-variables | `variables.resolver` | `plugin-variables` | service, config |
| Extra sources of variables, such as recipe answers | `variable-source` | `plugin-variables` | entity kind |
| Variable names and their spellings (`bareName`) | `variables.names` | `plugin-variables` | service, singleton |
| Which values are secret, and hiding them | `variables.secrets` | `plugin-variables` | service, config |
| Building a LiquidJS engine with every tag and filter | `liquid.engine` | `plugin-liquid` | service, factory |
| Liquid tags and filters plugins add | `liquid-tag`, `liquid-filter` | `plugin-liquid` | entity kinds |
| Which expression languages exist, Liquid first (S5) | `expression-language` | `plugin-expressions` | entity kind |
| Evaluating config expressions inside each layer, before it merges (S2, S5) | `expressions.evaluator` | `plugin-expressions` | service, used by the config-file contributors |

`variables.resolver` is used by the config files (S2) and by the compiler (per-target and per-output
scopes), so it lives below both. `plugin-recipe-answers` adds the recipe answers as a
`variable-source` entity, so config expressions can read answers (S2, "Recipe answers") without
`plugin-variables` knowing recipes exist.

Ruled 2026-10-29: config expressions see every `liquid-filter` entity plugins add. A filter that does
not exist yet gives `undefined` for that pass and is tried again on the next; if it still does not
exist once the config settles, that is an error naming it. A filter used in the config must give the
same result for the same input, like every contributor.

### Config files: `plugin-config-files` and `plugin-confd`

| Concern | Owner | Plugin | Kind |
| --- | --- | --- | --- |
| Finding `sous.config.*` | `config-files.main` | `plugin-config-files` | contributor |
| Reading one config file (`.json`, `.jsonc`, `.yaml` parsed; `.js`, `.ts` imported) | `config-files.loader` | `plugin-config-files` | service, singleton |
| Setting one value from the command line | `config.set` | `plugin-config-files` | intent |
| Reading and writing `.sous/.env` and `.sous/.env.local` | `config-files.env` | `plugin-config-files` | service, singleton; adds to `ctx.env` |
| Finding the `conf.d` files, one contributor per file (`confd/<file name>`) | `confd.files` | `plugin-confd` | contributor per file |
| Reading patch files (`.patch.json`, `.patch.jsonl`) as contributors, in `conf.d` and beside `sous.config.*` (S2, "Patch files") | `confd.files`, `config-files.main` | `plugin-confd`, `plugin-config-files` | contributor per file |
| Surgical edits to the managed `conf.d/5xx` files (S2) | `confd.managed` | `plugin-confd` | service, config |

The `sous.config.*` contributor and each `conf.d` contributor apply their file as one merge at the
root, so each monitors the whole config automatically; any change in a pass re-runs them and their
patches land on top. Each `conf.d` contributor runs `after` the file before it, the first one after
`config-files.main`, so the files keep today's order (S2, "Order and stages"). `plugin-confd` uses `plugin-config-files`' loader to read each
file.

### Recipes: `plugin-recipes`

The name is an agent decision, which the user may overrule; the concern is everything about getting recipes into a project.

| Concern | Owner | Kind |
| --- | --- | --- |
| Hosts of recipe repositories, each with its read strategies and token sources (S4) | `repository-host` | entity kind |
| Adding and removing repositories (`conf.d/500`) | `repo.add`, `repo.remove` | intents |
| Trust: which repositories the project accepts recipes from; nothing inside an untrusted repository runs | `recipes.trust` | service, config; `repo.trust` intent |
| Subscriptions (`conf.d/510`) | `subscription.add`, `.remove`, `.enable`, `.disable`, `.list` | intents |
| Which recipes are active on this machine: reached from the subscriptions in force (S4) | `recipes.active` | service, config |
| Resolving subscriptions to versions, and keeping only what is reachable | `recipes.resolver` | service, config |
| The lockfile | `recipes.lock` | service, config; `lock.rebuild` intent |
| Downloading what subscribed recipes need, during config building, cached | `recipes.fetch` | contributor |
| The machine-wide recipe store | `recipes.store` | service, singleton |
| Cached repository indexes, and when to look upstream | `recipes.index-cache` | service, singleton |
| The core recipe that ships in the package, and seeding it | `recipes.core` | contributor |
| Recipe config layers, filtered to the keys a recipe may set | `recipes.config-layers` | contributor |
| Loading the plugins recipes ship (one bundled file each; types copied to `.sous/types/`) | `recipes.plugins` | contributor |
| Links: the project and machine-wide links maps; editable checkouts | `repo.link`, `repo.unlink` | intents; `recipes.links` service |
| How one recipe brings in another (`depends`, `subscribes`) | `recipes.declarations` | service, singleton |
| The `~` sigil: which directory an include of a pinned recipe means | `compiler.namespace-resolver` | service, config; type declared by `plugin-compiler` |
| Index and lockfile lookups for refs | `ref-lookup` entities | entities |
| Browsing namespaces and recipes | `catalog.list`, `catalog.show` | intents |
| Planning an update of pinned versions | `recipe.update` | intent |
| The config keys `repos`, `subscriptions`, `store` | `config-key` entities | entities |

Removing a repository reports what it deletes from the compiler's state file (ruled 2026-10-29):

```ts
// plugin-recipes, in its "repo.remove" intent
const files = ctx.services.get("compiler.state").filesFrom({ repository: input.repository });

ctx.reporter.note(`Removing ${input.repository} deletes ${files.length} built files.`);
```

### Recipe answers: `plugin-recipe-answers`

| Concern | Owner | Kind |
| --- | --- | --- |
| Which variables the active recipes define | `recipe-answers.definitions` | service, config |
| The answer ladder: where an answer comes from, in order | `recipe-answers.ladder` | service, config |
| The answers a build uses, per recipe | `recipe-answers.answers` | service, config; adds a `variable-source` entity |
| Asking for missing answers | `vars.ask` | intent; asks through the chain's `Prompter` |
| Answers given up front, by file or flag (L4) | `recipe-answers.preanswers` | service, factory |
| Variable mapping records (`conf.d/520`) | `vars.map` | intent; `recipe-answers.mappings` service |
| Checking an answer against its definition, with a time-limited regex | `recipe-answers.validator` | service, singleton |
| Ref lookups over variables | `ref-lookup` entities | entities |

### Compiler: `plugin-compiler`

Ruled 2026-10-29: among the built-in plugins, only the compiler writes build outputs. Other plugins
add compilation targets to the config.

| Concern | Owner | Kind |
| --- | --- | --- |
| Compiling every target's templates into outputs | `compiler.compile` | intent, internal |
| Include resolution: include lines and `{% render %}` paths, `@`, `~` and `#` | `compiler.includes` | service, config |
| Aliases | `compiler.aliases` | service, config |
| Compilation settings: targets, entry globs, `content` targets, outputs, runtime context | the `compilation` config key | `config-key` entity |
| The built-in tags (`showVars`, `exportScalarVarsJs`, `getFiles`, `listFiles`) and filter (`bulletList`) | `liquid-tag`, `liquid-filter` entities | entities |
| The state file: every file sous wrote, and which recipe it came from | `compiler.state` | service, config |
| Writing outputs: overwrite and take ownership, unless `compilation.overwriteUntracked` is `false` | `compiler.writer` | service, config |
| Pruning outputs no target produces any more | `compiler.prune` | intent, internal |
| The namespace resolver the `~` sigil uses | `compiler.namespace-resolver` | service type, implemented by `plugin-recipes` |
| Announcing what a compile wrote | `compiler.wrote` | event |

A compilation target may give its source as `content`, a template string, instead of `entryGlob` or
`entryPoint`. Such a target needs an `id`, which names the source in errors (ruled 2026-10-29).

```jsonc
// What `sous config show compilation.targets` prints for a target plugin-memories added
{
    "id": "memories/claude-code",
    "content": "@/home/luke/.sous/cache/.../workflow/github-projects/memories/board.md\n\n@...",
    "outputs": [{ "destinationFile": "/home/luke/code/acme/CLAUDE.md" }]
}
```

### Build: `plugin-build`

| Concern | Owner | Kind |
| --- | --- | --- |
| The one build path, used by `build`, `compile`, `launch`, `init` and every front end | `build` | intent |
| Compiling without recipes (`sous compile`) | `compile` | intent |
| Preparing for a build: seed core, lock new subscriptions, restore, check upstream | `build.prepare` | intent, internal |
| Prune and clear | `prune`, `clear` | intents |
| Watch mode | `build.watch` | intent, background; submits a `build` chain for each change |
| The watch settings | the `watch` config key | `config-key` entity |
| The PID file | `build.pid` | service, singleton |
| The runtime context file (git branch, task file) | `build.runtime-context` | service, config |

### Skills: `plugin-skills`

| Concern | Owner | Kind |
| --- | --- | --- |
| Places a harness reads skills from | `skill-target` | entity kind |
| Where skills come from: active recipes, and the user's own | `skills.sources` | service, config |
| Turning skill targets into compilation targets, with each target's optional `transform` | `skills.targets` | contributor |
| The user's own destinations (`recipes.skills.outputs`) | `config-key` entity | entity |

With no `skill-target` and no configured destination, skills go nowhere, and the build says why and
how to fix it. Core has no default destination (ruled 2026-10-25, G8):

```text
Skipped the skills of 3 recipes: nothing says where skills go.
  Set recipes.skills.outputs in the config, or enable an agent plugin (sous-plugin-claude-code).
```

### Memories: `plugin-memories`

| Concern | Owner | Kind |
| --- | --- | --- |
| Files a harness reads into every session | `memory-target` | entity kind |
| Which memories go where: the active recipes' memories, then the config's selection (`memories.first`, `memories.exclude`) | `memories.selection` | service, config |
| Turning memory targets into compilation targets | `memories.targets` | contributor |
| The `#memories` name | `hash-name` entity | entity |
| Pointer files for memory targets read in any directory (agent decision, which the user may overrule) | `pointer-file` entities | entities |

Ruled 2026-10-29: a memory target has an id, its harness, its file name, where the harness reads it,
an optional `filter(memory, ctx)` and an optional `format(memories, ctx)`. The order is: the active
recipes' memories, the config's selection, the target's `filter()`, then its `format()`. The default
`format()` writes one compiler `@` include line per memory, so the compiler pulls each memory in.
Sous does not report what a filter left out; a plugin that wants the user to know says so itself.

```ts
// plugin-memories, in its config contributor
contribute(config) {
    for (const target of config.entities("memory-target")) {
        const memories = selectMemories(config).filter((m) => target.filter?.(m) ?? true);
        const content = target.format
            ? target.format(memories)
            : memories.map((m) => `@${m.path}`).join("\n\n");

        config.atPath("compilation.targets").appendValue({
            id: `memories/${target.id}`,
            content,
            outputs: [{ destinationFile: "${projectRoot}/" + target.fileName }],
        });
    }
}
```

### Harnesses: `plugin-harnesses`

| Concern | Owner | Kind |
| --- | --- | --- |
| A harness: the program that wraps a model, used interactively, headless, or both | `harness` | entity kind |
| Launching a harness after a build | `launch` | intent |
| Running a harness with no person at the keyboard, and reading its transcript | `harness.run-headless` | intent |
| The `tools` settings, and a `harness` entity for each tool written there with no plugin | the `tools` config key; `harnesses.tools` contributor | entity, contributor |

Ruled 2026-10-29: one `harness` entity per tool, with `launch`, `runHeadless` and `readTranscript`
each optional. Anything that depends on the config, such as a user's launch arguments, is read by
the method when it runs:

```ts
// plugin-claude-code
sous.entities.add("harness", {
    id: "claude",
    launch: (args, ctx) => {
        const settings = ctx.config.get("tools.claude");

        return spawnInteractive(settings?.command ?? "claude", [...(settings?.args ?? []), ...args], ctx);
    },
    runHeadless: (prompt, ctx) => sdkQuery(prompt, ctx),
    readTranscript: (result) => toTranscript(result),
});
```

A tool written under `tools` in the config launches with no plugin at all (G8).

### Authoring: `plugin-authoring`

| Concern | Owner | Kind |
| --- | --- | --- |
| Releasing a recipe repository: validate, plan, tag, bump, changelog, settle, build the index | `repo.release` | intent |
| Proposing changes to a recipe repository | `repo.submit` | intent |
| Contributing: link, submit and unlink in one go | `repo.contribute` | intent; runs `repo.link`, `repo.submit`, `repo.unlink` |
| Scaffolding a recipe repository (`sous repo init`) | `repo.init` | intent |

The CI workflow a scaffold writes comes from the `repository-host` entity (GitHub writes a GitHub
Actions workflow, GitLab its own), so nothing host-specific lives outside the host plugins.

### Project setup and updates: `plugin-init`, `plugin-update`

| Concern | Owner | Package | Kind |
| --- | --- | --- | --- |
| Scaffolding a project's `.sous/` | `init` | `plugin-init` | intent |
| Updating sous itself (`sous update`) | `update` | `plugin-update` | intent |
| Installing a plugin a recipe requires (`--install-plugins`) | `plugins.install` | `plugin-update` | intent |
| Package managers: detecting one, listing installed packages, installing | `package-manager` | `plugin-update` | entity kind |
| Scanning installed packages for plugins, when the config asks for it | `update.scan` | `plugin-update` | contributor; adds to the `plugins` key |

### Showing the engine's state: `plugin-inspect`

Agent suggestion: these intents show what the engine built, rather than any one plugin's data, so
they share one plugin.

| Concern | Owner | Kind |
| --- | --- | --- |
| Printing the built config, and each contributor's changes (`--layers`, `--raw`) | `config.show`, `config.get` | intents |
| Every plugin, and what it registered, wrapped or replaced | `plugins.show` | intent |
| Every timing of the last run | `timings.show` | intent |

### Front ends: `plugin-cli`, `plugin-mcp`

| Concern | Owner | Package | Kind |
| --- | --- | --- | --- |
| Turning argv into an intent: the command tree, groups, aliases, flags, `--help`, completion and "did you mean", generated from every intent's declaration, on Node's `util.parseArgs` (S1) | `cli.commands` | `plugin-cli` | service, config |
| Arguments every command accepts, and command groups' help | `cli-global-argument`, `cli-group` | `plugin-cli` | entity kinds |
| `--debug` and `--log-level <level>` | `cli-global-argument` entities | `plugin-cli` | entities |
| Whether a prompt is possible in this run | `cli.interactivity` | `plugin-cli` | service, singleton |
| Terminal output: colors, wrapping, tables, every view of domain data | `TerminalReporter` and the views | `plugin-cli` | a `Reporter` |
| Terminal prompts | `TerminalPrompter` | `plugin-cli` | a `Prompter` |
| Turning an error into a message and an exit code | `cli.errors` | `plugin-cli` | service, singleton |
| `sous --version` | `version` | `plugin-cli` | intent |
| The MCP server: tools generated from every intent's input schema | `mcp.serve` | `plugin-mcp` | intent, background |
| MCP output and questions | `McpReporter`, `ElicitationPrompter` | `plugin-mcp` | a `Reporter` and a `Prompter` |

Every front end can do anything another can, because they all submit the same intents (ruled
2026-10-28). A view of domain data, such as the catalog table, belongs to `plugin-cli`: the intent
returns plain data, and the CLI decides how it looks.

```ts
// plugin-mcp
sous.intents.add({
    intent: "mcp.serve",
    background: true,
    async handle(input, ctx) {
        const server = new McpServer();

        server.onToolCall((call, client) =>
            ctx.engine.submit(intentFromToolCall(call), {
                reporter: new McpReporter(client),
                prompter: new ElicitationPrompter(client),
            }),
        );

        await server.runUntilClosed();
    },
});
```

The `sous mcp` server answers MCP elicitation with `ElicitationPrompter`, so `sous vars ask` works the
same in a terminal and in an agent session. `sous mcp` is new: nothing like it exists before the
refactor.

### Host and package-manager plugins

| Plugin | Adds |
| --- | --- |
| `plugin-npm` | a `package-manager` entity: detect npm, list installed packages, install |
| `plugin-pnpm` | a `package-manager` entity: the same for pnpm |
| `plugin-yarn` | a `package-manager` entity: the same for Yarn, plus Yarn Plug'n'Play's resolver for plugin lookup |
| `plugin-github` | a `repository-host` entity: reading indexes, the token (`GITHUB_TOKEN`, then `gh`), proposing changes, the CI workflow for a scaffold |
| `plugin-gitlab` | a `repository-host` entity: the same for GitLab, with S4's fixes to the index address and the token |
| `plugin-local` | a `repository-host` entity: a repository on disk |
| `plugin-claude-code` | a `harness` (`claude`), a `skill-target` (`.claude/skills`) and a `memory-target` (`CLAUDE.md`) |

## Where Each Setting Goes

S2 leaves open where aliases, tools, compilation and watch settings are resolved once they leave the
config files. Each is a `config-key` entity added by the plugin that uses it, which reads the built
config through `ctx.config`. None of them reads a config file.

| Settings | Owner | Package |
| --- | --- | --- |
| Aliases | `compiler.aliases` | `plugin-compiler` |
| Compilation (targets, outputs, runtime context, `overwriteUntracked`) | the `compilation` key | `plugin-compiler` |
| Tools | the `tools` key | `plugin-harnesses` |
| Watch (poll interval, extra paths) | the `watch` key | `plugin-build` |
| Skill destinations | `recipes.skills.outputs` | `plugin-skills` |
| Memory selection | `recipes.memories` | `plugin-memories` |

## Where Each Concern Lives Before the Refactor

What each owner replaces. Every file named here is removed or emptied by the refactor (L2); none of
these code paths survives beside its new owner.

| Concern | Files before the refactor |
| --- | --- |
| Startup, the project-install hand-off | `bin/run.js`, `src/lib/project-install.mjs` |
| Finding the config, the layers and the env files | `src/base-command.ts` (`init`), `src/lib/config-discovery.ts`, `src/lib/env-local.ts` |
| Loading and merging the config | `src/lib/config-kernel.mjs` (a child process), `src/lib/settings.ts` (`loadSettings`, `loadSettingsWithLayers`) |
| The config schema | `src/lib/config-schema.ts` (one strict literal of every key) |
| Built-in config entries, recipe config layers | `src/lib/repos/defaults.ts`, `src/lib/repos/recipe-config-layers.ts` |
| Managed layers | `src/lib/repos/managed-layer.ts` |
| Reading a value by path | `src/lib/config-inspect.ts` |
| Env files | `src/lib/env-local.ts` (reads), `src/lib/env-file.ts` (writes) |
| `${var}` and `_vars` | `src/lib/settings.ts` (`substituteVars`, `substituteVarsStrict`, `findUnresolvedVars`, `normalizeConfigPath`, `resolveScope`, `buildAutoVars`, `resolveEnvScope`, `resolveRootScope`), `src/lib/include-resolver.ts` (a second `substituteVars`), `src/lib/config-kernel.mjs` (a second auto-vars list) |
| Aliases, tools, compilation, watch settings | `src/lib/settings.ts` (`buildBuiltInAliases`, `resolveAliases`, `resolveTools`, `resolveCompilation`, `resolveWatchConfig`) |
| The project root | `_vars.projectRoot` written by hand (and by `src/lib/project-scaffold/templates.ts`), `ProjectHashName` in `src/services/ref-resolver/hash-names.ts`, `projectRootFor` in `src/lib/repos/recipe-targets.ts`, `projectLabel` in `src/base-command.ts`, the `process.cwd()` fallback in `src/commands/launch.ts`, the `process.cwd()` default in `src/lib/state.ts`, the project lookup in `src/lib/self-update/installs.ts` |
| Sous home | `src/lib/sous-home.ts` |
| The sous-directory helper | `src/utils/sous-directory.ts` |
| Package identity | `src/lib/package-info.ts`, re-exported by `src/lib/settings.ts` |
| Errors | `src/lib/errors.ts`, `NonInteractiveError` in `src/lib/interactive.ts`, `src/utils/command-errors.ts` |
| Interactivity | `src/lib/interactive.ts` |
| Printing | `src/utils/formatting.ts`, `src/utils/table.ts`, and direct `console` and `process.stderr` calls in `src/lib/settings.ts`, `src/lib/build-service.ts`, `src/lib/repos/recipe-memories.ts`, `src/lib/self-update/run.ts` |
| Prompting | `src/utils/prompts.ts`, `src/utils/value-prompt.ts`, `src/utils/choice-prompt.ts`, `src/utils/confirm-prompt.ts`, called from `src/lib/repos/trust.ts`, `src/lib/repos/subscription-service.ts`, `src/lib/repos/release/submit-questions.ts`, `src/lib/vars/ask.ts`, `src/lib/self-update/run.ts`, `src/services/ref-resolver/ref-picker-service.ts`, and `@inquirer/prompts` directly in `src/commands/clear.ts` |
| Running processes | `spawnSync` in `src/lib/settings.ts` and `src/commands/launch.ts`, `execFileSync` in `src/lib/markdown-compiler.ts`, `spawn` in `src/lib/self-update/run.ts`, `spawnCommand` in `src/lib/repos/providers/git.ts` |
| Git | two runners: `src/lib/repos/providers/git.ts` (async, `CommandRunner`, used by providers and releases) and `src/lib/repos/git-clone.ts` (sync, `GitRunner`, used by `repo link`); both export a `runGit` with different signatures |
| HTTP | `src/lib/repos/providers/http.ts` |
| Globs and paths | `src/services/ref-resolver/glob.ts`, `inferGlobBase` in `src/lib/markdown-compiler.ts`, `realPathInside` in `src/lib/include-resolver.ts` |
| Refs, `#` names | `src/services/ref-resolver/` |
| Repository identity | `src/lib/repos/identity.ts` |
| Formats | `src/lib/repos/formats/`, `src/lib/repos/load-manifest.ts`, `src/lib/repos/store/hash.ts` |
| Repository providers | `src/lib/repos/providers/{provider,base,index,github,gitlab,local}.ts` |
| Trust | `src/lib/repos/trust.ts` |
| Subscriptions | `src/lib/repos/subscription-service.ts` (3,859 lines, with nine sections marked inside it), `src/lib/repos/catalog-inputs.ts` |
| Active recipes | `src/lib/repos/locked-recipes.ts`, `src/lib/repos/locked-recipe-lookup.ts` |
| Resolving versions | `src/lib/repos/resolver.ts` |
| The lockfile | `src/lib/repos/lock-service.ts`, and the pipeline `src/commands/lock/rebuild.ts` runs by hand |
| The store | `src/lib/repos/store/` |
| The index cache, freshness | `src/lib/repos/providers/index-cache.ts`, `src/lib/repos/freshness.ts` |
| The core recipe | `src/lib/repos/core-recipe.ts`, `src/lib/repos/seed.ts` |
| Links and checkouts | `src/lib/repos/links.ts`, `src/lib/repos/git-clone.ts`, and the rules inside `src/commands/repo/link.ts` and `src/commands/repo/unlink.ts` |
| Recipe declarations | `src/lib/repos/declarations.ts` |
| The `~` sigil | `src/lib/repos/namespace-resolver.ts` (the contract), `src/lib/repos/locked-namespace-resolver.ts` (the implementation) |
| Recipe memories | `src/lib/repos/recipe-memories.ts`, `src/lib/repos/memories-hash-name.ts`, `src/lib/repos/recipe-key-matcher.ts` |
| The catalog | `src/lib/repos/catalog.ts`, `src/lib/repos/ref-search.ts` |
| Update plans | `src/lib/repos/update-plan.ts` |
| Variable definitions | `src/lib/vars/definition-source.ts`, and the list `SubscriptionService` builds by hand |
| The answer ladder | `src/lib/vars/ladder.ts` |
| Answers for a build | `src/lib/vars/answers.ts`, `resolveProjectAnswers` in `src/lib/build-service.ts` |
| Asking | `src/lib/vars/ask.ts`, `src/lib/vars/preanswers.ts` |
| Variable mappings | `src/lib/vars/mappings.ts` |
| Validating answers | `src/lib/vars/validate.ts`, `src/lib/vars/safe-regex.ts` |
| Variable names, secrets | `src/lib/vars/names.ts`, `src/lib/vars/secrets.ts`, `src/templating/lib/secret-scope.ts` |
| Compiling | `src/lib/markdown-compiler.ts` (`CompilationService`) |
| Include resolution | `src/lib/include-resolver.ts` |
| The Liquid engine, tags and filters | `src/templating/init-liquid-engine.ts`, `src/templating/tags/`, `src/templating/filters/`, `src/templating/lib/` (two fixed lists of static imports, with no way for a plugin to add a tag or filter) |
| The one build path | `src/lib/build-service.ts` (`runProjectBuild`, `BuildService`); `src/commands/compile.ts` builds its own `CompilationService` and namespace resolver instead |
| Preparing for a build | `src/lib/build-preparation.ts` |
| Recipe targets | `src/lib/repos/recipe-targets.ts` |
| The state file | `src/lib/state.ts` |
| Prune and clear | `BuildService.prune` in `src/lib/build-service.ts`, `src/commands/clear.ts` |
| Watch | `src/lib/watch-service.ts`, `src/lib/watch-loop.ts`, and watch wiring repeated in `src/commands/build.ts` and `src/commands/compile.ts` |
| The PID file | `src/lib/pid-service.ts` |
| The runtime context file | `generateRuntimeSessionContext` in `src/lib/markdown-compiler.ts` |
| Launch | `src/commands/launch.ts` |
| Releasing, submitting, contributing | `src/lib/repos/release/`, `src/lib/repos/contribute.ts`, and the rules inside `src/commands/repo/release.ts` (`assertFlagsAgree`, `readExistingIndex`) |
| Scaffolding a recipe repository | `src/lib/repos/scaffold/` |
| Scaffolding a project | `src/lib/project-scaffold/` |
| Updating sous | `src/lib/self-update/` (its `managers.ts` holds the npm, pnpm and Yarn logic) |
| The CLI front end | `src/base-command.ts`, `src/config-command.ts`, `src/commands/`, `src/utils/flags.ts`, `src/utils/command-help.ts` |
| `sous --version` | `src/lib/version-report.ts` |
| Views of domain data | `src/lib/repos/catalog-display.ts`, `src/lib/repos/update-plan.ts`, `src/services/ref-resolver/ref-report.ts`, `src/lib/vars/display.ts`, `src/lib/vars/report.ts`, `src/lib/vars/question-plan.ts`, the reporting half of `src/lib/build-preparation.ts`, `colorizeJson` and `renderJson` in `src/lib/config-inspect.ts` |

### Duplicate implementations today

Each is two implementations of one concern (L2). The refactor keeps one.

| Concern | The copies |
| --- | --- |
| `${var}` substitution | `substituteVars` in `src/lib/settings.ts` and in `src/lib/include-resolver.ts` |
| The auto-vars list | `buildAutoVars` in `src/lib/settings.ts`, and a smaller list in `src/lib/config-kernel.mjs` |
| Parsing `.env` files | `parseEnvLocal` in `src/lib/env-local.ts`, `parseEnvFile` in `src/lib/env-file.ts` |
| Running git | `src/lib/repos/providers/git.ts`, `src/lib/repos/git-clone.ts` |
| The project root | the seven places in the table above |
| Assembling what to compile | `runProjectBuild` in `src/lib/build-service.ts`, and the copy in `src/commands/compile.ts` |
| Reading subscriptions | the merged config, and `SubscriptionService` re-reading `conf.d/510-subscriptions.jsonc` (S2, S4) |
| Variable definitions | the definition sources in `src/lib/vars/definition-source.ts`, and the list `SubscriptionService` builds by hand |

## Import Cycles Before the Refactor, and How the Plugins Break Them

Found by building the import graph of every non-test module in `src/`. Three cycles between
features, and several more between a feature and the layer below it. The headings name today's
folders; the "After" text names the plugins.

### vars and refs

Today:

- refs imports vars: `src/services/ref-resolver/lookups/env-var-lookup.ts` imports
  `variableCandidates` from `src/lib/vars/ladder.ts`, `bareName` from `src/lib/vars/names.ts` and the
  `DefinedVariable` type from `src/lib/vars/definition-source.ts`;
  `src/services/ref-resolver/lookups/variable-lookup.ts` imports `DefinedVariable`.
- vars imports refs: `src/lib/vars/ask.ts` (`refKey`, `variableRefOf`) and
  `src/lib/vars/mappings.ts` (`parseNamedRef`, `formatRef` and others).
- The cycle already breaks loading: `src/services/ref-resolver/index.ts` leaves `EnvVarLookup` out of
  its exports, because the ladder reaches config discovery, which reaches back into refs through the
  recipe formats.

After: the two variable lookups are lookups over variables, so they move to `plugin-recipe-answers`
and are added as `ref-lookup` entities. `plugin-refs` knows nothing of variables or answers;
`plugin-recipe-answers` depends on `plugin-refs`, one way.

### vars and repos

Today:

- vars imports repos: `src/lib/vars/definition-source.ts` (`listLockedRecipes`,
  `readProjectLockfile`, `readRecipeManifestIn`, `loadManifestFile`, the manifest schema),
  `src/lib/vars/preanswers.ts` (`loadManifestFile`), `src/lib/vars/mappings.ts`
  (`updateManagedLayer`).
- repos imports vars: `src/lib/repos/catalog-display.ts` (`renderFacts`),
  `src/lib/repos/update-plan.ts` (`formatQuestionPlan`), `src/lib/repos/subscription-service.ts` (the
  whole vars barrel, to ask the new recipes' questions after subscribing).

After:

- Reading manifests moves to `plugin-formats` (`formats.manifests`); managed layers move to
  `plugin-confd` (`confd.managed`). `plugin-recipe-answers` reads active recipes from
  `plugin-recipes`, one way.
- `renderFacts`, `formatQuestionPlan` and the update plan are views; they move to `plugin-cli`.
- Subscribing no longer asks anything itself. The `subscription.add` intent subscribes, then runs
  `vars.ask` and `build` through `ctx.run`. Every front end calls the same intent.

### repos and the compiler

Today:

- repos imports the compiler: `src/lib/repos/recipe-targets.ts` (`CompilationTarget`,
  `inferGlobBase`), `src/lib/repos/recipe-memories.ts` (`inferGlobBase`, `realPathInside`),
  `src/lib/repos/subscription-service.ts` (`resolveOutputPath`, to report what removing a repository
  deletes).
- the compiler imports repos: `src/lib/include-resolver.ts`, `src/lib/markdown-compiler.ts` and
  `src/templating/init-liquid-engine.ts` import the `NamespaceResolver` contract and
  `formatNamespaceProblem` from `src/lib/repos/namespace-resolver.ts`.

After:

- Recipe targets become contributors in `plugin-skills` and `plugin-memories`, which add
  compilation targets to the config.
- `inferGlobBase` and `realPathInside` move to `plugin-host` (`host.globs`).
- `plugin-compiler` declares the `compiler.namespace-resolver` service type and
  `formatNamespaceProblem`, which describes a failed include; `plugin-recipes` registers the
  implementation.
- What removing a repository deletes is read from the compiler's state file, which records every
  file each recipe's outputs wrote, instead of recomputing output paths in `plugin-recipes`.

### refs and repos

Today:

- refs imports repos: `src/services/ref-resolver/container.ts` (`builtInProviders`,
  `MemoriesHashName`), `location.ts` (`repoIdentity`, the providers), `format.ts`,
  `parser/location-splitter.ts`, `pruners/manifest-pruner.ts` (`providerById`), `types.ts`
  (`ProviderId`), `lookups/fetched-index-lookup.ts`.
- repos imports refs from twelve modules, among them `resolver.ts`, `lock-service.ts`,
  `locked-recipes.ts` and `subscription-service.ts`.

After: `plugin-refs` reads the `repository-host` entities, a kind `plugin-recipes` defines;
`ProviderId`, a closed list of three hosts today, becomes an entity's string id. Repository identity
moves into `plugin-refs` with locations. The index lookups move to `plugin-recipes`, added as
`ref-lookup` entities, and `plugin-memories` adds the `#memories` name. `plugin-refs` depends on
neither.

Agent suggestion: reading `repository-host` entities defined by a plugin above it is fine, because an
entity read needs no dependency: if no plugin defines the kind, the list is empty.

### refs, formats and repos

Today:

- `src/lib/repos/formats/recipe-manifest.ts` (`sharedRefResolver`) and
  `src/lib/repos/formats/index-file.ts` (`namespaceOfKey`) import `refs`, while the ref lookups import
  `formats/index-file.ts` and `formats/common.ts`.
- `src/lib/repos/formats/lockfile.ts` imports `repoIdentity` and `requireProvider` from repos, to
  work out a missing identity while parsing.

After: the lookups have moved to `plugin-recipes`, so `plugin-formats` uses `plugin-refs` one way.
Parsing a lockfile never works out an identity; `recipes.lock` does that after parsing, so
`plugin-formats` stays pure.

### config and the features above it

Today the config code imports the features that depend on it:

- `src/lib/config-discovery.ts` imports `src/lib/repos/recipe-config-layers.ts`.
- `src/lib/config-schema.ts` imports `src/lib/repos/recipe-key-matcher.ts` and
  `src/lib/repos/formats/common.ts` and `patterns.ts`.
- `src/lib/settings.ts` imports `src/lib/repos/defaults.ts`, `src/lib/vars/answers.ts`,
  `src/lib/markdown-compiler.ts`, `src/lib/include-resolver.ts` and the ref resolver's `#` names.

After: `plugin-recipes` adds its layers through its own contributors and its keys as `config-key`
entities; `plugin-recipe-answers` adds recipe answers as a `variable-source` entity; compilation,
aliases, tools and watch settings move to their plugins. `plugin-config-files` depends on none of
them.

### The compiler and the build

Today `src/lib/markdown-compiler.ts` imports `StateService`, `hashContent` and `recordDirCreation`
from `src/lib/state.ts`, so the compiler writes the build's state file itself, while `build` imports
the compiler.

After: the compiler owns the state file and every write (ruled 2026-10-29), and the build plugin
only runs intents. Neither imports the other's code.

### Presentation and services

Today services import presentation, and presentation imports services: about twenty modules under
`src/lib/` and `src/services/` import `src/utils/formatting.ts` or `src/utils/prompts.ts`, while
`src/utils/sous-directory.ts` imports `src/lib/sous-home.ts` and `src/utils/command-errors.ts`
imports the error classes.

After: presentation lives only in the front-end plugins. Services report through the chain's
`Reporter` and ask through its `Prompter` (L3). The sous-directory helper moves to `plugin-host`.

### repos and authoring

Today `src/lib/repos/contribute.ts` imports `FORK_REMOTE` from
`src/lib/repos/release/submit-service.ts`, and the `src/lib/repos/index.ts` barrel exports the
recipe-repository scaffold, though nothing outside its own test imports the barrel.

After: contributing moves to `plugin-authoring` (the `repo.contribute` intent), which depends on
`plugin-recipes`. The barrel goes.

## Misfiled Modules

| Module | What it is | Where it goes |
| --- | --- | --- |
| `src/lib/repos/recipe-targets.ts` | turning recipe content into compilation targets | `plugin-skills` and `plugin-memories`, as contributors |
| `src/lib/repos/catalog-display.ts` | a view | `plugin-cli` |
| `src/lib/repos/update-plan.ts` | a view (it says so: "It is pure: it formats what it is handed") | `plugin-cli` |
| `src/services/ref-resolver/ref-report.ts` | a view | `plugin-cli` |
| `src/lib/vars/display.ts`, `report.ts`, `question-plan.ts` | views | `plugin-cli` |
| `src/lib/version-report.ts` | a view | `plugin-cli`, the `version` intent |
| The reporting half of `src/lib/build-preparation.ts` | a view | `plugin-cli`; `build.prepare` reports events |
| `colorizeJson`, `renderJson` in `src/lib/config-inspect.ts` | a view | `plugin-cli` |
| `src/utils/sous-directory.ts` | a file-system service, not presentation | `plugin-host`, `host.directories` |
| `src/lib/repos/managed-layer.ts` | a `conf.d` concern | `plugin-confd`, `confd.managed` |
| `src/lib/repos/providers/index-cache.ts` | the index cache, filed with the providers | `plugin-recipes`, `recipes.index-cache` |
| `src/lib/repos/providers/{github,gitlab,local}.ts` | host-specific code | `plugin-github`, `plugin-gitlab`, `plugin-local` |
| `src/lib/self-update/managers.ts` | package-manager-specific code | `plugin-npm`, `plugin-pnpm`, `plugin-yarn` |
| The GitHub Actions workflow in `src/lib/repos/scaffold/templates.ts` | host-specific | `plugin-github` |
| The `.claude/skills` default in `src/lib/repos/recipe-targets.ts` | tool-specific | `plugin-claude-code`, as a `skill-target` entity |
| The `CLAUDE.md` and `AGENTS.md` pointer files in `src/utils/sous-directory.ts` | tool-specific | `pointer-file` entities, from memory targets |
| The contract half of `src/lib/repos/namespace-resolver.ts` | an interface the compiler consumes | `plugin-compiler`'s types; its test-only `StaticNamespaceResolver` goes to the test helpers |
| `generateRuntimeSessionContext` in `src/lib/markdown-compiler.ts` | a product feature inside the compiler | `plugin-build`, `build.runtime-context` |
| `resolveAliases`, `resolveCompilation`, `resolveTools`, `resolveWatchConfig` in `src/lib/settings.ts` | feature code in the config module | `plugin-compiler`, `plugin-harnesses`, `plugin-build` |
| The domain rules in `src/commands/repo/release.ts`, `repo/link.ts`, `repo/unlink.ts`, `lock/rebuild.ts` | rules living in commands | the `repo.release`, `repo.link`, `repo.unlink` and `lock.rebuild` intents |

## Open Questions

None.

## Changes

None yet.
