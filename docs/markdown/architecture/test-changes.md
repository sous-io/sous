# Test Changes

Every old test that changed during the refactor, grouped by package. Each entry gives the test, its
old file (and new file when it moved), what it expected before, what it expects now, and why.
"Old" means the code before the refactor (commit `6845d0c`), where everything lived under `src/`.

## plugin-liquid

### "should register the bulletList filter…" and "should register the showVars tag…"

- **File:** `src/templating/init-liquid-engine.spec.ts` → `packages/plugin-liquid/test/engine.test.ts`
- **Before:** `createLiquidEngine([])` had `bulletList` and `showVars` built in.
- **Now:** the test adds stand-in `liquid-filter` and `liquid-tag` entities and expects the engine to
  register them. The `showVars` stand-in prints its own simple JSON, so the test checks the dump, not
  the exact `# Sous Debug` heading (that output is tested in plugin-compiler).
- **Why:** the `bulletList` filter and the `showVars` tag now belong to plugin-compiler, which adds
  them as entities. plugin-liquid only registers the filters and tags that entities add.

### "should set engine.options.root…", "should return a Liquid instance", "should not throw when roots is an empty array"

- **File:** same as above.
- **Before / now:** unchanged, except they create the engine through `liquid.engine`'s
  `create({ root })`.

## plugin-skills

All from `src/lib/repos/recipe-targets.spec.ts`, ported to `packages/plugin-skills`.

### "destinationsFor() should default skills to the project's .claude/skills directory"

