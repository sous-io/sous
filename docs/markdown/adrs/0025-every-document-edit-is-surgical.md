# ADR 0025: Every document edit is surgical, and Markdown frontmatter and plain text files are documents

**Status:** Accepted, 2026-11-18.

The living answer is the section "The Document-Editing Package" of specification
[S2](../architecture/specifications/S2-config-building.md), and the README of the package
`packages/sous-lib-documents`.

## Context

Sous is to edit files it does not own: `.claude/settings.json` and `settings.local.json`, `.mcp.json`,
VS Code's settings, CI files such as `.github/workflows/*.yml`, `.pre-commit-config.yaml`, the
frontmatter of agent and skill files (an agent's `model`), and `.gitignore`. People and other programs
write those files too. A whole-file rewrite would undo their formatting, and a committed file should
show only the line that changed.

The agreed meaning of a surgical edit: it changes only the values it was told to change, and leaves
every other byte of the file as it was.

`@sous-io/sous-lib-documents` already edited JSON and JSONC that way. YAML was not surgical: after any edit the
`yaml` package reprinted the whole document, so comments survived but spacing and layout could change.
There was no way to edit a Markdown file's frontmatter, or a plain text file such as `.gitignore`
beyond the one block `host.gitignore` keeps.

The agent had recommended leaving surgical YAML and frontmatter to separate issues outside this work.
Luke ruled otherwise:

> "yes, all document edits should be surgical."

> "Front matter in markdown files should be supported."

TOML stays out: "add toml as its own issue, keep it out of this work." A plugin adding its own format:
"Yes, but not now."

## Decision

- **YAML is edited in its text.** The `yaml` package's parse says where each node is; the edit is made
  there, and every line it does not touch stays byte for byte: comments, key order, indentation,
  quoting style, blank lines, block and flow style, line endings. A new value is written like the value
  it replaces; new keys and items take their neighbors' indentation.
- **Every YAML edit is checked.** The edited text is parsed again and must read back as the value asked
  for. When an edit cannot be made in place (a key written with `?`, a list item whose value starts on
  the line below its dash), the document is reprinted whole, as before, comments kept, and
  `doc.reprinted()` says so. An edit to a value a YAML anchor (`&name`) shares with its aliases
  (`*name`) is refused with an error, because it would change every copy.
- **A Markdown file's frontmatter is a document**, format `markdown`. Edits change only the block
  between the `---` lines at the top; the body is never changed. A file with none gets one when a value
  is set, and an edit that empties it removes the block.

  ```ts
  const agent = parseDocument("---\nmodel: sonnet\n---\n# Reviewer\n", "markdown");

  agent.atPath("model").set("opus");   // "---\nmodel: opus\n---\n# Reviewer\n"
  ```

- **A plain text file is a list of lines**, format `lines`: test for a line, add one at the end, the
  start, after or before a line, or at a line number, remove one, and keep a named block between the
  marker lines `>>> sous managed: <name> (do not edit between these markers)` and
  `<<< sous managed: <name>`, written in the file type's comment style. An opening marker with no
  closing marker is an error, never a guess.

  ```gitignore
  # >>> sous managed: session-files (do not edit between these markers)
  docs/context/.kw-session-*
  # <<< sous managed: session-files
  ```

- **One function chooses the format from a path**, `formatForPath`, so another package can ask which
  format a file is. It returns nothing for TOML.
- **The library offers primitives, not policies.** It gains structural comparison, adding a list item
  only when it is missing, sorting, and moving keys. The operations that state what must be true
  (`ensureIncludes`, `ensureLine`, `ensureBlock` and the rest), the record of what was done, undoing it
  and assertions belong to the editor plugin, which composes them from these.

## Consequences

- A YAML file Sous edits, `sous config set` included, now changes only in the lines the edit names.
- A YAML edit to an anchored value used to succeed and silently change every alias; it is now an
  error naming the path.
- A YAML file whose lists sit at a depth the `yaml` package cannot write (dashes in line with their key
  while maps are indented 4) gets new lists at the nearest depth it can.
- TOML, and a plugin adding a format, remain to be done.
