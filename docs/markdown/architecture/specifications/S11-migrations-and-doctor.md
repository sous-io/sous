# S11: Migrations, `sous doctor`, `sous upgrade` and `sous update`

**Status:** Accepted on 2026-11-18, from the maintainer's rulings quoted below. From now on, a change to this
specification is recorded under "Changes".

**Serves:** G2 (a plugin system: a plugin adds a migration or a check the way it adds anything else), G3
(versatility: every question a migration asks can be answered by a flag), G4 (predictable and observable: one
command reports a project's health, and every command says when migrations are waiting), G6 (testability).

## What This Specifies

1. How sous brings a project's files in line with a newer version of itself (migrations).
2. One command that checks a project's health and puts right what it can (`sous doctor`).
3. The names of the commands that upgrade sous itself (`sous upgrade`) and update a project's recipes
   (`sous update`).
4. Short forms for command groups and common commands, and how a group's alias works.

## Owners

| Concern | Owner |
|---|---|
| Migrations: registering them, deciding what is pending, running them, the notice | `@sous-io/sous-plugin-migrations` |
| The version a project last migrated to, stored in `sous.lock.json` | `@sous-io/plugin-recipes` (`recipes.lock`), the lockfile's owner; the migrations plugin decides what the value means |
| `sous doctor`: the `doctor-check` entity kind, running checks, asking before fixes | `@sous-io/sous-plugin-doctor` |
| Each check | The plugin that owns what it checks; the doctor plugin's own checks read other owners only through their services and intents |
| Upgrading sous itself (`sous upgrade`) | `@sous-io/plugin-update` |
| Updating a project's recipes (`sous update`) | `@sous-io/plugin-recipes` |
| Command words, aliases and help | `@sous-io/plugin-cli` |

## Migrations

### The rule

> "every migration function (`up()` I guess?) is given a version and a 'order', which is a number (higher numbers
> run last, ties use a predictable order, but its arbitrary), default `500`. We store the last version migrations
> were run for. If the current version > last migration version, we know we have migrations to run."
>
>   -- **Luke Chavers** (2026-11-18)

> "I don't think we need a `down()`"
>
>   -- **Luke Chavers** (2026-11-18)

- A plugin adds a migration with `sous.migrations.add({ version, order, up })`. Optional: `id`, `description`,
  and `questions`.
