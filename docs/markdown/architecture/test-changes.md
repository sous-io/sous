# Test Changes

Every change to an old test during the refactor: the test, what it expected, what it expects now, and why.

## plugin-liquid: `src/templating/init-liquid-engine.spec.ts` → `packages/plugin-liquid/test/engine.test.ts`

- **"should register the bulletList filter…" and "should register the showVars tag…"**: expected
  `createLiquidEngine([])` to have `bulletList` and `showVars` built in. Now the test adds stand-in
  `liquid-filter` and `liquid-tag` entities and expects the engine to register them. Why: S6 makes
  those built-ins entities of plugin-compiler; plugin-liquid only registers what entities add. The
  showVars stand-in prints its own simple JSON, so the test checks the dump, not the exact
  `# Sous Debug` heading (that output is tested in plugin-compiler).
- **"should set engine.options.root…", "should return a Liquid instance", "should not throw when
  roots is an empty array"**: unchanged, except they go through `liquid.engine` `create({ root })`.

## plugin-skills: `src/lib/repos/recipe-targets.spec.ts`, ported to `packages/plugin-skills`

- **"destinationsFor() should default skills to the project's .claude/skills directory"**: expected
  `[<project>/.claude/skills]` with nothing configured. Now expects no destination
  (`skillDestinations([], [])` is `[]`), no compilation target, and a compile warning saying why
  (`test/plugin.test.ts`, "should add no target and say why when skills go nowhere"). Why: core has no
  default destination (S6, "Skills: plugin-skills", ruled 2026-10-25, G8); `.claude/skills` now comes
  from plugin-claude-code's `skill-target`.
- **"destinationsFor() should substitute variables in configured destinations"**: expected `${root}`
  replaced from a scope. Now expects `${var}` kept in `destinationDir` (`outputDir()`), with relative
  paths placed under `${projectRoot}`. Why: `${var}` substitution belongs to plugin-variables (S6), and
  the contributor runs before variables are resolved.
- **"buildRecipeTargets() should warn once about prompts and copy no memories"**: expected one warning
  about prompts. Now only expects that memories and prompts are not skills (`sources.spec.ts`). Why:
  prompts are not plugin-skills' concern; the warning belongs to whichever plugin owns prompts.
- **"buildRecipeTargets() should report a linked recipe's directory for watching"**: dropped. Why:
  watch directories belong to plugin-build's `build.watch` (S6), which can read linked recipes from
  `active-recipe` entities.
