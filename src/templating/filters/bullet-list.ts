import type { Liquid } from "liquidjs";

/** Converts an array to a markdown bullet list. */
export function registerBulletListFilter(engine: Liquid): void {
  engine.registerFilter("bulletList", (items: unknown) => {
    if (!Array.isArray(items)) return String(items);
    return items.map(i => `- ${String(i)}`).join("\n");
  });
}
