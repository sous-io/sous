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
govern how tests are written in this project — naming, structure, filesystem strategy,
and console capture patterns.

## Steps

1. **Load conventions.** Load `about-unit-tests` if not already loaded.

2. **Read the SUT.** Read the source file under test in full before writing any tests.
   Understand every exported function, its inputs, outputs, and side effects.

3. **Determine the spec file location.** Co-located specs live next to the source file
   as `<filename>.spec.ts`. Integration tests go in `src/test/integration/`.

4. **Choose a filesystem strategy.** For each function under test, decide:
   - Pure logic or deterministic FS → `memfs`
   - Real OS behavior required → `os.tmpdir()` temp directory
   - Complex multi-file scenarios → fixtures in `src/test/fixtures/`

5. **Write the spec.** Follow all conventions from `about-unit-tests`:
   - `describe("functionName()")` — parens on the subject name
   - JSDoc comment on every `it` block documenting the contract and a concrete example
   - `it("should ...")` — test names always start with "should"
   - Strip ANSI codes when asserting on console output

6. **Verify coverage.** Run `npm run test:coverage` and check the SUT's row in the
   coverage table. Annotate any genuinely unreachable branches with `/* c8 ignore next */`.
   Investigate and add tests for any unexpected gaps before considering the work done.

# Related Skills

YOU MUST load `about-unit-tests` for all conventions, strategies, and helper patterns.

## Source for this Skill

This is a local skill for the `sous` project. Since `sous` uses its CLI to compile its own LLM configs, you cannot
edit the skill output directly. Instead, you need to edit the template.

- Source Path: {{ sousTemplatePath }}
