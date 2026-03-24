import { Liquid } from "liquidjs";
import filterRegistrars from "./filters/index.js";
import tagRegistrars from "./tags/index.js";

/**
 * Creates a configured LiquidJS engine instance for Sous template rendering.
 * Registers built-in Sous filters.
 *
 * @param roots - Filesystem root paths searched (in order) when resolving {% render %} partials.
 */
export function createLiquidEngine(roots: string[]): Liquid {
  const engine = new Liquid({
    root: roots,
    extname: "",
    strictVariables: false,
    strictFilters: false,
  });

  for (const register of filterRegistrars) {
    register(engine);
  }

  for (const register of tagRegistrars) {
    register(engine);
  }

  return engine;
}