- `version` is the version of sous the migration belongs to. `order` defaults to 500; among migrations of one
  version a higher number runs later; a tie runs in the order the migrations were added (plugin order, then each
  plugin's own order).
- The lockfile's `migratedVersion` records the version of sous whose migrations the project last ran. Every
  migration whose version is above it is pending; with no `migratedVersion` (a lockfile written before migrations
  existed) every migration is pending.
- A project with no lockfile yet has nothing pending, and its first lockfile records the running version: nothing
  an older version wrote is there to migrate. The migrations service also offers `markCurrent()` for a command
  that sets a project up.
- Running them: every pending migration, lowest version first, then by `order`. Afterwards the lockfile records
  the running version, or the highest version among those that ran when that is higher (a migration may name the
  release it ships in before the package's version is raised). Running with nothing pending still records the
  running version, once the project has a lockfile.
- A failed migration stops the run. The lockfile records the highest version every one of whose migrations ran,
  so the failed one and every later one stay pending.
- There is no `down`.

### Questions, and no terminal

Law L4 applies: every question a migration asks can be answered without a prompt.

> Without a terminal and without `--yes`, a migration that needs an answer does NOT run. The command lists what
> is pending and how to answer it. With `--yes`, each question takes its default. A migration whose answer is
> already in the config asks nothing.
>
>   -- The ruling **Luke Chavers** chose (2026-11-18)

- A migration declares its questions: `{ id, message, choices?, default, answered?(ctx) }`. A question with no
  choices is yes-or-no.
- Every answer is worked out before anything runs, in this order: the answer the config already gives
  (`answered`), `--answer <id>=<value>`, the person's answer when there is a terminal, the default under `--yes`.
- When a question has no answer, NO migration runs, not only the one that asked: running the ones around it would
  record a version past it (so it would never run) or run them out of order. The result lists each question and
  the `--answer` that answers it, and the command does not fail.

### When they run

- `sous upgrade`: after the project's install moves to a newer version, the NEW copy runs them (only it has the
  new version's migrations), with `--yes` and every `--answer` passed on, then builds. A downgrade runs none. A new
  copy from before migrations existed has no command for them, which is not a failure.
- `sous doctor` runs any still pending.
- Every other command prints one line when migrations are pending and carries on. It speaks once, for the
  command that was run (never for an intent another runs), through the chain's reporter, which writes messages to
  standard error under `--json`. `doctor`, `upgrade`, the migrations command itself, `help`, `version`,
  `completion` and `mcp` print nothing.

Rejected by Luke: only the upgrade command runs them; the first build with the new version runs them.

### The command

`sous migrations run` (`--yes`, `--answer`, `--dry-run`) is the intent `migrations.run`. It is hidden from help:
people use `sous doctor`, and `sous upgrade` runs it in the new copy.

## `sous doctor`

> "`sous doctor` will also run any migrations that were not executed during an `upgrade` (currently `update`)"
>
>   -- **Luke Chavers** (2026-11-18)

One command: it runs every check, reports what it found, runs pending migrations, and offers to fix each problem
it can, asking before each fix. Rejected by Luke: two commands, one that reports and one that repairs; a small
`sous doctor` limited to migrations and git hooks.

### A check

A plugin adds a `doctor-check` entity:

```ts
interface DoctorCheckEntity {
    id: string;
    order: number;
    description: string;
    check(ctx: Context, run: DoctorRun): DoctorCheckResult | Promise<DoctorCheckResult>;
    fix?(ctx: Context, run: DoctorRun): DoctorFixResult | Promise<DoctorFixResult>;
    confirm?: boolean; // default true; false for a fix that asks its own questions
}
```

A check reports `ok`, `problem`, `warning`, `pending` (waiting on an answer only a person can give) or `skipped`
(it cannot run here, saying why). A finding that can be fixed names the fix in a short imperative phrase. A check
that throws is reported as a problem saying it could not run. Neither a check nor a fix prints or prompts (L3); a
fix that needs answers runs intents, which ask through the chain's prompter.

### The checks, in order

| Order | Check | Owner | Fix |
|---|---|---|---|
| 100 | The config loads | doctor | none |
| 200 | The lockfile agrees with the subscriptions | doctor, through `recipes.lock` and `recipes.resolver` | write the lockfile the subscriptions make, keeping every pin their ranges allow |
| 300 | Required recipe variables have answers | doctor, through `vars.list` | `vars.ask` |
| 400 | Every migration for this version has run | migrations | run them (asks no confirmation of its own) |
| 500 | The git hooks are installed, when the project was set up with them | the git hooks stream | install them |
| 600 | `check` handlers | the handlers stream | none |
| 700 | Assertions, without writing | the editor stream | none |
| 800 | The files sous wrote are present and unchanged | doctor, through `compiler.state` | build |

The numbers are `DOCTOR_CHECK_ORDER`. A check whose owner is not loaded skips itself. When the config does not
load, every check that needs it skips itself; the first check reports the error.

### Flags, exit code, no terminal

- `--dry-run` reports and changes nothing.
- `--yes` applies every fix without asking, and takes every migration question's default.
- `--answer <name>=<value>` answers a migration's question or a recipe variable (one list for both: the entries
  naming a migration's question go to the migrations, the rest to `vars.ask`).
- `--only <id>` runs one check.
- Without a terminal and without `--yes`, no fix runs; each is reported with the flag that applies it.
- It ends with exit code 1 when a `problem` remains. `warning`, `pending` and `skipped` do not change the exit
  code: a migration waiting for an answer is not a failure (Luke rejected failing the command because
  it would break scripts that call `sous doctor`).

## `sous upgrade` and `sous update`

> "rename to `sous upgrade`. `sous update` now becomes the main way to update recipes and the existing commands
> become aliases."
>
>   -- **Luke Chavers** (2026-11-18)

> "no one, except me, has ever run `sous update` (or `sous recipes update`) in the history of the earth"
>
>   -- **Luke Chavers** (2026-11-18)

- `sous upgrade` (intent `upgrade`) moves sous itself to a newer version, with every flag `sous update` had, plus
  `--answer` for the new version's migrations. It always runs in the copy that was invoked.
- `sous update [REF]` (intent `update`) moves the project's pinned recipe versions to the newest their ranges
  allow; `--dry-run` prints the plan. `sous subscription update` and `sous recipe update` are aliases of it, so
  `sous recipe update`, which used to print a plan, now performs the update. The plan is the internal intent
  `recipe.plan-update`.
- There is no deprecation step and no notice.

## Short aliases

| Short form | Stands for |
|---|---|
| `ns` | the `namespace` group |
| `sub` | the `subscription` group |
| `rc` | the `recipe` group |
| `cfg` | the `config` group |
| `ls` | `list`, in every group that has it |
| `rm` | `remove`, in every group that has it |

> "an early objective in the refactor was to allow `sous ns *` to be an alias for `sous namespace *`, but last I
> tried, it did not work. Let's fix that too."
>
>   -- **Luke Chavers** (2026-11-18)

### How a group's alias works

A `cli-group` entity's `aliases` make a whole group answer to another word. Each alias reaches every command in
the group and every alias those commands have inside it (`sous ns ls` is `sous namespace list`). A command never
spells its group's aliases itself. Each command's help lists, under ALIASES, its own aliases and its words with
each group above it spelled by one of the group's aliases; a group's help lists the group's other words.

Why `sous ns list` failed before: the group mechanism existed, but only plurals were ever declared through it, and
each command also spelled its group's plural itself (`["namespaces", "list"]`); `ns` was never declared anywhere.
Sharing a group with its alias copied only the group's canonical commands, so a command's alias inside the group
did not work under the alias, and no help named a group's aliases.

## Adding a namespace to the `sous` object

`sous.migrations` is added by the migrations plugin with `sous.extensions.add(name, factory)`, which gives every
plugin registered afterwards a `sous.<name>` made from that plugin's own `sous` (so what it registers is recorded
as that plugin's). Plugins type it with declaration merging on `SousExtensions`. Two plugins adding one name is
an error naming both.

## Changes

None yet.
