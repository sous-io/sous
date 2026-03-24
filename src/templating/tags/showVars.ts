import type { Liquid } from "liquidjs";
import type { Context } from "liquidjs/dist/context/context.js";
import { sortObjectKeys } from "../../utils/formatting.js";

/** Dumps all variables currently in scope as a fenced JSON block. */
export function registerShowVarsTag(engine: Liquid): void {
  engine.registerTag("showVars", {
    render(ctx: Context) {
      const seen = new WeakSet();
      const scope = sortObjectKeys(ctx.getAll() as Record<string, unknown>);
      const json = JSON.stringify(scope, (_key, value) => {
        if (typeof value === "object" && value !== null) {
          if (seen.has(value)) return "[Circular]";
          seen.add(value);
        }
        return value;
      }, 2);

      return "# Sous Debug: Variable Dump\n```json\n" + json + "\n```";
    },
  });
}
