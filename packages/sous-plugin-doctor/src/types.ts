/**
 * The contract of the doctor plugin: the `doctor-check` entity kind any plugin adds a check to,
 * and the `doctor` intent (`sous doctor`) that runs them.
 *
 * ```ts
 * sous.entities.add("doctor-check", {
 *     id: "git-hooks",
 *     order: 500,
 *     description: "The git hooks this project was set up with are installed",
 *     check: async (ctx) => (await hooksInstalled(ctx)) ? { status: "ok" } : { status: "problem", summary: "The git hooks are not installed.", fix: "Install them" },
 *     fix: async (ctx) => ({ summary: await installHooks(ctx) }),
 * });
 * ```
 */

import type { Context } from "@sous-io/plugin-api";

/** What `sous doctor` was asked to do, as every check and fix sees it. */
export interface DoctorRun {
    /** `--dry-run`: report only; no fix runs. */
    readonly dryRun: boolean;
    /** `--yes`: every fix is applied without asking, and every question takes its default. */
    readonly yes: boolean;
    /** `--answer <name>=<value>`, as given: answers a fix may pass on to what it runs. */
    readonly answers: readonly string[];
    /**
     * Whether the config failed to build. A check that needs the config returns `skipped` then,
     * since the first check (`config`) already reports it.
     */
    readonly configFailed: boolean;
}

/** What a check found. */
export type DoctorCheckResult =
    | {
          /** Nothing to put right. */
          readonly status: "ok";
          /** One sentence, when there is something worth saying anyway. */
          readonly summary?: string;
      }
    | {
          /**
           * `problem`: something is wrong, and `sous doctor` ends with exit code 1 unless it is fixed.
           * `warning`: worth knowing, and does not change the exit code. `pending`: waiting on an
           * answer only a person can give (a migration with no terminal to ask in), which does not
           * change the exit code either.
           */
          readonly status: "problem" | "warning" | "pending";
          /** One sentence stating what was found. */
          readonly summary: string;
          /** One line per item found (a missing file, a variable with no answer). */
          readonly details?: readonly string[];
          /**
           * What the fix would do, as a short imperative phrase ("Build the project"), when the
           * check's `fix` can put it right. Without it, nothing is offered.
           */
          readonly fix?: string;
          /** How to put it right by hand, when no fix is offered or the fix was declined. */
          readonly hint?: string;
      }
    | {
          /** The check could not run here (no project, no config); says why. */
          readonly status: "skipped";
          readonly summary: string;
      };

/** What a fix did. */
export interface DoctorFixResult {
    /** One sentence stating what was done. */
    readonly summary: string;
    /** One line per change. */
    readonly details?: readonly string[];
}

/**
 * One check `sous doctor` runs. Checks run in `order`, lowest first; a tie runs in the order the
 * plugins added them. A check reads and reports; only its `fix` changes anything, and only after
 * `sous doctor` asked (or `--yes` was given). Neither prints nor prompts: a fix that needs answers
 * runs intents, which ask through the chain's prompter.
 */
export interface DoctorCheckEntity {
    /** Names the check in the report and in `--json`. */
    id: string;
    /** Lower runs first. The built-in checks use 100 to 800 (see {@link DOCTOR_CHECK_ORDER}). */
    order: number;
    /** One sentence saying what is checked, stated as the healthy state. */
    description: string;
    /** Looks, and changes nothing. */
    check(ctx: Context, run: DoctorRun): DoctorCheckResult | Promise<DoctorCheckResult>;
    /** Puts right what `check` found; `sous doctor` checks again afterwards. */
    fix?(ctx: Context, run: DoctorRun): DoctorFixResult | Promise<DoctorFixResult>;
    /**
     * `boolean = true`. Whether `sous doctor` asks before running the fix. False for a fix that
     * asks its own questions (running migrations), so nothing is asked twice.
     */
    confirm?: boolean;
}

/**
 * The order of the checks spec 24 lists, so a plugin adding one of them lands in its place. The
 * gaps are free for other checks.
 */
export const DOCTOR_CHECK_ORDER = {
    config: 100,
    lockfile: 200,
    variables: 300,
    migrations: 400,
    gitHooks: 500,
    checkHandlers: 600,
    assertions: 700,
    outputs: 800,
} as const;

/** `doctor`'s input. */
export interface DoctorInput {
    dryRun?: boolean;
    yes?: boolean;
    answer?: string[];
    /** Only these checks, by id. */
    only?: string[];
}

/** One check as `doctor` reports it. */
export interface DoctorCheckReport {
    readonly id: string;
    readonly description: string;
    /** What the check found first. */
    readonly found: DoctorCheckResult;
    /** What became of the fix: applied, declined, not offered, or not run (`--dry-run`, no terminal). */
    readonly fix?:
        | { readonly result: "applied"; readonly summary: string; readonly details?: readonly string[] }
        | { readonly result: "declined" | "dry-run" | "cannot-ask" }
        | { readonly result: "failed"; readonly error: string };
    /** What the check found after the fix, when one ran. */
    readonly after?: DoctorCheckResult;
    /** Whether a problem remains. */
    readonly problem: boolean;
}

/** `doctor`'s result. */
export interface DoctorResult {
    readonly checks: readonly DoctorCheckReport[];
    /** How many checks still report a problem. */
    readonly problems: number;
    readonly dryRun: boolean;
}

declare module "@sous-io/plugin-api" {
    interface SousEntities {
        "doctor-check": DoctorCheckEntity;
    }

    interface SousIntents {
        doctor: { input: DoctorInput; result: DoctorResult };
    }
}
