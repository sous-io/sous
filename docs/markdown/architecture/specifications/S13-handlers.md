# S13: Handlers

**Status:** Accepted on 2026-11-18. From now on, a change to this specification is recorded under
"Changes".

**Serves:** G2 (a plugin system), G3 (versatility, always), G4 (predictable and observable), G10
(config as desired state).

## What This Specifies

A handler is a function a recipe or a plugin provides for a purpose. A recipe's manifest points at
exported functions in its own files; a plugin passes the function itself. Each handler receives every
tool sous can give it, reports what it finds, and never prints.

> "I think we can do better. We allow manifests to point to exported functions for different purposes.
> purpose+file+handler ... those handlers get access to every Sous tool we can provide, including tools
> that check for commands in the path. Most or all 'purposes' should be able to point to multiple
> handlers that run in a predictable order."
>
>   -- **Luke Chavers** in an agent session (2026-11-17)

It is owned by one built-in plugin, `@sous-io/sous-plugin-handlers` (L1). It started as a need to name
the commands a recipe depends on (`git`, `jq`, `pandoc`) and say which are missing; a `check` handler
answers it.

## The Purposes

The set is fixed for now ("thats fine, we can add more later if we need to", Luke, 2026-11-17).

| Purpose | When it runs | What it is for |
|---|---|---|
| `check` | On subscribing, and on each build | Prerequisites. `error` fails the build before anything is written; `warn` does not |
| `configure` | During config building | Adding config from code (the hybrid path of declared document edits) |
| `beforeBuild`, `afterBuild` | Around the build | Work that is an action, not a standing state |
| `uninstall` | Before a recipe is removed through sous | Undoing what its own code did |
| `migrate` | After a recipe moves to a new version in a project | Bringing the project in line; given `{ from, to }` |

`migrate` was added on 2026-11-18 as the way recipes take part in migrations:

> "actually, we wont attach plugin and recipe functions to the sous migration. Instead, we'll run it
> after a new version of the recipe is installed."
>
>   -- **Luke Chavers** in an agent session (2026-11-18)

On `check` errors:

> "error fails by default, but users can push through it if they dare."
>
>   -- **Luke Chavers** in an agent session (2026-11-17)

## In a Recipe's Manifest

`handlers` is a top-level key: a map from purpose to a list of `{ file, handler }`, in run order. An
unknown purpose is an error in the manifest.

```yaml
handlers:
  check:
    - file: handlers/prerequisites.js
      handler: checkCommands
    - file: handlers/prerequisites.js
      handler: checkJiraSignIn

  configure:
    - file: handlers/edits.js
      handler: declareEdits

  uninstall:
    - file: handlers/cleanup.js
      handler: removeSessionFiles
```

```js
/** Reports the commands the knowledge worker needs. */
export async function checkCommands(sous) {
    for (const command of ["git", "jq"]) {
        if (!(await sous.utils.system.isAppAvailable(command))) {
            sous.report.error(`${command} is not installed. The knowledge worker's hooks cannot run without it.`);
        }
    }
}
```

Following L8, the manifest becomes config before anything acts on it:

1. The contributor `handlers/recipe-declarations` adds one entry to `recipes.handlers` for each handler
   an active recipe lists: `{ recipe, purpose, file, handler }`. Only a recipe held through `subscribes`
   adds entries (one held only through `depends` is a library), and only from a repository the project
   trusts and has switched on.
2. The contributor `handlers/recipes` responds to `recipes.handlers` by adding a `handler` entity for each
   entry, after checking the file stays inside the recipe (the same check a recipe's plugin bundle
   gets). Its id is `<namespace>/<recipe>/<purpose>/<function>`; a repeat gets `#2`, `#3`. An entry
   repeated exactly (two contributors declaring one manifest) is one handler.
3. The entity's function imports the file the first time a handler from it runs, and calls the named
   export. A missing file or export fails that handler with a message naming the recipe.

Nothing inside a repository runs before it is trusted:

> "The rule is: we never execute anything inside of a repo until we trust it."
>
>   -- **Luke Chavers** in an agent session (2026-10-25)

Each file is one self-contained JavaScript file, since sous never runs `npm install` for a recipe. A
plugin a recipe ships is covered by the recipe's handlers, `migrate` included.

## In a Plugin

> "Sous Plugins should be able to register handlers, too. It should function about the same, but should
> use an API more appropriate for plugins."
>
>   -- **Luke Chavers** in an agent session (2026-11-17)

```ts
register(sous) {
    sous.handlers.add("check", {
        id: "knowledge-worker/commands",
        handle: checkCommands,
    });
}
```

`sous.handlers.add(purpose, { id, handle, order? })` is part of the plugin API (`@sous-io/plugin-api`). It
adds a `handler` entity of the registering plugin, `{ id, purpose, handle, order? }`; the kind is
defined by `sous-plugin-handlers`. The handler's types (`HandlerTools`, the second argument of each
purpose) reach plugin authors through `SousHandlerTypes`, which `sous-plugin-handlers` fills in by
declaration merging, as `SousServices` is filled in.

A plugin's form of `configure` is `sous.config.contribute`, as before; `sous.handlers.add("configure", ...)`
also works and runs with the recipes' `configure` handlers.

## What a Handler Receives

Decided 2026-11-18 (option 1): the full context a plugin receives, plus these helpers.

