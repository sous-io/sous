import type { Settings, RawProject } from "../../lib/settings.js";

/**
 * Builds a minimal valid Settings object for use in tests.
 * Provide project overrides to add compilation targets, tools, etc.
 *
 * Usage:
 *   const settings = makeSettings("myproject", {
 *     compilation: { targets: [...] },
 *   });
 */
export function makeSettings(
  projectKey: string,
  project: Partial<RawProject> & Pick<RawProject, "name"> = { name: "Test Project" }
): Settings {
  return {
    projects: {
      [projectKey]: { ...project },
    },
  };
}
