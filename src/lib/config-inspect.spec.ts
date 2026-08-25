import { describe, it, expect } from "vitest";
import { lookupPath, NOT_FOUND, parsePath } from "./config-inspect.js";

/**
 * Unit tests for the config-inspect dot-path helpers shared by the
 * `xcv config get` command. The focus here is lookupPath's contract: it must
 * return NOT_FOUND for absent paths and never leak inherited prototype members.
 */

describe("lookupPath()", () => {
  const config = {
    name: "T",
    compilation: { targets: [{ entryPoint: "a.md" }, { entryPoint: "b.md" }] },
    tools: { claude: { command: "claude" } },
  };

  it("resolves a top-level scalar", () => {
    expect(lookupPath(config, parsePath("name"))).toBe("T");
  });

  it("resolves a nested value through arrays and objects", () => {
    expect(lookupPath(config, parsePath("compilation.targets[1].entryPoint"))).toBe("b.md");
  });

  it("returns NOT_FOUND for a genuinely absent key", () => {
    expect(lookupPath(config, parsePath("does.not.exist"))).toBe(NOT_FOUND);
  });

  it("returns NOT_FOUND for an out-of-range array index", () => {
    expect(lookupPath(config, parsePath("compilation.targets[5]"))).toBe(NOT_FOUND);
  });

  // Regression: lookupPath used `segment in current`, which walks the prototype
  // chain, so inherited Object.prototype members ("resolved" instead of
  // NOT_FOUND) let `config get` print garbage ("undefined"/"{}") with exit 0.
  it.each(["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__", "isPrototypeOf"])(
    "returns NOT_FOUND for the inherited prototype member '%s'",
    (member) => {
      expect(lookupPath(config, [member])).toBe(NOT_FOUND);
    }
  );

  it("returns NOT_FOUND for an inherited member reached through a nested object", () => {
    // e.g. `compilation.constructor`
    expect(lookupPath(config, ["compilation", "constructor"])).toBe(NOT_FOUND);
  });

  it("returns NOT_FOUND for an inherited Array.prototype method on an array value", () => {
    // e.g. `compilation.targets.map` — Array.prototype methods must not resolve.
    expect(lookupPath(config, ["compilation", "targets", "map"])).toBe(NOT_FOUND);
  });

  it("still resolves an OWN key that shadows a prototype member name", () => {
    // A config MAY legitimately define a key literally named "constructor".
    const shadowing = { constructor: "own-value" } as unknown;
    expect(lookupPath(shadowing, ["constructor"])).toBe("own-value");
  });
});
