import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  applyManagedIgnoreBlock,
  describeLinkedRepos,
  ensureReposIgnoreFiles,
  globalLinksPath,
  globalReposDir,
  IGNORE_BLOCK_END,
  IGNORE_BLOCK_ENTRIES,
  IGNORE_BLOCK_START,
  linkedPathFor,
  projectLinksPath,
  projectReposDir,
  readEffectiveLinks,
  readGlobalLinks,
  readProjectLinks,
  resolveSousHomeDir,
  writeGlobalLinks,
  writeProjectLinks,
} from "./links.js";
import { createEmptyLinksMap, type LinksMap } from "./formats/links-map.js";
import { isConfigError } from "../errors.js";
import { makeTmpDir, type TmpDir } from "../../test/utils/tmp.js";

/** Builds a links map holding one entry, for the tests that only need one. */
function linksWith(entries: Record<string, string>): LinksMap {
  const map = createEmptyLinksMap();
  for (const [name, linkPath] of Object.entries(entries)) {
    map.links[name] = {
      path: linkPath,
      linkedAt: "2026-09-09T14:03:11.482Z",
      origin: "path",
    };
  }
  return map;
}

describe("resolveSousHomeDir()", () => {
  /**
   * resolveSousHomeDir should honour SOUS_HOME when it is set to something
   * other than whitespace, and fall back to `~/.sous` otherwise.
   *
   * resolveSousHomeDir({ SOUS_HOME: "/opt/sous" }); // -> "/opt/sous"
   * resolveSousHomeDir({ HOME: "/home/me" });       // -> "/home/me/.sous"
   */
  it("should use SOUS_HOME when set, and ~/.sous otherwise", () => {
    expect(resolveSousHomeDir({ SOUS_HOME: "/opt/sous" })).toBe("/opt/sous");
    expect(resolveSousHomeDir({ HOME: "/home/me" })).toBe(path.join("/home/me", ".sous"));
  });

  /**
   * resolveSousHomeDir should treat an empty or whitespace-only SOUS_HOME as
   * unset, the way every other sous environment variable is treated, so a bare
   * `export SOUS_HOME=` never turns the working directory into the store.
   *
   * resolveSousHomeDir({ SOUS_HOME: "   ", HOME: "/home/me" }); // -> "/home/me/.sous"
   */
  it("should treat a blank SOUS_HOME as unset", () => {
    expect(resolveSousHomeDir({ SOUS_HOME: "   ", HOME: "/home/me" })).toBe(
      path.join("/home/me", ".sous")
    );
    expect(resolveSousHomeDir({ SOUS_HOME: "", HOME: "/home/me" })).toBe(
      path.join("/home/me", ".sous")
    );
  });

  /**
   * resolveSousHomeDir should expand a leading tilde in SOUS_HOME, so a value
   * set in an env file behaves the way it reads.
   *
   * resolveSousHomeDir({ SOUS_HOME: "~/elsewhere", HOME: "/home/me" });
   * // -> "/home/me/elsewhere"
   */
  it("should expand a leading tilde in SOUS_HOME", () => {
    expect(resolveSousHomeDir({ SOUS_HOME: "~/elsewhere", HOME: "/home/me" })).toBe(
      path.join("/home/me", "elsewhere")
    );
  });

  /**
   * The paths built on top of the home directory should sit inside it, so a
   * caller never has to assemble them itself.
   *
   * globalLinksPath({ SOUS_HOME: "/opt/sous" }); // -> "/opt/sous/sous.links.json"
   */
  it("should place the global links file and repos directory inside the home", () => {
    const env = { SOUS_HOME: "/opt/sous" };
    expect(globalLinksPath(env)).toBe(path.join("/opt/sous", "sous.links.json"));
    expect(globalReposDir(env)).toBe(path.join("/opt/sous", "repos"));
  });

  /**
   * The project paths should sit inside the discovered `.sous/` directory.
   *
   * projectLinksPath("/p/.sous"); // -> "/p/.sous/sous.links.json"
   */
  it("should place the project links file and repos directory inside .sous", () => {
    expect(projectLinksPath("/p/.sous")).toBe(path.join("/p/.sous", "sous.links.json"));
    expect(projectReposDir("/p/.sous")).toBe(path.join("/p/.sous", "repos"));
  });
});

