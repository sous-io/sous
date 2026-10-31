# S7: Capabilities

**Status:** Accepted on 2026-10-29. From now on, a
change to this specification is recorded under "Changes".

**Serves:** G2 (a plugin system), G3 (versatility, always), G4 (predictable and
observable), G6 (testability).

## What This Specifies

Every thing the design lets a user or a plugin author do. Each entry is one capability, written so
that a test can check it and the docs can describe it. S1 (the engine), S2 (config building), S5
(config expressions) and S6 (concerns and owners) say how each one works; this specification only
lists them.

The user's standing direction behind most of them:

> "we want versatility... always...."
>
>   -- **Luke Chavers** in an agent session (2026-10-28)

The rules for the list:

1. Every capability has an ID (`C1`), never reused. A dropped capability keeps its ID, marked
   dropped.
2. Every capability has at least one test before the refactor ships as 1.0.0.
3. A new capability the design allows is added here when it is found.

## Plugin Authors: Config

- **C1.** A plugin can change the config through a config contributor, using the builder object to
  set a value, set a default or append to an array.
- **C2.** A contributor can read its own previous patches, and never has to make itself idempotent.
- **C3.** A plugin can declare that it runs before or after other plugins, to save passes.
- **C4.** A plugin can register config keys, each with a schema.
- **C5.** A plugin can add other plugins to the config's plugin list, so a plugin can find and load
  more plugins.
- **C6.** A plugin can add compilation targets, including targets whose source is a template string
  (`content`) instead of a file.
- **C7.** A plugin can build a separate "what if" config, with extra contributors, without changing
  the real one.

## Plugin Authors: Intents

- **C8.** A plugin can add an intent, and the CLI command, its flags and its `--help`, and the MCP
  tool are generated from the intent's input schema.
- **C9.** A plugin can add an internal intent, which other plugins can run but neither the CLI nor
  MCP shows.
- **C10.** An intent's handler can run other intents as it goes (`ctx.run`), and use their results.
- **C11.** A chain can run some of its intents in parallel.
- **C12.** A chain can declare itself parallel, so it runs alongside other parallel chains.
- **C13.** A plugin can add a background intent, such as a server or a file watcher, that submits new
  chains while the process runs.
- **C14.** A background intent can read the latest config and call services directly.
- **C15.** A plugin can wrap another plugin's intent handler, to change what it does.
- **C16.** A plugin can add a front end, with its own reporter and prompter, that submits the same
  intents as the CLI and MCP.

## Plugin Authors: Events

- **C17.** A plugin can fire any event it likes, and any plugin can listen for it.
- **C18.** A listener can subscribe by exact name, by wildcard (`build.*`, `*.before`) or by regular
  expression.
- **C19.** A listener can subscribe once (`sous.once`), and unsubscribe (`sous.off`).
- **C20.** A listener can set a priority, to run before or after other listeners.
- **C21.** A `before` listener can change the intent's input.
- **C22.** An `after` listener can replace the intent's result.
- **C23.** A listener can cancel an intent, or a custom event, with a reason that is reported.
- **C24.** A listener can stop later listeners from seeing an event, while the intent still runs.
- **C25.** A listener can leave data for later listeners and for the `after` event.
- **C26.** An `error` listener can turn a failure into a result.
- **C27.** A listener can run intents, read the config and report progress, as a handler can.
- **C28.** A `config.built` listener can run an intent that changes the config.

## Plugin Authors: Services and Entities

- **C29.** A plugin can add a service with one of three lifetimes: one per process, one per config
  build, or a new one on every get.
- **C30.** A plugin can wrap another plugin's service; wrappers stack.
- **C31.** A plugin can replace another plugin's service.
- **C32.** A plugin can define a kind of entity, with a schema.
- **C33.** A plugin can add entities when it loads, or from a contributor, so the config can create
  entities.
- **C34.** An entity's methods can read the built config when they run.
- **C35.** A plugin can register a name that starts with another plugin's prefix, to extend that
  plugin's area.
- **C36.** A plugin can add Liquid tags and filters, and config expressions can use the filters.

## Plugin Authors: Types and Packaging

- **C37.** A plugin can use another plugin's services, intents, events and entities with full types,
  by importing only its types.
- **C38.** A plugin can declare the plugins it depends on, with version ranges, and sous stops with a
  message naming any that are missing or at the wrong version.
- **C39.** A plugin can be published to npm, or shipped inside a recipe as one bundled file.
- **C40.** A recipe plugin can ship a `.d.ts` file, which sous copies into `.sous/types/` so other
  plugins in the project get its types.

## Plugin Authors: Agent Tools and Content

- **C41.** A plugin can add a harness, with an interactive launch, a headless run and transcript
  reading, each optional.
- **C42.** A plugin can add a skill target, with an optional transform of each file's name or
  contents.
