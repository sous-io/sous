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
npm test                 # run all tests once (excludes e2e)
npm run test:watch       # watch mode
npm run test:coverage    # run with v8 coverage report
npm run test:e2e         # slow, real-FS end-to-end tests only
```

`npm test` uses `vitest.config.ts`. `npm run test:e2e` uses a separate
`vitest.e2e.config.ts` with a 30s `testTimeout`; the default config excludes
`src/test/e2e/**` so the slow tests never run as part of `npm test`.

## File Layout

**Co-located specs** live next to their source file:

```
src/lib/settings.ts
src/lib/settings.spec.ts
src/utils/formatting.ts
src/utils/formatting.spec.ts
```

This applies at any depth, including the `src/` root (`src/base-command.spec.ts`) and
nested template directories (`src/templating/tags/getFiles.spec.ts`).

**Shared test infrastructure** lives under `src/test/`:

```
src/test/
  fixtures/          # pre-built sample directories copied into temp dirs by tests
  integration/       # multi-module integration tests (*.test.ts)
  watch/             # watch-mode tests with a mocked chokidar (*.test.ts)
  e2e/               # real chokidar + real files; excluded from `npm test`
  utils/             # shared test helpers (tmp dirs, fixtures, settings builder)
```

The default config's `include` covers three patterns: `src/**/*.spec.ts`,
`src/test/**/*.test.ts`, and `shared-prompts/**/*.spec.mjs` (the browser-automation
bundle ships its own `.mjs` specs, which run alongside the TypeScript ones).

## Naming Conventions

### `describe` blocks

For a unit spec, use the function or class name followed by `()`:

```ts
describe("sortObjectKeys()", () => { ... });
describe("CompilationService", () => { ... });
```

Integration tests, whose subject is a behavior rather than a single export, use a plain
prose description instead (e.g. `describe("full rebuild on config change", ...)`).
Nested `describe` blocks are common in the larger specs — an outer block naming the
module and inner blocks naming each exported function.

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
| Real file I/O, or code that walks/creates directories | Real `os.tmpdir()` directory via `makeTmpDir()` |
| Complex multi-file scenarios | Fixtures in `src/test/fixtures/`, copied with `copyFixture()` |
| Pure in-memory FS behavior with no OS interaction | `memfs` — mock `node:fs` with `vi.mock` |

**Real temp directories are the dominant pattern** in this project — most specs use
`makeTmpDir()`. `memfs` is the exception, not the default: mocking `node:fs` hides real
path/permission behavior, and several modules genuinely need it. `src/lib/state.spec.ts`
is the one spec that mocks the whole module:

```ts
import { vol } from "memfs";

vi.mock("node:fs", async () => {
  const { fs } = await import("memfs");
  return { default: fs, ...fs };
});

beforeEach(() => {
  vol.reset();
});
```

Two documented cases where `memfs` is explicitly the wrong choice:
- **Config discovery** walks up to the filesystem root; a mocked fs hides the
  interaction between `.sous/` directories at different depths.
- **Watch tests** rely on chokidar, which uses kernel-level `fs.watch()` and does not
  work against `memfs`. `src/test/watch/` mocks `chokidar.watch()` to return a real
  `EventEmitter` and emits events manually, combined with fake timers. The real-chokidar
  version of those tests lives in `src/test/e2e/`.

### Shared helpers

`src/test/utils/` holds three helpers, imported via relative paths:

- `makeTmpDir(prefix?)` → `{ path, cleanup }`, a unique dir under `os.tmpdir()`.
- `copyFixture(fixtureName, destDir)` → copies a directory from `src/test/fixtures/`.
- `makeSettings(projectKey, project)` → a minimal valid `Settings` object.

## Console / stdout Capture

Many functions in `sous` write to `console.log` or `process.stdout.write` rather than
returning values. Use spy helpers to capture and assert on their output, and strip ANSI
codes before asserting so tests are not brittle against color changes.

These helpers are defined locally in the spec that needs them (see
`src/utils/formatting.spec.ts`) rather than in `src/test/utils/`, since output capture is
only relevant to the formatting layer:

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
that cannot be meaningfully tested. For a longer region, use the paired
`/* c8 ignore start */` … `/* c8 ignore stop */` form. These are the v8-compatible
equivalents of Istanbul's `/* istanbul ignore */` comments. Apply sparingly — only on
genuinely unreachable branches, not to paper over missing tests.

Coverage is configured to measure `src/**/*.ts`, excluding the specs themselves and
everything under `src/test/`.

# Other Skills

## Action Skills

Action skills for unit tests will have "unit-tests" in their name. Find the appropriate
action skill for what you want to do. If no appropriate action skill exists, ask the
user whether one should be created before continuing.

# Source for this Skill

This is a hand-maintained, sous-specific skill. Its source is
`.sous/skills/about-unit-tests/SKILL.md` in the sous repository; the copy under
`.claude/skills/` is compiled output and must not be edited directly.