describe("reading and writing links", () => {
  let tmp: TmpDir;
  let sousDir: string;
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmp = makeTmpDir("sous-links-");
    sousDir = path.join(tmp.path, "project", ".sous");
    home = path.join(tmp.path, "home", ".sous");
    fs.mkdirSync(sousDir, { recursive: true });
    env = { SOUS_HOME: home };
  });

  afterEach(() => {
    tmp.cleanup();
  });

  /**
   * A missing links file should read as an empty map rather than an error: a
   * project that has never linked anything is the normal case.
   *
   * readProjectLinks("/p/.sous"); // -> { formatVersion: 1, links: {} }
   */
  it("should read a missing links file as an empty map", () => {
    expect(readProjectLinks(sousDir)).toEqual({ formatVersion: 1, links: {} });
    expect(readGlobalLinks(env)).toEqual({ formatVersion: 1, links: {} });
  });

  /**
   * Writing then reading a map should round-trip it exactly, through the same
   * schema that validates a hand-edited file.
   */
  it("should round-trip a written map through the parser", () => {
    const map = linksWith({ "sous-recipes": "/work/sous-recipes" });
    writeProjectLinks(sousDir, map);
    expect(readProjectLinks(sousDir)).toEqual(map);

    writeGlobalLinks(map, env);
    expect(readGlobalLinks(env)).toEqual(map);
    expect(fs.existsSync(globalLinksPath(env))).toBe(true);
  });

  /**
   * A links file that exists but does not validate should raise a ConfigError
   * naming it, never be silently treated as empty: losing a link silently would
   * change what a build produces with nothing to show for it.
   */
  it("should raise a ConfigError for a links file that does not validate", () => {
    fs.writeFileSync(
      projectLinksPath(sousDir),
      JSON.stringify({ formatVersion: 1, links: { good: { path: "relative/path" } } }),
      "utf8"
    );

    let caught: unknown;
    try {
      readProjectLinks(sousDir);
    } catch (error) {
      caught = error;
    }
    expect(isConfigError(caught)).toBe(true);
    expect((caught as Error).message).toContain(projectLinksPath(sousDir));
  });

  /**
   * readEffectiveLinks should merge both maps with the project's entries
   * winning, which is the precedence `sous repo link` documents: the narrower
   * decision is the more deliberate one.
   *
   * global:  { a: /g/a, b: /g/b }
   * project: { b: /p/b }
   * // -> { a: /g/a, b: /p/b }
   */
  it("should merge both maps with the project's entries winning", () => {
    writeGlobalLinks(linksWith({ a: "/g/a", b: "/g/b" }), env);
    writeProjectLinks(sousDir, linksWith({ b: "/p/b" }));

    const merged = readEffectiveLinks(sousDir, env);
    expect(Object.keys(merged).sort()).toEqual(["a", "b"]);
    expect(merged.a!.path).toBe("/g/a");
    expect(merged.b!.path).toBe("/p/b");
  });

  /**
   * linkedPathFor should return the working copy for a linked repository and
   * undefined for one that is not linked, which is the signal to fall through
   * to the store.
   *
   * linkedPathFor("sous-recipes", sousDir); // -> "/work/sous-recipes"
   * linkedPathFor("other", sousDir);        // -> undefined
   */
  it("should return the linked path, or undefined when nothing is linked", () => {
    writeProjectLinks(sousDir, linksWith({ "sous-recipes": "/work/sous-recipes" }));
    expect(linkedPathFor("sous-recipes", sousDir, env)).toBe("/work/sous-recipes");
    expect(linkedPathFor("other", sousDir, env)).toBeUndefined();
  });
});

