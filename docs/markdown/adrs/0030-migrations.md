# ADR 0030: Migrations, and `sous doctor`

**Status:** Accepted, 2026-11-18.

The living answer is [S11](../architecture/specifications/S11-migrations-and-doctor.md) and the
[`sous doctor`](../commands.md#sous-doctor) entry in the command reference.

## Context

A newer version of sous can change a default in a way that leaves an existing project wrong. The first case:
the memories file moves out of the project's root `CLAUDE.md`, and a project that upgrades would otherwise
have its instructions written twice.

> "the new defaults will cause existing projects to duplicate instructions. I want to make it so that a user
> upgrading Sous via `sous upgrade` ... when projects upgrade to this new ver, I'd like a migration to offer to
> move their CLAUDE.md output to the new path, or if they'd like to keep output pointed at the root CLAUDE.md."
>
>   -- **Luke Chavers** (2026-11-18)

Sous had no migration system, and no one command that tells a person whether a project is healthy.

## Decision

1. **A migration is a function with a version and an order.** A plugin adds one with
   `sous.migrations.add({ version, order, up })`; `order` defaults to 500, higher runs later, and ties run in
   the order the migrations were added. There is no `down`.

   > "every migration function (`up()` I guess?) is given a version and a 'order', which is a number (higher
   > numbers run last, ties use a predictable order, but its arbitrary), default `500`. We store the last version
   > migrations were run for."
   >
   >   -- **Luke Chavers** (2026-11-18)

2. **The project stores the last version it migrated to**, as `migratedVersion` in `sous.lock.json`, which is
   committed, so a migration runs once for the project and not once per developer. Every migration of a later
   version is pending. A new project's first lockfile records the version that created it.
3. **`sous upgrade` runs them after it installs the new version, `sous doctor` runs any still pending, and every
   other command prints one line saying they are waiting**, then carries on.

   > "`sous doctor` will also run any migrations that were not executed during an `upgrade`"
   >
   >   -- **Luke Chavers** (2026-11-18)

4. **Without a terminal and without `--yes`, a migration that needs an answer does not run**; the command lists
   what is pending and the `--answer` for each question, and does not fail. `--yes` takes each default. A
   question the config already answers is not asked. Because running the migrations around a waiting one would
   record a version past it, nothing runs while one is waiting.
5. **`sous doctor` is one command** that runs every check, reports, runs pending migrations, and offers to fix
   each problem, asking before each fix. `--dry-run` reports only. It exits with 1 when a problem remains; a
   migration waiting for an answer is not one. Any plugin adds a check as a `doctor-check` entity.
6. **A recipe's own migrations are not part of this.** Luke ruled that a recipe's `migrate` handlers run after
   the recipe moves to a new version, given the old and new version; that is the handlers' work, not this one's.

## Rejected

- Only the upgrade command runs migrations: a project upgraded another way (a teammate's install, a dependency
  bot) would never be told.
- The first build with the new version runs them: it would put questions inside `sous build`, which also runs
  from git hooks and scripts.
- A committed list of named migrations instead of one version: the agent recommended it because a single version
  merges badly across branches on different versions of sous; Luke chose the version.
- Taking every default when there is no terminal, and failing the command when there is no terminal.
- Two commands for health (`sous status` reporting, `sous doctor` repairing), and a `sous doctor` limited to
  migrations and git hooks.

## Consequences

- An older sous refuses a lockfile that has `migratedVersion`, as it refuses any key it does not know.
- `sous.extensions.add` lets a plugin add a namespace such as `sous.migrations` to every later plugin's `sous`
  object; other plugin APIs (`sous.handlers`) can use it the same way.
