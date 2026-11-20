# S9: The Editor

**Status:** Accepted on 2026-11-18, from rulings Luke made on 2026-11-17 and 2026-11-18; built the
same day. From now on, a change to this specification is recorded under "Changes".

**Serves:** G10 (config as desired state), G3 (versatility, always), G4 (predictable and
observable), G2 (a plugin system).

**Related:** S1 (the engine: plugins, intents, services, entities), S2 (config building), S6
(concerns and owners).

## What This Specifies

Sous writes the files it owns through the compiler: it overwrites them and deletes one that nothing
produces any more. Many files a recipe or a plugin needs to change are not Sous's: Claude Code's
`.claude/settings.json`, `.mcp.json`, `.pre-commit-config.yaml`, `.gitignore`, the frontmatter of an
agent file, a file in the person's home directory. Sous must change only the values it was told to
change, leave every other byte, record what it did, and undo it when it is no longer wanted.

> "something we've known we've needed to do for a long time is to teach [Sous] how to surgically
> alter JSON/YAML/and maybe TOML files, and maybe others."
>
>   -- **Luke Chavers** in an agent session (2026-11-17)

**A surgical edit** changes only the values Sous was told to change, in a file Sous does not own,
and leaves every other byte of the file as it was.

The editor is one built-in plugin, `@sous-io/sous-plugin-editor`. It owns:

| Concern | Owner | Kind |
| --- | --- | --- |
| The master list of edits | the `editor` config key (`editor.edits`, `editor.historyFile`) | `config-key` entity |
| Applying the list, undoing what is no longer declared, checking assertions | `editor.apply` | intent, internal |
| Editing one file directly (open, apply, read, write) | `editor` | service, config |
| The record of what was applied, for undoing | `.sous/sous.edits.json` | file, git-ignored |
| Backups before a change or a removal | `.sous/backups/<date-time>/<path>` | files, git-ignored |

The compiler and the editor are two concerns (L1): the compiler writes files Sous owns, and the
editor edits files the project or another tool owns. Within a build the compiler runs first and the
editor second, because a recipe may edit a file the compiler writes.

## Two Usages

- **Declarative.** An edit is stated as data in `editor.edits`, and Sous carries it out, records it
  and undoes it. A recipe can only use this one, since a recipe has no code. Plugins use it in almost
  every case (the hybrid path below).
- **Direct.** Code calls the `editor` service. It is for work that is an action, not a standing
  state. The plugin is then responsible for undoing what it did:

  > "for direct usages, the implementers are responsible for undoing anything they've done, using
  > the 'bad-ass' service we provide"
  >
  >   -- **Luke Chavers** in an agent session (2026-11-17)

## The Master List (L8)

Everything that declares an edit becomes an entry in `editor.edits`, added by a contributor during
config building; `editor.apply` reads only the finished config (L8, G10). A recipe's manifest
`edits` are added by `sous-plugin-recipes`, each entry carrying the recipe's id as `recipe`. A plugin adds
its own. A project writes them in its config files.

> "Given that our separate plugin is declarative and has a state, then a plugin can just write to
> its declarative config. If the plugin is removed, then it would no longer write to the config,
> and the declarative processor would know to undo the operations that no longer exist in the
> stack."
>
>   -- **Luke Chavers** in an agent session (2026-11-17)

So one undo covers every way an edit can stop being wanted: a plugin is removed, a recipe is
unsubscribed, a setting changes, a harness goes away, a condition flips.

### The shape of an entry

ONE form. An operation's key holds an object, and everything the operation needs is inside it,
including `path`. There is no short form, and no entry-level `path`.

```yaml
edits:
  - file: .claude/settings.json
    set:
      path: env.SESSION_HARNESS_MODE
      value: strict
    ensureIncludes:
      path: permissions.allow
      items:
        - "Bash(git-commit.sh:*)"
    sort:
      path: permissions.allow

  - file: .gitignore
    ensureLine:
      line: "docs/context/.kw-session-*"
      position:
        after: "# session files"

  # An exact order, or one operation more than once.
  - file: .claude/settings.json
    operations:
      - ensureIncludes:
          path: permissions.allow
          items: ["Bash(git-commit.sh:*)"]
      - ensureIncludes:
          path: permissions.deny
          items: ["Bash(rm:*)"]
```