describe("describeLinkedRepos()", () => {
  let tmp: TmpDir;
  let sousDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmp = makeTmpDir("sous-links-notice-");
    sousDir = path.join(tmp.path, ".sous");
    fs.mkdirSync(sousDir, { recursive: true });
    env = { SOUS_HOME: path.join(tmp.path, "home") };
  });

  afterEach(() => {
    tmp.cleanup();
  });

  /**
   * describeLinkedRepos should return nothing at all when nothing is linked,
   * which is the signal for a build to print no notice.
   *
   * describeLinkedRepos(sousDir); // -> []
   */
  it("should return no lines when nothing is linked", () => {
    expect(describeLinkedRepos(sousDir, env)).toEqual([]);
  });

  /**
   * describeLinkedRepos should name every linked repository and its working
   * copy, and say how to undo it, so a link is never a silent change to what a
   * build produces.
   */
  it("should name every linked repository and how to undo it", () => {
    writeProjectLinks(sousDir, linksWith({ zebra: "/w/zebra", alpha: "/w/alpha" }));

    const lines = describeLinkedRepos(sousDir, env);
    const text = lines.join("\n");

    expect(text).toContain("2 repositories are LINKED");
    expect(text).toContain("alpha -> /w/alpha");
    expect(text).toContain("zebra -> /w/zebra");
    expect(text).toContain("sous repo unlink");
    // Sorted, so the notice reads the same on every machine.
    expect(lines.indexOf("alpha -> /w/alpha")).toBeLessThan(
      lines.indexOf("zebra -> /w/zebra")
    );
  });

  /**
   * The notice should say "One repository" rather than "1 repositories" for a
   * single link; CLI output is written in complete sentences.
   */
  it("should use singular wording for a single link", () => {
    writeProjectLinks(sousDir, linksWith({ alpha: "/w/alpha" }));
    expect(describeLinkedRepos(sousDir, env).join("\n")).toContain(
      "One repository is LINKED"
    );
  });
});

describe("applyManagedIgnoreBlock()", () => {
  /** The block sous maintains, as it appears in the file. */
  const block = [IGNORE_BLOCK_START, ...IGNORE_BLOCK_ENTRIES, IGNORE_BLOCK_END].join("\n");

  /**
   * applyManagedIgnoreBlock should produce just the block for a file that does
   * not exist yet.
   *
   * applyManagedIgnoreBlock(undefined); // -> "# >>> sous managed ...\n...\n# <<< sous managed\n"
   */
  it("should produce just the block when there is no file", () => {
    expect(applyManagedIgnoreBlock(undefined)).toBe(`${block}\n`);
    expect(applyManagedIgnoreBlock("")).toBe(`${block}\n`);
  });

  /**
   * applyManagedIgnoreBlock should append the block to an existing file,
   * leaving every line the user wrote exactly where it was.
   *
   * applyManagedIgnoreBlock("my-notes.md\n");
   * // -> "my-notes.md\n\n# >>> sous managed ...\n"
   */
  it("should append the block and leave the user's own lines alone", () => {
    const result = applyManagedIgnoreBlock("my-notes.md\nscratch/\n");
    expect(result.startsWith("my-notes.md\nscratch/\n")).toBe(true);
    expect(result).toContain(block);
  });

  /**
   * applyManagedIgnoreBlock should be idempotent: applying it to its own output
   * changes nothing, so `sous repo link` can run any number of times without
   * growing the file.
   */
  it("should be idempotent", () => {
    const once = applyManagedIgnoreBlock("keep-me\n");
    const twice = applyManagedIgnoreBlock(once);
    expect(twice).toBe(once);
    expect(applyManagedIgnoreBlock(twice)).toBe(once);
  });

  /**
   * applyManagedIgnoreBlock should replace a stale block in place, keeping the
   * lines above and below it, so an entry sous no longer manages disappears
   * without disturbing anything the user wrote.
   */
  it("should replace a stale block in place, keeping the lines around it", () => {
    const stale = [
      "above.txt",
      IGNORE_BLOCK_START,
      "something-old",
      IGNORE_BLOCK_END,
      "below.txt",
      "",
    ].join("\n");

    const result = applyManagedIgnoreBlock(stale);

    expect(result).toContain("above.txt");
    expect(result).toContain("below.txt");
    expect(result).not.toContain("something-old");
    expect(result).toContain(block);
    expect(result.indexOf("above.txt")).toBeLessThan(result.indexOf(IGNORE_BLOCK_START));
    expect(result.indexOf("below.txt")).toBeGreaterThan(result.indexOf(IGNORE_BLOCK_END));
  });

  /**
   * applyManagedIgnoreBlock should refuse to guess when the opening marker has
   * no closing partner: sous cannot tell where the block ends, and guessing
   * would mean rewriting lines it does not manage.
   */
  it("should raise a ConfigError when the closing marker is missing", () => {
    let caught: unknown;
    try {
      applyManagedIgnoreBlock(`${IGNORE_BLOCK_START}\nsomething\n`, "/p/.sous/.gitignore");
    } catch (error) {
      caught = error;
    }
    expect(isConfigError(caught)).toBe(true);
    expect((caught as Error).message).toContain("/p/.sous/.gitignore");
    expect((caught as Error).message).toContain("no closing marker");
  });
});

