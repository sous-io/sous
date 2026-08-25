import { describe, it, expect } from "vitest";
import { validateSettings, settingsSchema, SUPPORTED_CONFIG_VERSION } from "./config-schema.js";
import { isConfigError } from "./errors.js";
import type { Settings } from "./settings.js";

/**
 * Unit tests for the Phase 4 zod schema + `validateSettings`. These exercise the
 * validator in isolation (no kernel subprocess). Every failure path must surface
 * as a readable, single-line-per-issue ConfigError — never a raw zod JSON dump.
 */

const CONFIG_PATH = "/repo/.sous/sous.config.js";

/** Invokes validateSettings and returns the thrown ConfigError message, or fails. */
function expectRejectMessage(raw: unknown): string {
  try {
    validateSettings(raw, CONFIG_PATH);
  } catch (error) {
    expect(isConfigError(error)).toBe(true);
    return (error as Error).message;
  }
  throw new Error("expected validateSettings to throw, but it returned");
}

describe("validateSettings", () => {
  describe("valid configs pass", () => {
    it("accepts a full config exercising every section", () => {
      const raw = {
        version: 1,
        name: "Test Project",
        _env: { userHome: "HOME" },
        _vars: { root: "/data", nested: "${root}/x" },
        _aliases: { single: "path/one", multi: ["a", "b"] },
        compilation: {
          includeSourceComments: true,
          _vars: { c: "1" },
          targets: [
            {
              entryPoint: "in.md",
              generateRuntimeContext: true,
              _vars: { t: "1" },
              outputs: [
                {
                  destinationFile: "out.md",
                  _vars: { o: "1" },
                  _if: { flag: { eq: "on" } },
                },
              ],
            },
            {
              entryGlob: "src/**/*.md",
              globBase: "src",
              outputs: [{ destinationDir: "out" }],
            },
          ],
        },
        runtimeContext: {
          gitRoot: "/r",
          outputPath: "/o",
          taskFileRoot: "/t",
          branchPattern: "PT-",
        },
        tools: {
          claude: { command: "claude", args: ["--x"], promptFile: "P.md" },
        },
      };

      const result = validateSettings(raw, CONFIG_PATH);
      // Returned value is the config, typed as Settings (not z.infer).
      const typed: Settings = result;
      expect(typed.name).toBe("Test Project");
      expect(typed.compilation?.targets).toHaveLength(2);
    });

    it("accepts a minimal empty-ish config", () => {
      expect(() => validateSettings({}, CONFIG_PATH)).not.toThrow();
    });

    it("accepts _aliases in both string and string[] forms", () => {
      expect(() =>
        validateSettings({ _aliases: { asString: "one/two" } }, CONFIG_PATH)
      ).not.toThrow();
      expect(() =>
        validateSettings({ _aliases: { asArray: ["one", "two"] } }, CONFIG_PATH)
      ).not.toThrow();
      expect(() =>
        validateSettings(
          { _aliases: { asString: "one/two", asArray: ["one", "two"] } },
          CONFIG_PATH
        )
      ).not.toThrow();
    });
  });

  describe("version handling", () => {
    it("accepts version 1", () => {
      expect(() => validateSettings({ version: 1 }, CONFIG_PATH)).not.toThrow();
      expect(SUPPORTED_CONFIG_VERSION).toBe(1);
    });

    it("accepts an absent version", () => {
      expect(() => validateSettings({ name: "no-version" }, CONFIG_PATH)).not.toThrow();
    });

    it("rejects version 2 with a not-supported message", () => {
      const message = expectRejectMessage({ version: 2 });
      expect(message).toMatch(/not supported/i);
      expect(message).toContain("version 2");
      expect(message).toContain(CONFIG_PATH);
    });

    it("rejects a string version '1' (must be the number 1)", () => {
      const message = expectRejectMessage({ version: "1" });
      expect(message).toMatch(/not supported/i);
      // JSON.stringify keeps the quotes, proving it was a string, not the number 1.
      expect(message).toContain('"1"');
    });
  });

  describe("unknown keys (strict mode)", () => {
    it("rejects an unknown top-level key, naming it with a typo hint", () => {
      const message = expectRejectMessage({ compilaton: {} });
      expect(message).toContain("compilaton");
      expect(message).toMatch(/typo/i);
      expect(message).toContain(CONFIG_PATH);
    });

    it("rejects an unknown nested key inside a target, with the full path", () => {
      const message = expectRejectMessage({
        compilation: { targets: [{ entryPoint: "a.md", outputs: [], nestedTypo: 1 }] },
      });
      expect(message).toContain("nestedTypo");
      expect(message).toContain("compilation.targets[0]");
      expect(message).toMatch(/typo/i);
    });
  });

  describe("target entryPoint/entryGlob exclusivity", () => {
    it("rejects a target with BOTH entryPoint and entryGlob", () => {
      const message = expectRejectMessage({
        compilation: { targets: [{ entryPoint: "a.md", entryGlob: "b/**", outputs: [] }] },
      });
      expect(message).toContain("compilation.targets[0]");
      expect(message).toMatch(/exactly one of/i);
    });

    it("rejects a target with NEITHER entryPoint nor entryGlob", () => {
      const message = expectRejectMessage({
        compilation: { targets: [{ outputs: [] }] },
      });
      expect(message).toContain("compilation.targets[0]");
      expect(message).toMatch(/exactly one of/i);
    });
  });

  describe("error message readability", () => {
    it("renders a per-issue path:message line for a wrong type", () => {
      const message = expectRejectMessage({
        compilation: { targets: [{ entryPoint: 123, outputs: [] }] },
      });
      expect(message).toContain("compilation.targets[0].entryPoint");
      expect(message).toContain("expected string");
    });

    it("never leaks raw JSON braces from a zod dump", () => {
      const message = expectRejectMessage({
        compilation: { targets: [{ entryPoint: 123, outputs: [] }] },
      });
      // A leaked zod issue object would contain '{' / '}'. Readable lines do not.
      expect(message).not.toContain("{");
      expect(message).not.toContain("}");
    });

    it("lists multiple issues, one readable line each, with no JSON braces", () => {
      const message = expectRejectMessage({
        bogusA: 1,
        bogusB: 2,
        tools: { claude: { command: 123 } },
      });
      expect(message).not.toContain("{");
      expect(message).not.toContain("}");
      // Each reported problem is on its own line.
      const issueLines = message.split("\n").filter((l) => l.trim().startsWith("- "));
      expect(issueLines.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("exposes the zod schema object for the schema:build artifact", () => {
    // settingsSchema must be a parseable zod schema (used by scripts/build-schema.mts).
    expect(settingsSchema.safeParse({}).success).toBe(true);
    expect(settingsSchema.safeParse({ nope: 1 }).success).toBe(false);
  });
});
