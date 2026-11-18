# S10: Includes

**Status:** Accepted on 2026-11-18, from Luke's rulings that day. From now on, a change to this
specification is recorded under "Changes".

**Serves:** G4 (predictable and observable), G6 (testability), G3 (versatility).

## What This Specifies

How the compiler finds the includes in a source file, resolves them, and puts each file's text in
the output; the order of the files a glob include gives; and what happens when an include names
nothing. The owner is `sous-plugin-compiler` (S6, "Compiler"): `paths.ts` holds the rules for a reference
and the file types, `markdown.ts` reads the Markdown structure, `globs.ts` holds the order,
`includes.ts` resolves a path, and `compiler.ts` reads a file and its includes.

## Why

Claude Code has its own includes, called imports: an `@path` in a memory file loads that file.
Sous compiles memory files for Claude Code, so a source carries both. Before this specification,
Sous took only a line holding nothing but `@path`, at the first column, ending in `.md`. Every other
`@path` passed through to the output, and Claude Code then imported it, resolved from the output's
folder rather than the folder the author wrote it against. Luke's direction:

> "Basically, no _real_ imports should make it through to Claude. Sous basically replaces Claude's
> import/include mechanism. Ideally, users would escape `@scope/package` in the same way they would
> if they were giving it to Claude."
>
>   -- **Luke Chavers** in an agent session (2026-11-17)

> "In general, we want to behave as closely as we can to Claude Code's native behavior (but with
> our intentionally added behaviors). We should also allow imports mid-file. We should allow every
> mechanism for escape that CC allows."
>
>   -- **Luke Chavers** in an agent session (2026-11-17)

**Trade between goals.** Copying one tool's syntax leans toward that tool, but G8 holds: the include
syntax is Sous's own feature, works the same for every agent tool and for a project with none, and
Claude Code's rule was chosen because authors already know it.

## Claude Code's Rule, Copied In

Read from Claude Code 2.1.326's bundled code, and tested against it on 2026-11-17:

```js
let k = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g;
// the capture is cut at its first "#", and "\ " becomes a space; it is an import when it
// starts with "./", "~/", "/" (and is not just "/"), or a letter, digit, ".", "_" or "-"
```

The scan runs only over Markdown text: code blocks, code spans and HTML are skipped; an HTML block
that starts with a comment has its comments removed and the rest scanned. A file's extension, in lower
case, must be on a list of about a hundred text types (`.md`, `.txt`, `.json`, `.yaml`, `.sh`, `.py`
and so on), or the file must have none. Claude Code imports a file at most once, ignores cycles and
missing files silently, stops four hops deep, appends each imported file after the importing file,
and strips the imported file's frontmatter.

## The Rules

### 1. Where a reference stands

An `@path` is found anywhere in a line of Markdown text, by Claude Code's rule above. No trailing
punctuation is stripped: `see @x.md.` names a file called `x.md.`.

Not scanned: code spans of any backtick count, fenced code blocks (backticks or tildes, three or
more), indented code blocks, HTML blocks, HTML comments, the frontmatter at the top of the file, link
destinations and image text. An `@` not preceded by whitespace or the start of a text is not a
reference (`\@x.md`, `"@x.md"`, `(@x.md)`, `see:@x.md`, `word@x.md`). Quotes, headings, lists,
emphasis, link text and table cells are scanned. Inside a block, each piece of text between two pieces
of inline syntax (a code span, a tag, an escape, a link bracket, a mark of emphasis) is a text of its
own, so `**@x.md**` and `[@x.md](https://example.com)` are references, as they are in Claude Code.

### 2. Sous's own forms

A glob, `@~namespace/recipe/path`, `@#name/...`, a `${var}` in a path, and a `?name=value` query
count only on a line holding nothing else, starting at the first column. Such a line is checked first,
before Claude Code's rule. The same text inside a line is left as written.

```markdown
@#memories/**/*.md                  <- a Sous include
See @#memories/**/*.md for more.    <- text
```

### 3. File types

A plain path is an include only when it names a regular file whose extension, in lower case, is on
Claude Code's list, or which has none. A glob's matches outside that list are left out. A Sous form
that names one file is not checked against the list.

