# ADR 0026: Declared edits to files Sous does not own

**Status:** Accepted, 2026-11-18, from Luke's rulings of 2026-11-17 and 2026-11-18. The living
answer is [S9, the editor](../architecture/specifications/S9-the-editor.md) and the user page
[Editing files Sous does not own](../editing-files.md).

## Context

A recipe or a plugin often needs a change in a file Sous does not own: a permission rule in
`.claude/settings.json`, a hook in `.pre-commit-config.yaml`, a line in `.gitignore`, a starter file
or folder the project then keeps. Sous could only write files it owns, through the compiler, which
overwrites them and deletes one nothing produces any more. Writing the whole of someone else's file
would delete what others put there; unsubscribing must remove exactly what the recipe added.

> "something we've known we've needed to do for a long time is to teach [Sous] how to surgically
> alter JSON/YAML/and maybe TOML files, and maybe others."
>
>   -- **Luke Chavers** in an agent session (2026-11-17)

## Decision

- **One built-in plugin, `@sous-io/sous-plugin-editor`, carries out edits declared as config.** Its
  master list is `editor.edits`, filled by contributors as the compiler's `compilation.targets` is:
  a recipe's manifest `edits` through `sous-plugin-recipes`, a plugin's own, the project's. Its internal
  intent `editor.apply` runs after the compiler in a build. A separate `editor` service serves
  direct usage, where the plugin undoes its own work.

  > "basically build a master 'do these edits' config for a fundamental plugin that actually does
  > the work... just like we do with the compiler."
  >
  >   -- **Luke Chavers** in an agent session (2026-11-17)

- **One entry shape, no short form.** An operation's key holds an object with everything it needs,
  including `path`; several keys run in a defined `order`; an `operations` list gives an exact order.
- **No `id`.** An entry's identity is who declared it plus what it says. An entry no longer declared
  is undone; a changed value is the old one undone and the new one applied in one pass.
- **A small core of operations with options, and every other name a shorthand or alias**
  (`ensureFirst` is `ensureIncludes` with `position: first`). Each is defined once, with `up`,
  `down` and its automatic assertion, and the manifest form, the object style and the chain are made
  from that one definition.
- **"Ensure" operations are the common case.** `append` always adds; `ensureIncludes` adds only what
  is missing.

  > "Declaring 'what must be done' should be rare. Telling the system 'do this if' (e.g. 'ensure',
  > etc) would be the more common play."
  >
  >   -- **Luke Chavers** in an agent session (2026-11-17)

- **Sous owns what it declares, without ceremony.** While an entry is declared, Sous applies it on
  every build and says so only in debug output; a rollback restores the stored previous value (for
  a list, removes only what Sous added).
- **Edits don't fail; assertions fail.** A missing file is created; an unparseable one is skipped with
  a warning; a file outside the project is edited like any other, and each project keeps its own
  record.
- **Rollback protection** on every entry: `once` (off), `rollback` (on), `backupBeforeChange` (off),
  `backupOnRemoval` (on). Files are undone before folders, deepest folder first; a folder is removed
  only if Sous created it and it is empty. Backups go to `.sous/backups/<date-time>/<path>`; the
  history to `.sous/sous.edits.json`; both are git-ignored.
- **The compiler is no longer the only built-in that writes.** S6's ruling "among the built-in
  plugins, only the compiler writes build outputs" changes:

  > "I don't recall deciding that the compiler should be the _only_ thing that outputs, forever."
  >
  >   -- **Luke Chavers** in an agent session (2026-11-17)

## Rejected

- A content kind (`document-modification`) whose file is combined into the target: two paths to the
  same thing. Edits live only in `edits`; a file is only a place a value can come from (`$file`).
- Composing a whole `.claude/settings.json` from recipe fragments.
- A short form of any kind, an entry-level `path`, applying operation keys in the order written.
- Failing the build on an unparseable file; a notice every time Sous puts a value back; undoing an
  edit only when the value is still what Sous set.
- One record per machine shared by all projects.

## Consequences

- A recipe with no code can change any JSON, JSONC, YAML, Markdown frontmatter or text file, and
  unsubscribing undoes it.
- A plugin needs no uninstall function and no storage of its own for declared edits.
- TOML is recognized and skipped until the document library edits it in place.