> "It's just getting confusing. I'm all for versatility, but having too many forms will confuse
> people, especially when some forms only work for certain cases. I'm now leaning toward banning the
> short form, entirely."
>
>   -- **Luke Chavers** in an agent session (2026-11-17)

- On the entry: `file` (relative to the project root; `~` and `${var}` allowed; a file outside the
  project is allowed), `recipe` (set by `sous-plugin-recipes`), and the settings `once`, `rollback`,
  `backupBeforeChange`, `backupOnRemoval`.
- Then one or more operation keys, OR an `operations` list (not both), and optionally `assert` and
  `silence`.
- `path` left out, or `""`, is the root of the document.
- Several operation keys run in the order their definitions give, never the order written, because
  an object does not keep its key order. `sort` comes after every operation that adds.
- `ensureDirectoryExists` takes no `file` and goes in an entry of its own.
- Every entry names its operation; there is no default operation.
- An entry is checked when the config is built, by the same code that applies it, so a misspelt
  operation, a missing parameter or an unknown check is a `ConfigError`.

### Identity

There is no `id` on an entry. Its identity is who declared it plus what it says.

> "The only thing I don't like is that `id`. Its utility value is obvious, but we should try to find
> a way to generate them automatically."
>
>   -- **Luke Chavers** in an agent session (2026-11-17)

- **Who declared it:** the `recipe` on the entry; otherwise the plugin whose contributor added it,
  found by replaying every contributor's primitive patches to `editor.edits` in the order they
  applied; the project's config files are named `project`.
- **What it says:** the file (relative to the project root when inside it), and each operation's
  canonical name and parameters. The same entry declared twice by one declarer is told apart by its
  occurrence.
- A changed value is one entry disappearing and another appearing: both happen in the same pass
  over the file, which is written once.

## Operations

Each operation is defined ONCE, with its parameters, an `order`, `up`, `down`, and the automatic
assertion that goes with it. The manifest form, the object style and the chain are all made from
that one definition, and every shorthand or alias is a name for one of them with options set.

- **`up`** makes the operation true and returns a record of what it changed. It is given the record
  of an earlier run, so the record keeps what was there before Sous first acted.
- **`down`** undoes it from that record. A rollback restores the stored previous value; for a list
  it removes only the items Sous added, so items someone else added stay.

> "when the editor 'rolls back' (for whatever reason), it will roll back to what it stored as the
> previous value. Again, we're not going to over-complicate this."
>
>   -- **Luke Chavers** in an agent session (2026-11-17)

Two groups: operations that state what must be true change the file only when it is not already
true (the common ones); actions always act. Sous runs an action (`append`, `prepend`, `insertAt`,
`insertBeforeWhere`, `insertAfterWhere`, `removeAt`, `appendText`, `prependText`, `increment`, `decrement`, `toggle`) once per declaration,
when the entry is first applied, since repeating it on every build would add the item again each
time.

| Order | Operations |
| --- | --- |
| 0 | `ensureFileExists`, `ensureDirectoryExists` |
| 10 | `ensureObject`, `ensureList`, `wrapInList`, `unwrapList` |
| 20 | `set` (`ifMissing`), `setIfEquals`, `renameKey`, `copy` (`ifMissing`), `move` (`ifMissing`) |
| 25 | `merge` (`ifMissing`), `replaceWhere`, `updateWhere`, `mergeWhere` |
| 30 | `upsertWhere` |
| 40 | `ensureIncludes` (`position`), `prependIfMissing`, `append` (`position`), `insertBeforeWhere`, `insertAfterWhere` |
| 50 | `remove` (`values` or `where`), `removeAt`, `removeLine`, `delete`, `deleteIfEquals`, `deleteIfEmpty`, `deleteKeys`, `keepOnlyKeys` |
| 60 | `ensureLine` (`position`), `ensureBlock`, `appendText`, `prependText`, `replaceText`, `replacePattern` |
| 70 | `increment`, `decrement`, `toggle` |
| 80 | `dedupe` (`by`) |
| 90 | `sort` (`by`, `descending`) |
| 95 | `sortKeys`, `moveKeyBefore`, `moveKeyAfter`, `moveKeyFirst`, `moveKeyLast`, `moveItem` (`item` or `where`, `position`) |
| 100 | `setCommentBefore` (`text`), `setCommentAfter` (`text`), `removeComment` (`before`, `after`) |

