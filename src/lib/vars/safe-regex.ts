/**
 * Running a recipe's regular expression under a time budget.
 *
 * A recipe publishes `validate.pattern` as a plain string, and a consuming
 * project runs it against whatever the person answering types. A pattern with
 * catastrophic backtracking in it (the classic `(a+)+$`) can take effectively
 * forever on a short input, which would hang `sous subscription add` or
 * `sous vars ask` with no way out. So sous never runs a published pattern on
 * its own thread: the match happens inside a worker, and the caller waits only
 * for a fixed budget before giving up on it.
 *
 * The API is SYNCHRONOUS because every caller of `validateAnswer` is
 * synchronous, and the whole variables layer would have to become async to
 * change that. The workable synchronous shape is a worker plus a
 * `SharedArrayBuffer`: the caller posts the work, blocks in `Atomics.wait` for
 * at most the budget, and reads the answer the worker stored in shared memory.
 * The worker thread keeps running while the calling thread is parked, so the
 * result arrives without an event loop turn on this side.
 *
 * COMPILING a pattern is not budgeted, and does not need to be: V8 compiles a
 * regular expression in time proportional to its source text and has no
 * pathological compile step, so the `new RegExp(...)` validity check that
 * `recipe-manifest.ts` runs at parse time is safe as it stands. Only the MATCH
 * can run away.
 */

import { Worker } from "node:worker_threads";

/** How long a published pattern may run before sous stops waiting for it. */
export const DEFAULT_PATTERN_BUDGET_MS = 100;

/** What running a pattern against an input produced. */
export type MatchOutcome = "match" | "no-match" | "timeout";

/** How long a worker is given to come online before it is written off. */
const STARTUP_GRACE_MS = 5_000;

/** Slot 0 of the shared array: the outcome the worker wrote. */
const STATUS = 0;

/** Slot 1 of the shared array: set once the worker has the match in hand. */
const STARTED = 1;

/** The status words the worker writes into shared memory. */
const PENDING = 0;
const MATCHED = 1;
const DID_NOT_MATCH = 2;
const FAILED = 3;

/**
 * The part of a worker this module uses. Narrow on purpose, so a test can hand
 * in a stand-in (or refuse to make one) without constructing a real thread.
 */
export interface MatcherWorker {
  /** Delivers one match request to the worker thread. */
  postMessage(message: unknown): void;
  /** Stops the worker, including one that is stuck inside a runaway match. */
  terminate(): unknown;
  /** Lets the process exit while this worker is idle. */
  unref?(): void;
}

/**
 * Makes the worker that runs patterns. Returning `undefined` means workers are
 * not available here, which sends `matchWithBudget` down its in-process
 * fallback path.
 */
export type MatcherWorkerFactory = () => MatcherWorker | undefined;

