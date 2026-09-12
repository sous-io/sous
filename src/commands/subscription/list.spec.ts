/**
 * The wording of the listing's "Pinned version" cell.
 *
 * The cell states a fact about the subscription in front of it, which is why
 * an empty one still says something: an enabled subscription with nothing in
 * the lockfile gets pinned by the next build, and a disabled one does not.
 */

import { describe, it, expect } from "vitest";
import { describePinned } from "./list.js";

describe("describePinned()", () => {
  /**
   * A pinned subscription names every recipe it holds, with the version beside
   * it, because a namespace subscription holds several at once.
   *
   * describePinned([{ key: "core/sous-skills", version: "0.1.1" }], true);
   * // -> "core/sous-skills 0.1.1"
   */
  it("should name every locked recipe with its version", () => {
    expect(describePinned([{ key: "core/sous-skills", version: "0.1.1" }], true)).toBe(
      "core/sous-skills 0.1.1"
    );
    expect(
      describePinned(
        [
          { key: "workflow/task-files", version: "1.0.1" },
          { key: "workflow/github-projects", version: "1.0.1" },
        ],
        true
      )
    ).toBe("workflow/task-files 1.0.1, workflow/github-projects 1.0.1");
  });

  /**
   * An enabled subscription the lockfile does not hold yet is waiting on a
   * build, so the cell says when it gets pinned rather than reporting a gap.
   *
   * describePinned([], true);  // -> "pinned on first build"
   */
  it("should say when an enabled subscription gets pinned", () => {
    expect(describePinned([], true)).toBe("pinned on first build");
  });

  /**
   * A subscription switched off is never pinned by any build, so it says only
   * that.
   *
   * describePinned([], false);  // -> "not pinned"
   */
  it("should say a disabled subscription is simply not pinned", () => {
    expect(describePinned([], false)).toBe("not pinned");
  });
});
