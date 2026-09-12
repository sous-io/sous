## CLI Conventions (every command, every prompt, every output)

These bind every command, flag, question, table and file sous writes. Where the code already
holds the mechanism, use it rather than building a second one beside it.

- **Help describes precisely the thing it names, in one sentence.** No cross-references to other
  commands, no tips, no "see also". Command OUTPUT shows facts about what happened; it never
  ends in a footer hinting at some other command the reader might want.
- **Topics are singular** (`repo`, `subscription`, `config`); `vars` is the deliberate plural.
  Every topic accepts both spellings, with the alternate hidden (`oclif.topics` in
  `package.json`, plus each command's `aliases`).
- **One confirmation flag family, from the shared factory** in `src/utils/flags.ts`: `--yes`
  with `-y` is the primary spelling, `--force` and `-f` are aliases of it, and `--trust` is
  added where trust is the question. Aliases render as a suffix on the primary's help line;
  never declare a second flag.
- **Only `sous repo release` edits a version number, and only in the repository it is run in.**
  It raises a changed recipe whose version still equals its last tag; `--bump` chooses how far
  (a patch step by default) and `--no-bump`, which `--ci` implies, makes an unraised change an
  error instead. The rule lives in `buildReleasePlan` (`src/lib/repos/release/plan.ts`).
- **Every command that takes a reference resolves it through `src/lib/refs/`.** One module
  decides what a word on the command line names (`findReference` over the `SousScope` list a
  command accepts, plus the tighter `findRepository`, `findNamespace`, `findRecipe` and
  `findVariable`), and one settles which meaning a run proceeds with (`pickReference`: one
  match, a question, `--accept-first`, or the shared non-interactive failure). Any level of
  qualification is accepted up to the fully qualified name, matching is case-sensitive, and
  the listing order is the contract. Never resolve a name by walking an index or a definition
  list in a command.
- **Never prompt when the terminal is not ours**: `--non-interactive`, a truthy `CI`, or no TTY
  (`src/lib/interactive.ts`). Fail instead, naming both the question that could not be asked and
  the flag that would have answered it, and print the command's help under the error. All of it
  goes to stderr, so piped stdout stays clean.
- **Every question type supports Tab for "Advanced"** (`src/utils/value-prompt.ts`,
  `choice-prompt.ts`, `confirm-prompt.ts`). The word is always "Advanced", and the hint never
  presumes what advanced contains.
- **Informed consent, never prevention.** Warn with facts the user can verify, confirm, then do
  what the user asked for. Never state what a user intended.
- **Tables go through the responsive renderer** (`src/utils/table.ts`) with per-column
  priorities: identifiers truncate, prose wraps, and a non-TTY run never drops a column.
- **Machine-written config layers are `.jsonc`** with a header comment saying what the file
  holds and who writes it, edited by key so comments, key order and formatting survive
  (`src/lib/repos/managed-layer.ts`). Users may edit them too. Where strict JSON makes a comment
  property unavoidable, the key is `//`.
- **Every directory sous creates for itself carries `README.md`, `AGENTS.md` and `CLAUDE.md`**
  (`src/utils/sous-directory.ts`); rendered output directories carry none of the three.
- **Variable definitions require `description` and `example`.** The description says, in full
  sentences, what the setting is for, what the default does, and what else is acceptable; the
  prompt itself stays one plain question.
- **Dependencies are declared by location**: a bare sibling ref, or a provider-scheme locator
  URL. The last two path segments are always the recipe identity (namespace and name), never a
  filesystem path. The ref grammar lives in `src/lib/repos/ref.ts`.
- **One way to show a key and its value**: `showVariable` and `showVariables` in
  `src/utils/formatting.ts`, four spaces in, labels padded so every colon lines up, values in the
  value color, and anything secondary (a location, a provenance) trailing in muted grey rather
  than in parentheses. Never build a second aligner beside them; a labeled block anywhere (the
  facts about a variable, a command's opening block, a result, a notice) goes through them.
- **One palette, in `palette`** (same file): label, value, muted, warning, highlight, note, error.
  A warning is bright yellow with its sharpest words in orange; a note (an explanation that is
  neither warning nor error) is bright teal; an error is bright red and is always preceded by the
  literal `Error: `, so it stays findable with color off.
- **One wrap, `wrapText`**, and every paragraph goes through `paragraph` or `note` before it is
  printed. Wrapping stops short of the right edge, never breaks a word or a URL, keeps whatever
  indentation a line arrived with, and hangs continuation lines two spaces.
- **Prefer a list over a paragraph.** Facts belong in a key and value list with one short sentence
  after it, not in a sentence with the facts buried inside it. A list of points uses the real
  `BULLET` character.
- **A question has room around it**: two blank lines above the "Question N of M" header, and two
  blank lines under the input line, so a question never sits on the terminal's last row. The keys
  a prompt answers to are named by a legend under the input line, built with `keysHelpTip`, in the
  style `@inquirer/select` uses (`↑↓ navigate • ⏎ select • ⇥ advanced`); never a bracketed hint
  above it.
