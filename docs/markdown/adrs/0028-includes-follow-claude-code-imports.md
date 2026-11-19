# ADR 0028: Includes follow Claude Code's imports

**Status:** Accepted, 2026-11-18.

This record changes the include rules in [ADR 0024](0024-init-imports-agent-files.md): an include
that matches nothing no longer stops a build. The rest of that record stands. The living answer is
[S10: Includes](../architecture/specifications/S10-includes.md) and the
[include syntax](../configuration.md#include-syntax) in the configuration reference.

## Context

Sous took an include only from a line holding nothing but `@path`, at the first column, ending in
`.md`. Claude Code imports an `@path` anywhere in Markdown text, for about a hundred file types. Every
other `@path` passed through Sous untouched, and Claude Code then imported it from the compiled
file's folder, not the folder the author wrote it against. Tests on 2026-11-17 confirmed it: a compiled
memories file made Claude Code load nine extra files.

Luke's direction:

> "Basically, no _real_ imports should make it through to Claude. Sous basically replaces Claude's
> import/include mechanism. Ideally, users would escape `@scope/package` in the same way they would
> if they were giving it to Claude."

> "we want to behave as closely as we can to Claude Code's native behavior (but with our
> intentionally added behaviors). We should also allow imports mid-file. We should allow every
> mechanism for escape that CC allows."

## Decision

- An `@path` is found anywhere in a line of Markdown text with Claude Code's own rule, and every
  escape Claude Code honours is honoured: code spans, fenced and indented code, HTML blocks and
  comments, frontmatter at the top, link destinations, image text, and an `@` that does not follow
  whitespace or the start of a text.
- The same file types are accepted as Claude Code accepts, compared in lower case, and files with no
  extension.
- Sous's own forms (globs, `@~namespace/...`, `@#name/...`, `${var}`, `?name=value`) stay whole-line
  only, checked first. There is no depth limit.
- **A missing file named by a plain path is ignored silently, as Claude Code does**, alone on a line
  or not. This replaces Luke's earlier ruling that a missing named file stays an error. A Sous form
  that cannot be resolved stays an error.
- **Each include is replaced in place.** Luke: "for includes in the middle of a line, we should
  trim() the content being injected." The agent had recommended appending, as Claude Code does.
- **Every included file's frontmatter is removed**, with no exception for an include at the top.
- **Sous does nothing about import-looking text left in its output.** Authors escape it, as for
  Claude Code. The recommendation to put a backslash before every leftover reference was rejected.
- **Files outside the project are included with no check**, as before.
- A file named twice is included each time, and a cycle is an error.
- **A glob that matches nothing does nothing.** Luke: "A glob that matches nothing should simply do
  nothing. It should be removed (not injected in the final output)."
- **A glob's files come folder by folder.** Luke: "We will slightly modify the behavior of glob
  includes so that it will include files within a directory _before_ any files in sub-directories".
  Names are compared ignoring case, one character at a time, `_` first, then digits, then letters;
  the capitalised one of two case twins first. A recipe's memories use the same order: "that step
  should use the same alorithm we just designed."

## Consequences

- Lines that were text become includes when a file exists at the path: `- @x.md`, an indented
  `@x.md`, `See @x.md for details.`, `@README`, `@notes.txt`, and `@alice` when a file `alice` exists.
- A typo in an include's file name no longer fails the build; the instructions quietly go missing.
- An include line inside a multi-line HTML comment, a `<div>` or a `<pre>` block is no longer
  included.
- An output that took its frontmatter from an include at its top loses it.
- A project that relied on the bytewise order of a glob's files gets a different order.
- The compiler reads Markdown structure through its own small scanner, `markdown.ts`, because the
  in-place replacement needs offsets a parser library's tokens do not give.
- `sous init`'s import of a project's agent files (`sous-plugin-init`) still finds includes by the old
  whole-line rule; it is not changed by this record.
