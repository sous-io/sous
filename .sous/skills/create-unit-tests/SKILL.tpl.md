---
name: create-unit-tests
description: >
  YOU MUST use this skill when asked to write, add, or create unit tests for any
  file in the sous project.
---

# Abstract

This "action skill" (command) performs a specific operation: writing unit tests for a
source file in the `sous` project.

YOU MUST load `about-unit-tests` before proceeding. It defines all conventions that
govern how tests are written in this project: naming, structure, filesystem strategy and
the stand-ins for the engine.

## Steps

1. **Load conventions.** Load `about-unit-tests` if not already loaded.

2. **Read the SUT.** Read the source file under test in full before writing any tests.
   Understand every exported function, its inputs, outputs, and side effects.

3. **Determine the spec file location.** Co-located specs live next to the source file
   as `<filename>.spec.ts`. Tests that run several modules together go in the package's
   `test/` directory as `*.test.ts`.

4. **Choose a filesystem strategy.** For each function under test, decide:
   - Real file I/O or directory walking: `makeTmpDir()` from the package's `test/` helpers
     (this is the default in this project)
   - Complex multi-file scenarios: a fixture in the package's `test/fixtures/`, or one the
     test builds as it runs
   - Pure in-memory FS with no OS interaction: `memfs` via `vi.mock("node:fs", ...)`

5. **Write the spec.** Follow all conventions from `about-unit-tests`:
   - `describe("functionName()")`: parens on the subject name (prose descriptions for
     integration tests)
   - JSDoc comment on every `it` block documenting the contract and a concrete example
   - `it("should ...")`: test names always start with "should"
   - Assert on a `BufferedReporter`'s messages, never on captured console output

6. **Run the tests.** `pnpm --filter @sous-io/plugin-<name> test` must pass for the package,
   and `pnpm typecheck` must pass.

7. **Verify coverage.** Run `pnpm test:coverage` and check the SUT's row in the
   coverage table. Annotate any genuinely unreachable branches with
   `/* c8 ignore next */`, or `/* c8 ignore start */` ... `/* c8 ignore stop */` for a
   region. Investigate and add tests for any unexpected gaps before considering the work
   done.

# Related Skills

YOU MUST load `about-unit-tests` for all conventions, strategies, and helper patterns.

# Source for this Skill

This is a hand-maintained, sous-specific skill. Its source is
`.sous/skills/create-unit-tests/SKILL.tpl.md` in the sous repository; the copy under
`.claude/skills/` is compiled output and must not be edited directly.
