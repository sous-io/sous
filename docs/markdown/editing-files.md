# Editing files Sous does not own

Sous writes the files it owns (compiled skills, agents, the memories file) and overwrites them on every
build. Some files belong to the project or to another tool: Claude Code's `.claude/settings.json`,
`.mcp.json`, `.pre-commit-config.yaml`, `.gitignore`, the frontmatter of an agent file, a file in
your home directory. For those, Sous has **the editor**: you declare an edit, and Sous makes exactly
that change, leaves every other byte of the file alone, remembers what it did, and undoes it when the
edit is no longer declared.

Declared edits live in one config key, `editor.edits`. A recipe declares them in its manifest's
`edits` list, a plugin adds them from its code, and a project can write them in its own config.

## A first edit

```yaml
# .sous/sous.config.yaml
editor:
  edits:
    # The list contains these rules; Sous adds the missing ones.
    - file: .claude/settings.json
      ensureIncludes:
        path: permissions.allow
        items:
          - "Bash(git-commit.sh:*)"
          - "Bash(issues.sh:*)"

    # One value at a path.
    - file: .claude/settings.json
      set:
        path: env.SESSION_HARNESS_MODE
        value: strict

    # A line in a plain text file.
    - file: .gitignore
      ensureLine:
        line: "docs/context/.kw-session-*"
```

In a recipe's `sous.recipe.yaml` the same entries go in a top-level `edits:` list.

Each entry names one `file` (relative to the project root; `~` and `${variables}` work, and a file
outside the project is allowed) and then one or more **operations**. An operation's key always holds
an object with everything it needs, including `path`, the place in the file it acts on. Leave `path`
out, or give `""`, to act on the whole document:

```yaml
- file: words.json
  sort: {}
```

?> There is no short form. `set: "x"` is an error; write `set: { path: ..., value: "x" }`.

### Several operations in one entry

An entry may hold several operation keys. They run in a fixed order, not the order you write them
(a list is sorted after anything is added to it); the order is in the table below. For an exact
order, or one operation more than once, use an `operations` list:

```yaml
- file: .claude/settings.json
  operations:
    - ensureIncludes:
        path: permissions.allow
        items: ["Bash(git-commit.sh:*)"]
    - ensureIncludes:
        path: permissions.deny
        items: ["Bash(rm:*)"]
```

## What Sous does on each build

- **It applies every declared edit**, after compiling and pruning (so a recipe can edit a file the
  compiler writes), and before the recipes' `afterBuild` handlers. If someone changed a value Sous
  sets, Sous puts it back; to keep a different value, declare it in the project's own config, which comes after every
  recipe's and so wins.
- **It undoes an edit that is no longer declared:** the recipe was unsubscribed, the plugin removed, a
  condition stopped matching. A value Sous set goes back to what it was before; an item Sous added to
  a list is removed, and items others added stay. Undoing happens only after a config that loaded
  without errors.
- **A missing file is created** with just the declared content, and removed again (after a backup)
  when nothing declares it any more.
- **A file Sous cannot parse is skipped** with a warning and left exactly as it is.
- **It says what it did only in debug output** (`--log-level debug`). Ordinary builds stay quiet.
- **`sous build --dry-run`** works out every edit and checks every assertion, and writes nothing.
  `sous doctor` checks the assertions the same way.

The record of what Sous applied is `.sous/sous.edits.json`, and backups go to
`.sous/backups/<date>/<time>/<path>`. Both stay out of git.

### Protecting against an unwanted rollback

Every entry takes these settings:

| Setting | Default | What it does |
| --- | --- | --- |
| `once` | off | Applies the entry on the first run only; later changes to the value are kept. |
| `rollback` | on | Undoes the entry when it is no longer declared. Off leaves the result in place. |
| `backupBeforeChange` | off | Copies the file to `.sous/backups/` before Sous changes it. |
| `backupOnRemoval` | on | Copies a file to `.sous/backups/` before a rollback deletes it. |

### Starter files and folders

A recipe can set up files and folders the project then keeps:

```yaml
edits:
  - ensureDirectoryExists:
      paths:
        - docs/context
        - docs/work

  - file: .kw/descriptor.json
    ensureFileExists:
      content:
        $file: starter/descriptor.tpl.json
```

`ensureFileExists` writes the file only when it is missing, so the project's later edits stay. If
the recipe goes away, the file is backed up and removed, and each folder Sous created is removed if it
is empty; a folder that was already there, or that holds anything, stays.

## Operations

Operations that state what must be true change the file only when it is not already true, and are
the ones to reach for. Actions (`append` and the others marked below) always act; Sous runs an
action once, when the entry is first applied.

