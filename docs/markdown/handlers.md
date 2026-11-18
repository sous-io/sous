# Handlers

A handler is a function a recipe or a sous plugin provides for a purpose: checking that the commands a
recipe's scripts call are installed, cleaning up when the recipe is removed, bringing a project in line
after the recipe moves to a new version. Each handler receives sous's tools, reports what it finds, and
never prints; the command you ran prints what it reported.

## The purposes

| Purpose | When it runs | What it is for |
|---|---|---|
| `check` | On subscribing, and on each build | Prerequisites: commands, versions, sign-in. An `error` fails the build before anything is written; a `warn` does not |
| `configure` | While the config is built | Adding config from code, such as declared document edits, without writing a whole plugin |
| `beforeBuild`, `afterBuild` | Around the build | Work that is an action, not a standing state |
| `uninstall` | Before a recipe is removed through sous (`sous subscription remove`) | Undoing what its own code did |
| `migrate` | After the recipe moves to a new version in a project | Bringing the project in line with the new version; it is given `{ from, to }` |

The set is fixed for now. Each purpose takes a list, and the handlers run in a predictable order: a
recipe's in the order its manifest lists them, recipes in the lockfile's order; a plugin's in the order
it registered them, plugins in the order they loaded. Plugins' handlers run before recipes'.

### Where they run in a build

`sous build` runs, in this order: the `check` handlers; the `beforeBuild` handlers; the compiler and its
prune; the declared edits to files sous does not own, with their assertions; the `afterBuild` handlers. A
`check` error stops the build there, before anything in the project is written, and the build ends with exit
code 1, naming each handler that failed. A compile error skips the edits and `afterBuild`.

`sous build --dry-run` runs the `check` handlers, which only report, and no `beforeBuild` or `afterBuild`
handler, which act. Watch mode runs them on every rebuild. `sous prune` runs none. `sous doctor` runs the
`check` handlers too, and reports their errors and warnings without building.

?> To build past failed checks, pass `--ignore-failed-checks` (or `--keep-going`, which also covers
failed assertions). The failures are still printed, as warnings, and the build ends as successful. There is no
setting that makes this permanent.

## In a recipe

A recipe lists its handlers under `handlers` in `sous.recipe.yaml`. Each entry names a file in the recipe
and the function it exports:

```yaml
formatVersion: 1
namespace: voltagrid
name: knowledge-worker
version: 1.0.0

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

A handler file. Each handler is an exported function that receives sous's tools:

```js
/** Reports the commands the knowledge worker needs. */
export async function checkCommands(sous) {
    for (const command of ["git", "jq"]) {
        if (!(await sous.utils.system.isAppAvailable(command))) {
            sous.report.error(`${command} is not installed. The knowledge worker's hooks cannot run without it.`);
        }
    }

    for (const command of ["pandoc", "curl", "jira"]) {
        if (!(await sous.utils.system.isAppAvailable(command))) {
            sous.report.warn(`${command} is not installed. Some knowledge worker scripts will not work.`);
        }
    }
}

/** Warns when the jira command is installed but not signed in. */
export async function checkJiraSignIn(sous) {
    if (!(await sous.utils.system.isAppAvailable("jira"))) {
        return;
    }

    const result = await sous.utils.process.run("jira", ["me"]);

    if (result.exitCode !== 0) {
        sous.report.warn("The jira command is not signed in. Run `jira init`.");
    }
}
```

The rules for a recipe's handlers:

- **Trust.** A handler is code, so it runs only from a repository the project trusts, as a recipe's
  plugin does. Nothing inside a repository runs before it is trusted.
- **One self-contained file each.** sous never runs `npm install` for a recipe, so a handler file cannot
  import packages. Bundle anything it needs into the file.
- **Only subscribed recipes.** A recipe held only through `depends` is a library and contributes no
  handlers.
- **A plugin a recipe ships is covered by the recipe's handlers**, `migrate` included: it changes only when
  the recipe's version does.

### `configure` and `migrate` handlers

A `configure` handler runs while the config is built, as a contributor sous registers on the recipe's
behalf. It receives the config builder as `config`, and what it adds is undone when the recipe stops
listing it:

```js
/** Declares the edits this recipe needs. */
export function declareEdits(sous, { config }) {
    config.atPath("editor.edits").append({
        file: ".claude/settings.json",
        ensureIncludes: { path: "permissions.allow", items: ["Bash(git-commit.sh:*)"] },
    });
}
```

While the config is built there is no finished config yet: `sous.config.get` reads the config built so
far, and `sous.editor.file` is not available (declare the edit instead).

A `migrate` handler runs after the recipe moves to a new version in a project (`sous subscription update`,
a subscription that always pulls, or subscribing again at another version), once the new version's files
are in place. It is given the old and the new version, and is called once per version change:

```js
/** Runs after this recipe moves to a new version in a project. */
export async function migrate(sous, { from, to }) {
    if (from.startsWith("1.") && to.startsWith("2.")) {
        // Bring the project in line with version 2.
    }
}
```

## In a plugin for sous

A plugin registers the same functions inside `register`, with `sous.handlers.add`. Each handler a
plugin registers has an `id`, which names it when sous times it or reports it as slow or failing:

```ts
import { definePlugin } from "@sous-io/plugin-api";

