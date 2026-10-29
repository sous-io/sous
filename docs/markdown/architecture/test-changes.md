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