Shorthands and aliases, each a name for the operation shown:

| Name | Means |
| --- | --- |
| `ensureValue`, `replace` | `set` |
| `setIfMissing`, `ensureDefault` | `set` with `ifMissing: true` |
| `ensureAbsent` | `delete` |
| `ensureKeys`, `deepMerge` | `merge` |
| `mergeIfMissing` | `merge` with `ifMissing: true` |
| `ensureFirst`, `ensureLast` | `ensureIncludes` with `position: first` or `last` |
| `ensureAt` | `ensureIncludes` with `position: <index>` |
| `appendIfMissing`, `union` | `ensureIncludes` |
| `prepend` | `append` with `position: first` |
| `insertAt` | `append` with `position: <index>` |
| `insertBefore`, `insertAfter` | `append` with `position: { before: ... }` or `{ after: ... }` |
| `ensureItemWhere` | `upsertWhere` |
| `removeValues`, `ensureExcludes`, `removeValue` | `remove` with `values` |
| `removeWhere`, `ensureNoItemWhere` | `remove` with `where` |
| `ensureUnique`, `dedupeBy` | `dedupe` |
| `ensureSorted`, `sortBy` | `sort` |
| `moveItemWhere` | `moveItem` with `where` |
| `createIfMissing` | `ensureFileExists` |

`position` takes `first`, `last` (or `start`, `end`), an index from 0, `{ after: ... }`,
`{ before: ... }` or `{ line: n }` (from 1). For `ensureIncludes`, `first`, `last` and an index are
states (the items are there, moved if needed); `after` and `before` only place a missing item. For
`ensureLine` every position only places a missing line; an `after` or `before` that is not found
means the end.

`prependIfMissing` puts each missing item at the start, in the order given, and leaves an item
already there where it is (unlike `ensureFirst`, which moves it). The four key moves change nothing
when the key or the anchor is missing, and have no automatic assertion.

An order is recorded like a value. `sort` records the list as it was before Sous first sorted it;
`sortKeys` and the key moves record the object's key order. `down` puts that order back: the items
or keys that were there take the places they hold now, in their recorded order, and one added since
keeps its place. `dedupe` records each item it removed with its index, and `down` puts them back.

`copy` makes the value at `to` a copy of the value at `path`, read from the file on each build: a
value already at `to` is recorded and replaced (put back by `down`), nothing happens while `path`
is missing, and `ifMissing: true` fills only a missing `to`. `to` may not overlap `path`, and a `to`
naming a list item replaces an item that is there (one past the end is skipped with a warning).
It has no automatic assertion: the value is only known from the file, and a missing `path` is not
an error.

`move` takes the value at `path` (which must end in a key) to `to`. Within one object it is the
library's rename, keeping the key's place, text and comments, and `down` renames it back. To
another object it is a delete and an insert of the key's own text (its comment lines above and the
comment on its line included) under its new name, last in that object, at its indentation; `down`
puts the key back at `path` from its recorded entry, in its old place and with its old text, and
restores what `to` held. A value already at `to` is
replaced unless `ifMissing: true`. Nothing happens while `path` is missing. Its automatic assertion
is that `path` does not exist (none with `ifMissing`, where the source may stay).

`insertBeforeWhere` and `insertAfterWhere` are actions: they add `items` (or `item`) just before or
after the first item matching `where`, even when an equal item is there, and at the end when no item
matches (as `insertBefore` and `ensureLine` do with an anchor that is not found). A missing list is
created; `down` removes each item added (at the index it was added at, or else the last equal one)
and a list `up` created. The automatic assertion is that the list includes each item.

`moveItem` puts the item equal to `item`, or the first matching `where`, at `position`: `first`,
`last`, an index (counted in the list without the item), `{ before: item }`, `{ after: item }`,
`{ beforeWhere: {...} }` or `{ afterWhere: {...} }`. It moves through the library's `move`, so the
item keeps its text, its comment lines above and the comment on its line. Nothing happens when the item, or the item to put
it beside, is not found (as with the key moves), or when it is already in place. Unlike the key
moves it is undone: `up` records where the item was, and `down` moves it back. It has no automatic
assertion, since an item that is not in the list is not an error.

