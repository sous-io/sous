---
name: about-unit-tests
description: >
  YOU MUST load this skill when writing, editing, or reviewing unit tests in the sous
  project. Covers test framework, file layout, naming conventions, and strategies for
  using the filesystem and stand-ins for the engine (reporter, prompter, timers).
user-invocable: false
---

# Abstract

This "topical skill" provides information about a specific concept: unit testing in the
`sous` project.

## Framework

Vitest is the test runner. The repository is a pnpm workspace: every package under `packages/`
has its own `vitest.config.ts`, built from the shared config in `packages/vitest.shared.ts`, and
the root `vitest.config.ts` runs them all as projects. Tests import other workspace packages by
name (`@sous-io/plugin-api`, `@sous-io/plugin-<name>/types`); the shared config resolves each to
its TypeScript source, so no build is needed first.

```bash
pnpm test                                                   # every package's tests, once
pnpm test:watch                                             # watch mode
pnpm test:coverage                                          # with a v8 coverage report
pnpm --filter @sous-io/plugin-<name> test                   # one package
pnpm --filter @sous-io/plugin-<name> exec vitest run <file> # one file
pnpm typecheck                                              # tsc --noEmit in every package
```

`packages/sous` is the exception: its tests run the bundled bin, so its `vitest.config.ts` adds a
global setup (`packages/sous/test/global-setup.ts`) that builds the bundle once per run, longer
timeouts, and `SOUS_BUDGETS=off`. `pnpm e2e` runs Docker scenarios against a published version;
it is not part of `pnpm test` and runs only by hand.

## File Layout

Each package follows the same layout; the shared config's `include` is `src/**/*.spec.ts` and
`test/**/*.test.ts`.

**Co-located specs** (`*.spec.ts`) sit next to their source file, at any depth:

```
packages/plugin-recipe-answers/src/combine.ts
packages/plugin-recipe-answers/src/combine.spec.ts
packages/plugin-recipes/src/part-b/resolver/ranges.ts
packages/plugin-recipes/src/part-b/resolver/ranges.spec.ts
```

**A package's `test/` directory** holds tests that run several modules together (`*.test.ts`),
the package's test helpers, and its `fixtures/` when it has any. Helper files are named per
package (`helpers.ts`, `stand-ins.ts`, `tmp.ts`, `support/`, `utils/`); list the package's
`test/` directory to find them. A spec imports them by relative path
(`import { makeTmpDir } from "../test/tmp.js"`).

## Naming Conventions

### `describe` blocks

For a unit spec, name the function followed by `()`, or the class by its bare name:

```ts
describe("sortObjectKeys()", () => { ... });
describe("CompilationService", () => { ... });
```

Integration tests, whose subject is a behavior rather than a single export, use a plain
prose description instead (e.g. `describe("full rebuild on config change", ...)`).
Nested `describe` blocks are common in the larger specs: an outer block names the module
and inner blocks name each exported function.

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

The JSDoc comment documents the *contract*, what the function accepts, what it returns,
and a concrete before/after example. This makes the test file readable as documentation.

## Filesystem Strategy

| Scenario | Approach |
|---|---|
| Real file I/O, or code that walks or creates directories | A real directory under `os.tmpdir()`, from the package's `makeTmpDir()` |
| Complex multi-file scenarios | A fixture in the package's `test/fixtures/`, or one the test builds as it runs |
| Pure in-memory FS behavior with no OS interaction | `memfs`, mocking `node:fs` with `vi.mock` |

**Real temp directories are the dominant pattern.** Most packages define `makeTmpDir(prefix?)`
in their `test/` helpers, returning `{ path, cleanup }`; some follow links with `realpathSync`
so paths compare equal on machines where the temp directory is a link. `memfs` is the exception:
mocking `node:fs` hides real path and permission behavior. Config discovery, for example, walks
up to the filesystem root, and a mocked fs hides how `.sous/` directories at different depths
interact.

```ts
let tmp: TmpDir;

beforeEach(() => {
    tmp = makeTmpDir();
});

afterEach(() => {
    tmp.cleanup();
});
```

## Stand-ins for the Engine

Code that runs inside the engine receives its services through a context, so a test hands it
stand-ins rather than mocking modules:

- `BufferedReporter` (`@sous-io/plugin-api`) keeps every reported message; `reporter.at("warn")`
  returns the text at one level, and `reporter.styled(style)` the messages of one style. Assert on
  those rather than capturing `console` or `process.stdout`.
- `scriptedPrompter([answers])` answers questions in order and records what was `asked`;
  `nonInteractivePrompter` fails every question the way a run with no terminal does. Both come
  from `@sous-io/plugin-api`.
- Several plugin packages have a `makeEngine(...)` helper in `test/` that starts the engine with the
  plugins under test and a `BufferedReporter`.
- `@sous-io/repository-hosts/testing` holds recorded HTTP responses, fake processes, a fake git
  runner and a fake sous home for the repository host plugins.
- Timing code takes its timers as a parameter, so a test drives them by hand (for example
  `ManualTimers` in `packages/plugin-build/test/timers.ts`) instead of using fake timers.

## Self-Contained Tests

A test never reads anything outside this repository, and never skips itself because
something is missing. Every fixture is either built by the test as it runs (see
`buildFixtureRepo` in `packages/sous/test/utils/fixture-repo.ts`) or shipped in the repository in
the package's `test/fixtures/` directory, so a fresh clone and a continuous integration runner behave exactly like a developer's
machine.

Two rules follow from that:

- **No conditional skips for a missing dependency.** `describe.skipIf(...)` around an
  absent directory, tool or fixture hides a failure everywhere but the one machine that
  has it. If a test needs something, ship it; if it cannot be shipped, the test does not
  belong in `pnpm test`.
- **Nothing reaches the user's home directory.** A test that boots the real CLI copies
  what it needs into a temp directory and sets `SOUS_HOME` to a directory inside it, so
  the machine-wide store and index cache the CLI writes stay in the temp tree. A spec that
  only computes a path from `os.homedir()` is fine; reading or writing there is not.

## Dead Code and Coverage Hints

Use `/* c8 ignore next */` (or `/* c8 ignore next N */`) to annotate dead code branches
that cannot be meaningfully tested. For a longer region, use the paired
`/* c8 ignore start */` ... `/* c8 ignore stop */` form. These are the v8-compatible
equivalents of Istanbul's `/* istanbul ignore */` comments. Apply sparingly, only on
genuinely unreachable branches, not to paper over missing tests.

Coverage measures each package's `src/**/*.ts`, excluding the specs themselves. Give the reason
after the marker, as `packages/documents/src/yaml-text.ts` does:
`/* c8 ignore next: a complex YAML key, which a JSON path cannot name */`.

# Other Skills

## Action Skills

Action skills for unit tests will have "unit-tests" in their name. Find the appropriate
action skill for what you want to do. If no appropriate action skill exists, ask the
user whether one should be created before continuing.

# Source for this Skill

This is a hand-maintained, sous-specific skill. Its source is
`.sous/skills/about-unit-tests/SKILL.tpl.md` in the sous repository; the copy under
`.claude/skills/` is compiled output and must not be edited directly.
