# ADR 0027: Assertions on edited files

**Status:** Accepted, 2026-11-18, from Luke's rulings of 2026-11-17 and 2026-11-18. The living
answer is [S9, the editor](../architecture/specifications/S9-the-editor.md), section "Assertions",
and the user page [Editing files Sous does not own](../editing-files.md).

## Context

Several recipes and plugins may edit one file ([ADR 0026](0026-declared-edits-to-files-sous-does-not-own.md)),
and a person or another program may change it too. The author of an edit knows which values their
tool cannot work without, and which file sizes a tool cuts off. Sous needed a way to say so, and a way
to warn about conflicts that does not guess at which operations clash.

> "Perhaps we should also give them assertions that can run, after all edits have been made, that
> spot when something has changed in a way the plugin/recipe author knows will cause their tool to
> fail. When one of those assertions fail, Sous could give the relevant history of the SUT that led
> to the failure."
>
>   -- **Luke Chavers** in an agent session (2026-11-17)

## Decision

- **An assertion is data**, an `assert` entry in `editor.edits` beside the edits, and belongs to
  whoever declared it. It runs on each file as it is about to be written.
- **Level error by default, `warn` on request.** A failed error assertion leaves that file unwritten
  and fails the build; `--ignore-failed-assertions` (or `--keep-going`) prints it as a warning and
  lets the build succeed. There is no config setting for that.

  > "if a developer adds an assertion, they're stating outright 'this is going to break'; we should
  > error on failed assertions, but should provide a way for users to say 'don't fail on
  > assertions', if they want to be so bold."
  >
  >   -- **Luke Chavers** in an agent session (2026-11-17)

- **A failure shows the history of the value:** the edits that touched the path, in order, with who
  declared each.
- **The conflict detector is automatic assertions.** Each edit implies that its result still holds
  after all edits, checked at level warn. "The later entry wins, with a warning" is what happens when
  the earlier entry's automatic assertion fails.
- **No duplicates, by a rule with no judgment:** a declarer that wrote any assertion of its own on a
  file and path gets no automatic assertion there.
- **Silencing,** narrowest first: `assertion: none` on one edit; the author's own assertion; `silence`
  at a path with `kinds` or `except` and a `scope` (`key-and-below` by default, `key-only`, `below`);
  `silence: {}` for a file. A declarer silences only its own.
- **Checks** on values (`equals`, `includes`, `sorted`, `unique`, `noItemWhere` and more), on a file
  or folder existing (`fileExists: false` and `fileDoesNotExist: true` both accepted), and on size in
  bytes, characters and tokens (`o200k_base`, the compiler's tokenizer, approximate for any one model).
  An unparseable or missing file fails every assertion about a value in it.
- **In a plugin, Chai's `expect` style:** `expect` is a function whose argument is the thing checked.

  > "The whole reason `expect` was chosen is because it allowed the assertion to read like a
  > sentence. `expect( overrideFile.byteCount ).to.be.lessThan(32768).orWarn().withMessage("that's bad");`"
  >
  >   -- **Luke Chavers** in an agent session (2026-11-17)

  Comparisons are spelled out (`lessThan`, `lessThanOrEqualTo`, `greaterThan`,
  `greaterThanOrEqualTo`); every assertion ends in a method call; `byteCount`, `characterCount` and
  `tokenCount` are references, never numbers, because the file is read later.

## Rejected

- `settings.expect(...)`, which put the subject inside a method call.
- Chai's `at.most(...)` as the form shown (it is accepted as another spelling only).
- Comparing pairs of operations to guess at conflicts; failing the build on a detected conflict.
- A separate `silenceAllExcept(...)`; `.except([...])` is the one form.

## Consequences

- Feature 5 of the gh-146 work (an old install left in the home directory) needs no feature of its
  own: an assertion such as `fileExists: false` on the old file, or a `check` handler, covers it.
- A recipe can say everything a plugin can, since each check is defined once and both forms are made
  from it.
