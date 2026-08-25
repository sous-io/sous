import type { Settings } from "../../lib/settings.js";

/**
 * Builds a minimal valid Settings object for use in tests.
 * Provide overrides to add compilation targets, tools, etc.
 *
 * Usage:
 *   const settings = makeSettings({
 *     compilation: { targets: [...] },
 *   });
 */
export function makeSettings(
  overrides: Partial<Settings> = { name: "Test Project" }
): Settings {
  return { ...overrides };
}
