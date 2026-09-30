import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTmpDir, type TmpDir } from "../../test/utils/tmp.js";
import type { CommandResult, CommandRunner } from "../repos/providers/git.js";
import {
  classifyRunning,
  declaredDependency,
  discoverInstalls,
  findGlobalInstalls,
  findProjectInstallInfo,
  isWorkspaceRoot,
  projectManager,
  UNKNOWN_VERSION,
  type GlobalInstallInfo,
} from "./installs.js";

/** Writes `contents` (JSON when not a string) to `file`, creating its directory. */
function write(file: string, contents: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents));
}

/** Writes a copy of the package at `dir`, at `version`. */
function writeCopy(dir: string, version: string | undefined, name = "@sous-io/sous"): string {
  write(path.join(dir, "package.json"), version === undefined ? { name } : { name, version });
  return dir;
}

/** The path of the package under a `node_modules` directory. */
function underModules(modules: string): string {
  return path.join(modules, "@sous-io", "sous");
}

/**
 * A runner that answers each `<command> <args...>` line from `answers`, and
 * exits 127 (not installed) for anything else. Records every call.
 */
function fakeRunner(
  answers: Record<string, Partial<CommandResult> | Error>,
  calls: string[] = []
): CommandRunner {
  return async (command, args) => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    const answer = answers[line];
    if (answer instanceof Error) throw answer;
    if (answer === undefined) return { code: 127, stdout: "", stderr: "not found" };
    return { code: 0, stdout: "", stderr: "", ...answer };
  };
}

