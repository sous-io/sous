/**
 * What `sous update` does, from the first registry request to the summary.
 *
 * Every plan is worked out before anything runs: the registry is read, the
 * installs are found and `buildUpdatePlans` decides each one's version. Then
 * the plans are taken one at a time, in the order the planner returns them
 * (the global installs, then the project's): each prints its facts, asks its
 * own question (sous-io/sous#135 rules one confirmation per install), and runs
 * when the answer is yes. Asking the second question after the first install
 * has run means its answer can take the first result into account.
 *
 * Nothing here decides whether a question may be asked; the caller says so,
 * from `src/lib/interactive.ts`. The registry fetch, the command runner that
 * asks the package managers where their global installs are, the executor
 * that runs an install and the prompt are all injectable, so a test drives the
 * whole flow with no network and no package manager.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { color } from "@oclif/color";
import { binEntryOf, readPackageJson, realpathOr } from "../project-install.mjs";
import { nonInteractiveError } from "../interactive.js";
import type { CommandRunner } from "../repos/providers/git.js";
import type { FetchLike } from "../repos/providers/http.js";
import { confirmPrompt, type ConfirmPromptResult } from "../../utils/confirm-prompt.js";
import {
  blankLine,
  blankLines,
  displayError,
  dryRunNotice,
  heading,
  indent,
  keysHelpTip,
  log,
  note,
  section,
  showVariables,
  subheading,
  type VariableEntry,
} from "../../utils/formatting.js";
import { discoverInstalls } from "./installs.js";
import { buildUpdatePlans, type PlannedCommand, type UpdateNotice, type UpdatePlan } from "./plan.js";
import { fetchPublishedVersions, packageMetadataUrl, registryBaseUrl } from "./registry.js";
import type { VersionRequest } from "./versions.js";
import type { UpdateScope } from "./plan.js";

/**
 * Runs one command with the terminal handed straight to it, so a package
 * manager's progress and its errors reach the person as it prints them, and
 * resolves with its exit code. Tests replace it with one that records calls.
 */
export type InstallExecutor = (
  command: PlannedCommand,
  options?: { env?: NodeJS.ProcessEnv }
) => Promise<number>;

/**
 * The real executor. On Windows a bare command name is started through the
 * shell, so npm's `.cmd` shims resolve; an absolute path (the Node binary a
 * post-update build runs under) is started directly. A command that cannot be
 * started at all writes the reason to stderr and resolves with 127.
 */