/** The source the default worker runs. */
const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
parentPort.on("message", (task) => {
  const slots = new Int32Array(task.shared);
  Atomics.store(slots, ${STARTED}, 1);
  Atomics.notify(slots, ${STARTED});
  let code = ${FAILED};
  try {
    code = new RegExp(task.pattern).test(task.input) ? ${MATCHED} : ${DID_NOT_MATCH};
  } catch {
    code = ${FAILED};
  }
  Atomics.store(slots, ${STATUS}, code);
  Atomics.notify(slots, ${STATUS});
});
`;

/**
 * Starts the real worker. The source is passed inline (`eval: true`) rather
 * than as a file so the worker needs no TypeScript loader of its own, and it is
 * unreferenced so an idle matcher never holds the process open.
 */
const defaultFactory: MatcherWorkerFactory = () => {
  const worker = new Worker(WORKER_SOURCE, { eval: true });
  worker.unref();
  return worker;
};

let factory: MatcherWorkerFactory = defaultFactory;
let worker: MatcherWorker | undefined;
let workersUnavailable = false;

/**
 * Replaces the worker factory, for tests. Pass nothing to restore the real one.
 *
 * @param replacement - The factory to use, or `undefined` to restore the default.
 */
export function setMatcherWorkerFactory(replacement?: MatcherWorkerFactory): void {
  disposeMatcherWorker();
  factory = replacement ?? defaultFactory;
  workersUnavailable = false;
}

/** Stops and forgets the shared worker, if one was ever started. */
export function disposeMatcherWorker(): void {
  const running = worker;
  worker = undefined;
  if (running === undefined) return;
  try {
    running.terminate();
  } catch {
    // A worker that cannot be terminated is already gone.
  }
}

/**
 * Returns the shared worker, starting it on first use. One worker serves the
 * whole process; it is started only when a pattern is actually being checked,
 * never at import time.
 */
function matcher(): MatcherWorker | undefined {
  if (workersUnavailable) return undefined;
  if (worker !== undefined) return worker;
  try {
    worker = factory();
  } catch {
    worker = undefined;
  }
  if (worker === undefined) workersUnavailable = true;
  return worker;
}

/**
 * Tests `input` against `pattern`, giving up after `budgetMs`.
 *
 * @param pattern - The regular expression source a recipe published.
 * @param input - The text to test it against.
 * @param budgetMs - How long the pattern may run, in milliseconds.
 * @returns Whether it matched, did not match, or ran out of time.
 *
 * @example
 * matchWithBudget("^a+$", "aaa");        // -> "match"
 * matchWithBudget("^a+$", "b");          // -> "no-match"
 * matchWithBudget("(a+)+$", "aaaa!");    // -> "timeout", eventually
 */
export function matchWithBudget(
  pattern: string,
  input: string,
  budgetMs: number = DEFAULT_PATTERN_BUDGET_MS
): MatchOutcome {
  const running = matcher();

  // No worker here, so there is nothing to run the pattern on but this thread.
  // The budget cannot be enforced in that case; a plain test is still the right
  // answer, because refusing to validate at all would be worse than the risk.
  if (running === undefined) return inProcessMatch(pattern, input);

  const shared = new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT);
  const slots = new Int32Array(shared);

  try {
    running.postMessage({ pattern, input, shared });
  } catch {
    disposeMatcherWorker();
    return inProcessMatch(pattern, input);
  }

  // Starting a thread takes tens of milliseconds, and that time belongs to sous
  // rather than to the pattern, so the budget does not start until the worker
  // says it has the match in hand.
  if (!waitForStart(slots)) {
    // The worker never came online at all, so there is no budgeted thread to
    // run on. This means workers are broken here, not that the pattern is slow.
    disposeMatcherWorker();
    workersUnavailable = true;
    return inProcessMatch(pattern, input);
  }

  if (Atomics.load(slots, STATUS) === PENDING) {
    Atomics.wait(slots, STATUS, PENDING, budgetMs);
  }

  switch (Atomics.load(slots, STATUS)) {
    case MATCHED:
      return "match";
    case DID_NOT_MATCH:
      return "no-match";
    case FAILED:
      // The worker could not compile the pattern. Compiling is cheap and safe,
      // so repeating it here reproduces the same error for the caller.
      return inProcessMatch(pattern, input);
    default:
      // Still running, and it always might be, so the worker is thrown away and
      // the next check starts a fresh one.
      disposeMatcherWorker();
      return "timeout";
  }
}

/**
 * Blocks until the worker reports that it has started matching, or until the
 * startup grace runs out.
 *
 * @param slots - The shared status slots for this request.
 * @returns Whether the worker came online.
 */
function waitForStart(slots: Int32Array): boolean {
  const deadline = Date.now() + STARTUP_GRACE_MS;
  while (Atomics.load(slots, STARTED) === 0 && Atomics.load(slots, STATUS) === PENDING) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    Atomics.wait(slots, STARTED, 0, remaining);
  }
  return true;
}

/**
 * The unbudgeted fallback: run the pattern right here.
 *
 * @param pattern - The regular expression source.
 * @param input - The text to test it against.
 */
function inProcessMatch(pattern: string, input: string): MatchOutcome {
  return new RegExp(pattern).test(input) ? "match" : "no-match";
}