**Comments.** A comment belongs to a key or a list item: the comment lines directly above it (at its
indentation, no blank line between) and the comment ending its line. `setCommentBefore` and
`setCommentAfter` replace it or add one (`text` is the words, without the marker; a comment after
is one line); `removeComment` removes the one `before: true` or `after: true` names, or both. `up`
records the comment's exact bytes and `down` puts them back, so an undo is byte for byte. JSONC,
YAML and Markdown frontmatter have comments; on plain JSON, and on a value sharing its line with
others, the edit is skipped with a warning. They imply no automatic assertion: no check reads a
comment, and a check that cannot fail would say nothing. They run last (order 100), after every
operation that adds or moves keys.

**`selectDocument`: one document of a YAML file holding several.** It is not an operation key of
its own: it is the `document` parameter every operation that acts inside a document takes,
beside `path`, and the chain's `selectDocument(index)`, which writes `document` on every operation
recorded through it.

```yaml
- file: deploy/web.yaml
  set:
    document: 1        # from 0
    path: spec.replicas
    value: 3
```

Why a parameter and not an operation that selects for the others: what an operation needs is
inside its object, including where it acts (`path`), and an entry-level default was rejected
(above); an operation that only selected would change nothing itself, so it would have no `up`
and `down` of its own, and its effect on the others would depend on order, which breaks the undo
(run in reverse, the others would undo before the selection). As a parameter, `document` is kept
in the history with each operation, so the undo acts on the same document. Every other document,
and every `---` line, stays byte for byte. A file with one document is document 0; an index past
the last document skips the edit with a warning; an operation without `document` on a file holding
several skips the file, as any file Sous cannot parse. An operation with `document` gets no
automatic assertion (an assertion reads the whole file, which such a file is not as one value), and
the text operations take `document` only with a `path`.

Every operation of the list Luke accepted is built. The reading operations of the list are the direct path's
document API (`exists`, `get`, `keys`, `length` and the rest on a node).

## Formats

The format comes from the file's name, through `@sous-io/sous-lib-documents` (`formatForPath`): `.json`
(`.jsonc` by convention for `tsconfig*.json`, `.vscode/*.json` and the like), `.jsonc`,
`.yaml`/`.yml`, Markdown (`.md`, `.markdown`, `.mdx`, whose YAML frontmatter is the document and
whose body is kept byte for byte), and anything else as plain text, a list of lines. The editor
is a thin layer over that library: it parses, edits and writes every format, and a plain text
file's lines keep their own line endings. Edits to JSON and JSONC keep comments, key order,
indentation and line endings, and an object or list written beside one-line neighbours (in a
one-line container, in place of a one-line value, or in a list beside a one-line item) goes on one
line. In YAML a string keeps the quoting or block style its author chose, but not one its old value
only needed (`">> x"` must be quoted), and a text of several lines is written as a block. A key or
item that is deleted or moves takes its own lines, the comment lines directly above it and the
comment at the end of its line; blank lines stay between the same places and never move with it.
A key put back by an undo goes back after the key that was before it, with its old text. TOML is recognized and skipped with a warning until the document
library edits it. The text operations (`ensureLine`, `removeLine`, `ensureBlock`, `appendText`,
`prependText`, `replaceText`, `replacePattern`) act on the file's whole text when they have no
`path`, and on a string value when they do.

A block Sous keeps in a text file sits between `>>> sous managed: <name> (do not edit between these
markers)` and `<<< sous managed: <name>`, in the file type's comment style (`#`, `//`, `<!-- -->`,
`/* */`, `--`, `;`), written by the library's `managedBlockMarkers`. A block added at the end of a
file is separated from the line before it by a blank line. A block whose markers are damaged (one
without the other, or either twice) is never guessed at: the edit is skipped with a warning, and its
assertion fails.

## Applying the List

`editor.apply` takes `dryRun` and `ignoreFailedAssertions`. For each file named by a declared entry
or by the history, in one pass:

1. **Undo** the entries in the history that are no longer declared, last applied first, each
   operation's `down` in reverse. This happens only after a config build that succeeded, and only
   when every entry of the list could be read; otherwise an entry that failed to load would look the
   same as one that was removed. `rollback: false` skips it and drops the record.
2. **Apply** every declared entry in config order, so a later entry wins. An entry with `once`, and
   an action, applied before are not applied again.
