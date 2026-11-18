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
`edits` are added by `plugin-recipes`, each entry carrying the recipe's id as `recipe`. A plugin adds
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
  project is allowed), `recipe` (set by `plugin-recipes`), and the settings `once`, `rollback`,
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
`removeAt`, `appendText`, `prependText`, `increment`, `decrement`, `toggle`) once per declaration,
when the entry is first applied, since repeating it on every build would add the item again each
time.

| Order | Operations |
| --- | --- |
| 0 | `ensureFileExists`, `ensureDirectoryExists` |
| 10 | `ensureObject`, `ensureList`, `wrapInList`, `unwrapList` |
| 20 | `set` (`ifMissing`), `setIfEquals`, `renameKey` |
| 25 | `merge` (`ifMissing`), `replaceWhere`, `updateWhere`, `mergeWhere` |
| 30 | `upsertWhere` |
| 40 | `ensureIncludes` (`position`), `append` (`position`) |
| 50 | `remove` (`values` or `where`), `removeAt`, `removeLine`, `delete`, `deleteIfEquals`, `deleteIfEmpty`, `deleteKeys`, `keepOnlyKeys` |
| 60 | `ensureLine` (`position`), `ensureBlock`, `appendText`, `prependText`, `replaceText`, `replacePattern` |
| 70 | `increment`, `decrement`, `toggle` |
| 80 | `dedupe` (`by`) |
| 90 | `sort` (`by`, `descending`) |
| 95 | `sortKeys` |

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
| `createIfMissing` | `ensureFileExists` |

`position` takes `first`, `last` (or `start`, `end`), an index from 0, `{ after: ... }`,
`{ before: ... }` or `{ line: n }` (from 1). For `ensureIncludes`, `first`, `last` and an index are
states (the items are there, moved if needed); `after` and `before` only place a missing item. For
`ensureLine` every position only places a missing line; an `after` or `before` that is not found
means the end.

Not built yet, from the list Luke accepted: `copy`, `move`, `moveKeyBefore`, `moveKeyAfter`,
`moveKeyFirst`, `moveKeyLast`, `insertBeforeWhere`, `insertAfterWhere`, `moveItem`,
`prependIfMissing`, the comment operations (`setCommentBefore`, `setCommentAfter`,
`removeComment`) and `selectDocument`. The reading operations of the list are the direct path's
document API (`exists`, `get`, `keys`, `length` and the rest on a node).

## Formats

The format comes from the file's name: `.json`, `.jsonc`, `.yaml`/`.yml`, Markdown (`.md`,
`.markdown`, `.mdx`, whose YAML frontmatter is the document and whose body is kept byte for byte),
and anything else as plain text, a list of lines. Edits to JSON and JSONC keep comments, key order,
indentation and line endings. TOML is recognized and skipped with a warning until the document
library edits it. The text operations (`ensureLine`, `removeLine`, `ensureBlock`, `appendText`,
`prependText`, `replaceText`, `replacePattern`) act on the file's whole text when they have no
`path`, and on a string value when they do.

A block Sous keeps in a text file sits between `>>> sous managed: <name> (do not edit between these
markers)` and `<<< sous managed: <name>`, in the file type's comment style (`#`, `//`, `<!-- -->`).

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
recording each one; a rollback removes the recorded levels after the files, deepest first, and only
those that are empty. A folder that was already there is never removed.

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
parameters and what `up` recorded; and the files Sous created. Paths inside the project are
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
- `expect(subject)`: the subject is a value (`settings.at(...)`), a file (`settings`) or a size
  (`settings.byteCount`, `.characterCount`, `.tokenCount`, which are references, not numbers).
  Linking words as in Chai; every assertion ends in a method call; comparisons are spelled
  `lessThan`, `lessThanOrEqualTo`, `greaterThan`, `greaterThanOrEqualTo`; `.orWarn()` and
  `.withMessage(...)` end the chain.
- `settings.silence(path, kinds?)` with `.thisKeyOnly()`, `.belowOnly()`, `.except(kinds)`;
  `editor(config).file(path).withoutAutomaticAssertions()`.

The `editor` service, for direct usage: `open(file)` gives a file with `apply(operation, params)`
(returning the record), `undo(operation, params, record)`, `check(check, arg, options)`, `document`
(the node API, for reading), `text()`, `changed()` and `write()`; `parse(text, format)`,
`formatOf(file)`, `operations()` and `checks()`.

## Open Questions

- The merge of the per-harness config builds must carry entries limited to one harness; the merge
  rule was written for compile outputs, and an edit is not an output.
- Undoing a sort, a deduplication or a key order is not done: an order is not a value.

## Changes

None yet.
