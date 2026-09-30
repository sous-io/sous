import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { NonInteractiveError } from "../../lib/interactive.js";
import type { CommandRunner } from "../../lib/repos/providers/git.js";
import type { FetchLike } from "../../lib/repos/providers/http.js";
import type { PlannedCommand } from "../../lib/self-update/index.js";
import {
  runSelfUpdate,
  type InstallExecutor,
  type SelfUpdateOptions,
  type UpdateConfirm,
} from "../../lib/self-update/run.js";

/**
 * What the fake registry publishes. The default request from 0.2.30 lands on
 * 0.2.34 (0.3.0-beta.1 is a prerelease, and 1.0.0 is the next major); `next`
 * names a prerelease of the next minor of that major.
 */
const REGISTRY_DOCUMENT = JSON.stringify({
  name: "@sous-io/sous",
  "dist-tags": { latest: "1.0.0", next: "1.1.0-rc.1" },
  versions: {
    "0.2.18": {},
    "0.2.30": {},
    "0.2.34": {},
    "0.3.0-beta.1": {},
    "1.0.0": {},
    "1.1.0-rc.1": {},
  },
});

/** A fetch that answers every request with the fixture document. */
const fetchImpl: FetchLike = async () => ({
  ok: true,
  status: 200,
  statusText: "OK",
  text: async () => REGISTRY_DOCUMENT,
  headers: { get: () => null },
});

/** Queue this in place of a yes or no to press Tab and see the advanced view. */
const TAB = "<tab>";

let tmp: TmpDir;
/** npm's global node_modules in the temp tree; undefined means npm has no global root. */
let npmGlobalRoot: string | undefined;
/** Every command the executor was handed, with the environment it got. */
let executed: Array<{ command: PlannedCommand; env: NodeJS.ProcessEnv | undefined }>;
/** Exit codes the executor hands back, in order; 0 once the queue is empty. */
let exitCodes: number[];
/** Answers the fake prompt gives, in order: "yes", "no" or TAB. */
let answers: string[];
/** Every question the fake prompt was asked. */
let asked: string[];
/** Every line written to the console, colors removed. */
let output: string[];

/** Writes a package.json into `dir`, creating it. */
function writePackage(dir: string, pkg: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg), "utf8");
}

/** Installs a copy of sous at `version` in npm's temp global root, and returns its path. */
function installGlobal(version: string): string {
  npmGlobalRoot = path.join(tmp.path, "npm-global", "lib", "node_modules");
  const location = path.join(npmGlobalRoot, "@sous-io", "sous");
  writePackage(location, { name: "@sous-io/sous", version, bin: { sous: "bin/run.js" } });
  return location;
}

/**
 * Creates a project at `<tmp>/project` whose package.json declares sous at
 * `version` under devDependencies and whose node_modules holds that version.
 * A `package-lock.json` makes npm the detected manager, unless `lockfile`
 * names another (or is null, for none).
 */
function makeProject(version: string, lockfile: string | null = "package-lock.json"): string {
  const root = path.join(tmp.path, "project");
  writePackage(root, { name: "widget", devDependencies: { "@sous-io/sous": version } });
  if (lockfile !== null) fs.writeFileSync(path.join(root, lockfile), "{}", "utf8");
  writePackage(path.join(root, "node_modules", "@sous-io", "sous"), {
    name: "@sous-io/sous",
    version,
    bin: { sous: "bin/run.js" },
  });
  return root;
}

/** A directory that is none of the installs, standing in for a source checkout. */
function checkout(): string {
  const root = path.join(tmp.path, "checkout");
  writePackage(root, { name: "@sous-io/sous", version: "0.2.30" });
  return root;
}