3. **Remove** a file Sous created (it was missing) when no declared entry names it any more and
   every undone entry has rollback on; it is copied to the backups first unless
   `backupOnRemoval: false`.
4. **Check** the assertions on the file as it is about to be written.
5. **Write** the file once, when it changed, unless an assertion at level error failed and was not
   ignored. A `backupBeforeChange` entry copies the file first.

Folders come first and last: `ensureDirectoryExists` creates each missing level before the files,
recording each one, and a file Sous creates gets its missing parent folders created the same way,
recorded with the file. A rollback removes the recorded levels after the files (a file's levels
when the file itself is removed), deepest first, and only those that are empty and that no declared
`ensureDirectoryExists` entry still wants. A folder that was already there is never removed.

> "if the directory was already there, the rollback should not delete it (this aligns with other
> things we've already discussed). If the directory is not-empty, then it should not be deleted."
>
>   -- **Luke Chavers** in an agent session (2026-11-17)

### The entry settings (rollback protection)

| Setting | Default | What it does |
| --- | --- | --- |
| `once` | off | Applies the entry on the first run only. |
| `rollback` | on | Undoes the entry when it is no longer declared. |
| `backupBeforeChange` | off | Copies the file before Sous alters it. |
| `backupOnRemoval` | on | Copies a file before a rollback deletes it. |

> "The main thing we should worry about is Sous screwing up and a 'rollback' occuring
> unintentionally. Our main goal should be preventing this, but we should assume that it will
> happen, given how complex everything is."
>
>   -- **Luke Chavers** in an agent session (2026-11-17)

### Edits do not fail; assertions fail

> "edits dont fail, assertions fail"
>
>   -- **Luke Chavers** in an agent session (2026-11-17)

- A missing file is created with just the declared content; its rollback removes it.
- A file that cannot be parsed is skipped with a warning and left exactly as it is; none of its
  edits are made, its history is kept to try again, and every assertion on it fails.
- An operation that cannot be made (a list operation on a value that is not a list) is skipped with
  a warning; its assertion then fails.
- While an entry is declared, Sous applies it on every build, putting back a value someone changed.
  What Sous did is said only in debug output; there is no notice on ordinary builds (L6: Sous
  reports, and lets it happen).
- A file outside the project is edited like any other, and each project keeps its own record of its
  edits to it. Projects do not coordinate: a project whose edit found the value already there
  records nothing to undo.

### The history

`.sous/sous.edits.json` (or `editor.historyFile`), git-ignored: for each applied entry its identity,
declarer, file, `rollback` and `backupOnRemoval`, and for each operation its canonical name, its
parameters and what `up` recorded; the files Sous created; and, for each created file, the parent
folders Sous created to hold it (`createdFolders`; a history written without it records none). Paths inside the project are
relative to its root. Backups go to `.sous/backups/<YYYY-MM-DD>/<HHMM-SS>/<path from the project
root>`, as the compiler's do (files outside the project under `outside-project/`).

## Assertions

An assertion is data, like an edit, and belongs to whoever declared it. It runs after every edit to
a file has been worked out, on the document as it is about to be written.

```yaml
edits:
  - file: .claude/settings.json
    assert:
      path: permissions.allow
      includes: "Bash(git-commit.sh:*)"
      message: The session harness cannot commit without this rule.

  - file: AGENTS.override.md
    assert:
      maxBytes: 32768
      level: warn
      message: Codex cuts project instructions off at 32 KiB.
```

- **Levels:** `error` (the default) fails the build and that file is not written; `warn` prints a
  warning. The flag `--ignore-failed-assertions` (input `ignoreFailedAssertions`) prints a failure as
  a warning and the build ends as successful; there is no config setting for it.
- **Checks:** `equals`, `includes`, `excludes`, `exists`, `first`, `last`, `at`, `itemWhere`,
  `noItemWhere`, `unique`, `sorted`, `sortedKeys`, `type`, `matches`, `includesLine`,
  `includesBlock`, `lessThan`, `lessThanOrEqualTo`, `greaterThan`, `greaterThanOrEqualTo`,
  `fileExists`, `fileDoesNotExist`, `directoryExists`, `directoryDoesNotExist`, `maxBytes`,
  `minBytes`, `maxCharacters`, `minCharacters`, `maxTokens`, `minTokens`. One `assert` object may
  hold several checks; `not: true` turns them around; a check whose argument is `true` or `false`
  is turned around by `false`. `fileExists: false` and `fileDoesNotExist: true` mean the same.
