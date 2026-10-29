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

## plugin-recipe-answers: `src/lib/vars/*.spec.ts` → `packages/plugin-recipe-answers`

- **`ladder.spec.ts`, every test**: expected an answer's `source.file` to be `".env"` or
  `".env.local"`. Now expects `"shared"` or `"local"`. Why: the contract's `AnswerSourceFile` is
  `"shell"` or an `EnvFileKind` (plugin-config-files names the files). `recordAnswerInContext` and
  `lookupEnvName` are now `Ladder.record` and `Ladder.lookup`; same expectations otherwise.
- **`preanswers.spec.ts`, "parseAnswerPair()", "loadAnswersFile()", "applyProvidedAnswers()"**:
  expected `ConfigError`s with the explanation in the message. Now expect `InputError`s (exit code 2)
  on `vars.ask`, with the same lines in `details`. Why: the contract says
  `recipe-answers.preanswers` throws an `InputError` for a malformed or unknown answer. The YAML and
  JSONC file tests now read JSON (and a `.env` file), since parsing YAML and JSONC is
  plugin-formats' `formats.manifests.readFile`, stood in here. "should resolve a relative answers
  file against the given directory": now resolves against `PWD` (services never read
  `process.cwd()`, S6 rule 6). `applyProvidedAnswers` is now `storeGivenAnswers`, same expectations,
  with a secret's value shown as `(hidden)` in the result.
- **`definition-source.spec.ts`, "StaticDefinitionSource" and "loadProjectDefinitions()"**: expected
  definitions read from the lockfile and the store on disk. Now `definitionsFromRecipes` reads the
  `active-recipe` entities plugin-recipes adds. Why: only active recipes count (S4, 3), and reading
  the lockfile and store is plugin-recipes' concern (S6). "loadDefinitionsFile()": the YAML file
  is now JSON (see above); the invalid-definition test expects the stand-in parser's issue in
  `details`.
- **`mappings.spec.ts`, "writeMappingRecord()" (comments kept, the old `.json` layer migrated, an
  interrupted write, a missing file)**: dropped here. Now `MappingsService.set`/`remove` are tested
  against a stand-in `confd.managed`. Why: surgical, atomic edits to `conf.d/5xx` files are
  plugin-confd's concern (S6, `confd.managed`). Reading the old `520-var-mappings.json` name is
  not carried over.
- **`answers.spec.ts`, "resolveRootScope() with recipe answers"**: dropped here. Why: `_vars` and
  `_env` winning over answers is plugin-variables' scope resolution; this plugin now gives the
  answers as a `variable-source` entity (tested in `test/plugin.test.ts`). "should read answers from
  the project when none are handed in" is now the engine test "should give a build its answers".
  The rest expect the same values, with `byRecipe` a plain object instead of a `Map`.
- **`ask.spec.ts`, "basicViewLines()", "questionHint()", "nameChoices()", "fileChoices() and
  committedFileWarning()"**: dropped. Why: they test the terminal view and the Tab "advanced view",
  which are presentation (S6: views move to plugin-cli) and cannot be expressed through the
  `Prompter` interface. "askLeadIn()" and "recipeOpeningLine()" are unchanged.