| Order | Operation | Parameters | Other names |
| --- | --- | --- | --- |
| 0 | `ensureFileExists` | `content` | `createIfMissing` |
| 0 | `ensureDirectoryExists` | `paths` (no `file`) | |
| 10 | `ensureObject`, `ensureList`, `wrapInList`, `unwrapList` | | |
| 20 | `set` | `value`, `ifMissing` | `ensureValue`, `replace`; with `ifMissing: true`: `setIfMissing`, `ensureDefault` |
| 20 | `setIfEquals` | `value`, `equals` | |
| 20 | `renameKey` | `name` | |
| 25 | `merge` | `value`, `ifMissing` | `ensureKeys`, `deepMerge`; with `ifMissing: true`: `mergeIfMissing` |
| 25 | `replaceWhere`, `updateWhere`, `mergeWhere` | `where`, `item` or `value` | |
| 30 | `upsertWhere` | `match`, `item` | `ensureItemWhere` |
| 40 | `ensureIncludes` | `items` (or `item`), `position` | `appendIfMissing`, `union`; `ensureFirst`, `ensureLast`, `ensureAt` (with `index`) |
| 40 | `prependIfMissing` | `items` (or `item`) | |
| 40 | `append` (action) | `item` or `items`, `position` | `prepend`, `insertAt` (with `index`), `insertBefore`, `insertAfter` |
| 50 | `remove` | `values` or `where` | `removeValues`, `ensureExcludes`, `removeValue`; `removeWhere`, `ensureNoItemWhere` |
| 50 | `removeAt` (action) | `index` | |
| 50 | `delete` | | `ensureAbsent` |
| 50 | `deleteIfEquals`, `deleteIfEmpty`, `deleteKeys`, `keepOnlyKeys` | `value`, `keys` | |
| 50 | `removeLine` | `line` | |
| 60 | `ensureLine` | `line`, `position` | |
| 60 | `ensureBlock` | `name`, `content`, `position`, `comment` | |
| 60 | `appendText`, `prependText` (actions) | `value` | |
| 60 | `replaceText`, `replacePattern` | `match`, `value` | |
| 70 | `increment`, `decrement`, `toggle` (actions) | `value` | |
| 80 | `dedupe` | `by` | `ensureUnique`, `dedupeBy` |
| 90 | `sort` | `by`, `descending` | `ensureSorted`, `sortBy` |
| 95 | `sortKeys` | | |
| 95 | `moveKeyBefore`, `moveKeyAfter` | `key`, `anchor` | |
| 95 | `moveKeyFirst`, `moveKeyLast` | `key` | |

Every name in the last column is the same operation with an option set, so these two entries mean
the same thing:

```yaml
- file: .claude/settings.json
  ensureFirst:
    path: permissions.allow
    item: "Bash(git-commit.sh:*)"

- file: .claude/settings.json
  ensureIncludes:
    path: permissions.allow
    items: ["Bash(git-commit.sh:*)"]
    position: first
```

`position` takes `first`, `last`, an index from 0, `{ after: ... }`, `{ before: ... }` or
`{ line: n }` (from 1). For `ensureIncludes`, `first`, `last` and an index mean "the item is there",
moving it if needed. For `ensureLine` a position only says where a missing line goes; a line already
anywhere in the file is left alone, and an `after` or `before` line that is not found means the end.

`prependIfMissing` puts each missing item at the start, in the order given; an item already in the
list stays where it is (`ensureFirst` would move it). The key moves (`moveKeyFirst` and the others)
change nothing when the key or the anchor is missing.

An order is undone like a value: `sort`, `sortKeys` and the key moves record the order the list or
object had before Sous first changed it, and put it back when the entry goes away; an item or key
added since keeps its place. `dedupe` records each item it removed and where, and puts them back.

`ensureBlock` keeps a block between two marker lines, written in the file's comment style (`#`,
`//`, `<!-- -->`, `/* */`, `--` or `;`, from the file's name, or `comment` to choose):

```text
# >>> sous managed: kw (do not edit between these markers)
docs/context/.kw-session-*
# <<< sous managed: kw
```

A block added at the end of a file gets a blank line before it. If a marker line is missing or
appears twice, Sous does not guess where the block ends: it skips the edit with a warning, and the
block's assertion fails.

**Formats:** JSON, JSONC (comments, key order and layout are kept; a `tsconfig*.json` or a `.json`
file in `.vscode/` is read as JSONC), YAML (comments are kept), the YAML frontmatter of a Markdown
file (the body is kept byte for byte), and any other file as plain text lines, each keeping its own
line ending. TOML files are skipped with a warning for now.

## Assertions

An assertion states something that must hold in a file after every edit. It fails the build by
default, so use one where your tool breaks without the value:

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

- `level: warn` prints a warning instead of failing. `sous build --ignore-failed-assertions` (or
  `--keep-going`, which also covers failed checks) lets a build finish in spite of failed
  assertions, still printing each as a warning, and the build ends as successful. There is no
  setting that makes this permanent.
- When an assertion at level error fails, that file is not written; every other file is, and the
  build then ends with exit code 1. Sous shows what changed the value:

```text
Assertion failed in .claude/settings.json at permissions.allow
  voltagrid/session-harness expects it to include "Bash(git-commit.sh:*)".
  The session harness cannot commit without this rule.

  What changed this value, in order:
    1. voltagrid/session-harness   ensureIncludes   ["Bash(git-commit.sh:*)"]
    2. acme/strict-permissions     set              []
```