/** A directory outside any project. */
function outside(): string {
  const dir = path.join(tmp.path, "elsewhere");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Answers `npm root -g` with the temp global root; every other manager is not installed. */
const run: CommandRunner = async (command, args) => {
  if (command === "npm" && args.join(" ") === "root -g" && npmGlobalRoot !== undefined) {
    return { code: 0, stdout: `${npmGlobalRoot}\n`, stderr: "" };
  }
  return { code: 127, stdout: "", stderr: "not installed" };
};

const execute: InstallExecutor = async (command, options) => {
  executed.push({ command, env: options?.env });
  return exitCodes.shift() ?? 0;
};

const confirm: UpdateConfirm = async ({ message }) => {
  asked.push(message);
  const next = answers.shift() ?? "yes";
  return next === TAB ? { kind: "advanced" } : { kind: "value", value: next === "yes" };
};

/** Runs an update with the fakes, answering every question unless told otherwise. */
function update(overrides: Partial<SelfUpdateOptions> = {}) {
  return runSelfUpdate({
    cwd: outside(),
    ownRoot: checkout(),
    request: { kind: "default" },
    dryRun: false,
    yes: false,
    interactive: true,
    build: true,
    buildDirFor: () => undefined,
    env: {},
    fetchImpl,
    run,
    execute,
    confirm,
    ...overrides,
  });
}

/** The commands the executor ran, each as one line. */
function ran(): string[] {
  return executed.map(({ command }) => [command.command, ...command.args].join(" "));
}

/** The console output as one string, every run of whitespace collapsed. */
function printed(): string {
  return output.join("\n").replace(/\s+/g, " ");
}

beforeEach(() => {
  tmp = makeTmpDir("sous-self-update-");
  npmGlobalRoot = undefined;
  executed = [];
  exitCodes = [];
  answers = [];
  asked = [];
  output = [];
  const capture = (...args: unknown[]) => {
    // eslint-disable-next-line no-control-regex
    output.push(args.join(" ").replace(/\x1b\[[0-9;]*m/g, ""));
  };
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
});

afterEach(() => {
  vi.restoreAllMocks();
  tmp.cleanup();
});

/**
 * Which installs an update plans, how each one's version is chosen, and what
 * it runs, driven with a fake registry, a fake command runner for the global
 * lookups, a fake executor and a fake prompt. Nothing reaches the network or a
 * real package manager.
 */
describe("sous update, from plan to summary", () => {
  describe("which installs are updated", () => {
    /**
     * Outside a project only the global install is planned, and it moves to
     * the newest version in its own major.
     *
     * global 0.2.30, outside a project -> npm i -g @sous-io/sous@0.2.34
     */
    it("should update the global install only when run outside a project", async () => {
      installGlobal("0.2.30");

      const outcome = await update();

      expect(ran()).toEqual(["npm i -g @sous-io/sous@0.2.34"]);
      expect(asked).toEqual(["Update the global install from 0.2.30 to 0.2.34?"]);
      expect(outcome.failed).toBe(false);
      expect(printed()).toContain("Global install: updated to 0.2.34 from 0.2.30");
    });

    /**
     * In a project with its own install and no global one, only the project
     * install is planned, and the command runs in the project root.
     *
     * project 0.2.18 -> npm i -D -E @sous-io/sous@0.2.34, in the project
     */
    it("should update the project install only when there is no global one", async () => {
      const project = makeProject("0.2.18");

      await update({ cwd: project });

      expect(ran()).toEqual(["npm i -D -E @sous-io/sous@0.2.34"]);
      expect(executed[0]!.command.cwd).toBe(project);
      expect(asked).toEqual(["Update the project install from 0.2.18 to 0.2.34?"]);
    });

    /**
     * With both installs, each gets its own plan and its own question, the
     * global one first; answering no to the first still asks the second.
     *
     * global 0.2.30 (no), project 0.2.18 (yes) -> only the project install runs
     */
    it("should ask about each install separately", async () => {
      installGlobal("0.2.30");
      const project = makeProject("0.2.18");
      answers.push("no", "yes");

      const outcome = await update({ cwd: project });

      expect(asked).toEqual([
        "Update the global install from 0.2.30 to 0.2.34?",
        "Update the project install from 0.2.18 to 0.2.34?",
      ]);
      expect(ran()).toEqual(["npm i -D -E @sous-io/sous@0.2.34"]);
      expect(outcome.outcomes.map((entry) => entry.result)).toEqual(["declined", "updated"]);
      expect(printed()).toContain("Question 1 of 2: Global install");
      expect(printed()).toContain("Global install : skipped left at 0.2.30");
    });

    /**
     * `--yes` answers every question, so nothing is asked and both run.
     *
     * global 0.2.30 + project 0.2.18, yes -> both installs run, no question
     */
    it("should run every install without asking under --yes", async () => {
      installGlobal("0.2.30");
      const project = makeProject("0.2.18");

      await update({ cwd: project, yes: true });

      expect(asked).toEqual([]);
      expect(ran()).toEqual([
        "npm i -g @sous-io/sous@0.2.34",
        "npm i -D -E @sous-io/sous@0.2.34",
      ]);
    });

    /**
     * `--global` and `--project` each narrow the run to one install.
     *
     * only: "global" -> the global install; only: "project" -> the project's
     */
    it("should narrow the run with --global and --project", async () => {
      installGlobal("0.2.30");
      const project = makeProject("0.2.18");

      await update({ cwd: project, yes: true, only: "global" });
      expect(ran()).toEqual(["npm i -g @sous-io/sous@0.2.34"]);

      executed = [];
      await update({ cwd: project, yes: true, only: "project" });
      expect(ran()).toEqual(["npm i -D -E @sous-io/sous@0.2.34"]);
    });

    /**
     * Pressing Tab shows the exact command and where it would run, then asks
     * the same question again.
     *
     * TAB, then yes -> the command is printed, the question asked twice
     */
    it("should show the command behind Tab and ask again", async () => {
      installGlobal("0.2.30");
      answers.push(TAB, "yes");

      await update();

      expect(asked).toHaveLength(2);
      expect(printed()).toContain("Command : npm i -g @sous-io/sous@0.2.34");
      expect(ran()).toEqual(["npm i -g @sous-io/sous@0.2.34"]);
    });
  });

  describe("which version is chosen", () => {
    /**
     * `--major` takes the newest published version whatever its major.
     *
     * global 0.2.30, major -> 1.0.0
     */
    it("should cross into the next major under --major", async () => {
      installGlobal("0.2.30");
      await update({ yes: true, request: { kind: "major" } });
      expect(ran()).toEqual(["npm i -g @sous-io/sous@1.0.0"]);
    });

    /**
     * `--version` takes an exact version, the newest in a range, or a
     * dist-tag's version.
     *
     * "0.2.34" -> 0.2.34; "~0.2.20" -> 0.2.34; "next" -> 1.1.0-rc.1
     */
    it("should take an exact version, a range or a dist-tag under --version", async () => {
      installGlobal("0.2.30");
      for (const [spec, expected] of [
        ["0.2.34", "0.2.34"],
        ["~0.2.20", "0.2.34"],
        ["next", "1.1.0-rc.1"],
      ] as const) {
        executed = [];
        await update({ yes: true, request: { kind: "spec", spec } });
        expect(ran()).toEqual([`npm i -g @sous-io/sous@${expected}`]);
      }
    });

    /**
     * An older version named with `--version` is a downgrade, and the plan
     * and the question both say so.
     *
     * global 0.2.30, version 0.2.18 -> "Downgrade the global install ..."
     */
    it("should say plainly that an older --version is a downgrade", async () => {
      installGlobal("0.2.30");

      await update({ request: { kind: "spec", spec: "0.2.18" } });

      expect(asked).toEqual(["Downgrade the global install from 0.2.30 to 0.2.18?"]);
      expect(printed()).toContain("Will install : 0.2.18 a downgrade from 0.2.30");
      expect(ran()).toEqual(["npm i -g @sous-io/sous@0.2.18"]);
    });

    /**
     * Prereleases count by default only when the installed version is one;
     * `prerelease: true` counts them for a release install too, and `false`
     * leaves them out for a prerelease install.
     *
     * 0.2.30 -> 0.2.34; 0.2.30 with prereleases -> 0.3.0-beta.1;
     * 0.2.31-beta.0 -> 0.3.0-beta.1; 0.2.31-beta.0 without prereleases -> 0.2.34
     */
    it("should count prereleases by default only for a prerelease install", async () => {
      const cases: Array<[string, boolean | undefined, string]> = [
        ["0.2.30", undefined, "0.2.34"],
        ["0.2.30", true, "0.3.0-beta.1"],
        ["0.2.31-beta.0", undefined, "0.3.0-beta.1"],
        ["0.2.31-beta.0", false, "0.2.34"],
      ];
      for (const [installed, prerelease, expected] of cases) {
        installGlobal(installed);
        executed = [];
        await update({ yes: true, ...(prerelease === undefined ? {} : { prerelease }) });
        expect(ran()).toEqual([`npm i -g @sous-io/sous@${expected}`]);
      }
    });

    /**
     * An install already at the newest version it may have is reported, and
     * gets no question and no command.
     *
     * global 0.2.34 -> "Will install: nothing", nothing asked or run
     */
    it("should report a current install without asking about it", async () => {
      installGlobal("0.2.34");

      const outcome = await update();

      expect(asked).toEqual([]);
      expect(ran()).toEqual([]);
      expect(outcome.outcomes[0]!.result).toBe("current");
      expect(printed()).toContain("Will install : nothing 0.2.34 is already the version");
    });
  });

  describe("dry runs and runs with no terminal", () => {
    /**
     * A dry run prints every plan, with its command, and runs and asks nothing.
     *
     * dryRun -> the commands are printed, nothing is executed
     */
    it("should print every plan and run nothing in a dry run", async () => {
      installGlobal("0.2.30");
      const project = makeProject("0.2.18");

      await update({ cwd: project, dryRun: true, buildDirFor: () => project });

      expect(ran()).toEqual([]);
      expect(asked).toEqual([]);
      expect(printed()).toContain("Command : npm i -g @sous-io/sous@0.2.34");
      expect(printed()).toContain(`Command : npm i -D -E @sous-io/sous@0.2.34 in ${project}`);
      expect(printed()).toContain(`Then builds : yes with the new copy, in ${project}`);
      expect(printed()).toContain("Nothing was installed.");
    });

    /**
     * With no terminal and no `--yes`, the first question fails the run with
     * the shared error naming the question and `--yes`, before anything runs.
     *
     * interactive: false -> NonInteractiveError mentioning --yes, nothing run
     */
    it("should fail naming --yes when it cannot ask", async () => {
      installGlobal("0.2.30");

      const failure = await update({ interactive: false }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(NonInteractiveError);
      expect((failure as Error).message).toContain(
        '"Update the global install from 0.2.30 to 0.2.34?"'
      );
      expect((failure as Error).message).toContain("--yes");
      expect(ran()).toEqual([]);
    });
  });

  describe("failures", () => {
    /**
     * A package manager that fails the first install is reported with its exit
     * code, the second install is still offered and runs, and the outcome is a
     * failure so the command exits 1.
     *
     * global install exits 243, project install exits 0 -> failed: true, both ran
     */
    it("should still offer the second install after the first fails", async () => {
      installGlobal("0.2.30");
      const project = makeProject("0.2.18");
      exitCodes.push(243, 0);

      const outcome = await update({ cwd: project });

      expect(asked).toHaveLength(2);
      expect(ran()).toEqual([
        "npm i -g @sous-io/sous@0.2.34",
        "npm i -D -E @sous-io/sous@0.2.34",
      ]);
      expect(outcome.failed).toBe(true);
      expect(printed()).toContain("Error: npm exited with code 243");
      expect(printed()).toContain("Global install : failed npm exited with code 243");
      expect(printed()).toContain("Project install: updated to 0.2.34");
    });
  });

  describe("the build after a project update", () => {
    /**
     * A successful project update runs the new copy's own bin with `build`,
     * under this Node, in the config's directory, with the hand-off off.
     *
     * project updated, config found -> node <copy>/bin/run.js build
     */
    it("should build the project with the newly installed copy", async () => {
      const project = makeProject("0.2.18");

      const outcome = await update({ cwd: project, yes: true, buildDirFor: () => project });

      expect(executed).toHaveLength(2);
      const build = executed[1]!;
      expect(build.command.command).toBe(process.execPath);
      expect(build.command.args).toEqual([
        path.join(fs.realpathSync(path.join(project, "node_modules", "@sous-io", "sous")), "bin", "run.js"),
        "build",
      ]);
      expect(build.command.cwd).toBe(project);
      expect(build.env?.SOUS_NO_DELEGATE).toBe("1");
      expect(outcome.build?.result).toBe("built");
    });

    /**
     * `--no-build`, or a project with no sous config, installs and builds
     * nothing.
     *
     * build: false -> skipped; no config -> not run; only the install runs
     */
    it("should skip the build under --no-build and when there is no sous config", async () => {
      const project = makeProject("0.2.18");

      const skipped = await update({ cwd: project, yes: true, build: false, buildDirFor: () => project });
      expect(ran()).toEqual(["npm i -D -E @sous-io/sous@0.2.34"]);
      expect(skipped.build?.result).toBe("skipped");

      executed = [];
      const none = await update({ cwd: project, yes: true });
      expect(ran()).toEqual(["npm i -D -E @sous-io/sous@0.2.34"]);
      expect(none.build?.result).toBe("no-config");
    });

    /**
     * A build that fails leaves the update in place and fails the run.
     *
     * install exits 0, build exits 1 -> failed: true, "The update stands"
     */
    it("should report a failed build and fail the run", async () => {
      const project = makeProject("0.2.18");
      exitCodes.push(0, 1);

      const outcome = await update({ cwd: project, yes: true, buildDirFor: () => project });

      expect(outcome.failed).toBe(true);
      expect(outcome.build?.result).toBe("failed");
      expect(printed()).toContain("The update stands, but the build that followed it exited with code 1");
    });
  });

  describe("what is reported without acting", () => {
    /**
     * A copy running through npx is not an install: the notice says so, and
     * the installs found are still planned.
     *
     * ownRoot under _npx -> the npx notice
     */
    it("should say that an npx copy is not an install", async () => {
      const npx = path.join(tmp.path, ".npm", "_npx", "abc123", "node_modules", "@sous-io", "sous");
      writePackage(npx, { name: "@sous-io/sous", version: "0.2.30" });

      const outcome = await update({ ownRoot: npx });

      expect(outcome.notices.map((notice) => notice.kind)).toEqual(["npx"]);
      expect(printed()).toContain("This sous is running through npx, which is not an install");
      expect(printed()).toContain("There is no install of sous here that sous can update.");
    });

    /**
     * A running copy that is none of the installs (a source checkout) is
     * reported with its location, and the global install is still updated.
     *
     * ownRoot a checkout, global 0.2.30 -> the notice, and the global update
     */
    it("should report an unknown running copy and still update the global install", async () => {
      installGlobal("0.2.30");
      const root = checkout();

      await update({ ownRoot: root, yes: true });

      expect(printed()).toContain("This sous is not the project install or a global install");
      expect(printed()).toContain(`Location: ${root}`);
      expect(ran()).toEqual(["npm i -g @sous-io/sous@0.2.34"]);
    });

    /**
     * A project with no lockfile and no `packageManager` field is updated with
     * npm, and the plan says npm was assumed.
     *
     * no lockfile -> "Package manager: npm assumed, ..."
     */
    it("should say when the project's package manager was assumed", async () => {
      const project = makeProject("0.2.18", null);

      await update({ cwd: project, dryRun: true });

      expect(printed()).toContain(
        "Package manager: npm assumed, because the project's files name no package manager"
      );
    });
  });
});
