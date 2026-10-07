import type { Liquid } from "liquidjs";
import type { Context } from "liquidjs/dist/context/context.js";
import { sortObjectKeys } from "../../utils/formatting.js";
import { HIDDEN_VALUE, isSecretEntry } from "../lib/secret-scope.js";

/**
 * Dumps all variables currently in scope as a fenced JSON block. A secret (one a
 * recipe declared, or one that very probably is) prints as `(hidden)`, so the
 * dump never carries it into compiled output.
 */
export function registerShowVarsTag(engine: Liquid): void {
  engine.registerTag("showVars", {
    render(ctx: Context) {
      const seen = new WeakSet();
      const scope = sortObjectKeys(ctx.getAll() as Record<string, unknown>);
      const json = JSON.stringify(scope, (key, value) => {
        if (typeof value === "object" && value !== null) {
          if (seen.has(value)) return "[Circular]";
          seen.add(value);
        }
        if (key !== "" && isSecretEntry(engine, key, value)) return HIDDEN_VALUE;
        return value;
      }, 2);

      return "# Sous Debug: Variable Dump\n```json\n" + json + "\n```";
    },
  });
}