- **Before:** with nothing configured, skills went to `[<project>/.claude/skills]`.
- **Now:** no destination (`skillDestinations([], [])` is `[]`), no compilation target, and a compile
  warning saying why (`test/plugin.test.ts`, "should add no target and say why when skills go
  nowhere").
- **Why:** the engine no longer has a default skills folder, because no core feature may depend on
  one agent tool. The Claude Code plugin adds `.claude/skills` through its `skill-target` entity.

### "destinationsFor() should substitute variables in configured destinations"

- **Before:** `${root}` was replaced from a scope.
- **Now:** `${var}` is kept as written in `destinationDir` (`outputDir()`), and relative paths are
  placed under `${projectRoot}`.
- **Why:** replacing `${var}` is plugin-variables' job, and this code runs before variables are
  resolved.

### "buildRecipeTargets() should warn once about prompts and copy no memories"

- **Before:** one warning about prompts.
- **Now:** only checks that memories and prompts are not treated as skills (`sources.spec.ts`).
- **Why:** prompts are not plugin-skills' concern; the warning belongs to whichever plugin handles
  prompts.

### "buildRecipeTargets() should report a linked recipe's directory for watching"

- **Now:** dropped.
- **Why:** which directories watch mode follows is plugin-build's `build.watch`, which can read linked
  recipes from the `active-recipe` entities.

### "buildRecipeTargets() should produce one target per contributed file"

- **Before:** each target had a `rootInputPath`.
- **Now:** the field is `entryPoint`, and the destination is `${projectRoot}/...` from a configured
  output or a skill target. Otherwise the same: one target per file, with `globBase` the include's
  static base.

## plugin-formats

### "should derive a missing identity from a hosted repository url" and "... from a local path"

- **File:** `src/lib/repos/formats/lockfile.spec.ts`
- **Before:** the lockfile parser filled in a missing `identity` through a provider.
- **Now:** renamed "should leave a missing identity missing" and "should accept a local path url with
  no identity"; the identity is left missing.
- **Why:** parsing a lockfile never works out an identity; `recipes.lock` does that after parsing.

### The four dependency-ref tests (consumer-side qualifier, local locator, bad ref, range on a namespace)

- **File:** `src/lib/repos/formats/recipe-manifest.spec.ts`
- **Before:** used the real ref parser inside the schema.
- **Now:** pass a stand-in `DependencyRefChecker` to `parseRecipeManifest`.
- **Why:** plugin-formats now receives the ref check from `refs.resolver` instead of importing the
  ref resolver.

### `hash.spec.ts`

- **File:** `src/lib/repos/store/hash.spec.ts`
- **Before / now:** old cases unchanged. New cases cover case-insensitive `equal` and `isHash`.
- **Why:** `hashesEqual` now ignores case, as the `formats.recipe-hash` service promises.

**Only imports changed:** the other formats specs and `load-manifest.spec.ts` (import paths and where
`isConfigError` comes from).

## plugin-variables

From `src/lib/settings.spec.ts`, `src/lib/include-resolver.spec.ts`, `src/lib/vars/names.spec.ts` and
`src/lib/vars/secrets.spec.ts`, ported to `packages/plugin-variables`.

### substituteVars(), findUnresolvedVars(), substituteVarsStrict()

- **File:** `src/lib/settings.spec.ts` and (for `substituteVars()`) `src/lib/include-resolver.spec.ts`
  → `src/substitute.spec.ts`, as `substitute`, `references` and `substituteStrict`.
- **Before:** two copies of the `substituteVars` tests, one per file. The strict error tests expected
  "raw value", the names in scope and `.sous/.env.local` in the error's `message`.
- **Now:** the two `substituteVars` tests are one. The strict error tests expect those in `message`
  plus `details`.
- **Why:** each feature now has one implementation, so its tests are not duplicated. Errors in the
  new plugin API carry the lines that tell you how to fix the problem as `details`.

### resolveScope(), and "should warn when a var uses the reserved sous* namespace"

- **File:** `src/lib/settings.spec.ts` → `src/resolve-block.spec.ts` (`resolveBlock`) and
  `test/plugin.test.ts`
- **Before:** the reserved-name test expected a `console.warn`.
- **Now:** `test/plugin.test.ts` expects a `warning` through the config builder's reporter. New: setting
  `projectRoot` (or any other auto-variable) is an error.
- **Why:** services never print; they report through the interfaces the command layer gives them.
  Sous sets `projectRoot` itself, so a user setting it is a mistake.

### buildAutoVars()

- **File:** `src/lib/settings.spec.ts` → `test/plugin.test.ts`, "auto-variables"
- **Before:** inside a project, the auto-variables were `sousHome`, `sousRootPath` and `sousVersion`,
  read from the real package.
- **Now:** inside a project, `projectRoot` and `sousConfDir` too; outside one, still only `sousHome`,
  `sousRootPath`, `sousVersion`. The values come from stand-ins of `host.package` and `host.sous-home`.
- **Why:** `projectRoot` is now an auto-variable. Knowing which sous package is running belongs to
  plugin-host.

### resolveEnvScope()

- **File:** `src/lib/settings.spec.ts`
- **Before:** read from `process.env` (set with `vi.stubEnv`).
- **Now:** reads the engine's `env`.
- **Why:** services never read `process.env` directly; they use `ctx.env`.

### resolveRootScope() "should allow root _vars to reference env-mapped vars"

- **File:** `src/lib/settings.spec.ts`
- **Before:** set `_vars.projectRoot` from `${codeBase}`.
- **Now:** the same chain of references with other names ("should lay sources, _env and _vars over the
  auto-variables in order"); setting `projectRoot` is tested as an error.
- **Why:** sous sets `projectRoot` itself.

### names.spec "deriveEnvName()" and secrets.spec "isSecretVariable()"

- **File:** `src/lib/vars/names.spec.ts`, `src/lib/vars/secrets.spec.ts`
- **Before:** tested `deriveEnvName` and `isSecretVariable`.
- **Now:** test `sharedName` (the same function as `deriveEnvName`) and `isSecret`.
- **Why:** those are the names the `variables.names` and `variables.secrets` services give them.

## plugin-build

Build, watch and PID tests, ported to `packages/plugin-build`.

### The watch service tests

- **File:** `src/test/watch/watch-service.test.ts` → `src/watch/watcher.spec.ts`
- **Before:** a 300 ms debounce; several files changed in one window gave one call with only the most
  recent event. A test checked the ignored pattern passed to chokidar.
- **Now:** the window is `watch.debounceMs` (default 200), and the batch holds every file changed in
  it, each once. If any change needs a full rebuild, the whole batch is a full rebuild. The
  ignored-pattern test is gone: the state file and PID file are ignored by path (`classifyChange`),
  whatever the state file is called.
- **Why:** watch mode now submits one `build` chain per batch with `changedFiles`, so no change is
  dropped.

### The compile-watch tests

- **File:** `src/test/watch/compile-watch.test.ts` → `test/watch.test.ts`
- **Before:** expected `startConfigReloadWatch` to call `rebuild` and `reloadConfig`.
- **Now:** expects `build.watch` to submit `build`/`compile` chains, and a full rebuild to rebuild the
  engine's config (its `buildNumber` grows) and restart the watcher. A source that changes while a
  rebuild runs is no longer dropped; it is queued for the next chain.
- **Why:** watch mode is now an intent that runs in the background and submits chains, and the engine
  rebuilds the config.

### The PID service tests

- **File:** `src/test/integration/pid-service.test.ts` → `src/pid.spec.ts`
- **Before:** tested `acquire()` and `release()`.
- **Now:** test the `BuildPid` service (`read`, `isRunning`, `write`, `remove`), with the same path
  rules. The "already running" error is tested in `test/build.test.ts` and `test/watch.test.ts`.

### The build service tests

- **File:** `src/test/integration/build-service.test.ts` → `test/build.test.ts`
- **Before:** checked written files, the state file and pruning on disk; also tested
  `resolveStateFilePath()`.
- **Now:** plugin-build's tests check that `build` runs the compiler's intents with the right input and
  in the right order, using compiler stand-ins. The on-disk checks moved to plugin-compiler
  (`compiler.compile`, `compiler.prune`, `compiler.state`), and so did the `resolveStateFilePath()`
  tests, with the state file.

### "newer versions" report

- **File:** `src/lib/build-preparation.spec.ts` → `src/report.spec.ts`
- **Before:** a section with aligned variables.
- **Now:** one note, `Newer versions published:` followed by `  <key>: <to> (this project pins <from>)`
  lines. The wording is kept.
- **Why:** services do not lay out terminal output; that is the command layer's job.

### The real-chokidar test

- **File:** `src/test/e2e/watch-loop.test.ts` → `test/chokidar.test.ts`
- **Now:** checks `chokidarWatcher` itself: a change arrives, and nothing arrives after `close()`.

## plugin-recipe-answers

From `src/lib/vars/*.spec.ts`, ported to `packages/plugin-recipe-answers`.

### Every test in ladder.spec.ts

- **File:** `src/lib/vars/ladder.spec.ts`
- **Before:** an answer's `source.file` was `".env"` or `".env.local"`.
- **Now:** `"shared"` or `"local"`. `recordAnswerInContext` and `lookupEnvName` are now `Ladder.record`
  and `Ladder.lookup`, with the same expectations otherwise.
- **Why:** the service's `AnswerSourceFile` type is `"shell"` or an `EnvFileKind`; plugin-config-files
  decides the file names.

### "parseAnswerPair()", "loadAnswersFile()", "applyProvidedAnswers()"

- **File:** `src/lib/vars/preanswers.spec.ts`
- **Before:** expected `ConfigError`s with the explanation in the message. The answers-file tests read
  YAML and JSONC. A relative answers file was resolved against the given directory.
- **Now:** expect `InputError`s (exit code 2) from `vars.ask`, with the same lines in `details`. The
  file tests read JSON (and a `.env` file). "should resolve a relative answers file against the given
  directory" resolves against `PWD`. `applyProvidedAnswers` is now `storeGivenAnswers`, with the same
  expectations, and a secret's value shows as `(hidden)` in the result.
- **Why:** `recipe-answers.preanswers` is defined to throw an `InputError` for a malformed or unknown
  answer. Parsing YAML and JSONC is plugin-formats' `formats.manifests.readFile`, which is a stand-in
  here. Services never read `process.cwd()`.

### "StaticDefinitionSource", "loadProjectDefinitions()", "loadDefinitionsFile()"

- **File:** `src/lib/vars/definition-source.spec.ts`
- **Before:** definitions were read from the lockfile and the recipe store on disk; the definitions
  file was YAML.
- **Now:** `definitionsFromRecipes` reads the `active-recipe` entities plugin-recipes adds. The
  definitions file is JSON (see above), and the invalid-definition test expects the stand-in parser's
  issue in `details`.
- **Why:** only active recipes count (those reached from subscriptions switched on on this machine),
  and reading the lockfile and store is plugin-recipes' job.

### "writeMappingRecord()" (comments kept, the old `.json` layer migrated, an interrupted write, a missing file)

- **File:** `src/lib/vars/mappings.spec.ts`
- **Before:** tested writing the mappings file on disk.
- **Now:** dropped here. `MappingsService.set`/`remove` are tested against a stand-in `confd.managed`.
  Reading the old `520-var-mappings.json` name is not carried over.
- **Why:** careful, all-or-nothing edits to the `conf.d/5xx` files are plugin-confd's job
  (`confd.managed`).

### "resolveRootScope() with recipe answers"

- **File:** `src/lib/vars/answers.spec.ts`
- **Before:** checked that `_vars` and `_env` win over answers; "should read answers from the project
  when none are handed in"; answers' `byRecipe` was a `Map`.
- **Now:** the `_vars`/`_env` test is dropped here; this plugin now gives the answers as a
  `variable-source` entity (tested in `test/plugin.test.ts`). "should read answers from the project
  when none are handed in" is now the engine test "should give a build its answers". The rest expect the
  same values, with `byRecipe` a plain object.
- **Why:** which value wins is plugin-variables' scope resolution.

### "basicViewLines()", "questionHint()", "nameChoices()", "fileChoices() and committedFileWarning()"

- **File:** `src/lib/vars/ask.spec.ts`
- **Now:** dropped. "askLeadIn()" and "recipeOpeningLine()" are unchanged.
- **Why:** they test the terminal view and the Tab "advanced view". Views moved to plugin-cli, and
  these cannot be expressed through the `Prompter` interface.

### Asking without a terminal (no old unit test; the behavior of `askForMissing`)

- **Before:** a `ConfigError` listing the environment variable names.
- **Now:** a `NonInteractiveError` (exit code 2) naming `--answer <name>=<value>`, with the same names
  in `details`.
- **Why:** anything sous asks at a prompt can also be answered with a flag, and front ends recognize
  the non-interactive error.

## plugin-refs

From `src/services/ref-resolver/**/*.spec.ts` and `src/lib/repos/identity.spec.ts`, ported to
`packages/plugin-refs`. Every case now runs against the `refs.*` services of a real build, with
stand-in `repository-host` entities for GitHub, GitLab and local (`test/fixtures.ts`) and a stand-in
catalog `ref-lookup` (`test/catalog-lookup.ts`, the old `CatalogMatcher`), instead of the Inversify
container and the built-in providers.

### "should raise an error that quotes the input and says why"

- **File:** `parser/ref-parser.spec.ts`
- **Before:** `parse()` threw.
- **Now:** `refs.parser.parse()` returns no readings, with the reasons. `parseError()` (used by
  `refs.resolver`) builds the same `Invalid ref '...': ...` message; the syntax reminder moved from the
  message into `details`.
- **Why:** the parser returns a `RefParseResult`; throwing is the resolver's job.

### Location messages naming the hosts

- **Before:** "sous ships these: github, gitlab".
- **Now:** "sous has these: github, gitlab".
- **Why:** hosts are `repository-host` entities that any plugin may add, so sous no longer ships a
  fixed list.

### `hash-names.spec.ts`

- **Before:** `ProjectHashName.bases({ projectRoot })`, and a `HashNameRegistry` that sorted names,
  refused a name registered twice and built an alias map.
- **Now:** `#project` is a `hash-name` entity whose bases are `ctx.project.root` (empty outside a
  project). An invalid name, or a name with both `bases` and `view`, fails the build through the entity
  kind's schema. Two plugins adding the same id follow the engine's rule (the later one wins). The alias
  and view maps belong to the compiler.
- **Why:** `#` names are now an entity kind, and the project root is defined in one place.

### `ref-picker-service.spec.ts`

- **Before:** the facts were written as aligned lines through `write`, and `choose` was called for
  several matches.
- **Now:** one `notice` through the chain's `Reporter`, whose message is the closing sentence and whose
  details are the facts. The choice is asked through the `Prompter` with `answeredBy: "--accept-first"`.
  When the prompter cannot ask, a `NonInteractiveError` names `--accept-first`, with the candidates in
  `details`.
- **Why:** services never print or prompt themselves, and every question can be answered with a flag.
  Laying out the facts is plugin-cli's view (`ref-report.ts` moves there, with its spec).

### `ref-resolver-service.spec.ts`

- **Before:** lookups were passed as a `lookup` argument; results had `isUnique` and `first()` helpers;
  "should refuse a lookup that cannot answer synchronously" expected a throw; `inspect()` existed;
  "should name a place no pruner speaks for" used an empty container.
- **Now:** lookups are `ref-lookup` entities or the request's `extraLookups`. The result
  (`RefResolution`) is plain data with no helpers. A lookup without `findSync` is skipped by
  `resolveSync`. `inspect()` is gone; the same facts come from `resolveSync` with `refusedIsEmpty` and
  `lookups: false`. The "no pruner" test uses an unknown place name.
- **Why:** that is how the `refs.resolver` service is defined.

### `named-refs.spec.ts`

- **Now:** ported to `refs.format` (`parseNamedRef`, `splitRecipeKey`, `namespaceOfKey`,
  `namespaceRef`, `recipeRef`). The `withRepoName` and `isNamedRef` cases are dropped.
- **Why:** those two functions are not part of the service.

### `ref-helpers.spec.ts`

- **Now:** `isValidRef` and `getRefsInString` became `refs.resolver.isValid` and `findInString`. The
  `getFirstRef` and `pruneRefs` cases are dropped. The location cases moved to `refs.locations`
  (`fromUrl`, and `locationFor`, which now throws instead of returning `undefined`).
- **Why:** `getFirstRef` and `pruneRefs` are not part of the service.

### `glob.spec.ts`

- **Now:** only `isGlobName` and `splitSegments` are tested here.
- **Why:** `hasGlob` belongs to `host.globs`, and `matchName`/`matchNames` to the lookups in
  plugin-recipes.

### `ref-search.spec.ts`

- **Now:** the repository and location cases are in `test/search.test.ts`. The variable and
  environment-variable cases moved with `VariableLookup` and `EnvVarLookup` to plugin-recipe-answers.

### Not ported: `container.spec.ts`, `dependency.spec.ts`, and the lookup specs (`cached-index`, `fetched-index`, `recorded-dependency`, `chained-lookup`, `variable`, `env-var`)

- **Why:** there is no container any more, and the code of the others moved to plugin-recipes and
  plugin-recipe-answers as `ref-lookup` entities.

**Only imports changed:** `src/lib/repos/identity.spec.ts`, whose cases now test `repositoryIdentity`,
`identitySegments` and `shortNameFromIdentity` in `locations/identity.ts`.

## plugin-config-files and plugin-confd

Config discovery, the config kernel, env files and managed layers, ported to
`packages/plugin-config-files` (`src/env/*.spec.ts`, `src/loader.spec.ts`, `test/main-config.test.ts`,
`test/config-set.test.ts`) and `packages/plugin-confd` (`src/managed.spec.ts`,
`test/confd-files.test.ts`).

### "should throw ConfigError listing every file when multiple primaries exist"

- **File:** `config-discovery.spec.ts` → `test/main-config.test.ts`, "should warn when a .sous directory
  holds several main config files"
- **Before:** a `ConfigError`.
- **Now:** the first name in the search order is read, and sous warns.
- **Why:** sous reports a risky choice instead of forbidding it.

### "should throw when a conf.d layer's baseName collides…", "…differ only by extension", `assertUniqueLayerBaseNames()`

- **File:** `config-discovery.spec.ts` → `test/confd-files.test.ts`, "should refuse files that
  differ only in their extension, naming both"
- **Before:** a `ConfigError`.
- **Now:** a `ConfigError` again, with the old wording ("Duplicate config layer baseName"). For a
  while sous warned and read both instead; the switch-over brought the error back, because the old
  CLI tests (`config validate`, `build`) expect the build to stop.

### "should find sous.config.yaml (and CONFIG_FILE_NAMES lists yaml, not yml)"

- **File:** `config-discovery.spec.ts`
- **Before:** `.yml`, `.ts` and `.mts` were not main config names.
- **Now:** they are, tried in the order `ts, mts, js, mjs, jsonc, json, yaml, yml` (the order
  `packages/sous` uses).
- **Why:** `.ts` config files are now imported in the same process, and sous accepts the spellings
  people are likely to use.

### `candidateDirs`, `discoverConfig`, `resolveConfigFlag`, `expandHome`, `formatNotFoundMessage`

- **File:** `config-discovery.spec.ts`
- **Now:** not ported here.
- **Why:** finding the project is `packages/sous`' job (`findProject`).

### "runs a configure() export that mutates currentConfig by reference", and the other `configure(cfg, builder)` cases

- **File:** `config-kernel.test.ts`
- **Before / now:** same behavior. `configure` now gets the config builder; the old style still works,
  because the first argument also reads and writes a copy of the config, whose changes become patches.

### "supports builder.env()…"

- **File:** `config-kernel.test.ts`
- **Before:** set `process.env`.
- **Now:** passes the variable in the engine's environment.
- **Why:** services never read `process.env` directly.

### "validates the MERGED result… The primary config file is named in the message"

- **File:** `config-kernel.test.ts`
- **Before:** the message named the primary config file.
- **Now:** the message names the file that set the unknown key (`conf.d/20-typo.json`), taken from the
  builder's record of which file set each value.
- **Why:** the config builder now records where every value came from.

### "reports a .js configure() throw once, without the spurious tsx require-cycle artifact"

- **File:** `config-kernel.test.ts`
- **Now:** just expects one error naming the file.
- **Why:** config files are loaded in the same process now; there is no second attempt under tsx in a
  child process.

### Trace-mode snapshots

- **File:** `config-kernel.test.ts`
- **Now:** not ported.
- **Why:** the engine's `BuiltConfig.layers()` and `contributions()` replace the trace, and
  plugin-inspect shows them.

### "loadSettings() flat-schema guard"

- **File:** `settings.spec.ts`
- **Before:** the migration steps were in the error message.
- **Now:** they are in the error's `details`; the message names the file.

### "should return an empty object when the layer does not exist"

- **File:** `managed-layer.spec.ts` → `src/managed.spec.ts`
- **Before:** an empty object.
- **Now:** `confd.managed.read()` gives `undefined`.
- **Why:** that is how `ConfdManaged.read` is defined.

### "should insert new keys in sorted position", and the sorted keys of `writeManagedLayer`

- **File:** `managed-layer.spec.ts`
- **Before:** new keys were inserted in sorted order.
- **Now:** dropped. A new key is added at the end of its object; the order a person wrote is still
  kept.
- **Why:** edits go through the documents package, whose `setKey` appends.

### "should treat removing a key from a layer that does not exist as done"

- **File:** `managed-layer.spec.ts`
- **Before:** the empty file was written with its header.
- **Now:** no file is written.
- **Why:** nothing changed, so there is nothing to write.

### "should honor an explicit conf.d directory", `removeManagedLayer`

- **File:** `managed-layer.spec.ts`
- **Now:** not ported.
- **Why:** the conf.d directory comes from `ProjectInfo.confDir`, and `confd.managed` has no remove.

### `config-inspect.spec.ts`

- **Now:** not ported.
- **Why:** path syntax is the documents package's `parsePath`; the JSON views belong to plugin-cli and
  plugin-inspect.

**Only imports changed:** `src/lib/env-local.spec.ts` and `src/lib/env-file.spec.ts` (`parseEnvLocal`
is now `parseEnv`; the environment type is `MutableEnvironment`, not `NodeJS.ProcessEnv`).

## plugin-init

### The project scaffold tests

- **File:** `src/lib/project-scaffold/index.spec.ts` → `packages/plugin-init/test/init.test.ts`, run
  through the `init` handler
- **Before:** the scaffolded config held `_vars.projectRoot` and `recipes.skills.outputs` with
  `.claude/skills`. The `json` format wrote `sous.config.json`. "should refuse to overwrite any file it
  would write" expected a refusal. Files were reported as relative paths, and the package.json outcomes
  were `present` / `added` / `absent`.
- **Now:**
  - "should write a config that loads through the real settings loader" reads the config back through
    `config-files.loader` and expects the starter target, no `_vars`, and no `.claude`.
  - The `json` format writes `sous.config.jsonc` (with comments), so its `$schema` case reads the
    commented file.
  - "should refuse to overwrite any file it would write" expects the existing file to be kept and
    listed in `kept`. The refusal stays only for a `.sous/` that already holds a main config.
  - Files are reported as absolute paths, and the package.json outcomes are `already-declared` /
    `added` / `no-package-json`.
  - The sous-managed `.gitignore` block comes from `host.gitignore`, and the sous directories get their
    READMEs from `host.directories`.
- **Why:** sous sets `projectRoot` itself (setting it is an error), and skill folders come from agent
  tool plugins, not from the starter config. The init result has a `kept` list.

## plugin-update

### The registry tests

- **File:** `src/lib/self-update/registry.spec.ts` → `packages/plugin-update/test/registry.test.ts`
- **Before:** used an injected `fetch`; failure messages held the hints; there was an abort-signal case.
- **Now:** the stand-in is an http service, since the fetch is `host.http.get`. Failure messages are
  the first line of the `ConfigError`, with the hints in `details` ("answered 404 Failed for <url>" with
  the registry hint in `details`; a failed request is "Could not read the list of published ...
  versions from <url>" with the reason in `details`). The abort-signal case is gone with the signal; the
  timeout is the `timeoutMs` passed to `host.http`.

### The plan tests

- **File:** `src/lib/self-update/plan.spec.ts` → `test/plan.test.ts`
- **Before:** installs carried a package manager's name. The Yarn Berry case asserted yarn's own flags.
  "unsupported-manager" carried a `manualCommand`, and its message named the manager.
- **Now:** installs carry a `package-manager` entity, so the commands in the expectations come from
  stand-in entities with the flags the real plugins use. The Yarn Berry case no longer checks yarn's
  flags (that is plugin-yarn's test). "unsupported-manager" has no `manualCommand`, and its message does
  not name the manager.
- **Why:** each package manager is now its own plugin. When no plugin claims a project, sous does not
  know the manager's name or its `add` command.

### The installs tests

- **File:** `src/lib/self-update/installs.spec.ts` → `test/installs.test.ts`
- **Before:** used fake command runners and real lockfiles; tested `projectManager()`,
  `isWorkspaceRoot()`, `yarnLockVersion()` and the Plug'n'Play location cases.
- **Now:** the `findProjectInstallInfo` and `findGlobalInstalls` cases drive stand-in entities
  (`detect`, `installed`). The detection cases are not ported here. `declaredDependency()` and
  `classifyRunning()` are unchanged.
- **Why:** detecting the package manager moved to plugin-npm, plugin-pnpm and plugin-yarn.

### The update command

- `commands/update.ts` had no spec; `test/update.test.ts` is new.

**Only formatting changed:** `src/lib/self-update/versions.spec.ts` → `test/versions.test.ts` (import
path and 4-space indentation).

## plugin-github, plugin-gitlab, plugin-local

From `src/lib/repos/providers/*.spec.ts`, ported to `packages/plugin-github`, `packages/plugin-gitlab`,
`packages/plugin-local` and `packages/repository-hosts`.

### GitlabProvider "should read the index from the instance's raw endpoint"

- **File:** → `plugin-gitlab/src/host.spec.ts`, "should use the API address with the project path
  encoded"
- **Before:** `https://<host>/<group>/<repo>/-/raw/HEAD/sous.index.json`.
- **Now:** the API address with the whole project path encoded,
  `https://<host>/api/v4/projects/<group>%2F<sub>%2F<repo>/repository/files/sous.index.json/raw?ref=HEAD`.
- **Why:** for a private repository the raw address redirects to the sign-in page even with a valid
  token; the API address accepts the token.

### findGitlabToken() "should prefer GITLAB_TOKEN and fall back to the glab command line tool"

- **Before:** `glab auth token`, and any non-empty output was taken as the token.
- **Now:** `glab config get token --host <host>`, tried after `git credential fill`, only when glab is
  installed. Output is accepted only as one line with no whitespace, so help text printed with exit
  code 0 is refused.
- **Why:** glab 1.114.0 has no `auth token` subcommand; it prints its help and exits 0, so sous could
  take the help text as the token.

### findGithubToken() "should prefer GITHUB_TOKEN and fall back to the gh command line tool"

- **Before:** `gh auth token`.
- **Now:** `GITHUB_TOKEN`, then `GH_TOKEN`, then `git credential fill`, then
  `gh auth token --hostname <host>`, with the same one-line check.
- **Why:** sous now looks for a token in the same places for every host, and `GH_TOKEN` is the other
  variable gh itself reads.

### GithubProvider "should read the index from the raw host…" and "should send GITHUB_TOKEN as a bearer token"

- **Before:** the index was read from the raw host, with the token sent there when one was found.
- **Now:** with a token, sous asks the contents API
  (`api.github.com/repos/<o>/<r>/contents/sous.index.json?ref=HEAD`); the raw host is asked only with
  no token.
- **Why:** sous tries HTTP with a token first, then without. The API is the documented way to read a
  private file with a token, and it sends an ETag.

### GithubProvider / GitlabProvider "should raise a ConfigError when the host answers with an error"

- **Before:** a `ConfigError` from one fetch.
- **Now:** one `RepositoryReadError` that lists every way sous tried to read the repository, and the
  fixes.
- **Why:** sous now tries several ways in turn, and when all fail it reports each of them in one error.

### LocalProvider "should explain a directory that publishes no index"

- **Before:** one message about a directory with no index and no git.
- **Now:** the same facts come as the attempts of one read error
  (`working tree: the working tree has no sous.index.json`, `git: not a git repository …`).
- **Why:** the local host reads through the same list of attempts as every other host.

### ProviderBase write-path refusals ("should refuse every write-path call…", "providers without the proposals feature")

- **Before:** calling `fork` and the like on the local provider threw a `ConfigError`.
- **Now:** the local entity has no such methods (`proposeChange` is `undefined`).
- **Why:** the methods that write to a host are optional; only hosts with the `submit` or `proposals`
  feature have them.

### GitlabProvider features

- **Before:** `["fetch", "submit"]`.
- **Now:** `["fetch", "submit", "proposals"]`, using `glab mr list/view/update`.
- **Why:** plugin-gitlab now supports merge requests as proposals.

### `requireProvider()`, `builtInProviders()`, `detectProvider()`, `assertLocalRepoDirectory()`

- **Now:** not ported. `looksLikeLocalPath()` and `resolveRepoArgument()` now take `cwd` and `home`
  instead of reading `process.cwd()` and the home directory.
- **Why:** choosing a host for a URL is `refs.locations` (plugin-refs) and the repository entry's job
  (plugin-recipes); checking that a path holds a repo manifest needs `formats.manifests`. Services
  never read `process.cwd()` directly.

## plugin-recipes

### TrustService "should fail hard in a non-interactive run"

- **File:** `src/lib/repos/trust.spec.ts` → `packages/plugin-recipes/src/part-a/**/*.spec.ts`
- **Before:** a `NonInteractiveError` whose message listed every repository and the
  `sous repo add … --trust` commands.
- **Now:** the error names `--yes` as the flag that answers the question; the repositories and
  commands (spelled with `--yes`) are its `details`.
- **Why:** questions go through the chain's `Prompter`, and every question can be answered with a flag.

### TrustService "should write the trust notice before asking"

- **File:** `src/lib/repos/trust.spec.ts`
- **Before:** the colored notice on the console.
- **Now:** the notice is reported as `notice` lines through the chain's reporter; only its wording is
  checked.
- **Why:** services never print; plugin-cli decides how it looks.

### SubscriptionService unsubscribe "written in the project's own config"

- **File:** `src/lib/repos/subscription-service.spec.ts`
- **Before:** a `ConfigError` saying to remove it by hand.
- **Now:** a `SousError` that also names `sous subscription disable <ref>`.
- **Why:** there are now `subscription enable` and `subscription disable` commands.

### SubscriptionService re-reading `conf.d/510-subscriptions.jsonc`

- **File:** `src/lib/repos/subscription-service.spec.ts`
- **Before:** tests relied on the 510 layer overriding a later layer.
- **Now:** not ported. A later layer's `enabled: false` now wins, and `subscription enable` warns that
  it does.
- **Why:** re-reading the 510 layer after the merge meant a later layer could not switch a subscription
  off. Sous now always reads the built config.

### RecipeStore gc

- **File:** `src/lib/repos/store/recipe-store.spec.ts`
- **Now:** the report also has `dryRun`, and `maxBytes` and `keep` default to `store.maxBytes` and this
  project's pins.
- **Why:** that is how `StoreGcReport` and `StoreGcOptions` are defined.

### catalog `describeRecipe` and `describeNamespace`

- **File:** `src/lib/repos/catalog.spec.ts`
- **Before:** took a ref string and resolved it inside.
- **Now:** take the repository and key already found; matching a ref is `findInCatalog`, over readings
  from `refs.resolver`. `contents[].destinations` is `[]`.
- **Why:** resolving refs is plugin-refs' job, and where each kind of file lands is the job of
  plugin-skills and plugin-memories.

### locked-recipes `listLockedRecipes`

- **File:** `src/lib/repos/locked-recipes.spec.ts`
- **Now:** not ported.
- **Why:** the active recipes are the `active-recipe` entities that `recipes.fetch` adds;
  `recipes.active` lists them and says why each other locked recipe is skipped. Only recipes reached
  from subscriptions switched on on this machine are active.

### update-plan.spec (`formatUpdatePlan`)

- **Now:** not ported here.
- **Why:** it formats output for the terminal, so it belongs with the views; `recipe.update` returns
  the plan as data.

### lock-service "diff … lines"

- **File:** `src/lib/repos/lock-service.spec.ts` → `packages/plugin-recipes/src/part-b/**/*.spec.ts`
- **Before:** `diff().lines`.
- **Now:** the lines come from `describeLockDiff(diff)`.
- **Why:** `LockDiff` has no `lines`; wording is presentation.

### lock-service "restore … throws when the index does not offer the version"

- **File:** `src/lib/repos/lock-service.spec.ts`
- **Before:** a throw.
- **Now:** the failure is listed in `RestoreReport.failed`.
- **Why:** `RestoreReport` has a `failed` list.

### lock-service restore with no keys

- **File:** `src/lib/repos/lock-service.spec.ts`
- **Before:** every pin was restored.
- **Now:** only the pins in force here, those reached from the subscriptions switched on.
- **Why:** a switched-off subscription downloads nothing on this machine, and subscriptions sous adds
  itself follow the same rule.

### resolver `missingManifests`

- **File:** `src/lib/repos/resolver.spec.ts`
- **Now:** the field is `unreadable`.
- **Why:** that is the name the service gives it.

### index-cache, seed and core-recipe "warns …"

- **File:** `src/lib/repos/providers/index-cache.spec.ts`, `src/lib/repos/seed.spec.ts`,
  `src/lib/repos/core-recipe.spec.ts`
- **Before:** a console warning.
- **Now:** a `problem` field on a stale lookup, an `onMismatch` callback, or `skippedBecause`.
- **Why:** services never print.

### core-recipe tests about the repository's own lockfile pin and the npm `files` list

- **File:** `src/lib/repos/core-recipe.spec.ts`
- **Now:** not ported.
- **Why:** they test the published package, not the plugin.

### namespace-resolver "should refuse a recipe the project does not subscribe to" (`projectScope`)

- **File:** `src/lib/repos/namespace-resolver.spec.ts`
- **Before:** project templates could not address a recipe the project does not subscribe to.
- **Now:** dropped. Project templates may address every active recipe.
- **Why:** the real resolver never set `projectScope`, and only active recipes are known to it.

### `formatNamespaceProblem()`

- **File:** `src/lib/repos/namespace-resolver.spec.ts`
- **Now:** not ported here.
- **Why:** describing a failed include is plugin-compiler's job.

### git-clone `repoNameFromUrl` and "recognize clonable forms"

- **File:** `src/lib/repos/git-clone.spec.ts`
- **Now:** `repoNameFromUrl` is dropped (the function no longer exists). "recognize clonable forms" is
  split into `looksLikeRepoUrl` (URL and SCP forms) and `looksLikeLocalPath` (paths).
- **Why:** the link intent tells paths and URLs apart before either is used.

### links `applyManagedIgnoreBlock`

- **File:** `src/lib/repos/links.spec.ts`
- **Now:** not ported; `ensureLocalFilesIgnored` is tested through `host.gitignore`.
- **Why:** the sous-managed `.gitignore` block belongs to `host.gitignore` (plugin-host).

### recipe-config-layers "listRecipeConfigLayers reads the lockfile and store"

- **File:** `src/lib/repos/recipe-config-layers.spec.ts`
- **Before:** read the lockfile and the store.
- **Now:** `readRecipeConfigLayers` reads the `active-recipe` entities.
- **Why:** `recipes.fetch` finds the recipes, and config layers come only from active ones.

## plugin-compiler

Compiling, includes, the state file, tags and filters, and pruning, ported to
`packages/plugin-compiler`. Every compile test now goes through a real engine and `compiler.compile`,
with targets in the config (`compilation.targets`). An output's variables are its `_vars`, an alias is
`_aliases` or a `hash-name` entity, the include scope is `_vars`, and the namespace resolver is the
`compiler.namespace-resolver` service. Messages are read from the chain's reporter, not `console`.

### Unrendered `.tpl.` warnings: "should warn and name the file when a .tpl. source is written with no vars", "should fail the compile for an unrendered .tpl. file when strict is set", "should not warn when the output has an empty vars object", "should not warn for a non-.tpl. source written with no vars"

- **File:** `src/test/integration/compilation.test.ts` → `test/compilation.test.ts`
- **Before:** a `WITHOUT BEING RENDERED` warning for an output with no `vars`.
- **Now:** removed.
- **Why:** every output now renders with its scope. The old code noted that a config build could never
  reach this case (only hand-built `CompilationConfig`s could), so the warning and its check are gone.

### "should treat a warning as an error in strict mode and carry on" and "should leave a warning a warning without strict mode"

- **File:** `src/test/integration/compilation.test.ts` → `test/compilation.test.ts`
- **Before:** used the unrendered-template warning.
- **Now:** use the other compile warning, an `entryGlob` that matches nothing.
- **Why:** the old warning no longer exists. An empty glob was a plain printed warning before; it is now
  a compile warning, so `strict` fails on it.

### "should error when includeSourceComments is a non-boolean value"

- **File:** `src/test/integration/compilation.test.ts` → `test/compilation.test.ts`
- **Before:** a `must be a boolean` message from the compile.
- **Now:** building the config fails, naming `compilation.includeSourceComments`. "should not error
  when includeSourceComments is present but undefined" is covered by the default.
- **Why:** plugins register their config keys with a schema, and the `compilation` key's schema checks
  the value when the config is built.

### "should write a state file…" and "should record newly created output directories…"

- **File:** `src/test/integration/compilation.test.ts` → `test/compilation.test.ts`
- **Now:** also expect each entry's `target` and `origin`, and every directory level created.
- **Why:** the state file now records which recipe each file came from.

### The circular include test

- **File:** `src/test/integration/compilation.test.ts` → `test/compilation.test.ts`
- **Before:** only "does not throw".
- **Now:** also expects the compile to fail with `Circular dependency detected`.

### `inferGlobBase` and the `destinationDir`/`globBase` tests

- **File:** `src/lib/markdown-compiler.spec.ts` → `src/paths.spec.ts`
- **Now:** the `inferGlobBase` tests are gone; the `destinationDir`/`globBase` tests check
  `resolveOutputPath` directly.
- **Why:** finding a glob's static base is `host.globs.staticBase`, tested in plugin-host.

### The include resolver tests

- **File:** `src/lib/include-resolver.spec.ts` → `src/includes.spec.ts`
- **Now:** unchanged expectations, through adapters over `planInclude`/`resolveIncludeFiles`.
  "substituteVars()" is gone. The `~/` test passes the home directory in instead of setting
  `process.env.HOME`. `buildAliasMap` takes a `substitute` function instead of a scope.
- **Why:** replacing `${var}` is plugin-variables' job, and services never read `process.env`.

### The include containment tests

- **File:** `src/lib/include-resolver.containment.spec.ts` → `src/includes.containment.spec.ts`
- **Now:** unchanged; the resolver is the static one in `test/namespace-resolver.ts`.
- **Why:** that static resolver was only ever used by tests, so it moved out of the source.

### The state file tests

- **File:** `src/lib/state.spec.ts` → `src/state.spec.ts`, `src/writer.spec.ts`
- **Before:** tested `hashFile`, `recordDirCreation` and `didSousCreateDir`; `StateService.load()` gave
  `null` for a missing or broken file; `deleteTrackedFiles`; `getFilePath()` fell back to
  `process.cwd()`.
- **Now:** the first three are gone (the writer records directories itself). `StateService.load()` gives
  an empty state. `deleteTrackedFiles` is `compiler.writer`'s `remove()`, which also refuses untracked
  files. The `process.cwd()` fallback is gone, and the path tests are in `test/prune.test.ts`.
- **Why:** services never read `process.cwd()`.

### Prune and `resolveStateFilePath`

- **File:** `src/test/integration/build-service.test.ts` → `test/prune.test.ts`
- **Before:** any file under an active `destinationDir` was kept.
- **Now:** same expectations through `compiler.prune`, but a prune counts outputs file by file, so a
  glob target's output whose source is gone is pruned too.

### Include globs, aliases, namespaces and the get-files tag

- **File:** `src/test/integration/{include-globs,alias-includes,alias-render,namespace-includes,get-files-tag}.test.ts`
  → `test/includes.test.ts`
- **Now:** same expectations. `#lib` aliases are `hash-name` entities.
  - "should refuse a user alias that starts with # or ~" expects the config build to fail (the
    `_aliases` schema).
  - "should resolve a repo-qualified, differently cased recipe reference" is not ported.
  - "should prefer the exact spelling of a recipe name" runs against the static test resolver.
- **Why:** the case rules for recipe names belong to the real namespace resolver in plugin-recipes.

### The entry glob alias tests

- **File:** `src/test/integration/entry-glob-aliases.test.ts` → `test/targets.test.ts`
- **Now:** same, except "should expand alias entryGlobs in the watch config" is not ported, and
  `#project` comes from plugin-refs' `hash-name` entity instead of a `_vars.projectRoot` override.
- **Why:** the watch settings are plugin-build's, and sous sets `projectRoot` itself.

### resolveCompilation()

- **File:** `src/lib/settings.spec.ts` → `test/targets.test.ts`
- **Before:** "should throw when a target has both…/neither…" threw from `resolveCompilation`; "should
  return null when project has no compilation config" expected `null`.
- **Now:** the first expects the config build to fail (the schema); the second expects the schema's
  defaults.

### Tags, filters and their helpers

- **File:** `src/templating/{tags,filters,lib}/*.spec.ts` → `src/liquid/*.spec.ts`
- **Now:** unchanged expectations. `registerShowVarsTag(engine)` and the rest are shims in
  `test/liquid.ts` that register the `liquid-tag`/`liquid-filter` entities. The "very probably a
  secret" cases use a stand-in of `variables.secrets`. (`src/templating/init-liquid-engine.spec.ts`
  went to plugin-liquid; see above.)

## plugin-authoring

From `src/lib/repos/release/*.spec.ts`, `src/lib/repos/contribute.spec.ts`,
`src/lib/repos/scaffold/index.spec.ts` and `src/test/integration/repo-{release,submit,contribute}.test.ts`,
ported to `packages/plugin-authoring`.

Every module now takes the services it uses (`git.runner`, the format parsers, `formats.recipe-hash`,
`refs.*`, `variables.names`, `repository-host` entities) as one bundle, so the specs call
`validateRepo(tools, dir)`, `buildIndex(tools, git, options)` and so on, with stand-ins of those plugins
in `test/support/standins.ts`. Expectations are otherwise unchanged, except for these.

### "isCommittedAndUnchanged() should be true only for a tracked path with no pending changes"

- **File:** `git-state.spec.ts` → `src/shared/git.spec.ts`
- **Now:** not ported.
- **Why:** nothing used the function.

### "hasCommitIdentity()"

- **File:** `git-state.spec.ts` → `src/shared/git.spec.ts`
- **Before:** failed through a stand-in `CommandRunner`.
- **Now:** fails through a stand-in `GitRunner`.

### "readIndexFile() should throw a readable error for an index that does not validate"

- **File:** `index-builder.spec.ts`
- **Before:** the message matched `/repo index/`.
- **Now:** it matches `/sous\.index\.json/`.
- **Why:** the wording is the index parser's (plugin-formats), which names the file.

### The settle tests, and "should fail on a tie, naming the /* form"

- **File:** `settle.spec.ts`
- **Before:** indexes were served by a fake `fetch` behind the old providers. The tie test expected the
  canonical spellings `gitlab://a/b/c/-/d/*` and `gitlab://a/b/-/c/d`.
- **Now:** indexes come from an injected index reader; reading through a host is tested on its own
  (`readIndexThroughHost()`, new). The tie test checks the `/*` form and the "each of these publishes
  it" list.
- **Why:** writing the canonical spelling of a ref is plugin-refs' job.

### The submit service tests

- **File:** `submit-service.spec.ts` → `src/submit/submit.spec.ts`
- **Before:** used the old provider; result fields `provider`, `usedFork`, `url`, `committed` (paths)
  and `changelog.compared`. "should refuse a new proposal without a title when nothing can ask"
  expected `/needs a title/`.
- **Now:**
  - The host is a stand-in `repository-host` entity, the questions go to a `Prompter`, and notices and
    warnings to a `BufferedReporter`.
  - Fields renamed: `provider` → `host`, `usedFork` → `fromFork`, `url` → `proposal.url`,
    `committed` → `committedPaths`. `changelog` is the rendered Markdown, so "should say so when there
    is no upstream branch" checks for "could not compare this change" instead of
    `changelog.compared === false`.
  - The no-title test expects `/--title/`, the flag the non-interactive error names.
  - "should spawn nothing but git of its own accord" now holds by construction (host commands are
    entity methods) and only checks that git ran.
- **Why:** these are the field names of the service's result. Every question can be answered with a
  flag, so the error names the flag.

### The submit question tests

- **File:** `submit-questions.spec.ts`
- **Now:** not ported as such. The questions are asked through the chain's `Prompter` with
  `answeredBy` (`--title`, `--body`, `--yes`, `--next-branch`), covered by `submit.spec.ts`.
  `--next-branch <name>` (new) answers the "continue on a new branch" question.

### The submit checkout tests, and "should use a clone that is no longer linked, and say so"

- **File:** `submit-checkout.spec.ts` → `src/submit/checkout.spec.ts`
- **Now:** rewritten against a `recipes.links` stand-in. The no-longer-linked test is not ported.
- **Why:** where `repo link` clones is plugin-recipes' business, and `recipes.links` does not expose it.

### The contribute tests, and "locatorArgs()"

- **File:** `contribute.spec.ts` → `src/contribute/{contribute,pending}.spec.ts`
- **Before:** steps ran as oclif argv; "locatorArgs()" passed the config-locating flags on.
- **Now:** steps are intents run with `ctx.run`, so `startStep`/`submitStep`/`unlinkStep` are checked by
  their input and by `commandLine()`. "locatorArgs()" is not ported.
- **Why:** chained intents share the chain's config, so the config-locating flags no longer need
  passing on.

### "should write every file a new repository needs" and "should write a release workflow that checks pull requests and publishes merges"

- **File:** `scaffold/index.spec.ts` → `src/scaffold/scaffold.spec.ts`
- **Before:** expected `.github/workflows/sous-release.yml`, and a test of the release workflow.
- **Now:** with no host named or found, no CI file. The workflow test is replaced by "should write the
  CI files of the host it is given" and two tests for picking the host.
- **Why:** core features must not depend on one host. The GitHub workflow belongs to plugin-github
  (`scaffoldFiles`).

### The repo release tests

- **File:** `src/test/integration/repo-release.test.ts` → `src/release/release.spec.ts`
- **Before:** ran in a child process. Included "should accept --non-interactive and refuse to publish,
  naming --yes" and the `repo submit` cases.
- **Now:** the same cases through the handler, each on its own repository. The `--non-interactive` test
  is covered by "should refuse to publish with nothing to ask and no --yes". The `repo submit` cases are
  in `submit.spec.ts`.

### The repo contribute and repo submit tests

- **File:** `src/test/integration/repo-contribute.test.ts`, `repo-submit.test.ts`
- **Now:** covered by `contribute.spec.ts` (through a stand-in intent runner) and `submit.spec.ts`. The
  `gh` stand-in script is now a stand-in host entity.

## plugin-memories

### "the #memories view"

- **File:** `packages/plugin-memories/test/plugin.test.ts`
- **Before:** `view.bases(ctx)` returned `[]`.
- **Now:** `view.bases` is `undefined`.
- **Why:** plugin-refs' `hash-name` schema refuses a name with both `bases` and `view`, so the
  `#memories` entity has only `view`. Without this change, an engine with every built-in plugin failed
  to start.

## sous

### `repo add --provider` in the command inventory

- **File:** `packages/sous/test/fixtures/command-inventory.json`
- **Before:** `--provider` was an option flag whose choices included `github`, `gitlab` and `local`.
- **Now:** `--provider` is a string flag.
- **Why:** `--provider` now takes the id of any loaded `repository-host` entity, including a plugin's
  own host, which is the more versatile choice. The hosts load after `repo.add`'s input schema is
  fixed, so the schema cannot list them; `repo.add` checks the value against the loaded hosts and names
  them when it is not one. `github`, `gitlab` and `local` work as before.

## Switch-over: the old CLI tests

### Where the old CLI tests went

- **File:** `src/test/integration/*.test.ts` (every test that runs the CLI as a process) →
  `packages/sous/test/integration/`; their helpers → `packages/sous/test/utils/`; the recipe-repository
  fixture → `packages/sous/test/fixtures/recipe-repos/`.
- **Before:** each test ran `bin/run.js`, the old oclif CLI, and imported a few helpers from `src/lib`
  (the version, the gitignore markers, the file-format parsers, the managed-layer reader, the store
  hash).
- **Now:** each test runs the bundled bin, built once per test run by `test/global-setup.ts` (into a
  directory of its own, so test runs side by side never overwrite each other's bin). The helpers come
  from the packages (`@sous-io/plugin-formats` for the hash and the parsers, plugin-host for the
  gitignore markers) or from small files in `test/utils/` (`package-info.ts` for the version,
  `managed-layer.ts` for reading a `conf.d` layer). `whole-build.test.ts` works out a local
  repository's identity itself instead of calling the old provider code. The `env` objects are typed
  as `NodeJS.ProcessEnv`, since the package type-checks its tests and the old repository did not.
- **Why:** these tests are the safety net of the switch-over, and the old code they reached into is
  deleted. `SOUS_BUDGETS=off` is set for them: time-budget warnings would make the output they check
  depend on how busy the machine is.

### "should print the version" (the bin test)

- **File:** `packages/sous/test/bin.test.ts`
- **Before:** expected the output to start with a digit.
- **Now:** accepts a leading `v`.
- **Why:** sous prints `v0.2.34`, as the old CLI did.

### findProject()

- **File:** `packages/sous/src/project.spec.ts`
- **Before:** "should accept a .sous directory without a config file" expected a bare `.sous/` to be a
  project.
- **Now:** "should pass over a .sous directory without a config file, and a .sous file": discovery
  keeps walking up past a `.sous/` that holds no config file, as the old CLI did. New tests cover
  `--config`, `SOUS_CONFIG`, `SOUS_DIR` and `--sous-confd`.
- **Why:** the user-level sous directory (`~/.sous`) has no config file and is not a project; the old
  rule kept it from being taken for one.

### projectRoot in _vars

- **File:** `packages/plugin-variables/test/plugin.test.ts` ("should refuse projectRoot in the root
  _vars"), `packages/plugin-variables/src/resolve-block.spec.ts`
- **Before:** `_vars.projectRoot: "${sousDir}/.."` failed the build.
- **Now:** a value other than the one sous sets is refused when the scope resolves; writing it the way
  sous sets it is accepted and ignored. A new test covers the accepted case.
- **Why:** every config the old `sous init` wrote holds that line, and so do the old CLI tests'
  fixtures; refusing it would break every existing project.

### Contributors that read sous.entities directly

- **File:** `packages/core/test/config-loop.test.ts`
- **Before:** "should warn when a contributor reads sous.entities directly" expected a warning.
- **Now:** "should note, at the debug level, ..." expects a debug message and no warning.
- **Why:** the note is for the plugin's author. As a warning it printed on every command (the recipe
  store's setup reads the pointer-file entities), which users can do nothing about.

### The contributor budget

- **File:** `packages/core/test/timing.test.ts`
- **Before:** a contributor's default budget was 50ms.
- **Now:** 100ms.
- **Why:** the built-in core-recipe contributor measured 50–80ms on ordinary runs, so 50ms warned on
  nearly every command.

### package-identity: the package name

- **File:** `packages/plugin-host/src/package-identity.spec.ts`
- **Before:** found the package under `@sous-io/sous` and `@sous-io/sous-next`.
- **Now:** only `@sous-io/sous`.
- **Why:** packages/sous is now the published `@sous-io/sous`; the temporary name is gone.

## Switch-over: vars

### Error messages read from standard error (vars commands)

- **File:** `packages/sous/test/integration/vars-commands.test.ts` ("should fail without a terminal…",
  "should resolve the name it is asked about at every scope", "should fail on an ambiguous name…",
  "should narrow by repository, namespace and variable flags", "should refuse a name that matches
  nothing", "should report a malformed definitions file readably", "should refuse a definition with no
  description and no example")
- **Before:** looked for the error message on standard output.
- **Now:** looks for it in standard output and standard error together. The exit codes and wording it
  checks are unchanged.
- **Why:** the old CLI printed errors on standard output; the new one prints them, and its progress
  notes, on standard error, so they never mix with a command's result.

### Messages the vars unit tests check

- **File:** `packages/plugin-recipe-answers/test/plugin.test.ts` ("should narrow to one recipe, and to a
  namespace"), `packages/plugin-recipe-answers/src/definitions.spec.ts` ("should report an invalid file
  with the file and the field")
- **Before:** expected "Nothing this project's recipes define matches 'nothing'", and a problem line
  "type: is required".
- **Now:** expect "Nothing called 'nothing' was found" and "- variables[0].type: is required", under
  "Invalid variable definitions file at …".
- **Why:** the plugin now words these errors as the old CLI did, which the old CLI tests check. The
  engine in `plugin.test.ts` is also given a project, since the vars commands now need one, as before.

## Switch-over: authoring (repo release, repo submit, repo contribute)

- **Tests:** `packages/sous/test/integration/repo-release.test.ts` and `repo-submit.test.ts`, every
  assertion about what a run printed.
  - **Before:** they read standard output alone (`result.stdout`).
  - **Now:** they read both streams together (`result.output`, standard output then standard error).
  - **Why:** the new CLI reports a command's progress (the checks, the plan, each step, what to do
    next) through the reporter, which writes to standard error so it never mixes with `--json`
    output. The old CLI printed the same lines on standard output. The words are unchanged.
- **Test:** `repo-contribute.test.ts`, "should link the repository on a generated branch".
  - **Before:** exactly one banner in the output.
  - **Now:** at most one banner.
  - **Why:** the new CLI prints the banner only on a terminal, and the test runs with none. What the
    test guards (a chained run never prints a second banner) still holds.
- **Test:** `plugin-authoring/src/contribute/contribute.spec.ts`, "should say which steps completed
  when one fails".
  - **Before:** the failure said "this step failed" and "What had already been done:".
  - **Now:** it says "The contribution stopped", "Failed step: ..." and "These steps had completed
    before it, and no later step ran:", as the old command did.
  - **Why:** the new wording was brought back to the old command's, which the old CLI test checks.

## Switch-over: config and inspect (config show, get, validate)

- **Test:** `packages/core/test/order-and-stages.test.ts`, the unknown top-level key message.
  - **Before:** `mystery: Not a known config key. (set by confd/610-mac.jsonc)`.
  - **Now:** `mystery: Not a known config key; likely a typo. (set by confd/610-mac.jsonc)`.
  - **Why:** the old CLI said an unknown key was "likely a typo", and the old `config validate` test
    checks for that word.
- **Test:** `packages/plugin-inspect/src/inspect.spec.ts`, "should read config files as written".
  - **Before:** the files were read straight from disk.
  - **Now:** the test adds a stand-in `config-files.loader`, because `--raw` now reads each file
    through it (the same text the build used).
- **Test:** `packages/plugin-inspect/src/inspect.spec.ts`, "should report issues and name the
  contributor".
  - **Before:** a good config gave exactly `{ ok: true, issues: [] }`.
  - **Now:** it gives at least that; the result also carries a summary (the config file, how many
    files were read, the targets and the tools), which `config validate` prints, as the old command
    did.
- The old CLI tests in `config-commands.test.ts`, `multi-source-e2e.test.ts` and
  `overrides-e2e.test.ts` were not changed.

## Switch-over: setup (init, update, the hand-off)

### `sous init`, through the CLI

- **File:** `packages/sous/test/integration/init-command.test.ts`
- **Before:** "should set the project up" expected `pinned: core/sous-skills at version X` on
  standard output. "should write a JSON config" expected `--format json` to write
  `.sous/sous.config.json` and read its `$schema` with `JSON.parse`.
- **Now:** the `pinned:` line is looked for on standard output and standard error together. The JSON
  case expects `.sous/sous.config.jsonc` and reads `$schema` out of the text.
- **Why:** the first build reports its progress (the lockfile pins among it) on standard error, as
  every build now does. The `json` format writes JSON with comments under the `.jsonc` name (see
  "plugin-init" above).

### `sous init`, the plugin tests

- **File:** `packages/plugin-init/test/init.test.ts`, `packages/plugin-init/test/index.test.ts`
- **Before:** five cases assumed the default format was `json` (`sous.config.jsonc`), and the format
  list was `["json", "js"]`. "should keep files that already exist" and "should write nothing on a dry
  run" expected the handler to report "Kept ..." and "Nothing was written".
- **Now:** the cases about the JSON config pass `format: "json"`; the failed-build case looks for
  `sous.config.js`; the format list is `["js", "json"]`. The two notices are no longer expected from
  the handler: the `init` view prints the files written, kept or planned (relative to the project,
  as `wrote .sous/sous.config.js` and `[Dry Run] would write ...`) and the dry run notice.
- **Why:** `js` (`sous.config.js`) is the default again, as in the old CLI. The file list moved to the
  view so it reaches standard output in the old wording.

### `sous update`, through the CLI

- **File:** `packages/sous/test/integration/update-command.test.ts`
- **Before:** with no terminal, expected `Error: Sous has to ask "Update the global install from
  0.2.30 to 0.2.34?"` and `pass '--yes'`.
- **Now:** expects `Error: sous needed to ask "Update the global install from 0.2.30 to 0.2.34?"` and
  `Pass --yes`.
- **Why:** a question that cannot be asked is one error for every command now (plugin-api's
  `NonInteractiveError`), with that wording. The exit code (1) and what it names are the same.

### `update`, the plugin tests

- **File:** `packages/plugin-update/test/update.test.ts`, `test/helpers.ts`
- **Before:** expected the handler to report "Nothing was installed" (dry run) and "There is no
  install of sous here", and the build result to be exactly `{ result, directory, exitCode }`.
- **Now:** those two messages are printed by the `update` view (the handler reports only each command
  as it runs, failures, and the plan a question is about); the build result also holds the command
  that ran. The stand-in context has an `engine` with `configError`. New: a case for a config this
  copy could not load (`configProblem` in the result).
- **Why:** the view prints the old layout on standard output (command variables with the registry,
  the plans, the commands that ran, the summary), so the handler no longer repeats it.

### The `init` and `update` views

- **File:** `packages/plugin-cli/src/views/domains/setup.spec.ts`
- **Before:** the `init` dry run printed only the `package.json` notice; with no plans `update`
  printed nothing; "Then builds" said only "yes".
- **Now:** the `init` view lists the files (`wrote`, `kept`, `[Dry Run] would write`) and the dry run
  notice; `update` opens with the command variables, says when there is nothing to update, names the
  build directory ("yes with the new copy, in /p"), shows the commands that ran, and warns about a
  config it could not load. New cases cover the warning, the notices and a Plug'n'Play location.
- **Why:** the old commands printed all of this on standard output.

## Switch-over: the CLI front end (help, usage errors, exit codes)

The help screen and usage errors went back to the old CLI's layout and words, so
`packages/sous/test/integration/help-and-flags.test.ts` passes unchanged. The new front end's own
tests had been written against the first new layout, and were brought in line:

### Help layout

- **Files:** `packages/plugin-cli/test/cli.test.ts` (help cases), `packages/sous/test/bin.test.ts`
- **Before:** expected `Usage:\n  sous namespace list [<repository>] [flags]`, `Commands:`,
  `Aliases:\n  sous render`, `Examples:` and `<repository>` as the argument name.
- **Now:** expect `USAGE\n  $ sous namespace list [REPOSITORY] [flags]`, `TOPICS` and `COMMANDS`
  (a group's commands listed by their full words, `repo add`), `ALIASES\n  $ sous render`,
  `EXAMPLES` and `REPOSITORY`.
- **Why:** the old CLI's help used these section titles and upper-case argument names, and the
  old tests (help-and-flags, repo-release, vars-commands, repositories) look for them.

### Usage error wording

- **Files:** `packages/plugin-cli/test/cli.test.ts` (mistakes, extra arguments, schema problems),
  `packages/plugin-cli/src/parse.spec.ts`
- **Before:** `There is no flag --priorty. Did you mean --priority?`, `--name needs a value.`,
  `"sous namespace list" takes at most 1 argument, but was also given "b".`, and a bad `--mode`
  choice reported as `The input to "repo.add" is not valid.` with `--mode:` and `<url>:` lines.
- **Now:** `Nonexistent flag: --priorty` with `Did you mean --priority?` under it, `Flag --name
  expects a value`, `Unexpected argument: b` with the "takes at most 1 argument" line under it,
  `Expected --mode=maybe to be one of: trusted, untrusted`, and `Missing 1 required arg:` naming the
  argument. Each is followed by the command's help on standard error, exit code 2.
- **Why:** these are the old CLI's (oclif's) words, which the old tests expect.

### A question that cannot be asked exits 1

- **Files:** `packages/plugin-cli/test/cli.test.ts` ("should fail a question it cannot ask"),
  `packages/plugin-cli/src/errors.spec.ts`, `packages/plugin-api/src/errors.spec.ts`
- **Before:** `NonInteractiveError` exited 2, and the CLI printed only the error.
- **Now:** it exits 1, and the command's help follows the error on standard error.
- **Why:** the old CLI exited 2 only for command lines it could not parse, and printed the help under
  a question it could not ask. Bad input (`InputError`) still exits 2.

## Switch-over: build

### `memories-view.test.ts`: the project builds `CLAUDE.md`, not `OUT.md`

- **File:** `packages/sous/test/integration/memories-view.test.ts`
- **Before:** the project built its one output to `OUT.md`, and the tests read that file.
- **Now:** the project builds its one output to `CLAUDE.md`, and the tests read that file. The checks are the same.
- **Why:** Claude Code now has a memory target: unless a project builds `CLAUDE.md` itself, sous writes a `CLAUDE.md`
  holding every memory. With the output at `OUT.md`, that file included every memory, so the warning about memories
  no output includes rightly stayed silent. A target from the project's own config now wins over a plugin's
  target for the same file, so building `CLAUDE.md` puts the test back where it was: memories reach the output only
  through include lines, and the warning names the rest.

### `launch-passthrough.test.ts`: the official repository is switched off

- **File:** `packages/sous/test/integration/launch-passthrough.test.ts`
- **Before:** the config named only the tools; the old `sous launch --no-build` never read recipes.
- **Now:** the config also sets `repos: { "sous-recipes": { enabled: false } }`. The checks are the same.
- **Why:** every command now reads the recipes while it builds the config, so the test reached GitHub. Launching
  must not depend on the network.

### Unincluded-memory warning cases from `src/test/integration/memories-warning.test.ts`

- **File:** `packages/plugin-build/test/build.test.ts` and `packages/plugin-build/src/report.spec.ts`
- **Before:** drove the old build service with a stand-in store.
- **Now:** the full-build, included-memory, partial-build and failed-compile cases run the `build` intent with
  stand-ins; the wording case checks `unincludedMemoriesMessage()`.
- **Why:** the check moved from the old build service into plugin-build.

## Switch-over: repos and links

### `repo-commands.test.ts`: "should link an existing checkout by path"

- **File:** `packages/sous/test/integration/repo-commands.test.ts`
- **Before:** `.sous/repos/` held `.gitignore`, `AGENTS.md`, `CLAUDE.md` and `README.md`, and `AGENTS.md` pointed at the README.
- **Now:** it holds `.gitignore`, `CLAUDE.md` and `README.md`; the `AGENTS.md` check is gone.
- **Why:** pointer files now come from plugins: each harness that reads its memory file in any directory adds
  one. Claude Code (`CLAUDE.md`) is the only built-in harness that does, so no `AGENTS.md` is written.

### `src/test/integration/per-file-rendering.test.ts` (10 cases)

- **File:** `packages/plugin-compiler/test/compilation.test.ts`, "per-file Liquid rendering"
- **Before:** drove the old `CompilationService` class, read its console output, and called `includedFiles()`.
- **Now:** run `compiler.compile` with the real Liquid, variables and host plugins; an output's variables are its
  `_vars`; "unchanged" is read from the result's `action`, and the files read from its `included`. Nine cases
  check the same things. The tenth, "should name a .tpl. child that could not render for lack of vars", now checks
  that such a child renders (an unknown variable gives an empty value) with no warning.
- **Why:** the old class is gone, and every output now has the project's variables, so the unrendered `.tpl.`
  warning was removed (see "Unrendered `.tpl.` warnings" above).

## Switch-over: setup (the hand-off)

### The hand-off to a project's own sous, through the CLI

- **File:** `packages/sous/test/integration/project-install-e2e.test.ts`
- **Before:** the project copy was made with `npm pack` at the repository root and extracted into a
  project's `node_modules`; its bin was `bin/run.js`, and "Invoked install" named the repository
  root.
- **Now:** the project copy is the published package's layout built in place: the bundle
  (`scripts/bundle.mjs` into `<copy>/dist/bin.js`), `packages/sous/package.json` with its version
  relabelled, the packaged core recipe and `packages/sous/node_modules` (both symlinked). Its bin is
  `dist/bin.js`, and "Invoked install" names `packages/sous`.
- **Why:** the published package is `packages/sous` now; the repository root is a workspace named
  `sous-workspace`, which the hand-off rightly refuses as not being sous. Building the copy directly
  keeps the test from running the package's `prepack` (which copies files into `packages/sous` while
  other tests run). The cases themselves are unchanged.

### The hand-off, the unit tests

- **File:** `src/lib/project-install.spec.ts` → `packages/sous/src/hand-off.spec.ts`
- **Before:** tested `src/lib/project-install.mjs`; `planHandoff` and `handOffToProjectInstall` could
  be called without `argv`.
- **Now:** the same cases against `src/hand-off.ts`, each passing `argv: []` where it passed none. New:
  `resolveOwnRoot()` finds the invoked install's package root above the bin's directory.
- **Why:** the module is TypeScript now and `argv` is required.

## Switch-over: release tooling

- `packages/sous/test/integration/sync-core-version.test.ts`: the fixture repository wrote its
  version into a `package.json` at its root. It now writes it into `packages/sous/package.json`,
  because the repository root is a private workspace root and the published sous package lives
  there; the script reads the version from that file. The "no package.json" test still expects
  the same message, now about that path. One test was added: every other
  `packages/<name>/package.json` is set to the same version (only its `version` value changes),
  and a package already at it is left byte for byte, because every workspace package is released
  at one version and `pnpm pack` writes plugin-api's version into the published sous's dependency.

## Switch-over: subscriptions and catalog

- **`repositories.test.ts`, "should ask about an untrusted repository a dependency needs" and
  "should write nothing when the confirmation is declined"**
  - **Before:** drove the old in-process `SubscriptionService` with injected `ask` and `write`
    functions; the plan question was `Proceed?`.
  - **Now:** they run the `subscription.add` intent in process, with every built-in plugin and a
    prompter that answers from a function (`test/utils/in-process.ts`), and read what the chain
    reported. The plan question is `Subscribe to 'workflow/needs-partials'?`. What they check is
    unchanged: the repository is named with its URL and identity, declining writes nothing.
  - **Why:** the service class is gone; the intent is what every front end runs.
- **`repositories.test.ts`, "should add a repository with --trust ...", and `core-namespace.test.ts`,
  "should explain the directories it created under the user-level sous directory"**
  - **Before:** each directory sous made held `README.md`, `AGENTS.md` and `CLAUDE.md`.
  - **Now:** `README.md` and `CLAUDE.md`; the `AGENTS.md` checks are gone.
  - **Why:** pointer files come from the harnesses now (see the `repo-commands.test.ts` entry above);
    only Claude Code adds one.
- **`repositories.test.ts`, "should restore a fresh clone", "should subscribe to a recipe named by a
  bare name", "should take the first candidate with --accept-first", "should build the project as
  part of adding and removing a subscription", "should leave the outputs untouched with --no-build"**
  - **Before:** looked for "Restoring recipes", the resolved ref and "Building the project" on
    standard output.
  - **Now:** on standard output and standard error together.
  - **Why:** a build and a ref resolution report as they go through the reporter, on standard error,
    as every command now does (see the authoring entry above). The words are unchanged.
- **`recipe-trust.test.ts`, "should refuse a recipe config layer that tries to add a tool command"**
  - **Before:** `tools` was absent from `config show`.
  - **Now:** `tools` is absent or `{}`.
  - **Why:** the `tools` key has a default of `{}` now; the test still proves no tool was added.
- **`whole-build.test.ts`, "should restore a missing recipe in sous init"**
  - **Before:** the new project held the lockfile and the repository layer.
  - **Now:** it also holds a subscriptions layer subscribing to `workflow/alpha`.
  - **Why:** only a pin a switched-on subscription reaches is restored (see "lock-service restore
    with no keys" above).
- **`plugin-refs`: `format.spec.ts`, `resolver.spec.ts`, `test/search.test.ts`**
  - **Before:** `refs.format.key()` of `r:workflow/alpha` was `r:workflow/alpha`.
  - **Now:** `workflow/alpha`; the cases that tell two repositories apart use `refs.format.identity()`.
  - **Why:** `key()` is the stored key its contract describes, with no repository: configs, lockfiles
    and indexes key recipes that way, and a release recorded a dependency in another repository under
    a key the index format refuses.
- **`plugin-recipes/src/part-a/config-keys.spec.ts`** (new): the "Repositories keys" cases of the old
  `src/lib/config-schema.spec.ts` (a URL is required and must be one sous can read, a repo name is
  kebab-case, a subscription key has no qualifier or range, a range is a real range, store numbers are
  whole, unknown keys in an entry are refused), against the `config-key` schemas. Unknown keys are
  named "Not a known key." where the old schema said "unknown key(s)".
- **View and unit specs** (`plugin-cli` `catalog.spec.ts`, `repos.spec.ts`; `plugin-build`
  `report.spec.ts`; `plugin-recipes` `intents.spec.ts`): `recipe show` expects "What subscribing
  installs" and the old question wording; `subscription list` always has a latest column; the build
  states a newer version as `<key>: <to> this project pins <from>`; `subscription.list` returns
  `latest`; the `vars.ask` after subscribing is no longer narrowed to the new recipe. Each follows
  the old CLI's output.