export const spawnInstall: InstallExecutor = (command, options = {}) =>
  new Promise<number>((resolve) => {
    const child = spawn(command.command, command.args, {
      cwd: command.cwd,
      stdio: "inherit",
      env: options.env ?? process.env,
      shell: process.platform === "win32" && !path.isAbsolute(command.command),
    });
    child.on("error", (error: Error) => {
      process.stderr.write(`${error.message}\n`);
      resolve(127);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });

/** Asks one yes-or-no question; the shared prompt, replaceable in a test. */
export type UpdateConfirm = (config: {
  message: string;
  default: boolean;
  hint: string;
}) => Promise<ConfirmPromptResult>;

/** What an update run needs. */
export type SelfUpdateOptions = {
  /** Where the project lookup starts. */
  cwd: string;
  /** The package root of the running copy. */
  ownRoot: string;
  request: VersionRequest;
  /** Whether prereleases count; undefined means the planner's default, per install. */
  prerelease?: boolean;
  /** `--global` or `--project`; undefined covers both. */
  only?: UpdateScope;
  dryRun: boolean;
  /** True when `--yes` answered every question. */
  yes: boolean;
  /** Whether a question may be asked (`src/lib/interactive.ts`). */
  interactive: boolean;
  /** False under `--no-build`. */
  build: boolean;
  /**
   * The directory a post-update build runs in, for a project root, or
   * undefined when that project has no sous config.
   */
  buildDirFor: (projectRoot: string) => string | undefined;
  /** Where the registry override is read from, and the environment installs run with. */
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  /** How the package managers are asked for their global roots. */
  run?: CommandRunner;
  execute?: InstallExecutor;
  confirm?: UpdateConfirm;
};

/**
 * What became of one plan.
 *
 * - `updated`: the install ran and exited 0.
 * - `failed`: the install ran and exited non-zero (`code`).
 * - `declined`: the person answered no.
 * - `current`: nothing newer to install; nothing was asked.
 * - `planned`: a dry run, which runs nothing.
 */
export type PlanOutcome = {
  plan: UpdatePlan;
  result: "updated" | "failed" | "declined" | "current" | "planned";
  code?: number;
};

/**
 * What became of the post-update build.
 *
 * - `built` / `failed`: it ran, and exited 0 or not (`code`).
 * - `skipped`: `--no-build`.
 * - `no-config`: the project has no sous config to build.
 * - `no-bin`: the newly installed copy names no bin sous can run.
 */
export type BuildOutcome = {
  result: "built" | "failed" | "skipped" | "no-config" | "no-bin";
  directory?: string;
  code?: number;
};

/** Everything a run did. */
export type SelfUpdateOutcome = {
  outcomes: PlanOutcome[];
  notices: UpdateNotice[];
  /** Set only when a project install was updated. */
  build?: BuildOutcome;
  /** True when an install or the build failed; the command then exits 1. */
  failed: boolean;
};

/** The key legend under every question, in the style every sous prompt uses. */
const QUESTION_HINT = keysHelpTip([
  ["y/n", "answer"],
  ["⏎", "accept default"],
  ["⇥", "advanced"],
]);

/** The flag spellings the non-interactive remedy names. */
const YES_REMEDY = "pass '--yes' (spelled '-y' or '--force' if you prefer) to update every install listed";

/**
 * Works out every plan, then takes them one at a time: print, ask, run.
 *
 * @throws ConfigError when the registry cannot be read or a `--version` spec
 *   matches nothing (before anything runs), and NonInteractiveError when a
 *   question has to be asked and cannot be.
 */
export async function runSelfUpdate(options: SelfUpdateOptions): Promise<SelfUpdateOutcome> {
  const env = options.env ?? process.env;
  const execute = options.execute ?? spawnInstall;
  const confirm: UpdateConfirm = options.confirm ?? ((config) => confirmPrompt(config));

  const metadata = await fetchPublishedVersions({
    env,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  const discovery = await discoverInstalls({
    cwd: options.cwd,
    ownRoot: options.ownRoot,
    ...(options.run === undefined ? {} : { run: options.run }),
  });
  const { plans, notices } = buildUpdatePlans(discovery, metadata, {
    request: options.request,
    only: options.only,
    ...(options.prerelease === undefined ? {} : { prerelease: options.prerelease }),
  });

  if (notices.length > 0) {
    section("Not updated");
    for (const notice of notices) printNotice(notice);
  }

  const actionable = plans.filter((plan) => plan.direction !== "current");
  const globalCount = plans.filter((plan) => plan.scope === "global").length;
  const outcome: SelfUpdateOutcome = { outcomes: [], notices, failed: false };

  if (plans.length === 0) {
    blankLine();
    note("There is no install of sous here that sous can update.", { indent: 2 });
    return outcome;
  }

  heading(options.dryRun ? "Update plan" : "Updating");

  for (const plan of plans) {
    const title = planTitle(plan, globalCount);
    const buildDir =
      plan.scope === "project" && plan.projectRoot !== undefined
        ? options.buildDirFor(plan.projectRoot)
        : undefined;
    subheading(title);
    showVariables(planFacts(plan, { dryRun: options.dryRun, build: options.build, buildDir }));

    if (plan.direction === "current") {
      outcome.outcomes.push({ plan, result: "current" });
      continue;
    }
    if (options.dryRun) {
      outcome.outcomes.push({ plan, result: "planned" });
      continue;
    }

    const question = questionFor(plan, title);
    let proceed = options.yes;
    if (!proceed) {
      if (!options.interactive) {
        throw nonInteractiveError({
          prompt: `"${question}"`,
          remedy: `${YES_REMEDY}.`,
        });
      }
      const index = actionable.indexOf(plan) + 1;
      proceed = await ask(confirm, question, plan, `Question ${index} of ${actionable.length}: ${title}`);
    }
    if (!proceed) {
      outcome.outcomes.push({ plan, result: "declined" });
      blankLine();
      log(indent(`The ${title.toLowerCase()} was left at ${plan.installed}.`));
      continue;
    }

    const code = await runCommandAnnounced(execute, plan.command, env);
    if (code !== 0) {
      outcome.failed = true;
      outcome.outcomes.push({ plan, result: "failed", code });
      displayError(
        `${plan.manager} exited with code ${code}, so the ${title.toLowerCase()} is still at ` +
          `${plan.installed}. Its own output is above.`,
        (line) => console.error(line)
      );
      continue;
    }
    outcome.outcomes.push({ plan, result: "updated" });
    blankLine();
    log(indent(`The ${title.toLowerCase()} is now at ${plan.target}.`));

    if (plan.scope === "project") {
      outcome.build = await buildProject(plan, buildDir, options.build, execute, env);
      if (outcome.build.result === "failed" || outcome.build.result === "no-bin") {
        outcome.failed = true;
      }
    }
  }

  if (options.dryRun) {
    blankLine();
    dryRunNotice("Nothing was installed. Run the same command without '--dry-run' to update.");
    return outcome;
  }

  printSummary(outcome, globalCount);
  return outcome;
}

/** "Global install", "Global install (pnpm)" when there are several, or "Project install". */
function planTitle(plan: UpdatePlan, globalCount: number): string {
  if (plan.scope === "project") return "Project install";
  return globalCount > 1 ? `Global install (${plan.manager})` : "Global install";
}

/** The question one plan asks. */
function questionFor(plan: UpdatePlan, title: string): string {
  const verb = plan.direction === "downgrade" ? "Downgrade" : "Update";
  return `${verb} the ${title.toLowerCase()} from ${plan.installed} to ${plan.target}?`;
}

/** A command as a person would type it. */
export function formatCommand(command: PlannedCommand): string {
  return [command.command, ...command.args].join(" ");
}

/**
 * The facts one plan prints before its question. The command itself is shown
 * in a dry run, and behind Tab otherwise, where it is printed again just
 * before it runs.
 */
function planFacts(
  plan: UpdatePlan,
  context: { dryRun: boolean; build: boolean; buildDir: string | undefined }
): VariableEntry[] {
  const facts: VariableEntry[] = [];
  if (plan.projectRoot !== undefined) facts.push({ label: "Project", value: plan.projectRoot });
  facts.push({ label: "Location", value: plan.location });
  facts.push(
    plan.managerAssumed
      ? {
          label: "Package manager",
          value: plan.manager,
          detail: "assumed, because the project's files name no package manager",
        }
      : { label: "Package manager", value: plan.manager }
  );
  if (plan.declaredIn !== undefined) {
    facts.push({
      label: "Declared in",
      value: plan.declaredIn.section,
      detail: `as ${plan.declaredIn.range}`,
    });
  }
  facts.push({ label: "Installed", value: plan.installed });

  if (plan.direction === "current") {
    facts.push({
      label: "Will install",
      value: "nothing",
      detail: `${plan.installed} is already the version this update chooses`,
    });
    return facts;
  }
  facts.push(
    plan.direction === "downgrade"
      ? { label: "Will install", value: plan.target, detail: `a downgrade from ${plan.installed}` }
      : { label: "Will install", value: plan.target }
  );
  if (context.dryRun) {
    facts.push(commandFact("Command", plan.command));
  }
  if (plan.scope === "project") facts.push(buildFact(context.build, context.buildDir));
  return facts;
}

/** The row naming a command and, when it has one, where it runs. */
function commandFact(label: string, command: PlannedCommand): VariableEntry {
  return command.cwd === undefined
    ? { label, value: formatCommand(command) }
    : { label, value: formatCommand(command), detail: `in ${command.cwd}` };
}

/** The row saying whether a project update is followed by a build. */
function buildFact(build: boolean, buildDir: string | undefined): VariableEntry {
  if (!build) return { label: "Then builds", value: "no", detail: "--no-build was passed" };
  if (buildDir === undefined) {
    return { label: "Then builds", value: "no", detail: "the project has no sous config" };
  }
  return { label: "Then builds", value: "yes", detail: `with the new copy, in ${buildDir}` };
}

/**
 * Asks one plan's question. Tab shows the command the answer runs, and the
 * question is asked again.
 */
async function ask(
  confirm: UpdateConfirm,
  question: string,
  plan: UpdatePlan,
  header: string
): Promise<boolean> {
  for (;;) {
    blankLines(2);
    log(color.bold(header));
    const answered = await confirm({ message: question, default: true, hint: QUESTION_HINT });
    if (answered.kind === "value") return answered.value;
    blankLine();
    showVariables([
      commandFact("Command", plan.command),
      { label: "Real path", value: realpathOr(plan.location) },
    ]);
  }
}

/** Prints a command, then runs it with the terminal handed over, and returns its exit code. */
async function runCommandAnnounced(
  execute: InstallExecutor,
  command: PlannedCommand,
  env: NodeJS.ProcessEnv
): Promise<number> {
  blankLine();
  showVariables([commandFact("Running", command)]);
  blankLine();
  return execute(command, { env });
}

/**
 * Runs the newly installed project copy's own build, so the lockfile's
 * `core/sous-skills` pin moves to the version just installed. The copy's bin
 * is read from its package.json again, now that the install has replaced it,
 * and it runs under this Node with the hand-off switched off, so no other copy
 * takes the build over.
 */
async function buildProject(
  plan: UpdatePlan,
  buildDir: string | undefined,
  build: boolean,
  execute: InstallExecutor,
  env: NodeJS.ProcessEnv
): Promise<BuildOutcome> {
  if (!build) return { result: "skipped" };
  if (buildDir === undefined) return { result: "no-config" };

  const root = realpathOr(plan.location);
  const entry = binEntryOf(readPackageJson(root));
  section("Building the project");
  if (entry === undefined) {
    displayError(
      `The update stands, but the new copy at ${root} names no bin sous can run, so the ` +
        "project was not built. Run 'sous build' in the project.",
      (line) => console.error(line)
    );
    return { result: "no-bin", directory: buildDir };
  }
  const command: PlannedCommand = {
    command: process.execPath,
    args: [path.resolve(root, entry), "build"],
    cwd: buildDir,
  };
  const code = await runCommandAnnounced(execute, command, { ...env, SOUS_NO_DELEGATE: "1" });
  if (code !== 0) {
    displayError(
      `The update stands, but the build that followed it exited with code ${code}. ` +
        "Fix what the build reported above and run 'sous build' again.",
      (line) => console.error(line)
    );
    return { result: "failed", directory: buildDir, code };
  }
  return { result: "built", directory: buildDir };
}

/** Prints one notice: its sentence, then where the copy is and the command to run by hand. */
function printNotice(notice: UpdateNotice): void {
  note(notice.message, { indent: 2 });
  const facts: VariableEntry[] = [];
  if (notice.location !== undefined) facts.push({ label: "Location", value: notice.location });
  if (notice.manualCommand !== undefined) facts.push(commandFact("Run by hand", notice.manualCommand));
  showVariables(facts);
  blankLine();
}

/** The summary: one line per plan, and one for the build when it applied. */
function printSummary(outcome: SelfUpdateOutcome, globalCount: number): void {
  section("Summary");
  const rows: VariableEntry[] = outcome.outcomes.map(({ plan, result, code }) => {
    const label = planTitle(plan, globalCount);
    switch (result) {
      case "updated":
        return { label, value: `updated to ${plan.target}`, detail: `from ${plan.installed}` };
      case "failed":
        return { label, value: `failed`, detail: `${plan.manager} exited with code ${code}` };
      case "declined":
        return { label, value: `skipped`, detail: `left at ${plan.installed}` };
      default:
        return { label, value: `up to date at ${plan.installed}` };
    }
  });
  const build = outcome.build;
  if (build !== undefined) {
    const label = "Project build";
    if (build.result === "built") rows.push({ label, value: "succeeded", detail: `in ${build.directory}` });
    if (build.result === "failed") {
      rows.push({ label, value: "failed", detail: `exited with code ${build.code}` });
    }
    if (build.result === "no-bin") rows.push({ label, value: "failed", detail: "the new copy names no bin" });
    if (build.result === "skipped") rows.push({ label, value: "skipped", detail: "--no-build was passed" });
    if (build.result === "no-config") {
      rows.push({ label, value: "not run", detail: "the project has no sous config" });
    }
  }
  showVariables(rows);
}

/** The registry URL an update reads, for the command's opening block. */
export function registryUrl(env: NodeJS.ProcessEnv = process.env): string {
  return packageMetadataUrl(registryBaseUrl(env));
}
