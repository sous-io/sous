import { describe, it, expect } from "vitest";
import {
  globalInstall,
  isGlobalManager,
  isProjectManager,
  manualProjectAdd,
  packageSpec,
  projectAdd,
} from "./managers.js";

const SPEC = "@sous-io/sous@0.2.34";

describe("packageSpec()", () => {
  /**
   * packageSpec should name the package at one version.
   *
   * packageSpec("0.2.34") -> "@sous-io/sous@0.2.34"
   */
  it("should name the package at the version", () => {
    expect(packageSpec("0.2.34")).toBe(SPEC);
  });
});

describe("isProjectManager() and isGlobalManager()", () => {
  /**
   * Yarn Berry should drive projects but not global installs, and a manager
   * sous does not drive should be neither.
   *
   * isProjectManager("yarn@berry") -> true; isGlobalManager("yarn@berry") -> false
   */
  it("should accept Yarn Berry for projects only", () => {
    expect(isProjectManager("yarn@berry")).toBe(true);
    expect(isGlobalManager("yarn@berry")).toBe(false);
    expect(isProjectManager("bun")).toBe(false);
    expect(isGlobalManager("pnpm")).toBe(true);
  });
});

describe("globalInstall()", () => {
  /**
   * globalInstall should give each global manager's own install command.
   *
   * globalInstall("npm", "0.2.34")  -> npm i -g @sous-io/sous@0.2.34
   * globalInstall("pnpm", "0.2.34") -> pnpm add -g @sous-io/sous@0.2.34
   * globalInstall("yarn", "0.2.34") -> yarn global add @sous-io/sous@0.2.34
   */
  it("should give each manager's global install", () => {
    expect(globalInstall("npm", "0.2.34")).toEqual({ command: "npm", args: ["i", "-g", SPEC] });
    expect(globalInstall("pnpm", "0.2.34")).toEqual({ command: "pnpm", args: ["add", "-g", SPEC] });
    expect(globalInstall("yarn", "0.2.34")).toEqual({
      command: "yarn",
      args: ["global", "add", SPEC],
    });
  });
});

describe("projectAdd()", () => {
  const dev = { section: "devDependencies", workspaceRoot: false } as const;

  /**
   * projectAdd should pin a devDependency exactly with each project manager.
   *
   * projectAdd("npm", "0.2.34", dev)        -> npm i -D -E @sous-io/sous@0.2.34
   * projectAdd("yarn@berry", "0.2.34", dev) -> yarn add -D -E @sous-io/sous@0.2.34
   */
  it("should pin a devDependency exactly with every manager", () => {
    expect(projectAdd("npm", "0.2.34", dev)).toEqual({
      command: "npm",
      args: ["i", "-D", "-E", SPEC],
    });
    expect(projectAdd("pnpm", "0.2.34", dev)).toEqual({
      command: "pnpm",
      args: ["add", "-D", "-E", SPEC],
    });
    expect(projectAdd("yarn", "0.2.34", dev)).toEqual({
      command: "yarn",
      args: ["add", "-D", "-E", SPEC],
    });
    expect(projectAdd("yarn@berry", "0.2.34", dev)).toEqual({
      command: "yarn",
      args: ["add", "-D", "-E", SPEC],
    });
  });

  /**
   * projectAdd should leave out -D for a dependency declared under
   * dependencies, so it stays there.
   *
   * projectAdd("pnpm", "0.2.34", { section: "dependencies", workspaceRoot: false })
   * // -> pnpm add -E @sous-io/sous@0.2.34
   */
  it("should leave out -D for a runtime dependency", () => {
    expect(
      projectAdd("pnpm", "0.2.34", { section: "dependencies", workspaceRoot: false })
    ).toEqual({ command: "pnpm", args: ["add", "-E", SPEC] });
  });

  /**
   * projectAdd should add pnpm's -w and Yarn classic's -W at a workspace root,
   * and nothing for npm or Yarn Berry.
   *
   * projectAdd("yarn", "0.2.34", { section: "devDependencies", workspaceRoot: true })
   * // -> yarn add -D -E -W @sous-io/sous@0.2.34
   */
  it("should add each manager's workspace-root flag", () => {
    const root = { section: "devDependencies", workspaceRoot: true } as const;
    expect(projectAdd("pnpm", "0.2.34", root).args).toEqual(["add", "-D", "-E", "-w", SPEC]);
    expect(projectAdd("yarn", "0.2.34", root).args).toEqual(["add", "-D", "-E", "-W", SPEC]);
    expect(projectAdd("npm", "0.2.34", root).args).toEqual(["i", "-D", "-E", SPEC]);
    expect(projectAdd("yarn@berry", "0.2.34", root).args).toEqual(["add", "-D", "-E", SPEC]);
  });
});

describe("manualProjectAdd()", () => {
  /**
   * manualProjectAdd should give a manager sous does not drive its own add
   * command, and undefined for a name package-manager-detector does not know.
   *
   * manualProjectAdd("bun", "0.2.34", "devDependencies") -> bun add -D @sous-io/sous@0.2.34
   * manualProjectAdd("nonsense", "0.2.34", "dependencies") -> undefined
   */
  it("should give a hand command for a known manager and nothing for an unknown one", () => {
    expect(manualProjectAdd("bun", "0.2.34", "devDependencies")).toEqual({
      command: "bun",
      args: ["add", "-D", SPEC],
    });
    expect(manualProjectAdd("deno", "0.2.34", "dependencies")?.command).toBe("deno");
    expect(manualProjectAdd("nonsense", "0.2.34", "dependencies")).toBeUndefined();
  });
});
