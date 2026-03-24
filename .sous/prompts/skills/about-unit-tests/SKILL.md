---
name: about-unit-tests
description: >
  YOU MUST load this skill when writing, editing, or reviewing unit tests in the sous
  project. Covers test framework, file layout, naming conventions, and strategies for
  mocking the filesystem and console output.
user-invocable: false
---

# Abstract

This "topical skill" provides information about a specific concept: unit testing in the
`sous` project.

## Framework

Vitest is the test runner. Tests are written in TypeScript and run via:

```bash
npm test                 # run all tests once
npm run test:watch       # watch mode
npm run test:coverage    # run with v8 coverage report
```

## File Layout

**Co-located specs** live next to their source file:

```
src/lib/settings.ts
src/lib/settings.spec.ts
src/utils/formatting.ts
src/utils/formatting.spec.ts
```

**Shared test infrastructure** lives under `src/test/`:

```
src/test/
  fixtures/          # pre-built sample files/directories for tests
  integration/       # multi-module integration tests (*.test.ts)
  watch/             # watch-mode tests that require real FS (*.test.ts)
  utils/             # shared test helpers (e.g. captureLog, tmpdir setup)
```

Vitest is configured to pick up both `src/**/*.spec.ts` and `src/test/**/*.test.ts`.

## Naming Conventions

### `describe` blocks

Use the function or class name followed by `()`:

```ts
describe("sortObjectKeys()", () => { ... });
describe("CompilationService", () => { ... });
```

### `it` blocks

Every `it` block must:
1. Begin with a JSDoc-style comment describing the contract, including an example
2. Start the test name with `"should "`

```ts
/**
 * sortObjectKeys should accept an input object with keys in any order
 * and return a _new_ object with the same keys sorted alphabetically.
 *
 * sortObjectKeys({ zebra: 1, apple: 2 });
 * // -> { apple: 2, zebra: 1 }
 */
it("should return a new object with keys in alphabetical order", () => {
  const result = sortObjectKeys({ zebra: 1, apple: 2 });
  expect(Object.keys(result)).toEqual(["apple", "zebra"]);
});
```

The JSDoc comment documents the *contract* — what the function accepts, what it returns,
and a concrete before/after example. This makes the test file readable as documentation.

## Filesystem Strategy

| Scenario | Approach |
|---|---|
| Pure logic, deterministic FS behavior | `memfs` — mock `node:fs` with `vi.mock` |
| Real file I/O needed (e.g. watch, child_process) | Real `os.tmpdir()` temp directory |
| Complex multi-file scenarios | Fixtures in `src/test/fixtures/` |

Prefer `memfs` when the goal is isolation and determinism. Use real files when the test
must exercise actual OS behavior (file watching, permissions, subprocess output).

## Console / stdout Capture

Many functions in `sous` write to `console.log` or `process.stdout.write` rather than
returning values. Use spy helpers to capture and assert on their output.

Shared helpers live in `src/test/utils/`. Strip ANSI codes before asserting so tests
are not brittle against color changes:

```ts
// Strip ANSI escape codes
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// Capture console.log output as plain-text lines
function captureLog(fn: () => void): string[] {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
    lines.push(strip(args.join(" ")));
  });
  fn();
  spy.mockRestore();
  return lines;
}

// Capture process.stdout.write output as plain-text chunks
function captureStdout(fn: () => void): string[] {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(strip(String(chunk)));
    return true;
  });
  fn();
  spy.mockRestore();
  return chunks;
}
```

## Dead Code and Coverage Hints

Use `/* c8 ignore next */` (or `/* c8 ignore next N */`) to annotate dead code branches
that cannot be meaningfully tested. This is the v8-compatible equivalent of Istanbul's
`/* istanbul ignore next */`. Apply sparingly — only on genuinely unreachable branches,
not to paper over missing tests.

# Other Skills

## Action Skills

Action skills for unit tests will have "unit-tests" in their name. Find the appropriate
action skill for what you want to do. If no appropriate action skill exists, ask the
user whether one should be created before continuing.
