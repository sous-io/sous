# @sous-io/sous-lib-documents

Edits JSON, JSONC and YAML files, the YAML frontmatter of Markdown files, and plain text files such as `.gitignore`, surgically: an edit changes only the values it was told to change, and every other byte of the file stays as it was (comments, key order, indentation, quoting, blank lines, line endings, block and flow style).

Every edit to a structured document is a primitive patch (set, remove, append, and so on) at a path. A list of patches is a patch set, which can be applied to a document, saved as a `.patch.json` file, and read back.

## Choosing a format

`formatForPath` says which format a file is edited in:

```ts
import { formatForPath } from "@sous-io/sous-lib-documents";

formatForPath(".claude/settings.json");        // "json"
formatForPath(".vscode/settings.json");        // "jsonc"
formatForPath(".github/workflows/ci.yml");     // "yaml"
formatForPath(".claude/agents/reviewer.md");   // "markdown" (the frontmatter)
formatForPath(".gitignore");                   // "lines"
formatForPath("config.toml");                  // undefined: not supported yet
```

## JSON, JSONC, YAML and Markdown frontmatter

```ts
import { parseDocument } from "@sous-io/sous-lib-documents";

const doc = parseDocument(fs.readFileSync(".pre-commit-config.yaml", "utf8"), "yaml");

doc.atPath("repos[0].rev").set("v5.0.0");
doc.atPath("default_stages").appendIfMissing("pre-commit");

fs.writeFileSync(".pre-commit-config.yaml", doc.toString());   // only those lines changed
```

A `markdown` document is the frontmatter between the `---` lines at the top of a Markdown file. The body is never changed, and a file with no frontmatter gets one when a value is set:

```ts
const agent = parseDocument("---\nmodel: sonnet\n---\n# Reviewer\n", "markdown");

agent.atPath("model").set("opus");
agent.toString();   // "---\nmodel: opus\n---\n# Reviewer\n"
```

The node operations, beyond `get`, `set`, `delete`, `merge` and the list edits:

```ts
const allow = doc.atPath("permissions.allow");

allow.includes("Bash(git:*)");                     // structural: objects equal in any key order
allow.insertAtIfMissing(0, "Bash(git:*)");         // also appendIfMissing, prependIfMissing
allow.removeValues(["Bash(rm:*)"]);
allow.sort();                                      // fewest moves; compareValues by default

doc.root().moveKeyBefore("env", "permissions");    // also moveKeyAfter, moveKeyFirst, moveKeyLast, sortKeys
```

A key or item that is moved keeps its old text, comments included.

### Comments

JSONC (`//` and `/* */`), YAML (`#`) and Markdown frontmatter keep comments, and a document can read and write the comment attached to a key or list item: the comment lines directly above it (`"before"`) and the comment ending its line (`"after"`). Plain JSON has no comments, so a `json` document refuses with a `CommentError`.

```ts
const doc = parseDocument("tools:\n  - Read\n  - Bash\nmodel: opus\n", "yaml");

doc.setComment("model", "before", "The model the reviewer runs on");
doc.setComment("tools[1]", "after", "dangerous");
doc.toString();
// tools:
//   - Read
//   - Bash # dangerous
// # The model the reviewer runs on
// model: opus

doc.comment("tools[1]", "after");     // "dangerous"
doc.removeComment("model", "before");
```

A comment before takes the node's indentation and may have several lines (`"one\ntwo"`); a comment after is one line. Only the comment's own bytes change, in the file's line endings; a JSONC `/* */` comment that is replaced stays a block. "Directly above" means comment lines at the node's indentation with no blank line between. A value that shares its line with others (inside `[...]` or `{...}`, or `"a": 1, "b": 2`) has no comment of its own and is refused, and so is an edit that would change a value (a `#` inside a multi-line string). `doc.commentSource(path, place)` returns the comment exactly as written, and `doc.restoreCommentSource(path, place, source)` puts it back byte for byte, for undoing. The same functions work on text: `readComment`, `setComment`, `removeComment`, `commentSource`, `restoreCommentSource`.

### When YAML cannot be edited line by line

A YAML edit is made to the text and then read back. When the editor cannot make it in place (a key written with `?`, a list item whose value starts on the line below its dash), the whole document is reprinted through the `yaml` package instead: comments survive, spacing may change, and `doc.reprinted()` returns `true`. An edit to a value a YAML anchor (`&name`) shares with its aliases (`*name`) throws, since it would change every copy. New values follow the file's style as far as the `yaml` package can write it: a list's dashes sit either `indent` or `indent - 2` columns right of their key.

## Plain text files, as lines

```ts
import { commentStyleForPath, parseLines } from "@sous-io/sous-lib-documents";

const file = parseLines(fs.readFileSync(".gitignore", "utf8"), { comment: commentStyleForPath(".gitignore"), label: ".gitignore" });

if (!file.includes("dist/")) {
    file.insert("dist/", { after: "# build output" });   // or "start", "end", { before }, { line: 3 }
}

file.setBlock("session-files", ["docs/context/.kw-session-*"]);
fs.writeFileSync(".gitignore", file.toString());
```

`setBlock` keeps a named block between two marker lines, in the file's comment style:

```gitignore
# >>> sous managed: session-files (do not edit between these markers)
docs/context/.kw-session-*
# <<< sous managed: session-files
```

An opening marker without its closing marker (or the reverse, or a marker twice) is a `ConfigError`, never a guess. To edit lines in a Markdown file's body, cut it with `splitFrontmatter` and put `head + body` back together.

## Where things are

- `src/node.ts`: the operations on one place in a document.
- `src/text-document.ts`, `src/value-document.ts`: documents backed by file text, and by plain values.
- `src/jsonc-text.ts`, `src/yaml-text.ts`, `src/frontmatter.ts`: the format-specific editing.
- `src/comments.ts`: the comments before and after a key or list item.
- `src/lines.ts`: plain text files as lines, and managed blocks.
- `src/formats.ts`: the format and comment style for a path.
- `src/patch-set.ts`, `src/apply.ts`, `src/serialize.ts`: patch sets, applying them, and the patch file format.

## Testing

```bash
corepack pnpm vitest run packages/sous-lib-documents
```