- **Sizes:** bytes (what Codex limits), characters (what Claude Code limits) and tokens, counted with
  `o200k_base`, the tokenizer the compiler uses, so a token count is approximate for any one model.
- **The failure** shows the history of the value: the edits of this build that touched the path, in
  order, with who declared each.

```text
Assertion failed in .claude/settings.json at permissions.allow
  voltagrid/session-harness expects it to include "Bash(git-commit.sh:*)".
  The session harness cannot commit without this rule.

  What changed this value, in order:
    1. voltagrid/session-harness   append   "Bash(git-commit.sh:*)"
    2. acme/strict-permissions     set      []
```

### Automatic assertions are the conflict detector

Each edit implies an assertion that its result still holds after all edits (`set` that the path
equals the value, `ensureIncludes` that the list includes each item, `sort` that the list is sorted,
and so on), at level warn. Two declarers that set different values at one path: the later wins, and
the earlier one's automatic assertion fails with the history above. Sous does not compare pairs of
operations.

> "Given a+b, perhaps our conflict detector should just auto-create `warn` assertions. The hard part
> is ensuring it doesnt create assertions that the author has also created."
>
>   -- **Luke Chavers** in an agent session (2026-11-17)

- **No duplicates:** where a declarer wrote any assertion of its own on a file and path, Sous adds
  no automatic assertion for that declarer there.
- **Silencing,** narrowest first: `assertion: none` inside one operation's object; the author's own
  assertion at that path; `silence` with `path`, `kinds` or `except` (not both) and `scope`
  (`key-and-below`, the default, `key-only`, `below`); `silence: {}` for the whole file. A declarer
  silences only its own automatic assertions. A silenced assertion is listed in `editor.apply`'s
  result as silenced, and the entry that silenced it is in the config.
- An entry with `once` has no automatic assertions: a person's later change is what `once` allows.

## For Plugins

Two styles, which record the same entries and can be mixed. Neither reads a file: the file is read
later, when the editor applies the list.

```ts
import { editor, expect } from "@sous-io/sous-plugin-editor";

contribute(config) {
    // Style 1: objects that mirror the manifest.
    config.atPath("editor.edits").appendValue({
        file: "${projectRoot}/.claude/settings.json",
        set: { path: "env.ACME_COMMS_DIR", value: "${projectRoot}/comms" },
    });

    // Style 2: the chain.
    const settings = editor(config).file("${projectRoot}/.claude/settings.json");

    settings.at("permissions.allow").appendIfMissing("Bash(acme-commit.sh:*)").dedupe().sort();

    expect( settings.at("permissions.allow") ).to.include("Bash(acme-commit.sh:*)");
    expect( settings.byteCount ).to.be.lessThan(100000).orWarn().withMessage("The settings file is large.");
}
```

- `editor(config).file(path, settings?)` gives a file handle; `.at(path)` a value in it. Every
  operation, alias and shorthand is a method; positional arguments are the operation's main
  parameters, then an options object. `.withoutAssertion()` drops the automatic assertion of the
  operation just recorded.
- `editor(config).directory(path)` gives a folder handle, which only `expect` takes.
- `expect(subject)`: the subject is a value (`settings.at(...)`), a file (`settings`), a size
  (`settings.byteCount`, `.characterCount`, `.tokenCount`, which are references, not numbers) or a
  folder. Linking words as in Chai; every assertion ends in a method call; comparisons are spelled
  `lessThan`, `lessThanOrEqualTo`, `greaterThan`, `greaterThanOrEqualTo`; `.orWarn()` and
  `.withMessage(...)` end the chain. `.to.includeBlock(name, content?)` records `includesBlock`
  (`.to.not.includeBlock(name)` its negation); on a folder, `.to.exist()` records
  `directoryExists` and `.to.not.exist()` `directoryDoesNotExist`, and no other check is taken.
- `settings.silence(path, kinds?)` with `.thisKeyOnly()`, `.belowOnly()`, `.except(kinds)`;
  `editor(config).file(path).withoutAutomaticAssertions()`.

