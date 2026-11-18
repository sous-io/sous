# ADR 0029: Every output file is a config entry, variables can be set by output path, and templates know their output

**Status:** Accepted, 2026-11-18.

The living answers are in [Configuration](../configuration.md#outputs-and-the-files-a-build-writes),
[Variables](../config-variables.md#auto-vars) and, for the design, the compiler section of
[S6, Concerns and Owners](../architecture/specifications/S6-concerns-and-owners.md).

## Context

A compile target in a project's config may name its sources with a glob (`entryGlob`). The config kept that
target as written, and the compiler matched the glob against the disk only when a build ran. So the finished
config said "whatever matches at build time", not which files a build writes: `sous config show` could not
list them, a plugin could not respond to one output file while the config was built, and two targets writing
one file could not be found by reading the config. The skills plugin already worked the other way, listing a
recipe's files while the config was built and adding one target per file. Law L8 ("Declarations as config")
and goal G10 ("Config as desired state") ask for one behavior, the second one.

Each output of a target could carry `_vars`, but only outputs a project wrote by hand. The outputs Sous
generates for a recipe's skills and memories set none, so a template inside a recipe could not tell which tool
it was rendered for. A template knew its source's path (`sousTemplatePath`) but not where its result went.

An output could also carry `_if`, an older mechanism that only tested whether a variable equals a fixed
string, checked at build time against that output's final variables.

Two defects were found while testing a Claude Code plugin shipped in a recipe: content was read and written as
UTF-8 text, so a 33-byte binary file came out as 43 bytes; and a templated script kept its executable bit only
when its name ended in `.sh`.

## Decision

### Glob targets are expanded during config building

> "So issue 2 should include moving the glob expansion out to a contributor, with glob-based variable
> overrides becoming a little added bonus."
>
>   -- **Luke Chavers** in an agent session (2026-11-16)

- A contributor in the compiler's package, `compiler.files`, matches each target's `entryGlob` against the
  disk while the config is built and sets `compilation.files`: one entry per output of each source, with the
  target, the source, the output's index and the destination from before any transform. The compiler
  compiles those entries and no longer matches globs itself. The concern keeps its owner (law L1); only the
  time it happens changes.
- The targets stay in the config as written; `compilation.files` sits beside them and `--layers` names the
  contributor. What listing finds wrong (a variable no one sets, a glob that matches nothing) is kept under
  `compilation.listing` and reported when a build runs, as before, not on every command.
- The contributor runs in config stage 1, after stage 0 has added every target. In stage 0 it ran on every
  pass in which a target changed, and its result made the user's config files run again. A target a later
  stage adds is never listed, and the build reports it.
- In watch mode, a file added to or removed from a glob target's folder rebuilds the config, not only the
  outputs.
- A project with unchanged files and config gets the same outputs. Measured on Sous's own repository
  (78 outputs): the same files, the same bytes, the same state-file entries.

### Variables by output path: `compilation.varOverrides`

> "idk if `outputVars` properly conveys the fact that the setting overrides things."
>
>   -- **Luke Chavers** in an agent session (2026-11-18)

- A second contributor, `compiler.var-overrides`, applies `compilation.varOverrides` to the listed files. A
  rule has `match`, an optional `exclude`, and `_vars`:

  ```js
  compilation: {
      varOverrides: [
          {
              match: "${projectRoot}/.claude/**/*",
              exclude: [
                  "${projectRoot}/.claude/desktop.md",
                  "/\\.local\\./",
              ],
              _vars: { tool: "claude" },
          },
      ],
  },
  ```

- `match` and `exclude` each take one entry or a list; an entry is a glob, or a regular expression when written
  between two slashes, the convention `recipes.memories.first` and `recipes.memories.exclude` already use.
  Luke: "we should also allow one or more `exclude` globs or regexs, perhaps? Just in case the user needs to
  fine tune the application?" The matcher moved from `sous-plugin-memories` to `sous-plugin-host`, so both use one
  implementation.
- A rule WINS over an output's own variables, so a project can change a variable on outputs it did not write,
  such as ones a plugin generated. Luke had called these "variable value overrides" from the start.
- When several rules match one output, the LATER rule wins for a variable both set; variables only one rule
  sets are all kept. The project's own config applies last, so its rules beat a plugin's or a recipe's.
  Rejected: the earlier rule wins; and "the more specific pattern wins", which has no general definition for
  globs and regular expressions.
- A rule matches the path Sous planned to write, not a path a transform changed it to: Sous decides a file's
  variables before rendering it, and a transform runs after. Luke accepted this as a documented limit ("yes").
- The rule's variables are set on the file's entry (`compilation.files[n]._vars`), which `sous config show`
  displays; the compiler lays them over the output's scope.

### `_if` on an output is removed

> "I'm definitely wanting to drop that `_if` logic in favor of conditionals"
>
>   -- **Luke Chavers** in an agent session (2026-11-18)

A config expression (`$if` on the output's entry) replaces it. The one thing `_if` could test that an
expression cannot is a variable written on the same output, a value the author wrote one line above. A config
that still uses `_if` is refused, naming the output and showing the `$if` to write:

```text
compilation.targets[0].outputs[0]._if: '_if' was removed; a config expression on the output
  replaces it. Write the output as { "$if": { "expr": "stage == 'prod'", "then":
  {"destinationFile":"out/a.md"} } }.
```

Converting existing configs is a job for the migration system; a config written as code cannot be edited by
Sous, so for `sous.config.js` the realistic result is this error with its replacement.

### What a template can read

- `sousOutputPath` and `sousOutputDir`: the file the output is written to and its directory, from before any
  transform. A file included into another sees the output it is included into.
- `host.platform`, the value config expressions read (Luke: "of course"). A templated hook file can then
  choose the full path to Git Bash on Windows, where plain `bash` starts WSL.
- `harness.id`: an output may carry `harness: "<id>"`, and a template rendered for it reads that id; for an
  output with no harness it is the empty string. Rejected: only conditions can read the harness, which would
  make an author ship two files to change a sentence per tool.

### Files reach the project byte for byte

A file that is not a template and includes nothing is copied as bytes, so a binary file is not corrupted. An
executable source gives an executable output, templated or not.

## Consequences

- `sous config show` lists every file a build writes; a project with a thousand matched files has a thousand
  entries.
- Config building reads the disk for each glob target, on every command. Both contributors are timed (law L5).
  Measured with the code before and after, alternating, six rounds each: on Sous's own repository the config
  build went from a median of about 189 ms to about 227 ms (the listing itself about 30 ms, most of it building
  one variable scope per recipe); on a project with 1000 files under one glob, from about 49 ms to about
  106 ms (matching the glob about 18 ms, which a build paid before at compile time; building the entries
  about 13 ms; checking the larger config about 10 ms).
- A plugin that adds a compile target in a config stage after 1 gets no files for it, and the build says so.
- A project variable named `host` or `harness` wins over the objects Sous gives templates, so a template
  written before them keeps working; such a template cannot read `host.platform` until the variable is renamed.