- **"buildRecipeTargets() should produce one target per contributed file"**: `rootInputPath` is now
  `entryPoint` and the destination is `${projectRoot}/...` from a configured output or skill target;
  otherwise the same (one target per file, `globBase` the include's static base).

## plugin-formats

- src/lib/repos/formats/lockfile.spec.ts, "should derive a missing identity from a hosted repository url" and "... from a local path": expected the parser to fill in `identity` through a provider; now expect it left missing (renamed "should leave a missing identity missing" and "should accept a local path url with no identity"). Why: parsing a lockfile never works out an identity (S6, refs, formats and repos); `recipes.lock` does it after parsing.
- src/lib/repos/formats/recipe-manifest.spec.ts, the four dependency-ref tests (consumer-side qualifier, local locator, bad ref, range on a namespace): expected the real ref parser inside the schema; now pass a stand-in `DependencyRefChecker` to `parseRecipeManifest`. Why: formats receives the ref check from `refs.resolver` instead of importing the ref resolver.
- src/lib/repos/store/hash.spec.ts: unchanged, plus new cases for case-insensitive `equal` and `isHash`. `hashesEqual` now ignores case (the `formats.recipe-hash` contract).
- Other formats specs and load-manifest.spec.ts: import paths and the `isConfigError` source only.

## plugin-variables: `src/lib/settings.spec.ts`, `src/lib/include-resolver.spec.ts`, `src/lib/vars/names.spec.ts`, `src/lib/vars/secrets.spec.ts` → `packages/plugin-variables`

- **substituteVars(), findUnresolvedVars(), substituteVarsStrict()** (settings.spec) and
  **substituteVars()** (include-resolver.spec): ported to `src/substitute.spec.ts` as `substitute`,
  `references` and `substituteStrict`. The two `substituteVars` tests are now one (L2). The strict
  error tests expected "raw value", the in-scope names and `.sous/.env.local` in `message`; now they
  expect them in `message` plus `details`. Why: plugin-api errors carry the fix lines as `details`.
- **resolveScope()**: ported to `src/resolve-block.spec.ts` (`resolveBlock`). "should warn when a var
  uses the reserved sous* namespace" expected a `console.warn`; now `test/plugin.test.ts` expects a
  `warning` through the builder's reporter. Why: services never print (L3). New: setting
  `projectRoot` (or any auto-variable) is an error (S6, "The published package").
- **buildAutoVars()**: now `test/plugin.test.ts` "auto-variables". With a project it expects
  `projectRoot` too, and `sousConfDir`; without one, still only `sousHome`, `sousRootPath`,
  `sousVersion`. Values come from `host.package` and `host.sous-home` stand-ins, not the real package.
  Why: S6 adds `projectRoot` as an auto-variable; package identity belongs to plugin-host.
- **resolveEnvScope()**: expected reads from `process.env` (`vi.stubEnv`); now the engine's `env`.
  Why: services read the environment through `ctx.env` (S6, rule 6).
- **resolveRootScope() "should allow root _vars to reference env-mapped vars"**: set
  `_vars.projectRoot` from `${codeBase}`. Now the same chain uses other names ("should lay sources,
  _env and _vars over the auto-variables in order"), and setting `projectRoot` is tested as an error.
  Why: S6 rules that sous sets `projectRoot`.
- **names.spec "deriveEnvName()"**: `deriveEnvName` is gone; the test checks `sharedName`, which was
  the same function. **secrets.spec "isSecretVariable()"**: now `isSecret`. Why: the
  `variables.names` and `variables.secrets` contracts name them so.

## plugin-build: build, watch and PID tests, ported to `packages/plugin-build`

- **`src/test/watch/watch-service.test.ts` → `src/watch/watcher.spec.ts`**: expected a 300 ms
  debounce and, for several files changed in one window, one call with only the most recent event.
  Now the window is `watch.debounceMs` (default 200, from the plugin-build contract) and the batch
  holds every file changed in it, each once; a full-rebuild path makes the whole batch full. Why:
  watch mode now submits one `build` chain per batch with `changedFiles`, so no change is dropped.
  The "ignored pattern passed to chokidar" test is gone: the state and PID files are ignored by
  path (`classifyChange`), whatever the state file is called.
- **`src/test/watch/compile-watch.test.ts` → `test/watch.test.ts`**: expected `startConfigReloadWatch`
  callbacks (`rebuild`, `reloadConfig`). Now expects `build.watch` to submit `build`/`compile` chains,
  and a full rebuild to rebuild the engine config (its `buildNumber` grows) and restart the watcher.
  Why: S1 makes watch mode a background intent submitting chains; the engine rebuilds the config.
  A changed source no longer drops while a rebuild runs: it is queued for the next chain.
- **`src/test/integration/pid-service.test.ts` → `src/pid.spec.ts`**: `acquire()` and `release()`
  became the `BuildPid` contract (`read`, `isRunning`, `write`, `remove`); the "already running"
  error is tested in `test/build.test.ts` and `test/watch.test.ts`. Same path rules.
- **`src/test/integration/build-service.test.ts` → `test/build.test.ts`**: the tests that check
  written files, the state file and pruning on disk belong to plugin-compiler now (`compiler.compile`,
  `compiler.prune`, `compiler.state`). plugin-build's tests check that `build` runs those intents with
  the right input and in the right order, with compiler stand-ins. `resolveStateFilePath()` tests moved
  with the state file to plugin-compiler.
- **`src/lib/build-preparation.spec.ts` → `src/report.spec.ts`**: "newer versions" is now one note,
  `Newer versions published:` followed by `  <key>: <to> (this project pins <from>)` lines, instead of
  a section with aligned variables. Why: services do not format terminal output (L3); the wording is kept.
- **`src/test/e2e/watch-loop.test.ts` → `test/chokidar.test.ts`**: the real-chokidar test now checks
  `chokidarWatcher` itself (a change arrives; nothing after `close()`).