describe("ensureReposIgnoreFiles()", () => {
  let tmp: TmpDir;
  let sousDir: string;

  beforeEach(() => {
    tmp = makeTmpDir("sous-links-ignore-");
    sousDir = path.join(tmp.path, ".sous");
    fs.mkdirSync(sousDir, { recursive: true });
  });

  afterEach(() => {
    tmp.cleanup();
  });

  /**
   * ensureReposIgnoreFiles should write `.sous/repos/.gitignore` holding a
   * single `*`, which hides the directory's whole contents including that file
   * itself, and a managed block in `.sous/.gitignore`.
   */
  it("should write both ignore files", () => {
    ensureReposIgnoreFiles(sousDir);

    expect(fs.readFileSync(path.join(sousDir, "repos", ".gitignore"), "utf8")).toBe("*\n");

    const gitignore = fs.readFileSync(path.join(sousDir, ".gitignore"), "utf8");
    for (const entry of IGNORE_BLOCK_ENTRIES) {
      expect(gitignore).toContain(entry);
    }
    expect(gitignore).toContain(IGNORE_BLOCK_START);
    expect(gitignore).toContain(IGNORE_BLOCK_END);
  });

  /**
   * ensureReposIgnoreFiles should be safe to run again: a second call leaves
   * both files byte for byte identical, so linking repeatedly never produces a
   * diff.
   */
  it("should leave both files unchanged on a second run", () => {
    ensureReposIgnoreFiles(sousDir);
    const first = fs.readFileSync(path.join(sousDir, ".gitignore"), "utf8");

    ensureReposIgnoreFiles(sousDir);
    expect(fs.readFileSync(path.join(sousDir, ".gitignore"), "utf8")).toBe(first);
  });

  /**
   * ensureReposIgnoreFiles should never disturb entries the user added to
   * `.sous/.gitignore` themselves.
   */
  it("should preserve the user's own ignore entries", () => {
    fs.writeFileSync(path.join(sousDir, ".gitignore"), "scratch/\n*.bak\n", "utf8");

    ensureReposIgnoreFiles(sousDir);

    const gitignore = fs.readFileSync(path.join(sousDir, ".gitignore"), "utf8");
    expect(gitignore).toContain("scratch/");
    expect(gitignore).toContain("*.bak");
    expect(gitignore).toContain(IGNORE_BLOCK_START);
  });
});

describe("resolveSousHomeDir() without an environment", () => {
  /**
   * With neither SOUS_HOME nor HOME set, resolveSousHomeDir should still return
   * an absolute path, falling back to the operating system's own idea of the
   * home directory.
   *
   * resolveSousHomeDir({}); // -> "<os.homedir()>/.sous"
   */
  it("should fall back to the operating system home directory", () => {
    expect(resolveSousHomeDir({})).toBe(path.join(os.homedir(), ".sous"));
  });
});
