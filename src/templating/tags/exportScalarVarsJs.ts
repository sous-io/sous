import type { Liquid } from "liquidjs";
import type { Context } from "liquidjs/dist/context/context.js";
import { sortObjectKeys } from "../../utils/formatting.js";

/**
 * A "scalar" for export purposes: the value types that can be safely embedded
 * in a settings module and consumed at runtime without structural ambiguity.
 */
function isScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/**
 * Dumps all in-scope scalar variables as an ES module default export.
 *
 * Iterates every variable currently in the LiquidJS scope, keeps only scalars
 * (strings, finite numbers, booleans), sorts them by key, and emits a valid
 * `export default { ... };` block. Objects, arrays, functions, null, undefined,
 * and non-finite numbers are skipped.
 *
 * Intended for compiling a `settings.tpl.mjs` that downstream runtime code
 * (e.g. browser automation scripts) imports for project configuration.
 */
export function registerExportScalarVarsJsTag(engine: Liquid): void {
  engine.registerTag("exportScalarVarsJs", {
    render(ctx: Context) {
      const scope = ctx.getAll() as Record<string, unknown>;
      const scalars: Record<string, string | number | boolean> = {};

      for (const [key, value] of Object.entries(scope)) {
        if (isScalar(value)) scalars[key] = value;
      }

      const sorted = sortObjectKeys(scalars);
      const json = JSON.stringify(sorted, null, 2);
      return `export default ${json};\n`;
    },
  });
}
