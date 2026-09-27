/**
 * The newer-version notice a build prints before it compiles.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { reportNewerVersions } from "./build-preparation.js";

/** Strips ANSI escape codes. */
const strip = (text: string) => text.replace(/\u001B\[[0-9;]*m/g, "");

/** Captures console.log output as plain-text lines. */
function captureLog(fn: () => void): string[] {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
    lines.push(strip(args.join(" ")));
  });
  fn();
  spy.mockRestore();
  return lines;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reportNewerVersions()", () => {
  /**
   * Nothing newer means nothing printed at all.
   *
   * reportNewerVersions([]); // -> no output
   */
  it("should print nothing when nothing is newer", () => {
    expect(captureLog(() => reportNewerVersions([]))).toEqual([]);
  });

  /**
   * Each recipe with a newer in-range version is one key and value line: the
   * recipe, the newer version, and the pinned version trailing it. A closing
   * note says no pin moved.
   *
   * reportNewerVersions([{ key: "workflow/alpha", from: "1.0.0", to: "1.1.0" }]);
   * // ▶ Newer versions published:
   * //     workflow/alpha: 1.1.0 this project pins 1.0.0
   * //   This version is within the range declared for the recipe. No pin was changed, ...
   */
  it("should list each newer version beside the pinned one and say nothing moved", () => {
    const text = captureLog(() =>
      reportNewerVersions([
        { key: "workflow/alpha", from: "1.0.0", to: "1.1.0" },
        { key: "tools/gamma", from: "2.0.0", to: "2.3.1" },
      ])
    ).join("\n");

    expect(text).toContain("Newer versions published");
    expect(text).toMatch(/workflow\/alpha\s*: 1\.1\.0 this project pins 1\.0\.0/);
    expect(text).toMatch(/tools\/gamma\s*: 2\.3\.1 this project pins 2\.0\.0/);
    expect(text).toContain("No pin was changed");
    expect(text).toContain("pinned versions");
  });
});