### 4. What names nothing

| Case | Result |
|---|---|
| A plain `@path` with no such file, anywhere, alone on a line or not | Left as written, no message |
| A Sous form naming one file that is not there | Error naming the file and line |
| A `~namespace` or `#name` that is not known | Error naming the file and line |
| A glob that matches nothing | Its line is removed from the output; no message |

The error's hint: "To write this line as text, put it in backticks, or put a backslash before the
"@"."

### 5. Where the text goes

Every include is replaced in place, where it stands. A name alone on a line is replaced by the file's
full text. A name inside a line is replaced by the file's text trimmed of leading and trailing
whitespace.

```markdown
<!-- source -->
See @guide.md for details.

<!-- guide.md -->

  Run the tests first.

<!-- output -->
See Run the tests first. for details.
```

The frontmatter of every included file is removed, with no exception. The entry's own frontmatter is
kept, and never scanned.

### 6. Repeats, cycles, depth, outside files

A file named twice is included each time. A cycle is an error, because in-place expansion cannot end
otherwise. There is no depth limit. A plain path that leads outside the project is included with no
check.

### 7. What Sous leaves in its output

Nothing. Sous does not escape import-looking text it leaves in an output. Authors escape it as they
would for Claude Code: backticks, or a backslash before the `@`.

### 8. The order of a glob's files

`compareIncludeOrder(left, right)` in `globs.ts`, exported by `sous-plugin-compiler`:

- At each folder its own files come first, then its sub-folders, with the same rule inside each.
- Names are compared one character at a time, ignoring case: `10-setup` before `2-setup`, `0002`
  before `0010`.
- `_` comes before every other character; the rest go by character code, so digits before letters.
- Two names that differ only by case put the capitalised one first.

```text
memories/_intro.md
memories/0002-setup.md
memories/0010-setup.md
memories/10-setup.md
memories/2-setup.md
memories/apple.md
memories/Zebra.md
memories/_private/a.md
memories/2-guides/Alpha.md
memories/2-guides/deep/note.md
memories/Api/routes.md
memories/zeta/last.md
```

The memories of one recipe (`sous-plugin-memories`) are ordered by the same function. The order between
two recipes is unchanged: dependencies first, ties by recipe name in raw character codes.

## Where Sous Departs From Claude Code

Each is intended.

- **Placement.** Claude Code leaves the line as written and appends the file after the importing
  file; Sous replaces the name in place (Luke chose this).
- **Repeats and cycles.** Claude Code loads a file once and ignores cycles; Sous includes each time
  and fails on a cycle.
- **Depth.** Claude Code stops four hops deep; Sous has no limit.
- **Sous's forms.** Claude Code would not import `@a*b*.md` (emphasis splits it) or `@x.md?name=value`;
  Sous includes them, alone on a line.
- **Two escapes in a list item.** In a tight list item, Claude Code scans the item's raw text as well
  as its parts, so it imports `- see ` @x.md ` here` (a code span with spaces) and
  `- note <!-- @x.md --> end` (an inline comment). Sous honours both escapes. Matching would put a
  file's text inside a code span or a comment.
- **Comment remainders.** Claude Code joins what is left of a comment block into one text; Sous scans
  each piece after the first as preceded by the last character of the one before, which gives the same
  result except for a path split by a comment.
- **Resolution.** A plain path resolves as every Sous include does: aliases, then the path relative to
  the including file, each followed by its `.tpl.` twin. Claude Code knows only the relative path.

## How the Markdown Structure Is Read

`markdown.ts` is a small block-and-inline scanner written for this, with no parser dependency.
Sous must know the offset of every reference to put the file in its place, and a parser's tokens do
not carry offsets (a list item's or a quote's text loses its indentation and markers). The scanner
follows CommonMark for fences, indented code (which cannot interrupt a paragraph, and inside a list
item counts from the item's content), the seven kinds of HTML block, ATX headings, thematic breaks,
list items, quotes, link reference definitions, code spans, inline HTML and autolinks, escapes, links
and images, and emphasis (the flanking and pairing rules). It does not read setext headings, tables
or strikethrough as structure, which does not change what is scanned.

## Changes

None yet.
