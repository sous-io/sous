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
