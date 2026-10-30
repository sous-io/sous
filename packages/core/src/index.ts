/**
 * The sous engine: what core holds. Everything else is a plugin.
 *
 * ```ts
 * const engine = createEngine({ project, env: process.env, builtIns: [cliPlugin] });
 *
 * await engine.buildConfig();
 * await engine.frontEnd("cli").start(process.argv.slice(2));
 * await engine.whenBackgroundIntentsReturn();
 * ```
 */

export { createEngine, Engine, WHAT_IF_PLUGIN } from "./engine.js";
export type { EngineOptions, StartableFrontEnd } from "./engine.js";
export { DEFAULT_LIMITS } from "./limits.js";
export type { Limits } from "./limits.js";
export { DEFAULT_BUDGETS } from "./timing/budgets.js";
export type { Budget } from "./timing/budgets.js";
export { sortContributors } from "./config/order.js";
export { CORE_PLUGIN, matchesWildcard, pluginPrefix } from "./util/names.js";