describe("installs", () => {
  let tmp: TmpDir;

  beforeEach(() => {
    tmp = makeTmpDir("sous-self-update-");
  });

  afterEach(() => {
    tmp.cleanup();
  });

  describe("declaredDependency()", () => {
    /**
     * declaredDependency should prefer devDependencies, fall back to
     * dependencies, and return undefined when neither names the package or the
     * value is not an object.
     *
     * declaredDependency({ dependencies: { "@sous-io/sous": "^0.2.0" } })
     * // -> { section: "dependencies", range: "^0.2.0" }
     */
    it("should read the section and range", () => {
      expect(
        declaredDependency({
          devDependencies: { "@sous-io/sous": "0.2.18" },
          dependencies: { "@sous-io/sous": "0.2.1" },
        })
      ).toEqual({ section: "devDependencies", range: "0.2.18" });
      expect(declaredDependency({ devDependencies: null, dependencies: { "@sous-io/sous": "^0.2.0" } })).toEqual({
        section: "dependencies",
        range: "^0.2.0",
      });
      expect(declaredDependency({ devDependencies: { other: "1" } })).toBeUndefined();
      expect(declaredDependency(undefined)).toBeUndefined();
    });
  });

  describe("projectManager()", () => {
    /**
     * projectManager should assume npm, marked as not detected, when the
     * project's files name no manager.
     *
     * projectManager(emptyDir) -> { supported: true, agent: "npm", detected: false }
     */
    it("should assume npm when nothing is detected", async () => {
      expect(await projectManager(tmp.path)).toEqual({ supported: true, agent: "npm", detected: false });
    });

    /**
     * projectManager should read the lockfile and the packageManager field.
     *
     * projectManager(dir with pnpm-lock.yaml) -> { supported: true, agent: "pnpm", detected: true }
     */
    it("should detect pnpm, npm and Yarn classic from their lockfiles", async () => {
      write(path.join(tmp.path, "pnpm", "pnpm-lock.yaml"), "lockfileVersion: 9\n");
      write(path.join(tmp.path, "npm", "package-lock.json"), {});
      write(path.join(tmp.path, "yarn", "yarn.lock"), "# yarn lockfile v1\n");
      expect(await projectManager(path.join(tmp.path, "pnpm"))).toEqual({
        supported: true,
        agent: "pnpm",
        detected: true,
      });
      expect((await projectManager(path.join(tmp.path, "npm"))).agent).toBe("npm");
      expect((await projectManager(path.join(tmp.path, "yarn"))).agent).toBe("yarn");
    });

    /**
     * projectManager should read Yarn Berry from the packageManager field, a
     * .yarnrc.yml, or a yarn.lock carrying Berry's __metadata header.
     *
     * projectManager(dir with yarn.lock starting "__metadata:") -> agent "yarn@berry"
     */
    it("should detect Yarn Berry three ways", async () => {
      write(path.join(tmp.path, "field", "package.json"), { packageManager: "yarn@4.5.0" });
      write(path.join(tmp.path, "rc", "yarn.lock"), "# yarn lockfile v1\n");
      write(path.join(tmp.path, "rc", ".yarnrc.yml"), "nodeLinker: node-modules\n");
      write(path.join(tmp.path, "lock", "yarn.lock"), "# comment\n\n__metadata:\n  version: 8\n");
      for (const dir of ["field", "rc", "lock"]) {
        expect((await projectManager(path.join(tmp.path, dir))).agent).toBe("yarn@berry");
      }
    });

    /**
     * projectManager should treat pnpm 6 as pnpm, and report a manager sous
     * does not drive as unsupported.
     *
     * projectManager(dir with packageManager "pnpm@6.35.1") -> agent "pnpm"
     * projectManager(dir with bun.lock) -> { supported: false, agent: "bun" }
     */
    it("should fold pnpm 6 into pnpm and report bun as unsupported", async () => {
      write(path.join(tmp.path, "p6", "package.json"), { packageManager: "pnpm@6.35.1" });
      write(path.join(tmp.path, "bun", "bun.lock"), "{}");
      expect(await projectManager(path.join(tmp.path, "p6"))).toEqual({
        supported: true,
        agent: "pnpm",
        detected: true,
      });
      expect(await projectManager(path.join(tmp.path, "bun"))).toEqual({ supported: false, agent: "bun" });
    });

    /**
     * projectManager should read only the project root, never a parent's
     * lockfile.
     *
     * projectManager("<tmp>/inner") with "<tmp>/pnpm-lock.yaml" -> agent "npm", not detected
     */
    it("should not look above the project root", async () => {
      write(path.join(tmp.path, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
      fs.mkdirSync(path.join(tmp.path, "inner"));
      expect(await projectManager(path.join(tmp.path, "inner"))).toMatchObject({
        agent: "npm",
        detected: false,
      });
    });
  });

  describe("isWorkspaceRoot()", () => {
    /**
     * isWorkspaceRoot should be true for pnpm with a pnpm-workspace.yaml and for
     * Yarn classic with a workspaces field, and false for everything else.
     *
     * isWorkspaceRoot("yarn", dir, { workspaces: ["packages/*"] }) -> true
     */
    it("should follow each manager's rule", () => {
      expect(isWorkspaceRoot("pnpm", tmp.path, {})).toBe(false);
      write(path.join(tmp.path, "pnpm-workspace.yaml"), "packages: []\n");
      expect(isWorkspaceRoot("pnpm", tmp.path, {})).toBe(true);
      expect(isWorkspaceRoot("yarn", tmp.path, { workspaces: ["packages/*"] })).toBe(true);
      expect(isWorkspaceRoot("yarn", tmp.path, {})).toBe(false);
      expect(isWorkspaceRoot("yarn", tmp.path, undefined)).toBe(false);
      expect(isWorkspaceRoot("npm", tmp.path, { workspaces: ["a"] })).toBe(false);
      expect(isWorkspaceRoot("yarn@berry", tmp.path, { workspaces: ["a"] })).toBe(false);
    });
  });

  describe("findProjectInstallInfo()", () => {
    /**
     * findProjectInstallInfo should find the copy from a directory inside the
     * project, and report its root, version, declaration, manager and
     * workspace-root reading.
     *
     * findProjectInstallInfo("<project>/packages/app")
     * // -> { projectRoot: "<project>", installed: "0.2.18",
     * //      declared: { section: "devDependencies", range: "0.2.18" }, manager: pnpm, workspaceRoot: true }
     */
    it("should describe a hoisted pnpm workspace install", async () => {
      const project = path.join(tmp.path, "project");
      write(path.join(project, "package.json"), { devDependencies: { "@sous-io/sous": "0.2.18" } });
      write(path.join(project, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
      write(path.join(project, "pnpm-workspace.yaml"), "packages: [packages/*]\n");
      // pnpm links the copy into its own store; the link is what names the project.
      const stored = writeCopy(
        underModules(path.join(project, "node_modules", ".pnpm", "@sous-io+sous@0.2.18", "node_modules")),
        "0.2.18"
      );
      fs.mkdirSync(path.join(project, "node_modules", "@sous-io"), { recursive: true });
      fs.symlinkSync(stored, underModules(path.join(project, "node_modules")), "dir");
      fs.mkdirSync(path.join(project, "packages", "app"), { recursive: true });

      const info = await findProjectInstallInfo(path.join(project, "packages", "app"));
      expect(info).toEqual({
        projectRoot: project,
        location: underModules(path.join(project, "node_modules")),
        realPath: fs.realpathSync(stored),
        installed: "0.2.18",
        declared: { section: "devDependencies", range: "0.2.18" },
        manager: { supported: true, agent: "pnpm", detected: true },
        workspaceRoot: true,
      });
    });

    /**
     * findProjectInstallInfo should report an installed but undeclared copy
     * with no `declared`, and a copy naming no version as UNKNOWN_VERSION.
     *
     * findProjectInstallInfo(projectWithoutDeclaration)
     * // -> { installed: "unknown", declared: undefined, ... }
     */
    it("should leave declared out for an undeclared copy and mark an unknown version", async () => {
      writeCopy(underModules(path.join(tmp.path, "node_modules")), undefined);
      const info = await findProjectInstallInfo(tmp.path);
      expect(info?.installed).toBe(UNKNOWN_VERSION);
      expect(info && "declared" in info).toBe(false);
      expect(info?.manager).toEqual({ supported: true, agent: "npm", detected: false });
    });

    /**
     * findProjectInstallInfo should return undefined when no copy is found, or
     * the copy found is some other package.
     *
     * findProjectInstallInfo(dirWithoutCopy) -> undefined
     */
    it("should return undefined without a usable copy", async () => {
      const bare = path.join(tmp.path, "bare");
      fs.mkdirSync(bare);
      const other = path.join(tmp.path, "other");
      writeCopy(underModules(path.join(other, "node_modules")), "1.0.0", "not-sous");
      expect(await findProjectInstallInfo(other)).toBeUndefined();
      expect(await findProjectInstallInfo(bare)).toBeUndefined();
    });
  });

  describe("findGlobalInstalls()", () => {
    /**
     * findGlobalInstalls should ask npm, pnpm and Yarn for their global roots
     * (Yarn's with node_modules appended), and return a global install for
     * each root holding a copy.
     *
     * npm root -g -> <npm>; pnpm root -g -> exit 127; yarn global dir -> <yarn>
     * // -> [{ manager: "npm", installed: "0.2.30" }, { manager: "yarn", installed: "0.2.12" }]
     */
    it("should find a copy under each manager's global root and skip missing managers", async () => {
      const npmRoot = path.join(tmp.path, "npm", "lib", "node_modules");
      const yarnDir = path.join(tmp.path, "yarn", "global");
      writeCopy(underModules(npmRoot), "0.2.30");
      writeCopy(underModules(path.join(yarnDir, "node_modules")), "0.2.12");
      const calls: string[] = [];
      const installs = await findGlobalInstalls(
        fakeRunner(
          {
            "npm root -g": { stdout: `${npmRoot}\n` },
            "yarn global dir": { stdout: `warning: something\n${yarnDir}\n` },
          },
          calls
        )
      );
      expect(calls).toEqual(["npm root -g", "pnpm root -g", "yarn global dir"]);
      expect(installs).toEqual([
        {
          manager: "npm",
          location: underModules(npmRoot),
          realPath: fs.realpathSync(underModules(npmRoot)),
          installed: "0.2.30",
        },
        {
          manager: "yarn",
          location: underModules(path.join(yarnDir, "node_modules")),
          realPath: fs.realpathSync(underModules(path.join(yarnDir, "node_modules"))),
          installed: "0.2.12",
        },
      ]);
    });

    /**
     * findGlobalInstalls should skip a manager that fails, throws, prints
     * nothing, or whose root holds no copy, and count two managers naming one
     * copy once.
     *
     * npm and pnpm both answer <root>; yarn throws
     * // -> [{ manager: "npm", ... }]
     */
    it("should skip failures and count a shared copy once", async () => {
      const shared = path.join(tmp.path, "shared");
      writeCopy(underModules(shared), "0.2.30");
      const installs = await findGlobalInstalls(
        fakeRunner({
          "npm root -g": { stdout: shared },
          "pnpm root -g": { stdout: shared },
          "yarn global dir": new Error("spawn failed"),
        })
      );
      expect(installs.map((install) => install.manager)).toEqual(["npm"]);

      const none = await findGlobalInstalls(
        fakeRunner({
          "npm root -g": { code: 1, stdout: shared },
          "pnpm root -g": { stdout: "   \n" },
          "yarn global dir": { stdout: path.join(tmp.path, "empty") },
        })
      );
      expect(none).toEqual([]);
    });
  });

  describe("classifyRunning()", () => {
    /**
     * classifyRunning should name the project install or a global install when
     * the running copy's real path is theirs, and read its version.
     *
     * classifyRunning(globalCopy, project, [npmGlobal])
     * // -> { kind: "global", manager: "npm", installed: "0.2.30" }
     */
    it("should match the project install and the global installs by real path", () => {
      const globalCopy = writeCopy(path.join(tmp.path, "g", "sous"), "0.2.30");
      const projectCopy = writeCopy(path.join(tmp.path, "p", "sous"), "0.2.18");
      const globals: GlobalInstallInfo[] = [
        { manager: "npm", location: globalCopy, realPath: fs.realpathSync(globalCopy), installed: "0.2.30" },
      ];
      const project = {
        projectRoot: path.join(tmp.path, "p"),
        location: projectCopy,
        realPath: fs.realpathSync(projectCopy),
        installed: "0.2.18",
        manager: { supported: true, agent: "npm", detected: true } as const,
        workspaceRoot: false,
      };
      expect(classifyRunning(globalCopy, project, globals)).toEqual({
        kind: "global",
        manager: "npm",
        realPath: fs.realpathSync(globalCopy),
        installed: "0.2.30",
      });
      expect(classifyRunning(projectCopy, project, globals)).toMatchObject({
        kind: "project",
        installed: "0.2.18",
      });
    });

    /**
     * classifyRunning should read an npx cache, a Volta image and anything else
     * from the running copy's path, with UNKNOWN_VERSION when it has no
     * package.json.
     *
     * classifyRunning("<tmp>/_npx/abc/node_modules/@sous-io/sous", undefined, []) -> kind "npx"
     */
    it("should read npx, Volta and unknown locations from the path", () => {
      const npx = writeCopy(underModules(path.join(tmp.path, "_npx", "abc", "node_modules")), "0.2.30");
      const volta = writeCopy(path.join(tmp.path, ".volta", "tools", "image", "sous"), "0.2.30");
      const checkout = path.join(tmp.path, "checkout");
      fs.mkdirSync(checkout);
      expect(classifyRunning(npx, undefined, []).kind).toBe("npx");
      expect(classifyRunning(volta, undefined, []).kind).toBe("volta");
      expect(classifyRunning(checkout, undefined, [])).toEqual({
        kind: "unknown",
        realPath: fs.realpathSync(checkout),
        installed: UNKNOWN_VERSION,
      });
    });
  });

  describe("discoverInstalls()", () => {
    /**
     * discoverInstalls should put the three findings together: the project
     * install, the global installs, and what the running copy is.
     *
     * discoverInstalls({ cwd: project, ownRoot: globalCopy, run })
     * // -> { project: { installed: "0.2.18" }, globals: [npm 0.2.30], running: { kind: "global" } }
     */
    it("should report the project, the globals and the running copy", async () => {
      const project = path.join(tmp.path, "project");
      write(path.join(project, "package.json"), { devDependencies: { "@sous-io/sous": "0.2.18" } });
      writeCopy(underModules(path.join(project, "node_modules")), "0.2.18");
      const npmRoot = path.join(tmp.path, "npm");
      const globalCopy = writeCopy(underModules(npmRoot), "0.2.30");

      const discovery = await discoverInstalls({
        cwd: project,
        ownRoot: globalCopy,
        run: fakeRunner({ "npm root -g": { stdout: npmRoot } }),
      });
      expect(discovery.project?.installed).toBe("0.2.18");
      expect(discovery.globals.map((install) => install.installed)).toEqual(["0.2.30"]);
      expect(discovery.running).toMatchObject({ kind: "global", manager: "npm" });
    });

    /**
     * discoverInstalls should leave `project` out when there is no project
     * install.
     *
     * discoverInstalls({ cwd: dirWithoutCopy, ... }) -> { globals: [], running: { kind: "unknown" } }
     */
    it("should leave project out when there is none", async () => {
      const discovery = await discoverInstalls({ cwd: tmp.path, ownRoot: tmp.path, run: fakeRunner({}) });
      expect("project" in discovery).toBe(false);
      expect(discovery).toMatchObject({ globals: [], running: { kind: "unknown" } });
    });
  });
});