**Checks:** `equals`, `includes`, `excludes`, `exists`, `first`, `last`, `at`, `itemWhere`,
`noItemWhere`, `unique`, `sorted`, `sortedKeys`, `type`, `matches`, `includesLine`, `includesBlock`,
`lessThan`, `lessThanOrEqualTo`, `greaterThan`, `greaterThanOrEqualTo`, `fileExists`,
`fileDoesNotExist`, `directoryExists`, `directoryDoesNotExist`, `maxBytes`, `minBytes`,
`maxCharacters`, `minCharacters`, `maxTokens`, `minTokens`. `not: true` turns the checks of an
`assert` around. `fileExists: false` and `fileDoesNotExist: true` mean the same.

?> Token counts use the `o200k_base` tokenizer, the one Sous uses for the files it writes, so they are
approximate for any particular model.

### Automatic assertions and conflicts

Every edit also checks, at level warn, that its own result still holds once every edit is made. When
two recipes set different values at one path, the later one wins and the earlier one's check warns,
with the history above. If you wrote your own assertion at a path, Sous adds no automatic one for you
there. To quiet an automatic check that is wrong for your case:

```yaml
edits:
  # On one edit.
  - file: .claude/settings.json
    sort:
      path: permissions.allow
      assertion: none

  # At a path: this key and below (the default), chosen kinds.
  - file: .claude/settings.json
    silence:
      path: permissions
      kinds: [sorted, unique]

  # Every kind except these; scope key-only or below narrows it.
  - file: .claude/settings.json
    silence:
      path: permissions.allow
      except: [includes]
      scope: key-only

  # The whole file.
  - file: .claude/settings.json
    silence: {}
```

You can only silence the automatic checks of your own edits.

## In a plugin

A plugin adds entries from a contributor, on every config build. When the plugin is removed it stops
adding them, and Sous undoes its edits; the plugin needs no uninstall code. Two styles record the same
entries:

```ts
import { definePlugin, type ContributorDefinition } from "@sous-io/sous-plugin-api";
import { editor, expect } from "@sous-io/sous-plugin-editor";

const editsContributor: ContributorDefinition = {
    id: "acme-tools/document-edits",

    contribute(config) {
        // Objects in the manifest's shape.
        config.atPath("editor.edits").appendValue({
            file: "${projectRoot}/.claude/settings.json",
            set: { path: "env.ACME_COMMS_DIR", value: "${projectRoot}/comms" },
        });

        // The chain. A handle on one file: nothing is read or written here.
        const settings = editor(config).file("${projectRoot}/.claude/settings.json");

        settings
            .at("permissions.allow")
            .appendIfMissing("Bash(acme-commit.sh:*)")
            .dedupe()
            .sort();

        expect( settings.at("permissions.allow") ).to.include("Bash(acme-commit.sh:*)");
        expect( settings.byteCount ).to.be.lessThan(100000).orWarn();
    },
};

export default definePlugin({
    name: "sous-plugin-acme-tools",
    version: "1.0.0",

    register(sous) {
        sous.config.contribute(editsContributor);
    },
});
```

!> The chain records edits; it does not make them. The file is read later, after the config is
built, so the chain has no `get` or `exists`, and `settings.byteCount` is a reference to "the byte
count of that file", not a number: `if (settings.byteCount > 100)` does not work. For "only if", use
an operation that carries the condition (`setIfMissing`, `setIfEquals`) or an assertion.

- `editor(config).file(path, { once, rollback, backupBeforeChange, backupOnRemoval })` gives a file;
  `.at(path)` a value in it. Every operation and every other name is a method: its main parameters in
  order, then an options object (`.ensureLine("x", { position: "start" })`).
- `.withoutAssertion()` after an operation drops its automatic check;
  `settings.silence("permissions", ["sorted"])`, with `.thisKeyOnly()`, `.belowOnly()` or
  `.except([...])`, and `settings.withoutAutomaticAssertions()` silence more.
- `expect(...)` takes a value, a file (`expect(oldManifest).to.not.exist()`) or a size
  (`byteCount`, `characterCount`, `tokenCount`). It reads like Chai, with comparisons spelled out
  (`lessThan`, `lessThanOrEqualTo`, `greaterThan`, `greaterThanOrEqualTo`), and every assertion ends
  in a method call: `.to.have.unique.members()`, `.to.be.an("array").that.is.sorted()`,
  `.to.have.first.member(x)`. `.orWarn()` and `.withMessage("...")` go last.

### Editing directly

For work that is an action rather than a standing state, a plugin can use the `editor` service. It
only edits: it keeps no record, so the plugin undoes its own work.

```ts
const file = ctx.services.get("editor").open("${projectRoot}/.claude/settings.json");
const record = file.apply("ensureIncludes", { path: "permissions.allow", items: ["Bash(x:*)"] });

file.document.atPath("permissions.allow").get();   // read anything back
file.write();                                      // writes only when it changed

// Later, to undo it:
file.undo("ensureIncludes", { path: "permissions.allow", items: ["Bash(x:*)"] }, record);
```