The `editor` service, for direct usage: `open(file)` gives a file with `apply(operation, params)`
(returning the record), `undo(operation, params, record)`, `check(check, arg, options)`, `document`
(the node API, for reading), `text()`, `changed()` and `write()`; `parse(text, format)`,
`formatOf(file)`, `operations()` and `checks()`.

## Open Questions

- The merge of the per-harness config builds must carry entries limited to one harness; the merge
  rule was written for compile outputs, and an edit is not an output.

## Changes

### 2026-11-18: A deleted key goes back in its place; comments move with their keys

Three defects this specification listed as open are fixed, under Luke's rulings that every edit is
surgical, every operation defines `down`, and undoing an edit restores what was there before:

- `delete`, `ensureAbsent`, `deleteIfEquals`, `deleteIfEmpty`, `deleteKeys` and `keepOnlyKeys`
  record each removed key's entry: its exact text (the comment lines directly above it and the
  comment on its line included), the key before it, its index, and how many blank or comment lines
  lay between it and its neighbour. Undoing puts the key back after that key (at its index when that
  key is gone), between the same lines, without rewriting the keys after it, so it comes back byte
  for byte. It no longer comes back at the end of its object.
- A key or list item that is deleted or moves takes its comment lines above with it, as well as the
  comment on its line: `sort`, `sortBy`, `sortKeys`, `moveKeyBefore`, `moveKeyAfter`,
  `moveKeyFirst`, `moveKeyLast` and `moveItem` swap whole entries in place, and `move` to another
  object writes the key from its own text under its new name, at that object's indentation.
- `set` and its relatives record an object's or list's text when they replace it, and undoing
  writes it back as it was: `unwrapList` undone puts a one-line JSONC list back on one line.

Blank lines belong to the places between entries, never to an entry: they do not move when a key
or item moves, so sorting keys separated by a blank line keeps the blank line where it was (a key
can end up on its other side), and sorting back restores the text exactly; a deleted key leaves the
blank lines around it and goes back between them. Records written before this change still undo,
the old way. The document library gained the means (S2, "The Document-Editing Package"). The 13
coverage cases that were marked as known defects now pass as ordinary tests. The agent's work; the
blank-line rule is the agent's choice, not yet reviewed by Luke.

### 2026-11-18: `includeBlock` and folders in `expect`

The `expect` chain had no method for three data checks. Luke chose the names:
`expect( textFile ).to.includeBlock("name")` (and `.to.not.includeBlock`) records `includesBlock`,
with the block's content as an optional second argument; `editor(config).directory(path)` is a new
entry point beside `file(path)`, and `expect( editor(config).directory(path) ).to.exist()` and
`.to.not.exist()` record `directoryExists` and `directoryDoesNotExist`. They take `.orWarn()` and
`.withMessage()` like the others; any other check on a folder is refused when it is written.

### 2026-11-18: The editor is a thin layer over the document library

The editor first carried its own plain text and frontmatter documents and its own block markers,
because `@sous-io/sous-lib-documents` had none. The library now has them (`parseLines`, the `markdown`
format, `managedBlockMarkers`, `commentStyleForPath`), so the editor uses them and its copies are
gone. What changed for a person: each line of a plain text file keeps its own line ending; a block
added at the end of a file gets a blank line before it, as `sous init`'s blocks do; and a damaged
block is skipped instead of a second one being added. The operations the library made cheap were
built: `prependIfMissing`, `moveKeyBefore`, `moveKeyAfter`, `moveKeyFirst` and `moveKeyLast`.
`sortKeys` now moves each key with its own lines and the comment at their end (a comment on a line
of its own stayed where it was; since fixed, see "A deleted key goes back in its place"). The
agent's work while joining the merged pieces;
not yet reviewed by Luke.

### 2026-11-18: The history and backups are ignored in a project set up before the editor

`sous init` writes `sous.edits.json` and `backups/` into `.sous/.gitignore`'s managed block, but a
project set up before the editor existed has neither line. The first `editor.apply` that writes
(not a dry run, in a project that declares an edit or has a history) adds both to the block through
`host.gitignore`. A history file configured outside `.sous/` is the project's to ignore. The
agent's choice; not yet reviewed by Luke.

### 2026-11-18: `sous doctor` checks the assertions

The editor adds the `doctor-check` `assertions` (order 700): `editor.apply`'s dry run, with nothing
printed, then a failed assertion at level error is a problem and one at level warn a warning. It has
no fix. The agent's choice of form; the check itself is the one S11 lists.

