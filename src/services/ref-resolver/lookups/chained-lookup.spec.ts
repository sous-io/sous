import { describe, expect, it } from "vitest";
import { candidates } from "../../../test/utils/ref-fixtures.js";
import type { SousRef } from "../types.js";
import { ChainedLookup } from "./chained-lookup.js";
import type { RefLookup, RefMatch } from "./ref-lookup.js";

/** A lookup answering every candidate with the given matches, and counting its calls. */
function answering(matches: RefMatch[]): RefLookup & { calls: number } {
  return {
    calls: 0,
    async find(_candidate: SousRef) {
      this.calls += 1;
      return matches;
    },
  };
}

const known: RefMatch = { ref: { kind: "namespace", name: "known" }, exactSpelling: true };
const [candidate] = candidates("known");

describe("ChainedLookup", () => {
  /**
   * The first lookup that answers with a non-empty list wins, and the rest
   * are never asked.
   *
   * chain(empty, known, never) // -> known
   */
  it("should return the first non-empty answer and stop", async () => {
    const empty = answering([]);
    const first = answering([known]);
    const never = answering([known]);
    expect(await new ChainedLookup(empty, first, never).find(candidate!)).toEqual([known]);
    expect(empty.calls).toBe(1);
    expect(never.calls).toBe(0);
  });

  /**
   * When every lookup answers with nothing, so does the chain.
   *
   * chain(empty, empty) // -> []
   */
  it("should return an empty list when no lookup knows", async () => {
    expect(await new ChainedLookup(answering([]), answering([])).find(candidate!)).toEqual([]);
    expect(await new ChainedLookup().find(candidate!)).toEqual([]);
  });

  /**
   * A lookup that throws stops the chain; the error is never skipped.
   *
   * chain(throwing, known) // rejects
   */
  it("should propagate an error from a lookup", async () => {
    const failing: RefLookup = {
      find: async () => {
        throw new Error("offline");
      },
    };
    await expect(new ChainedLookup(failing, answering([known])).find(candidate!)).rejects.toThrow(
      "offline"
    );
  });
});
