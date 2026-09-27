import { describe, expect, it } from "vitest";
import {
  describeUpdateScope,
  formatUpdatePlan,
  isEmptyUpdate,
  recipeInScope,
  type UpdatePlanFacts,
} from "./update-plan.js";
import type { LockDiff } from "./lock-service.js";

/** Strips ANSI escape codes, so assertions do not depend on colors. */
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/** A lockfile diff with the given change lines, or none. */
function diff(lines: string[] = []): LockDiff {
  return {
    added: [],
    removed: [],
    updated: lines.map((line) => ({ key: line })),
    reposAdded: [],
    reposRemoved: [],
    unchanged: lines.length === 0,
    lines: lines.length === 0 ? ["Nothing changed."] : lines,
  };
}

/** Plan facts with nothing in them, to be overridden per test. */
function facts(overrides: Partial<UpdatePlanFacts> = {}): UpdatePlanFacts {
  return {
    scope: { kind: "all" },
    diff: diff(),
    missingRepos: [],
    questions: [],
    unreadable: [],
    unreachable: [],
    linked: [],
    builtIn: [],
    switchedOff: [],
    failed: [],
    ...overrides,
  };
}

/** The plan as one plain string, wrapped wide so sentences stay on one line. */
function plan(input: UpdatePlanFacts): string {
  return strip(formatUpdatePlan(input, { width: 400 }).join("\n"));
}

describe("recipeInScope()", () => {
  /**
   * recipeInScope should allow every recipe for the whole-project scope, and
   * narrow by repository, then namespace, then recipe key.
   *
   * recipeInScope({ kind: "namespace", repo: "r", namespace: "workflow" }, "workflow/x", "r")
   * // -> true
   */
  it("should narrow by repository, namespace and recipe", () => {
    expect(recipeInScope({ kind: "all" }, "workflow/x", "r")).toBe(true);
    expect(recipeInScope({ kind: "repository", repo: "r" }, "workflow/x", "r")).toBe(true);
    expect(recipeInScope({ kind: "repository", repo: "r" }, "workflow/x", "s")).toBe(false);

    const namespace = { kind: "namespace", repo: "r", namespace: "workflow" } as const;
    expect(recipeInScope(namespace, "workflow/x", "r")).toBe(true);
    expect(recipeInScope(namespace, "support/x", "r")).toBe(false);
    expect(recipeInScope(namespace, "workflow/x", "s")).toBe(false);

    const recipe = { kind: "recipe", repo: "r", key: "workflow/x" } as const;
    expect(recipeInScope(recipe, "workflow/x", "r")).toBe(true);
    expect(recipeInScope(recipe, "workflow/y", "r")).toBe(false);
  });
});

describe("describeUpdateScope()", () => {
  /**
   * describeUpdateScope should name the scope in words a sentence can use.
   *
   * describeUpdateScope({ kind: "recipe", repo: "r", key: "workflow/x" })
   * // -> "the recipe 'r:workflow/x'"
   */
  it("should name each kind of scope", () => {
    expect(describeUpdateScope({ kind: "all" })).toBe("every subscription in this project");
    expect(describeUpdateScope({ kind: "repository", repo: "r" })).toContain(
      "the repository 'r'"
    );
    expect(
      describeUpdateScope({ kind: "namespace", repo: "r", namespace: "workflow" })
    ).toBe("the recipes in the namespace 'r:workflow'");
    expect(describeUpdateScope({ kind: "recipe", repo: "r", key: "workflow/x" })).toBe(
      "the recipe 'r:workflow/x'"
    );
  });
});

describe("isEmptyUpdate()", () => {
  /**
   * isEmptyUpdate should be true only when no pin moves and no repository
   * needs trusting.
   *
   * isEmptyUpdate({ diff: unchanged, missingRepos: [] }) // -> true
   */
  it("should be true only when nothing changes and nothing needs trusting", () => {
    expect(isEmptyUpdate({ diff: diff(), missingRepos: [] })).toBe(true);
    expect(isEmptyUpdate({ diff: diff(["Updating a"]), missingRepos: [] })).toBe(false);
    expect(
      isEmptyUpdate({
        diff: diff(),
        missingRepos: [{ name: "vendor", requiredBy: [] }],
      })
    ).toBe(false);
  });
});

describe("formatUpdatePlan()", () => {
  /**
   * formatUpdatePlan should say plainly when there is nothing to update.
   *
   * formatUpdatePlan(facts()) // -> "Nothing to update: every pin in ..."
   */
  it("should say when there is nothing to update", () => {
    expect(plan(facts())).toContain("Nothing to update");
  });

  /**
   * formatUpdatePlan should list every lockfile change as a bullet under one
   * sentence naming the scope.
   *
   * formatUpdatePlan(facts({ diff: diff(["Updating a from version 1.0.0 to version 1.1.0"]) }))
   * // -> "Updating every subscription in this project changes the lockfile:" then the bullet
   */
  it("should list each change under the scope", () => {
    const text = plan(
      facts({ diff: diff(["Updating workflow/a from version 1.0.0 to version 1.1.0"]) })
    );

    expect(text).toContain("Updating every subscription in this project changes the lockfile:");
    expect(text).toContain("• Updating workflow/a from version 1.0.0 to version 1.1.0");
  });

  /**
   * formatUpdatePlan should name every repository that needs trusting, with
   * where it lives and who needs it.
   */
  it("should name the repositories that need trusting", () => {
    const text = plan(
      facts({
        missingRepos: [
          {
            name: "vendor",
            url: "https://github.com/acme/vendor",
            requiredBy: [{ ref: "tools/fmt", requestedBy: "workflow/a" }],
          },
        ],
      })
    );

    expect(text).toContain("does not trust yet");
    expect(text).toContain("vendor at https://github.com/acme/vendor, needed by workflow/a");
  });

  /**
   * formatUpdatePlan should note, as facts, every pin it deliberately left
   * alone and why: an unreachable repository, a failed subscription, a linked
   * repository, the built-in core subscription, and switched-off ones.
   */
  it("should note everything the update left alone", () => {
    const text = plan(
      facts({
        diff: diff(["Updating workflow/a from version 1.0.0 to version 1.1.0"]),
        unreachable: [{ repo: "far", reason: "No answer.\nMore detail." }],
        failed: [{ key: "workflow/b", reason: "It could not be resolved." }],
        linked: ["mine"],
        builtIn: [{ key: "core", version: "1.2.3" }],
        switchedOff: ["old"],
      })
    );

    expect(text).toContain("The index of 'far' could not be fetched");
    expect(text).toContain("No answer.");
    expect(text).not.toContain("More detail.");
    expect(text).toContain("The subscription to 'workflow/b' could not be resolved");
    expect(text).toContain("The repository 'mine' is linked");
    expect(text).toContain("stays at version 1.2.3");
    expect(text).toContain("Switched off, so left alone: old.");
  });
});
