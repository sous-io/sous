import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTmpDir, type TmpDir } from "../test/utils/tmp.js";
import {
  binEntryOf,
  findProjectInstall,
  isEnvFlagOn,
  planHandoff,
  handOffToProjectInstall,
  NO_DELEGATE_ENV,
  DEBUG_ENV,
} from "./project-install.mjs";

/**
 * Writes a fake sous package at `root`: a package.json and the bin file it
 * names, so `findProjectInstall` treats it as a usable copy.
 */
function writePackage(
  root: string,
  pkg: Record<string, unknown> = {},
  opts: { withBin?: boolean } = {}
): string {
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "@sous-io/sous", version: "1.0.0", bin: { sous: "./bin/run.js" }, ...pkg })
  );
  if (opts.withBin !== false) {
    fs.writeFileSync(path.join(root, "bin", "run.js"), "// fake bin\n");
  }
  return root;
}

/** The path a project copy of the package lives at under `projectRoot`. */
function copyPathIn(projectRoot: string): string {
  return path.join(projectRoot, "node_modules", "@sous-io", "sous");
}

describe("project-install", () => {
  let tmp: TmpDir;
  let ownRoot: string;

  beforeEach(() => {
    tmp = makeTmpDir("sous-project-install-");
    ownRoot = writePackage(path.join(tmp.path, "global", "lib", "node_modules", "@sous-io", "sous"), {
      version: "2.0.0",
    });
  });

  afterEach(() => {
    tmp.cleanup();
  });

  describe("isEnvFlagOn()", () => {
    /**
     * The five spellings of "off" read as off, whatever their case or
     * surrounding whitespace, and everything else reads as on.
     * Example: isEnvFlagOn(" No ") is false; isEnvFlagOn("1") is true.
     */
    it("should treat empty, 0, false, no and off as off and anything else as on", () => {
      for (const off of [undefined, "", "0", "false", "no", "off", " No ", "FALSE"]) {
        expect(isEnvFlagOn(off)).toBe(false);
      }
      for (const on of ["1", "true", "yes", "anything"]) {
        expect(isEnvFlagOn(on)).toBe(true);
      }
    });
  });

  describe("binEntryOf()", () => {
    /**
     * A string bin is the entry; an object bin yields `sous`, then the older
     * `xcv`, then its only entry; anything else is undefined.
     * Example: binEntryOf({ bin: { xcv: "./bin/x.js" } }) is "./bin/x.js".
     */
    it("should read the bin the package names for sous, with the older name and a sole entry as fallbacks", () => {
      expect(binEntryOf({ bin: "./run.js" })).toBe("./run.js");
      expect(binEntryOf({ bin: { sous: "./bin/run.js", xcv: "./bin/old.js" } })).toBe("./bin/run.js");
      expect(binEntryOf({ bin: { xcv: "./bin/old.js" } })).toBe("./bin/old.js");
      expect(binEntryOf({ bin: { other: "./bin/other.js" } })).toBe("./bin/other.js");
      expect(binEntryOf({ bin: { a: "./a.js", b: "./b.js" } })).toBeUndefined();
      expect(binEntryOf({ bin: { sous: 42 } })).toBeUndefined();
      expect(binEntryOf({})).toBeUndefined();
      expect(binEntryOf(undefined)).toBeUndefined();
    });
  });

  describe("findProjectInstall()", () => {
    /**
     * The lookup walks up from the start directory, so a copy at the project
     * root is found from a nested directory.
     * Example: from <project>/packages/app, <project>/node_modules/@sous-io/sous is found.
     */
    it("should find a project copy from any directory beneath the project root", () => {
      const project = path.join(tmp.path, "project");
      writePackage(copyPathIn(project), { version: "1.2.3" });
      const start = path.join(project, "packages", "app");
      fs.mkdirSync(start, { recursive: true });

      const found = findProjectInstall(start, ownRoot);
      expect(found).toEqual({
        same: false,
        root: fs.realpathSync(copyPathIn(project)),
        version: "1.2.3",
        bin: path.join(fs.realpathSync(copyPathIn(project)), "bin", "run.js"),
      });
    });

    /**
     * No ancestor holding a copy means undefined.
     * Example: a bare directory under the temp root finds nothing.
     */
    it("should return undefined when no ancestor holds a copy", () => {
      const start = path.join(tmp.path, "elsewhere");
      fs.mkdirSync(start, { recursive: true });
      expect(findProjectInstall(start, ownRoot)).toBeUndefined();
    });

    /**
     * The invoked install is recognized by real path, so a copy reached
     * through a symlink to the invoked root is "same".
     * Example: <project>/node_modules/@sous-io/sous -> <ownRoot> reports same: true.
     */
    it("should report the invoked install itself as same, through a symlink", () => {
      const project = path.join(tmp.path, "project");
      fs.mkdirSync(path.join(project, "node_modules", "@sous-io"), { recursive: true });
      fs.symlinkSync(ownRoot, copyPathIn(project), "dir");

      expect(findProjectInstall(project, ownRoot)).toEqual({
        same: true,
        root: fs.realpathSync(ownRoot),
      });
    });

    /**
     * A copy started from its own directory is the invoked install, however
     * it was reached.
     * Example: findProjectInstall(<project>, <project>/node_modules/@sous-io/sous) is same.
     */
    it("should report same when the invoked install is the project copy", () => {
      const project = path.join(tmp.path, "project");
      const copy = writePackage(copyPathIn(project));
      expect(findProjectInstall(project, copy)).toMatchObject({ same: true });
    });

    /**
     * The first copy found decides, usable or not: a copy that is not this
     * package, has no usable bin, or names a bin that does not exist yields
     * undefined rather than a walk past it.
     * Example: a copy whose package.json names another package finds nothing.
     */
    it("should return undefined for a copy that cannot be handed off to", () => {
      const notSous = path.join(tmp.path, "not-sous");
      writePackage(copyPathIn(notSous), { name: "@sous-io/other" });
      expect(findProjectInstall(notSous, ownRoot)).toBeUndefined();

      const noBin = path.join(tmp.path, "no-bin");
      writePackage(copyPathIn(noBin), { bin: undefined });
      expect(findProjectInstall(noBin, ownRoot)).toBeUndefined();

      const missingBin = path.join(tmp.path, "missing-bin");
      writePackage(copyPathIn(missingBin), {}, { withBin: false });
      expect(findProjectInstall(missingBin, ownRoot)).toBeUndefined();

      const badJson = path.join(tmp.path, "bad-json");
      writePackage(copyPathIn(badJson));
      fs.writeFileSync(path.join(copyPathIn(badJson), "package.json"), "{ not json");
      expect(findProjectInstall(badJson, ownRoot)).toBeUndefined();
    });
  });

  describe("planHandoff()", () => {
    /**
     * With a different version installed in the project, the plan hands off
     * and carries a notice naming both versions and the escape hatch.
     * Example: global 2.0.0 in a project holding 1.2.3 hands off with a notice.
     */
    it("should hand off with a notice when the project's version differs", () => {
      const project = path.join(tmp.path, "project");
      writePackage(copyPathIn(project), { version: "1.2.3" });

      const plan = planHandoff({ cwd: project, ownRoot, env: {} });
      expect(plan.kind).toBe("hand-off");
      if (plan.kind !== "hand-off") return;
      expect(plan.install.version).toBe("1.2.3");
      expect(plan.notice).toEqual(["Handing off to the project-level Sous install: v1.2.3"]);
    });

    /**
     * `--verbose` anywhere on the command line makes the notice say where both
     * installs are and how to keep the invoked one running.
     * Example: ["build", "--verbose"] adds the install paths and the escape hatch.
     */
    it("should add both install locations and the escape hatch when --verbose is on the line", () => {
      const project = path.join(tmp.path, "project");
      writePackage(copyPathIn(project), { version: "1.2.3" });

      const plan = planHandoff({ cwd: project, ownRoot, env: {}, argv: ["build", "--verbose"] });
      expect(plan.kind).toBe("hand-off");
      if (plan.kind !== "hand-off") return;
      expect(plan.notice).toEqual([
        "Handing off to the project-level Sous install: v1.2.3",
        `    Project install: ${fs.realpathSync(copyPathIn(project))}`,
        `    Invoked install: v2.0.0 at ${fs.realpathSync(ownRoot)}`,
        `Set ${NO_DELEGATE_ENV}=1 to run the invoked install instead.`,
      ]);
    });

    /**
     * The same version installed in the project hands off silently, unless
     * SOUS_DEBUG or --verbose asks for every hand-off to be announced, in
     * which case the full form is printed.
     * Example: global 2.0.0 in a project holding 2.0.0 hands off with no notice.
     */
    it("should hand off silently for the same version, and announce it in full under SOUS_DEBUG or --verbose", () => {
      const project = path.join(tmp.path, "project");
      writePackage(copyPathIn(project), { version: "2.0.0" });

      const quiet = planHandoff({ cwd: project, ownRoot, env: {} });
      expect(quiet).toMatchObject({ kind: "hand-off", notice: [] });

      for (const input of [
        { env: { [DEBUG_ENV]: "1" }, argv: [] },
        { env: {}, argv: ["--version", "--verbose"] },
      ]) {
        const loud = planHandoff({ cwd: project, ownRoot, ...input });
        expect(loud.kind).toBe("hand-off");
        if (loud.kind !== "hand-off") return;
        expect(loud.notice[0]).toBe("Handing off to the project-level Sous install: v2.0.0");
        expect(loud.notice).toHaveLength(4);
      }
    });

    /**
     * SOUS_NO_DELEGATE keeps the invoked copy running, and so does the absence
     * of a project copy or a project copy that is the invoked install.
     * Example: SOUS_NO_DELEGATE=1 in a project holding 1.2.3 runs self.
     */
    it("should run self under SOUS_NO_DELEGATE, outside a project, and when the copy is self", () => {
      const project = path.join(tmp.path, "project");
      writePackage(copyPathIn(project), { version: "1.2.3" });
      expect(planHandoff({ cwd: project, ownRoot, env: { [NO_DELEGATE_ENV]: "yes" } })).toEqual({
        kind: "run-self",
      });
      expect(planHandoff({ cwd: project, ownRoot, env: { [NO_DELEGATE_ENV]: "0" } }).kind).toBe(
        "hand-off"
      );

      const outside = path.join(tmp.path, "outside");
      fs.mkdirSync(outside);
      expect(planHandoff({ cwd: outside, ownRoot, env: {} })).toEqual({ kind: "run-self" });

      const copy = copyPathIn(project);
      expect(planHandoff({ cwd: project, ownRoot: copy, env: {} })).toEqual({ kind: "run-self" });
    });
  });

  describe("handOffToProjectInstall()", () => {
    /**
     * A hand-off imports the project copy's bin in this process, writes the
     * notice to the given stderr, and resolves true.
     * Example: a bin that sets a global marker on import is seen to have run.
     */
    it("should import the project copy's bin and resolve true", async () => {
      const project = path.join(tmp.path, "project");
      const copy = writePackage(copyPathIn(project), { version: "1.2.3" });
      fs.writeFileSync(
        path.join(copy, "bin", "run.js"),
        "globalThis.__sousHandoffMarker = 'ran';\n"
      );
      const written: string[] = [];

      const handed = await handOffToProjectInstall({
        ownRoot,
        cwd: project,
        env: {},
        stderr: { write: (chunk: string) => written.push(chunk) },
      });

      expect(handed).toBe(true);
      expect((globalThis as { __sousHandoffMarker?: string }).__sousHandoffMarker).toBe("ran");
      expect(written.join("")).toBe("Handing off to the project-level Sous install: v1.2.3\n");
      delete (globalThis as { __sousHandoffMarker?: string }).__sousHandoffMarker;
    });

    /**
     * With nothing to hand off to, nothing is imported or written and the
     * result is false.
     * Example: outside any project the call resolves false with stderr untouched.
     */
    it("should resolve false and write nothing when the invoked copy should run", async () => {
      const outside = path.join(tmp.path, "outside");
      fs.mkdirSync(outside);
      const written: string[] = [];

      const handed = await handOffToProjectInstall({
        ownRoot,
        cwd: outside,
        env: {},
        stderr: { write: (chunk: string) => written.push(chunk) },
      });

      expect(handed).toBe(false);
      expect(written).toEqual([]);
    });
  });
});
