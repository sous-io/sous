import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTmpDir, type TmpDir } from "../test/utils/tmp.js";
import {
  AGENT_POINTER_LINE,
  ensureConfdDirectory,
  ensureGlobalReposDirectory,
  ensureIndexCacheDirectory,
  ensureProjectReposDirectory,
  ensureSousDirectory,
  ensureSousHomeDirectory,
  ensureStoreRootDirectory,
} from "./sous-directory.js";

/** The three files every sous-created directory carries. */
const TRIO = ["README.md", "AGENTS.md", "CLAUDE.md"];

describe("ensureSousDirectory()", () => {
  let tmp: TmpDir;

  beforeEach(() => {
    tmp = makeTmpDir("sous-directory-");
  });

  afterEach(() => {
    tmp.cleanup();
  });

  /**
   * ensureSousDirectory should create a directory that does not exist yet,
   * including any missing parents, and return the path it created.
   *
   * ensureSousDirectory("/tmp/x/y/z", { title: "T", body: "B" });
   * // -> "/tmp/x/y/z", which now exists
   */
  it("should create the directory, including missing parents", () => {
    const target = path.join(tmp.path, "one", "two", "three");

    const result = ensureSousDirectory(target, { title: "Title", body: "Body." });

    expect(result).toBe(target);
    expect(fs.statSync(target).isDirectory()).toBe(true);
  });

  /**
   * ensureSousDirectory should write all three explanatory files: a README.md
   * holding the given title and body, plus AGENTS.md and CLAUDE.md, each holding
   * the single pointer line.
   */
  it("should write README.md, AGENTS.md and CLAUDE.md", () => {
    const target = path.join(tmp.path, "created");

    ensureSousDirectory(target, { title: "A title", body: "A body sentence." });

    for (const name of TRIO) {
      expect(fs.existsSync(path.join(target, name))).toBe(true);
    }

    const readme = fs.readFileSync(path.join(target, "README.md"), "utf8");
    expect(readme).toBe("# A title\n\nA body sentence.\n");

    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      expect(fs.readFileSync(path.join(target, name), "utf8")).toBe(
        `${AGENT_POINTER_LINE}\n`
      );
    }
  });

  /**
   * ensureSousDirectory should join a multi-paragraph body with blank lines, so
   * the README reads as ordinary markdown prose.
   *
   * body: ["One.", "Two."] -> "# T\n\nOne.\n\nTwo.\n"
   */
  it("should separate body paragraphs with blank lines", () => {
    const target = path.join(tmp.path, "paragraphs");

    ensureSousDirectory(target, { title: "T", body: ["One.", "Two."] });

    expect(fs.readFileSync(path.join(target, "README.md"), "utf8")).toBe(
      "# T\n\nOne.\n\nTwo.\n"
    );
  });

  /**
   * ensureSousDirectory should never overwrite a file that is already there: a
   * README somebody rewrote, and an AGENTS.md somebody filled with real
   * instructions, both survive every later call.
   */
  it("should never overwrite an existing file", () => {
    const target = path.join(tmp.path, "existing");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "README.md"), "My own words.\n", "utf8");
    fs.writeFileSync(path.join(target, "AGENTS.md"), "My own rules.\n", "utf8");

    ensureSousDirectory(target, { title: "Generated", body: "Generated body." });
    ensureSousDirectory(target, { title: "Generated", body: "Generated body." });

    expect(fs.readFileSync(path.join(target, "README.md"), "utf8")).toBe("My own words.\n");
    expect(fs.readFileSync(path.join(target, "AGENTS.md"), "utf8")).toBe("My own rules.\n");
    // The one file that was missing is still created.
    expect(fs.readFileSync(path.join(target, "CLAUDE.md"), "utf8")).toBe(
      `${AGENT_POINTER_LINE}\n`
    );
  });

  /**
   * ensureSousDirectory should be idempotent: calling it again on a directory it
   * already prepared changes nothing at all.
   */
  it("should leave a prepared directory untouched on a second call", () => {
    const target = path.join(tmp.path, "twice");

    ensureSousDirectory(target, { title: "T", body: "B." });
    const before = TRIO.map((name) => fs.readFileSync(path.join(target, name), "utf8"));
    ensureSousDirectory(target, { title: "Different", body: "Different." });
    const after = TRIO.map((name) => fs.readFileSync(path.join(target, name), "utf8"));

    expect(after).toEqual(before);
  });
});

describe("the named sous directory helpers", () => {
  let tmp: TmpDir;

  beforeEach(() => {
    tmp = makeTmpDir("sous-directory-named-");
  });

  afterEach(() => {
    tmp.cleanup();
  });

  /**
   * Each named helper should create its directory with the trio present and a
   * README whose heading names that directory.
   *
   * ensureConfdDirectory("<sousDir>/conf.d") -> README.md starting "# conf.d:"
   */
  it("should give every sous-created directory its own README", () => {
    const cases: Array<[string, (dir: string) => string, string]> = [
      ["conf.d", ensureConfdDirectory, "# conf.d: drop-in configuration layers"],
      ["repos", ensureProjectReposDirectory, "# repos: linked repository checkouts"],
      ["home", ensureSousHomeDirectory, "# Your user-level sous directory"],
      ["home/cache", ensureStoreRootDirectory, "# cache: the machine-wide recipe store"],
      [
        "home/repos",
        ensureGlobalReposDirectory,
        "# repos: globally linked repository checkouts",
      ],
      [
        "home/cache/_indexes",
        ensureIndexCacheDirectory,
        "# _indexes: cached repository indexes",
      ],
    ];

    for (const [relative, ensure, heading] of cases) {
      const target = path.join(tmp.path, ...relative.split("/"));
      ensure(target);

      for (const name of TRIO) {
        expect(fs.existsSync(path.join(target, name))).toBe(true);
      }
      expect(fs.readFileSync(path.join(target, "README.md"), "utf8")).toContain(heading);
    }
  });

  /**
   * A nested helper should prepare its parent too, so a store root created on
   * demand leaves an explained `$SOUS_HOME` behind it rather than a bare
   * directory.
   */
  it("should prepare the parent directory of a nested sous directory", () => {
    const home = path.join(tmp.path, "sous-home");
    const previous = process.env.SOUS_HOME;
    process.env.SOUS_HOME = home;

    try {
      ensureIndexCacheDirectory(path.join(home, "cache", "_indexes"));
    } finally {
      if (previous === undefined) delete process.env.SOUS_HOME;
      else process.env.SOUS_HOME = previous;
    }

    expect(fs.readFileSync(path.join(home, "README.md"), "utf8")).toContain(
      "Your user-level sous directory"
    );
    expect(fs.readFileSync(path.join(home, "cache", "README.md"), "utf8")).toContain(
      "machine-wide recipe store"
    );
  });

  /**
   * A store root somewhere other than `$SOUS_HOME/cache` should leave its parent
   * alone; sous must never drop explanatory files into a directory it does not
   * own, such as the system temporary directory.
   */
  it("should not explain a parent that is not the user-level sous directory", () => {
    const previous = process.env.SOUS_HOME;
    process.env.SOUS_HOME = path.join(tmp.path, "elsewhere");

    try {
      ensureStoreRootDirectory(path.join(tmp.path, "detached-store"));
    } finally {
      if (previous === undefined) delete process.env.SOUS_HOME;
      else process.env.SOUS_HOME = previous;
    }

    expect(fs.existsSync(path.join(tmp.path, "README.md"))).toBe(false);
    expect(
      fs.existsSync(path.join(tmp.path, "detached-store", "README.md"))
    ).toBe(true);
  });
});