/** Reports the commands the knowledge worker needs. */
async function checkCommands(sous) {
    for (const command of ["git", "jq"]) {
        if (!(await sous.utils.system.isAppAvailable(command))) {
            sous.report.error(`${command} is not installed. The knowledge worker's hooks cannot run without it.`);
        }
    }

    for (const command of ["pandoc", "curl", "jira"]) {
        if (!(await sous.utils.system.isAppAvailable(command))) {
            sous.report.warn(`${command} is not installed. Some knowledge worker scripts will not work.`);
        }
    }
}

/** Removes the per-session files the hooks wrote. */
async function removeSessionFiles(sous) {
    await sous.utils.files.removeMatching("docs/context/.kw-session-*");
}

export default definePlugin({
    name: "sous-plugin-knowledge-worker",
    version: "1.0.0",
    description: "Example: registers handlers for three purposes.",

    register(sous) {
        // The "configure" purpose. This is the call plugins already use.
        sous.config.contribute(editsContributor);

        // The "check" purpose.
        sous.handlers.add("check", {
            id: "knowledge-worker/commands",
            handle: checkCommands,
        });

        // The "uninstall" purpose.
        sous.handlers.add("uninstall", {
            id: "knowledge-worker/session-files",
            handle: removeSessionFiles,
        });
    },
});
```

The handler functions are identical either way: the same function body works whether a manifest points at
it or a plugin registers it. A plugin may also pass `order` (a number, default `500`; lower runs earlier).
A recipe's handlers are named `<namespace>/<recipe>/<purpose>/<function>`, such as
`voltagrid/knowledge-worker/check/checkCommands`.

`uninstall` runs only when the recipe or plugin is removed through sous. Removing a plugin by hand (with
`npm uninstall`, or by deleting a line from the config) is the manual path, and sous does not clean up
after it. Plugins installed from npm get no `migrate` call yet.

## What a handler receives

A handler receives everything a plugin's code receives (every service, the finished config, the
project's folder, the reporter, `run` for starting another intent), plus these helpers:

| Helper | What it does |
|---|---|
| `sous.report.error(...)`, `.warn(...)`, `.info(...)` | Report a result. The command prints it |
| `sous.utils.system.isAppAvailable(name)` | Whether a command is installed: found on `PATH` (with `PATHEXT` on Windows) |
| `sous.utils.system.appVersion(name)` | Its version, from `<name> --version`, when it can be read |
| `sous.utils.process.run(command, args)` | Run a command in the project's folder and get its `exitCode`, `stdout` and `stderr`; a missing command exits 127 |
| `sous.utils.file.exists(path)`, `.read(path)`, `.remove(path)` | Work with ONE file in the project; `read` gives `undefined` for a missing file, `remove` says whether there was one |
| `sous.utils.files.removeMatching(pattern)` | Remove every file matching a glob pattern, dot files included, and get the paths removed |
| `sous.editor.file(path)` | Edit a document directly, with the same operations as a declared edit (needs the editor plugin) |
| `sous.project.root` | The project's folder |
| `sous.config.get(path)` | Read a value from the finished config |
| `sous.vars.get(name)` | Read a recipe variable's answer; a recipe's handler sees it as that recipe does |

Paths are relative to the project's folder. Each answer of `isAppAvailable` and `appVersion` is looked
up once per run, however many handlers ask.

A handler that throws is reported as an error naming it, and the handlers after it still run.