### 2026-11-18: No history file until there is something to record

`editor.apply` wrote an empty `sous.edits.json` after every build, even in a project that never
declared an edit, and such a project's `.sous/.gitignore` does not list it, so the file showed up as
new in git (found on Sous's own repository). The history is now written only when it records an
entry or a created file, or when the file already exists. The agent's fix, in the finishing pass.

### 2026-11-18: The operations that relocate values

From the list Luke accepted, built in `operations-relocate.ts` and registered with the others:
`copy` (`to`, `ifMissing`), `move` (`to`, `ifMissing`), the actions `insertBeforeWhere` and
`insertAfterWhere` (`where`, `item` or `items`), and `moveItem` (`item` or `where`, `position`;
`moveItemWhere` is the shorthand with `where`). `copy` and `move` replace a value already at `to`
by default, like `set`, and `ifMissing: true` keeps it, like `set`'s option. A `move` within one
object is a rename, which keeps the key's text and comments; a move to another object cannot keep a
comment on the key's own line, since the library reuses a key's old text only in its own object.
`move` refuses a `path` that is a list item: on the next build the index names the next item, so
the move would repeat on a different item. The inserts follow `insertBefore` when nothing matches
(the end) and `append` when the item is already there (added again, once per declaration).
`moveItem` follows the key moves when the item or its anchor is missing (nothing happens), but is
undone, as `ensureIncludes` undoes the moves it makes. So that a moved JSONC item keeps the comment
on its line (`"b", // bee`), the document library now carries that comment with an item or key it
removes and writes back. The agent's choices; not yet reviewed by Luke.

### 2026-11-18: The comment operations and `selectDocument`

Built from the list Luke accepted: `setCommentBefore`, `setCommentAfter` and `removeComment`, on
the document library's new comment editing, and `selectDocument`, on its new YAML stream. The
choices are the agent's, not yet reviewed by Luke: the parameter names (`text`; `before` and
`after` as switches); no automatic assertion for a comment; order 100; and `selectDocument` as a
`document` parameter on every operation plus a chain method, rather than an operation key of its
own (reasons under Operations). Not done: assertions cannot target one document of such a file,
and no operation adds a new document to it.

### 2026-11-18: An order is undone

`sort`, `dedupe`, `sortKeys` and the key moves were not undone ("an order is not a value"), against
spec 12's rule that every operation defines `down` and undo restores what was there. Recording the
order is cheap: the list as it was (or the key names), kept in the history like any previous value.
So `sort` records the list before Sous first sorted it, the key operations record the key order,
and `dedupe` records each item it removed with its index; `down` puts them back, and an item or key
added since keeps its place. `sort` now moves items with the library's `sort`, so each keeps its
own text. Found by running every operation through `editor.apply`; the agent's fix.

### 2026-11-18: `replacePattern` is undone

`replacePattern` had no `down`. A regular expression's replacement cannot be worked backwards, so
it now records the text before its last replacement and the text it left, and `down` puts the
first back only while the text is still the second: a change someone made since is never undone
with it. Found by running every operation through `editor.apply`; the agent's fix.

### 2026-11-18: Every operation and check runs through `editor.apply` in a test

Every operation and every other name is now applied by `editor.apply` to real JSONC, YAML and text
files, applied again, and undeclared, with the exact text checked each time; every check holds and
fails at level error and at level warn; silencing and the `expect` forms run the same way. What
those tests found was fixed where it was cheap: `removeLine` undone into an emptied text, or one
with CRLF line breaks, now puts back exactly the text there was; a YAML string no longer keeps a
quoting or block style its old value only needed; a JSONC object among one-line neighbours is
written on one line; and orders and `replacePattern` are undone (above). What was not fixed is in
Open Questions. The agent's work.

### 2026-11-20: A rolled-back file takes the folders Sous created for it (gh-270)

A file Sous created was written with every missing parent folder created on the way, and none of
those folders was recorded, so rolling the file back left them behind, empty: a `set` that created
`.claude/settings.json` left an empty `.claude/`. The editor now creates a new file's parent folders
level by level, records the levels it created under the file in the history's `createdFolders`, and
removes them with the file, under the rule for folders above. The agent's fix of the reported bug.