- **Asking without a terminal** (no old unit test; `askForMissing`'s behavior): was a
  `ConfigError` listing the environment names. Now a `NonInteractiveError` (exit code 2) naming
  `--answer <name>=<value>`, with the same names in `details`. Why: L4, and front ends recognize the
  non-interactive kind.

## plugin-refs: `src/services/ref-resolver/**/*.spec.ts` and `src/lib/repos/identity.spec.ts` → `packages/plugin-refs`

Every case runs against the services of a real build (`refs.*`) with stand-in `repository-host`
entities for GitHub, GitLab and local (`test/fixtures.ts`) and a stand-in catalog `ref-lookup`
(`test/catalog-lookup.ts`, today's `CatalogMatcher`), instead of the Inversify container and the
built-in providers.

- **`parser/ref-parser.spec.ts` "should raise an error that quotes the input and says why"**: expected
  `parse()` to throw. Now `refs.parser.parse()` returns no readings with the reasons, and
  `parseError()` (used by `refs.resolver`) builds the same `Invalid ref '...': ...` message; the
  syntax reminder moved from the message into `details`. Why: the S6 contract returns a
  `RefParseResult`; throwing is the resolver's job.
- **Location messages naming the hosts**: expected "sous ships these: github, gitlab". Now expects
  "sous has these: github, gitlab". Why: hosts are `repository-host` entities any plugin may add, so
  sous no longer ships a fixed list (S6, "refs and repos").
- **`hash-names.spec.ts`**: expected `ProjectHashName.bases({ projectRoot })`, a `HashNameRegistry`
  that sorts names, refuses a name registered twice and builds an alias map. Now `#project` is a
  `hash-name` entity whose bases are `ctx.project.root` (empty outside a project); an invalid name or
  a name with both `bases` and `view` fails the build through the kind's schema; two plugins adding
  one id follow core's rule (the later one wins); the alias and view maps belong to the compiler.
  Why: S6 makes `#` names an entity kind, and the project root has one definition (ruled 2026-10-25).
- **`ref-picker-service.spec.ts`**: expected the facts written as aligned lines through `write`, and
  `choose` called for several matches. Now expects one `notice` through the chain's `Reporter` whose
  message is the closing sentence and whose details are the facts, the choice asked through the
  `Prompter` with `answeredBy: "--accept-first"`, and a `NonInteractiveError` (naming
  `--accept-first`, the candidates in `details`) when the prompter cannot ask. Why: L3 and L4; the
  layout of the facts is plugin-cli's view (`ref-report.ts` moves there, with its spec).
- **`ref-resolver-service.spec.ts`**: lookups are `ref-lookup` entities or the request's
  `extraLookups`, not a `lookup` argument; `RefResolveResult` helpers (`isUnique`, `first()`) are gone
  (the contract's `RefResolution` is plain data). "should refuse a lookup that cannot answer
  synchronously" expected a throw; now a lookup without `findSync` is skipped by `resolveSync` (the
  contract says so). `inspect()` is gone; the same facts come from `resolveSync` with
  `refusedIsEmpty` and `lookups: false`. "should name a place no pruner speaks for" now uses an
  unknown place name instead of an empty container.
- **`named-refs.spec.ts`**: ported to `refs.format` (`parseNamedRef`, `splitRecipeKey`,
  `namespaceOfKey`, `namespaceRef`, `recipeRef`). `withRepoName` and `isNamedRef` are not in the
  contract and their cases are dropped.
- **`ref-helpers.spec.ts`**: `isValidRef` and `getRefsInString` became `refs.resolver.isValid` and
  `findInString`; `getFirstRef` and `pruneRefs` are not in the contract and their cases are dropped.
  The location cases moved to `refs.locations` (`fromUrl`, `locationFor`, which now throws instead of
  returning `undefined`).
- **`glob.spec.ts`**: `hasGlob` belongs to `host.globs` (S6), and `matchName`/`matchNames` to the
  lookups in plugin-recipes; only `isGlobName` and `splitSegments` stay here.
- **`ref-search.spec.ts`**: the repository and location cases are ported to `test/search.test.ts`.
  The variable and environment-variable cases move with `VariableLookup` and `EnvVarLookup` to
  plugin-recipe-answers (S6, "vars and refs").
- **Not ported here**: `container.spec.ts` (no container), `dependency.spec.ts` and the lookup specs
  (`cached-index`, `fetched-index`, `recorded-dependency`, `chained-lookup`, `variable`, `env-var`):
  their code moves to plugin-recipes and plugin-recipe-answers as `ref-lookup` entities.
- **`lib/repos/identity.spec.ts`**: unchanged cases, now for `repositoryIdentity`, `identitySegments`
  and `shortNameFromIdentity` in `locations/identity.ts`.

## plugin-config-files and plugin-confd: config discovery, the config kernel, env files, managed layers

Ported to `packages/plugin-config-files` (`src/env/*.spec.ts`, `src/loader.spec.ts`,
`test/main-config.test.ts`, `test/config-set.test.ts`) and `packages/plugin-confd`
(`src/managed.spec.ts`, `test/confd-files.test.ts`).

- **`src/lib/env-local.spec.ts`, `src/lib/env-file.spec.ts`**: unchanged except imports
  (`parseEnvLocal` is now `parseEnv`; the env type is `MutableEnvironment`, not `NodeJS.ProcessEnv`).
- **`config-discovery.spec.ts` "should throw ConfigError listing every file when multiple primaries
  exist"**: expected a `ConfigError`. Now the first name in the search order is read and sous warns
  (`main-config.test.ts`, "should warn when a .sous directory holds several main config files").
  Why: L6 (report, never forbid).
- **`config-discovery.spec.ts` "should throw when a conf.d layer's baseName collides…", "…differ only by
  extension", `assertUniqueLayerBaseNames()`**: expected a `ConfigError`. Now both files are read and
  sous warns (`confd-files.test.ts`, "should warn about files that differ only in their extension").
  Why: L6.
- **`config-discovery.spec.ts` "should find sous.config.yaml (and CONFIG_FILE_NAMES lists yaml, not
  yml)"**: now `.yml`, `.ts` and `.mts` are main config names too, tried first to last as
  `ts, mts, js, mjs, jsonc, json, yaml, yml` (the order `packages/sous` uses). Why: S2 (`.ts` files
  are imported in-process), the robustness principle.
- **`config-discovery.spec.ts` `candidateDirs`, `discoverConfig`, `resolveConfigFlag`, `expandHome`,
  `formatNotFoundMessage`**: not ported here. Finding the project is `packages/sous`' (`findProject`).
- **`config-kernel.test.ts` "runs a configure() export that mutates currentConfig by reference" and the
  other `configure(cfg, builder)` cases**: unchanged in behavior. `configure` now gets the builder
  (S2); the old style still works because the first argument also reads and writes a copy of the
  config, whose changes become patches.
- **`config-kernel.test.ts` "supports builder.env()…"**: set `process.env`. Now passes the variable
  in the engine's environment. Why: S6, rule 6 (services never read `process.env`).
- **`config-kernel.test.ts` "validates the MERGED result… The primary config file is named in the
  message"**: now the message names the file that set the unknown key (`conf.d/20-typo.json`), from
  the builder's record of who set what. Why: S2, "Where a value came from".
- **`config-kernel.test.ts` "reports a .js configure() throw once, without the spurious tsx
  require-cycle artifact"**: now just expects one error naming the file; there is no second attempt
  under tsx. Why: S2, "No child process".
- **`config-kernel.test.ts` trace-mode snapshots**: not ported. `BuiltConfig.layers()` and
  `contributions()` replace them (core), shown by plugin-inspect.
- **`settings.spec.ts` "loadSettings() flat-schema guard"**: the migration steps moved from the
  message to the error's `details`; the message names the file.
- **`managed-layer.spec.ts` "should return an empty object when the layer does not exist"**: now
  `confd.managed.read()` gives `undefined`. Why: the contract (`ConfdManaged.read`).
- **`managed-layer.spec.ts` "should insert new keys in sorted position" and the sorted keys of
  `writeManagedLayer`**: dropped. A new key is added at the end of its object. Why: edits go through
  the documents package (S2), whose `setKey` appends; the order a person gave is still kept.
- **`managed-layer.spec.ts` "should treat removing a key from a layer that does not exist as done"**:
  expected the empty file to be written with its header. Now no file is written. Why: nothing changed.
- **`managed-layer.spec.ts` "should honor an explicit conf.d directory", `removeManagedLayer`**: not
  ported. The conf.d directory comes from `ProjectInfo.confDir`; the contract has no remove.
- **`config-inspect.spec.ts`**: not ported. Path syntax is the documents package's `parsePath`; the
  JSON views belong to plugin-cli and plugin-inspect.

## plugin-init and plugin-update

- **`lib/project-scaffold/index.spec.ts`** (now `plugin-init/test/init.test.ts`, run through the
  `init` handler): the scaffolded config no longer holds `_vars.projectRoot` (sous sets it; setting it
  is an error) or `recipes.skills.outputs` with `.claude/skills` (skill targets come from plugins), so
  "should write a config that loads through the real settings loader" now reads the config back
  through `config-files.loader` and expects the starter target, no `_vars`, and no `.claude`. The
  `json` format writes `sous.config.jsonc` (with comments) instead of `sous.config.json`, so its
  `$schema` case reads the commented file. "should refuse to overwrite any file it would write" now
  expects the existing file to be kept and listed in `kept` (the contract has `kept`); the refusal
  stays only for a `.sous/` holding a primary config. Files are reported as absolute paths, the
  package.json outcomes are `already-declared` / `added` / `no-package-json` (were `present` / `added`
  / `absent`), the sous-managed ignore block comes from `host.gitignore`, and the sous directories get
  their READMEs from `host.directories`.
- **`lib/self-update/versions.spec.ts`** (now `plugin-update/test/versions.test.ts`): only the import
  path and 4-space indentation changed.
- **`lib/self-update/registry.spec.ts`** (now `test/registry.test.ts`): the fetch is `host.http.get`,
  not an injected `fetch`, so the stand-in is an http service. Failure messages are now the first line
  of the `ConfigError` with the hints in its `details` ("answered 404 Failed for <url>" with the
  registry hint in `details`; a failed request is "Could not read the list of published ... versions
  from <url>" with the reason in `details`). The abort-signal case is gone with the signal: the
  timeout is the `timeoutMs` passed to `host.http`.
- **`lib/self-update/plan.spec.ts`** (now `test/plan.test.ts`): installs carry a `package-manager`
  entity instead of an agent name, so the commands in the expectations come from stand-in entities
  with the flags the real plugins plan. The Yarn Berry case no longer asserts yarn's own flags (that
  is plugin-yarn). "unsupported-manager" no longer carries a `manualCommand` and its message no longer
  names the manager: no plugin claims such a project, so sous does not know its name or its `add`
  command.
- **`lib/self-update/installs.spec.ts`** (now `test/installs.test.ts`): detection moved to the
  package-manager plugins (S6), so `projectManager()`, `isWorkspaceRoot()`, `yarnLockVersion()` and
  the Plug'n'Play location cases are not ported here (they belong to plugin-npm, plugin-pnpm and
  plugin-yarn). The `findProjectInstallInfo` and `findGlobalInstalls` cases now drive stand-in entities
  (`detect`, `installed`) instead of fake command runners and real lockfiles. `declaredDependency()`
  and `classifyRunning()` cases are unchanged.
- **`commands/update.ts`'s flow** had no spec; `test/update.test.ts` is new.

## plugin-github, plugin-gitlab, plugin-local: `src/lib/repos/providers/*.spec.ts`, ported to `packages/plugin-{github,gitlab,local}` and `packages/repository-hosts`

- **GitlabProvider "should read the index from the instance's raw endpoint"**: expected
  `https://<host>/<group>/<repo>/-/raw/HEAD/sous.index.json`. Now expects the API address with the
  whole project path encoded, `https://<host>/api/v4/projects/<group>%2F<sub>%2F<repo>/repository/files/sous.index.json/raw?ref=HEAD`
  (`plugin-gitlab/src/host.spec.ts`, "should use the API address with the project path encoded").
  Why: S4, problem 1.
- **findGitlabToken() "should prefer GITLAB_TOKEN and fall back to the glab command line tool"**:
  expected `glab auth token`, and any non-empty output taken as the token. Now expects
  `glab config get token --host <host>`, tried after `git credential fill`, only when glab is
  installed, and output accepted only as one line with no whitespace; help text printed with exit 0
  is refused. Why: S4, problem 2 and "Token sources".
- **findGithubToken() "should prefer GITHUB_TOKEN and fall back to the gh command line tool"**:
  expected `gh auth token`. Now expects `GITHUB_TOKEN`, then `GH_TOKEN`, then `git credential fill`,
  then `gh auth token --hostname <host>`, with the same one-line check. Why: S4, "Token sources"; the
  contract adds `GH_TOKEN`.
- **GithubProvider "should read the index from the raw host…" / "should send GITHUB_TOKEN as a bearer
  token"**: expected the raw host, with the token on it when one was found. Now a token is sent to
  the contents API (`api.github.com/repos/<o>/<r>/contents/sous.index.json?ref=HEAD`), and the raw
  host is asked only with no token. Why: S4's strategy order (HTTP with token, then without); the
  API is the documented way to read a private file with a token, and sends an ETag.
- **GithubProvider/GitlabProvider "should raise a ConfigError when the host answers with an error"**:
  expected a `ConfigError` from one fetch. Now one `RepositoryReadError` lists every strategy tried
  and the fixes. Why: S4, "When everything fails".
- **LocalProvider "should explain a directory that publishes no index"**: expected one message about
  a directory with no index and no git. Now the same facts come as the attempts of one read error
  (`working tree: the working tree has no sous.index.json`, `git: not a git repository …`). Why: the
  local host reads through read strategies like every host (S4).
- **ProviderBase write-path refusals ("should refuse every write-path call…", "providers without the
  proposals feature")**: expected a `ConfigError` from calling `fork` etc. on the local provider. Now
  the local entity has no such methods (`proposeChange` is `undefined`). Why: the contract makes
  write-path methods optional, present only on hosts with `submit`/`proposals`.
- **GitlabProvider features**: expected `["fetch", "submit"]`. Now `["fetch", "submit", "proposals"]`,
  with `glab mr list/view/update`. Why: plugin-gitlab's contract.
- **`requireProvider()`, `builtInProviders()`, `detectProvider()` and `assertLocalRepoDirectory()`
  tests**: not ported. Why: choosing a host for a URL is `refs.locations` (plugin-refs) and the
  repository entry's concern (plugin-recipes); checking a path holds a repo manifest needs
  `formats.manifests`. `looksLikeLocalPath()` and `resolveRepoArgument()` now take `cwd` and `home`
  instead of reading `process.cwd()` and the home directory (S6, rule 6).

## plugin-recipes, part A: `src/lib/repos/{trust,catalog,declarations,locked-recipes}.spec.ts`, `store/recipe-store.spec.ts`, parts of `subscription-service.spec.ts` → `packages/plugin-recipes/src/part-a/**/*.spec.ts`

- **TrustService "should fail hard in a non-interactive run"**: expected a `NonInteractiveError`
  whose message listed every repository and the `sous repo add … --trust` commands. Now the error
  names `--yes` as the flag that answers the question, and the repositories and commands are its
  `details` (spelled `--yes`). Why: questions go through the chain's `Prompter` (L3, L4).
- **TrustService "should write the trust notice before asking"**: expected the colored notice on
  the console. Now the notice is reported as `notice` lines through the chain's reporter, and only
  its wording is checked. Why: services never print (L3); plugin-cli owns the look.
- **SubscriptionService unsubscribe "written in the project's own config"**: expected a
  `ConfigError` saying to remove it by hand. Now a `SousError` that also names
  `sous subscription disable <ref>`. Why: S2 adds `subscription enable` and `disable`.
- **SubscriptionService re-reading `conf.d/510-subscriptions.jsonc`**: tests that relied on 510
  overriding a later layer are not ported; a later layer's `enabled: false` now wins, and
  `subscription enable` warns that it does. Why: S4, problem 4; S2, "Sous always reads the built
  config".
- **RecipeStore gc**: the report now carries `dryRun`, and `maxBytes` and `keep` default to
  `store.maxBytes` and this project's pins. Why: plugin-recipes' contract (`StoreGcReport`,
  `StoreGcOptions`).
- **catalog `describeRecipe` and `describeNamespace`**: took a ref string and resolved it inside.
  Now they take the repository and key already found; matching a ref is `findInCatalog`, over
  readings from `refs.resolver`. `contents[].destinations` is `[]`: where a kind lands is the skills
  and memories plugins' concern. Why: S6 ("refs and repos"; recipe targets move to plugin-skills and
  plugin-memories).
- **locked-recipes `listLockedRecipes`**: not ported. Which recipes are active is the
  `active-recipe` entities part B's `recipes.fetch` adds; `recipes.active` lists them and says why
  each other locked recipe is skipped (S4, 3 and 4).
- **update-plan.spec (`formatUpdatePlan`)**: not ported here; it is a view (S6, "Misfiled
  Modules"). `recipe.update` returns the plan as data.

## plugin-compiler: compiling, includes, the state file, tags and filters, prune, ported to `packages/plugin-compiler`

Every compile test now goes through a real engine and `compiler.compile`, with targets in the
config (`compilation.targets`); an output's variables are its `_vars`, an alias is `_aliases` or a
`hash-name` entity, the include scope is `_vars`, and the namespace resolver is the
`compiler.namespace-resolver` service. Messages are read from the chain's reporter, not `console`.

- **`src/test/integration/compilation.test.ts` → `test/compilation.test.ts`**:
  - "should warn and name the file when a .tpl. source is written with no vars", "should fail the
    compile for an unrendered .tpl. file when strict is set", "should not warn when the output has an
    empty vars object", "should not warn for a non-.tpl. source written with no vars": removed. They
    expected a `WITHOUT BEING RENDERED` warning for an output with no `vars`. Why: every output now
    renders with its scope (the old code said a config build could never reach this; only hand-built
    `CompilationConfig`s could), so the warning and its tripwire are gone.
  - "should treat a warning as an error in strict mode and carry on" and "should leave a warning a
    warning without strict mode": expected the unrendered-template warning. Now use the other
    compile warning, an `entryGlob` that matches nothing. Why: the old warning no longer exists. An
    empty glob was a plain printed warning before; it is now a compile warning, so `strict` fails on it.
  - "should error when includeSourceComments is a non-boolean value": expected a `must be a boolean`
    message from the compile. Now expects building the config to fail naming
    `compilation.includeSourceComments`. Why: the `compilation` key's schema checks it (S2, C4).
    "should not error when includeSourceComments is present but undefined" is covered by the default.
  - "should write a state file…" and "should record newly created output directories…": now also
    expect each entry's `target` and `origin`, and every directory level created. Why: the state file
    records which recipe each file came from (S6).
  - The circular include test expected only "does not throw"; it now also expects the compile to fail
    with `Circular dependency detected`.
- **`src/lib/markdown-compiler.spec.ts` → `src/paths.spec.ts`**: the `inferGlobBase` tests are gone:
  it is `host.globs.staticBase` (S6, "repos and the compiler"), tested in plugin-host. The
  `destinationDir`/`globBase` tests check `resolveOutputPath` directly.
- **`src/lib/include-resolver.spec.ts` → `src/includes.spec.ts`**: unchanged expectations, through
  adapters over `planInclude`/`resolveIncludeFiles`. "substituteVars()" is gone: `${var}` substitution
  is plugin-variables' (S6). The `~/` test passes the home directory in instead of setting
  `process.env.HOME`. `buildAliasMap` takes a `substitute` function instead of a scope.
- **`src/lib/include-resolver.containment.spec.ts` → `src/includes.containment.spec.ts`**: unchanged;
  the resolver is the test-only static one in `test/namespace-resolver.ts` (S6, "Misfiled Modules").
- **`src/lib/state.spec.ts` → `src/state.spec.ts`, `src/writer.spec.ts`**: `hashFile`,
  `recordDirCreation` and `didSousCreateDir` are gone (the writer records directories itself);
  `StateService.load()` gives an empty state instead of `null` for a missing or broken file;
  `deleteTrackedFiles` is `compiler.writer`'s `remove()`, which also refuses untracked files.
  `getFilePath()` falling back to `process.cwd()` is gone (services never read it, S6 rule 6); the path
  tests are in `test/prune.test.ts`.
- **`src/test/integration/build-service.test.ts` (prune, `resolveStateFilePath`) → `test/prune.test.ts`**:
  same expectations through `compiler.prune`. A prune now counts outputs file by file, so a glob
  target's output whose source is gone is pruned too (before, any file under an active
  `destinationDir` was kept).
- **`src/test/integration/{include-globs,alias-includes,alias-render,namespace-includes,get-files-tag}.test.ts`
  → `test/includes.test.ts`**: same expectations. `#lib` aliases are `hash-name` entities. "should
  refuse a user alias that starts with # or ~" now expects the config build to fail (the `_aliases`
  schema). "should resolve a repo-qualified, differently cased recipe reference" and "should prefer the
  exact spelling of a recipe name"'s case rules are the namespace resolver's (plugin-recipes): the
  first is not ported; the second runs against the static test resolver.