| Helper | What it does |
|---|---|
| `sous.report.error(...)`, `.warn(...)`, `.info(...)` | Report a result. The command prints it |
| `sous.utils.system.isAppAvailable(name)` | Whether a command is on `PATH` (with `PATHEXT` on Windows) |
| `sous.utils.system.appVersion(name)` | The first version number `<name> --version` prints, when it can be read |
| `sous.utils.process.run(command, args)` | Runs a command in the project's folder; its exit code and output |
| `sous.utils.file.exists(path)`, `.read(path)`, `.remove(path)` | ONE file in the project |
| `sous.utils.files.removeMatching(pattern)` | Removes every file matching a glob |
| `sous.editor.file(path)` | Edits a document directly, through the `editor` service |
| `sous.project.root` | The project's folder |
| `sous.config.get(path)` | A value from the finished config |
| `sous.vars.get(name)` | A recipe variable's answer, as the handler's recipe sees it |

> "`sous.utils.file.` ... not `files` unless it accepts `path[]`."
>
>   -- **Luke Chavers** in an agent session (2026-11-18)

- Finding a command is `host.processes.which` (L1). The service `handlers.system` (a singleton, so one
  per run) keeps each answer of `isAppAvailable` and `appVersion`, so a command is looked up once per run.
- Running a command is `host.processes.run`; a missing command exits 127. Globs are `host.globs`.
- `sous.editor.file` uses the `editor` service of `sous-plugin-editor` when it is registered, and throws
  an error naming that plugin when it is not.
- `sous.vars.get` reads `recipe-answers.answers`: a recipe's handler gets `forRecipe(<its recipe>)`, a
  plugin's the merged answers.
- The helpers are laid over the chain's context; the context's own members (`run`, `services`,
  `reporter`, `entities`, the finished `config`) are unchanged.

A `configure` handler runs while the config is built, so it receives the helpers alone and, as its second
argument, `{ config }`: the builder. `sous.config.get` reads the config built so far, services are those
the engine can give during a build (`handlers.system` and `host.*` are singletons), and `sous.editor.file`
throws, telling the author to declare the edit.

A handler never prints (L3). What it reports is collected, returned in the run's result, and handed to
the chain's reporter, the front end's: `error` at `error`, `warn` at `warning`, `info` at `info`, each
with `{ handler: <id> }` as details. A handler that throws counts as one `error`, naming it, and the
handlers after it still run.

## Order

Within a purpose: plugins' handlers first, in the order the plugins loaded and then the order each
registered them; then recipes', in the lockfile's order and then each manifest's order. `order` (default
`500`) then moves a handler: lower runs earlier, ties keep that order. Plugins before recipes is the
agent's choice: Luke ruled the order within each, not between them.

## Running

Every call is timed (L5): a handler is an entity method, so the engine times it as
`entity.method:handler:<id>.handle`, named by the handler's id.

One internal intent per purpose runs its handlers: `handlers.check`, `handlers.beforeBuild`,
`handlers.afterBuild`, `handlers.uninstall` (input `{ recipes?, ignoreFailedChecks? }`) and
`handlers.migrate` (input `{ recipe, from, to }`). `configure` has no intent: it cannot run outside a
config build, so it runs in the contributor `handlers/configure`, which applies after
`handlers/recipes`. Each returns:

```ts
interface HandlerRunResult {
    purpose: HandlerPurpose;
    ran: Array<{ id: string; plugin: string; recipe?: string; reports: HandlerReportEntry[]; threw?: string }>;
    errors: number;
    warnings: number;
    ignoredErrors: number;
    failed: boolean;   // an error was reported and not ignored
}
```

`handlers.check` ends with exit code 1 when it failed. With `ignoreFailedChecks`, every error is shown as a
warning saying it was ignored, and nothing fails.

The `build` intent calls the purposes in this order: `check`; `beforeBuild`; the compiler; `editor.apply`;
`afterBuild`. A failed `check` stops the build before anything is written:

```ts
import { checksFailedError, runHandlerPurpose } from "@sous-io/sous-plugin-handlers";

const checks = await runHandlerPurpose(ctx, "check", { ignoreFailedChecks: input.ignoreFailedChecks });

if (checks.failed) {
    throw checksFailedError(checks);
}
```

### `check` on subscribing

`sous subscription add` runs a build, whose checks cover the new recipes. With `--no-build` there is no
build, so the recipes the lockfile gained or moved run their `check` handlers on their own, once the
subscription is written. A failed check there is reported; the subscription stays.

### `migrate`

Every lockfile write fires `recipes.locked` with what changed. A pin that moved (`sous subscription
update`, `alwaysPull` in a build, subscribing again at another version) is remembered in memory for the
run, keeping the first `from` if it moves twice and forgetting it if it moves back. A version pinned for
one holder alone is not a move: the project never sees it. After each config build (`config.built`), each
remembered recipe that is active at its new version (its files fetched) runs `handlers.migrate` once, in
the lockfile's order, and is forgotten. Nothing is stored: the lockfile holds the versions.

> "we wont store history. Plugins can use their persistence mechanism to store it themselves."
>
>   -- **Luke Chavers** in an agent session (2026-11-18)

Plugins installed from npm get no `migrate` call: their version changes when the package manager installs
a new one, which sous does not see.

### `uninstall`

During `sous subscription remove` (not a dry run), when the lockfile write that drops a recipe fires
`recipes.locked`, `handlers.uninstall` runs for each removed recipe, once. This is after the pin is gone
and before the config is rebuilt without the recipe: its files are still in the store, its outputs still
in the project, and its handlers still in the chain's config. An uninstall handler that fails is
reported; the removal stands. A recipe or plugin removed by hand gets no call:

> "If someone wants to take a manual path, then they need to take the manual path, entirely."
>
>   -- **Luke Chavers** in an agent session (2026-11-17)

## Changes

### 2026-11-18: Written

The specification of the handlers, from the working spec Luke settled on 2026-11-17
and widened with `migrate` on 2026-11-18. Approved by Luke in those sessions; the details he left open
(the order between plugins and recipes, `order`'s default, the ids of a recipe's handlers, when `migrate`
and `uninstall` run within a command) are the agent's and are marked as such above.