- **C43.** A plugin can add a memory target, with an optional filter of which memories it takes and
  an optional format for the file.
- **C44.** A plugin can name pointer files, which sous writes once each, whichever plugins name them.

## Users

- **C45.** A user can do from the web GUI, the CLI or an agent through MCP anything the other two can
  do.
- **C46.** A user can answer every prompt with a flag or an argument instead (L4, every prompt has a flag).
- **C47.** A user can load plugins the project's `package.json` does not list, and disable any
  plugin, built-ins included.
- **C48.** A user can add functionality, plugins included, through a project-level recipe.
- **C49.** A user can choose which plugin's replacement of a service wins
  (`services.replace."<name>"`), and is warned on every run.
- **C50.** A user can change any time budget, or turn its warning off with `false`.
- **C51.** A user can change any loop-detection limit.
- **C52.** A user can print every timing of a run with `--timings`.
- **C53.** A user can see which contributor changed each config value, in order
  (`sous config show --layers`).
- **C54.** A user can write a config expression at any depth of a config file, including inside
  arrays, with `$if`, `$elseif` and `$else` chains.
- **C55.** A user can switch a value off on some machines and leave it untouched on others, since a
  chain with no match drops the key.
- **C56.** A user can define a tool in the config and launch it with no plugin.
- **C57.** A user can set where skills go (`recipes.skills.outputs`).
- **C58.** A user can stop the compiler from overwriting files it did not write
  (`compilation.overwriteUntracked: false`).
- **C59.** A user can switch any subscription off on one machine, keeping its pins for everyone else.
- **C60.** A user can preview what a recipe update changes before applying it.
- **C61.** A user can choose which messages a run shows with `--log-level <level>` (`debug`, `info`,
  `notice`, `warning`, `error`, `critical`, `alert`, `emergency`), or show everything with
  `--debug`.
- **C62.** A user can see, with `--debug`, every contributor of a finished config stage that would
  have re-run, and what changed.

## Plugin Authors: Added Later

- **C63.** A contributor can declare a config stage, a number, to run after every lower stage has
  finished.
- **C64.** A plugin loaded during a config stage has its declared stages counted from that stage.
- **C65.** A contributor can declare `before` and `after`, naming plugins, contributor ids or
  wildcards, and a plugin can declare them as the default for all its contributors.
- **C66.** A contributor can monitor the whole config, so any change re-runs it and its patch is
  applied again, in its place.
- **C67.** A plugin can report at any of the eight log levels.
- **C68.** An intent can declare its CLI command path, aliases (across groups too), positional
  arguments, examples and whether it is hidden, and, for agents, its tool name, how to use it, when
  not to use it and whether it is hidden.
- **C69.** A plugin can add arguments every CLI command accepts, and help text for a command group.
- **C70.** A contributor that applies data with one merge at the root monitors the whole config
  automatically, and any contributor can declare `monitors` to watch more than it reads.
- **C71.** A plugin's config key can declare its defaults in its schema, filled in when the finished
  config is checked.
- **C72.** A contributor can change the config surgically: inspect, set, delete, rename, merge or
  replace a value; append, prepend, insert, remove, upsert, find, move or de-duplicate array items;
  and merge data at the root.
- **C73.** A plugin can edit any JSON, JSONC or YAML file surgically through the `documents.editor`
  service, with the same operations, keeping comments, key order and formatting.
- **C74.** A plugin's value for a key gives way to the user's files whenever they set that key, with
  no special operation.
- **C75.** A plugin can write its own config-editing helpers, built on the primitive operations.
- **C76.** Any set of config changes serializes to JSON and back, so it can be saved, sent, previewed
  and applied later.
- **C77.** A user can write raw patches in a `.patch.json` file (one patch, or several under a single
  `$patches` key) or a `.patch.jsonl` file (one per line), in `conf.d` or beside `sous.config.*`.
- **C78.** A user can see each helper operation and the primitive operations it made, per
  contributor (`sous config show --layers`).
- **C79.** A contributor can declare an apply order, a whole number from 0 to 99999, so its patch
  applies after every contributor with a lower number and wins over them; a number outside that
  range is refused when the contributor is registered.
- **C80.** A contributor's `before` and `after` win over apply orders that disagree with them: sous
  moves its actual apply order to one past (or one less than) the contributor it must apply after
  (or before), cascading, and logs each move at the `debug` level, naming both contributors and
  both numbers.
- **C81.** A user's `conf.d` files apply in the order of the number their names start with, after
  `sous.config.*` and every plugin.
- **C82.** A user can see each contributor's declared and actual apply order
  (`sous config show --layers`).

## Changes

### 2026-10-30: Apply orders

C79 to C82 added, from Luke's approval of apply orders (S2, config building, "Changes",
2026-10-30). C66 reworded to describe the apply order with "applied", not a stack.
