import { afterEach, describe, expect, it, vi } from "vitest";
import {
  disposeMatcherWorker,
  matchWithBudget,
  setMatcherWorkerFactory,
  type MatcherWorker,
} from "./safe-regex.js";

/** A pattern that backtracks catastrophically on a string that cannot match. */
const PATHOLOGICAL = "^(a+)+$";

/** An input short enough to be realistic and long enough to hang the pattern. */
const FORTY_CHARACTERS = "a".repeat(39) + "!";

afterEach(() => {
  setMatcherWorkerFactory();
  disposeMatcherWorker();
});

describe("matchWithBudget()", () => {
  /**
   * matchWithBudget should report a plain match the way RegExp.test would,
   * running it in the worker rather than on the calling thread.
   *
   * matchWithBudget("^gh_[a-z]+$", "gh_token");
   * // -> "match"
   */
  it("should report a pattern that matches", () => {
    expect(matchWithBudget("^gh_[a-z]+$", "gh_token")).toBe("match");
  });

  /**
   * matchWithBudget should report a pattern that does not match, which is an
   * ordinary validation failure rather than an error.
   *
   * matchWithBudget("^gh_[a-z]+$", "nope");
   * // -> "no-match"
   */
  it("should report a pattern that does not match", () => {
    expect(matchWithBudget("^gh_[a-z]+$", "nope")).toBe("no-match");
  });

  /**
   * matchWithBudget should give up on a pattern that cannot finish, within the
   * budget it was given, instead of hanging the command that asked.
   *
   * matchWithBudget("^(a+)+$", "aaa...!", 100);
   * // -> "timeout", after about 100 milliseconds
   */
  it("should time out on a pathological pattern", () => {
    const started = Date.now();
    expect(matchWithBudget(PATHOLOGICAL, FORTY_CHARACTERS, 100)).toBe("timeout");

    // The budget is a ceiling on the match itself; starting the worker is not
    // charged to it, so this generous bound only guards against waiting for
    // the pattern to finish, which it never would.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  /**
   * matchWithBudget should keep working when no worker can be started, by
   * running the pattern in process. The budget cannot be enforced on that path,
   * so only an ordinary pattern is used here.
   *
   * setMatcherWorkerFactory(() => undefined);
   * matchWithBudget("^a+$", "aaa");
   * // -> "match"
   */
  it("should fall back to an in-process test when workers are unavailable", () => {
    setMatcherWorkerFactory(() => undefined);

    expect(matchWithBudget("^a+$", "aaa")).toBe("match");
    expect(matchWithBudget("^a+$", "b")).toBe("no-match");
  });

  /**
   * matchWithBudget should start at most one worker for the whole process, and
   * should not start one until a pattern is actually being checked.
   */
  it("should start one worker and reuse it", () => {
    // A stand-in that answers 'matched' the moment it is handed the work, so
    // the call does not depend on a real thread.
    const worker: MatcherWorker = {
      postMessage: vi.fn((message: unknown) => {
        const slots = new Int32Array((message as { shared: SharedArrayBuffer }).shared);
        Atomics.store(slots, 1, 1);
        Atomics.store(slots, 0, 1);
      }),
      terminate: vi.fn(),
      unref: vi.fn(),
    };
    const factory = vi.fn(() => worker);
    setMatcherWorkerFactory(factory);

    expect(factory).not.toHaveBeenCalled();

    expect(matchWithBudget("^a+$", "aaa")).toBe("match");
    expect(matchWithBudget("^a+$", "aa")).toBe("match");
    expect(factory).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
  });
});
