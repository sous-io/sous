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
- **`--bump` is the author's permission for sous to edit version numbers.** Without it sous
  edits no version anywhere.
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