- **`src/test/integration/entry-glob-aliases.test.ts` → `test/targets.test.ts`**: same, except
  "should expand alias entryGlobs in the watch config" (plugin-build's watch settings) is not ported,
  and `#project` comes from plugin-refs' `hash-name` entity, not a `_vars.projectRoot` override.
- **`resolveCompilation()` in `src/lib/settings.spec.ts` → `test/targets.test.ts`**: "should throw when
  a target has both…/neither…" now expect the config build to fail (the schema); "should return null
  when project has no compilation config" now expects the schema's defaults.
- **`src/templating/{tags,filters,lib}/*.spec.ts` → `src/liquid/*.spec.ts`**: unchanged expectations;
  `registerShowVarsTag(engine)` and the rest are shims in `test/liquid.ts` that register the
  `liquid-tag`/`liquid-filter` entities. The "very probably a secret" cases use a stand-in of
  `variables.secrets`. `src/templating/init-liquid-engine.spec.ts` went to plugin-liquid (see above).

## plugin-authoring: `src/lib/repos/release/*.spec.ts`, `src/lib/repos/contribute.spec.ts`, `src/lib/repos/scaffold/index.spec.ts`, `src/test/integration/repo-{release,submit,contribute}.test.ts` → `packages/plugin-authoring`

Every module now takes the owners it uses (`git.runner`, the format parsers, `formats.recipe-hash`,
`refs.*`, `variables.names`, `repository-host` entities) as one bundle, so the specs call
`validateRepo(tools, dir)`, `buildIndex(tools, git, options)` and so on, with stand-ins of those
plugins in `test/support/standins.ts`. Expectations are otherwise unchanged, except:

- **`git-state.spec.ts` → `src/shared/git.spec.ts`**: "isCommittedAndUnchanged() should be true only for
  a tracked path with no pending changes" is not ported: nothing used the function. "hasCommitIdentity()"
  fails through a stand-in `GitRunner` instead of a `CommandRunner`.
- **`index-builder.spec.ts` "readIndexFile() should throw a readable error for an index that does not
  validate"**: expected the message to match `/repo index/`; now `/sous\.index\.json/`. The wording is
  the index parser's (plugin-formats), which names the file.
- **`settle.spec.ts`**: indexes are served by an injected index reader instead of a fake `fetch` behind
  the old providers; reading through a host is tested on its own (`readIndexThroughHost()`, new). "should
  fail on a tie, naming the /* form" expected the canonical spellings `gitlab://a/b/c/-/d/*` and
  `gitlab://a/b/-/c/d`; it now checks the `/*` form and the "each of these publishes it" list, since the
  canonical spellings are plugin-refs' to write.
- **`submit-service.spec.ts` → `src/submit/submit.spec.ts`**: the provider is a stand-in
  `repository-host` entity, the questions a `Prompter`, notices and warnings a `BufferedReporter`. Result
  fields renamed by the contract: `provider` → `host`, `usedFork` → `fromFork`, `url` →
  `proposal.url`, `committed` (paths) → `committedPaths`, `changelog` is the rendered Markdown (so
  "should say so when there is no upstream branch" checks for "could not compare this change" instead of
  `changelog.compared === false`). "should refuse a new proposal without a title when nothing can ask"
  expected `/needs a title/`; it now expects `/--title/`, the flag the non-interactive error names (L4).
  "should spawn nothing but git of its own accord" now holds by construction (host commands are entity
  methods) and only checks that git ran.
- **`submit-questions.spec.ts`**: not ported as such; the questions are asked through the chain's
  `Prompter` with `answeredBy` (`--title`, `--body`, `--yes`, `--next-branch`), covered by
  `submit.spec.ts`. `--next-branch <name>` (new) answers the "continue on a new branch" question.
- **`submit-checkout.spec.ts` → `src/submit/checkout.spec.ts`**: rewritten against a `recipes.links`
  stand-in. "should use a clone that is no longer linked, and say so" is not ported: where `repo link`
  clones is plugin-recipes' concern, and `recipes.links` does not expose it.
- **`contribute.spec.ts` → `src/contribute/{contribute,pending}.spec.ts`**: steps are intents run with
  `ctx.run` rather than oclif argv, so `startStep`/`submitStep`/`unlinkStep` are checked by their input
  and by `commandLine()`. "locatorArgs()" is not ported: chained intents share the chain's config, so
  the config-locating flags no longer need passing on.
- **`scaffold/index.spec.ts` → `src/scaffold/scaffold.spec.ts`**: "should write every file a new
  repository needs" expected `.github/workflows/sous-release.yml`; with no host named or found it now
  expects no CI file. "should write a release workflow that checks pull requests and publishes merges" is
  replaced by "should write the CI files of the host it is given" (and two tests for picking the host):
  the workflow is plugin-github's (`scaffoldFiles`, G8).
- **`src/test/integration/repo-release.test.ts` → `src/release/release.spec.ts`**: the same cases through
  the handler instead of a child process, each on its own repository. "should accept --non-interactive and
  refuse to publish, naming --yes" is covered by "should refuse to publish with nothing to ask and no
  --yes". The `repo submit` cases are in `submit.spec.ts`.
- **`src/test/integration/repo-contribute.test.ts`, `repo-submit.test.ts`**: covered by
  `contribute.spec.ts` (through a stand-in intent runner) and `submit.spec.ts`; the `gh` stand-in script
  is now a stand-in host entity.
