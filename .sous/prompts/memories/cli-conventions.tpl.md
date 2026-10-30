## CLI Conventions (every command, every prompt, every output)

These bind every command, flag, question, table and file sous writes. Where the code already
holds the mechanism, use it rather than building a second one beside it.

- **Help describes precisely the thing it names, in one sentence.** No cross-references to other
  commands, no tips, no "see also". Command OUTPUT shows facts about what happened; it never
  ends in a footer hinting at some other command the reader might want.
- **Topics are singular** (`repo`, `subscription`, `config`); `vars` is the deliberate plural.
  Every topic accepts both spellings, with the alternate hidden (`BUILT_IN_GROUPS` in
  `packages/plugin-cli/src/groups.ts`, whose `aliases` hold the hidden spelling).
- **One confirmation flag family, from the shared flag options** (`yesFlag` and `yesFlagNoTrust` in
  `packages/plugin-recipes/src/part-a/intents/schema.ts`; the command line reads `-y` and `-f` in
  `packages/plugin-cli/src/flags.ts`): `--yes`
  with `-y` is the primary spelling, `--force` and `-f` are aliases of it, and `--trust` is
  added where trust is the question. Aliases render as a suffix on the primary's help line;
  never declare a second flag.
- **Only `sous repo release` edits a version number, and only in the repository it is run in.**
  It raises a changed recipe whose version still equals its last tag; `--bump` chooses how far
  (a patch step by default) and `--no-bump`, which `--ci` implies, makes an unraised change an
  error instead. The rule lives in `buildReleasePlan` (`packages/plugin-authoring/src/release/plan.ts`).
- **Every command that takes a reference resolves it through `packages/plugin-refs/src/`.**
  `RefsResolver.resolve` (`createRefsResolver`, `resolver.ts`) reads what a word on the command line names (over the kinds a
  command accepts: repository, namespace, recipe, variable, environment variable name), and
  `RefsPicker` (`createRefsPicker`, `picker.ts`) settles which meaning a run proceeds with (one match, a question,
  `--accept-first`, or the shared non-interactive failure). Any level of qualification is
  accepted up to the fully qualified name, and so is a location (a URL, an SSH remote, a
  provider-scheme locator, a URL copied from the browser). Matching tries the exact spelling
  first, then ignores case; a name that still matches several things is a question. The
  listing order is the contract. What a reference resolved to is reported by
  `formatResolvedReference` (`packages/plugin-cli/src/views/ref-report.ts`), which the picker
  calls: the facts as a key and value list, then one sentence saying why that candidate won.
  Never resolve a name by walking an index or a definition list in a command.
- **Never prompt when the terminal is not ours**: `--non-interactive`, a truthy `CI`, or no TTY
  (`canPrompt` and `whyCannotPrompt` in `packages/plugin-cli/src/terminal-prompter.ts`). Fail instead, naming both the question that could not be asked and
  the flag that would have answered it, and print the command's help under the error. All of it
  goes to stderr, so piped stdout stays clean.
- **Informed consent, never prevention.** Warn with facts the user can verify, confirm, then do
  what the user asked for. Never state what a user intended.
- **Machine-written config layers are `.jsonc`** with a header comment saying what the file
  holds and who writes it, edited by key so comments, key order and formatting survive
  (`managedHeader` and `ConfdManagedImpl` in `packages/plugin-confd/src/managed.ts`). Users may edit them too. Where strict JSON makes a comment
  property unavoidable, the key is `//`.
- **Every directory sous creates for itself carries `README.md`, `AGENTS.md` and `CLAUDE.md`**
  (`createDirectories` in `packages/plugin-host/src/directories.ts`, with `KNOWN_READMES` in
  `readmes.ts`); rendered output directories carry none of the three.
- **Variable definitions require `description` and `example`.** The description says, in full
  sentences, what the setting is for, what the default does, and what else is acceptable; the
  prompt itself stays one plain question.
- **One ref resolver, told where the ref came from**: `RefsParser` (`createRefsParser`, `packages/plugin-refs/src/parser/parser.ts`)
  reads every form and returns every reading, and the `RefPrunerEntity` (`packages/plugin-refs/src/pruners/pruners.ts`) for the ref's `RefSource` (the
  place it was written) drops what that place refuses, saying what to write instead. Never
  parse a ref, or split a key, anywhere else (`splitRecipeKey` and `namespaceOfKey` in
  `packages/plugin-recipes/src/part-a/catalog.ts` take stored
  keys apart). A ref is stored and printed as its published identity (namespace and recipe),
  never as a folder path. Any spelling that settles to one identity is accepted, including a
  folder path or a pasted browser URL; host-specific readings belong to each provider's
  `readLocation`.
- **Output is reported, never formatted, outside the reporter.** Every message and every result
  goes through the reporter's level and style methods (`BaseReporter`,
  `packages/plugin-api/src/reporter.ts`; ADR 0021): a caller says what an entry is (`variables`,
  `table`, `list`, `operation`, `problem`, ...) and passes the facts. No caller writes a glyph,
  pads a label, indents a line or joins lines with "\n". A shape no style fits gets a new style
  in `packages/plugin-api/src/report-styles.ts`, with its method in `BaseReporter`.
- **How each style looks is decided once, in `TerminalReporter`**
  (`packages/plugin-cli/src/terminal/render-entry.ts`): aligned label and value blocks with
  details muted, the responsive table renderer (`packages/plugin-cli/src/views/table.ts`: per-column
  priorities, identifiers truncate, prose wraps, a non-TTY run never drops a column), one wrap
  (`wrapText`), the real `BULLET` character, and one palette (`packages/plugin-cli/src/views/style.ts`):
  a warning is bright yellow with its sharpest words in orange; a note (an explanation that is
  neither warning nor error) is bright teal; an error is bright red and is always preceded by the
  literal `Error: `, so it stays findable with color off.
- **Streams follow the level**: `debug`, `info` and `notice` go to stdout, `warning` and above to
  stderr; under `--json`, or while a background intent owns stdout (`sous mcp`), every message
  goes to stderr.
- **Prefer a list over a paragraph.** Facts belong in a key and value list with one short sentence
  after it, not in a sentence with the facts buried inside it.
- **A question has room around it**: two blank lines above the "Question N of M" header, and two
  blank lines under the input line, so a question never sits on the terminal's last row
  (`TerminalPrompter`, `packages/plugin-cli/src/terminal-prompter.ts`). The keys a prompt answers to
  are named by a legend under the input line, in the style `@inquirer/select` uses
  (`↑↓ navigate • ⏎ select`); never a bracketed hint above it.

## Tests

A test never reads anything outside this repository, and never skips itself because
something is missing. A fixture is either built by the test as it runs or shipped in the
repository in the package's `test/fixtures/` directory (for example `packages/plugin-compiler/test/fixtures/`); a test that would otherwise reach a directory beside
the checkout, a machine-wide store or the user's home directory copies what it needs into a
temporary directory first, and points `SOUS_HOME` at that directory for anything the CLI
writes for itself. A conditional skip hides a failure on every machine but one, so the whole
suite runs the same way on a fresh clone and in continuous integration.
