import { describe, expect, it } from "vitest";
import { ConfigError } from "../../../lib/errors.js";
import { RefSource } from "../source.js";
import type { SousRef } from "../types.js";
import { DroppedRef, RuleRefPruner, type RefPruneRule } from "./ref-pruner.js";

/** A pruner built from rules, for the tests. */
class TestPruner extends RuleRefPruner {
  readonly source = RefSource.CommandLine;
  readonly place = "in a test";

  constructor(private readonly list: RefPruneRule[]) {
    super();
  }

  protected rules(): RefPruneRule[] {
    return this.list;
  }

  protected normalize(ref: SousRef): SousRef {
    return ref.kind === "envVar" ? { ...ref, name: ref.name.toUpperCase() } : ref;
  }
}

const env: SousRef = { kind: "envVar", name: "abc" };
const ns: SousRef = { kind: "namespace", name: "workflow" };

describe("RuleRefPruner", () => {
  /**
   * A reading no rule matches is kept, and normalized.
   *
   * prune([env], "abc") with no rules // -> kept, name upper-cased
   */
  it("should keep a reading no rule matches, normalized", () => {
    const result = new TestPruner([]).prune([env], "abc");
    expect(result.kept).toEqual([{ kind: "envVar", name: "ABC" }]);
    expect(result.dropped).toEqual([]);
  });

  /**
   * The first rule that matches decides, and a drop records the reason and
   * what to write instead, from fixed text or from the reading.
   *
   * a drop rule before a throw rule // dropped, not thrown
   */
  it("should let the first matching rule decide", () => {
    const pruner = new TestPruner([
      {
        matches: (ref) => ref.kind === "envVar",
        action: "drop",
        message: (ref, input) => `${ref.kind} from ${input}`,
        instead: "'x'",
      },
      { matches: () => true, action: "throw", message: "never reached" },
    ]);
    const result = pruner.prune([env], "abc");
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]).toBeInstanceOf(DroppedRef);
    expect(result.dropped[0]!.describe()).toBe("envVar from abc\n    Write 'x' instead.");
    expect(() => pruner.prune([ns], "w")).toThrow(ConfigError);
  });

  /**
   * A warn rule keeps the reading and records a warning; a drop with no
   * `instead` describes only the reason.
   *
   * a warn rule // kept plus a warning
   */
  it("should keep a reading with a warning", () => {
    const warned = new TestPruner([{ matches: () => true, action: "warn", message: "careful" }]);
    const result = warned.prune([ns], "w");
    expect(result.kept).toEqual([ns]);
    expect(result.warnings).toEqual(["careful"]);
    expect(new DroppedRef(ns, "why").describe()).toBe("why");
  });
});
