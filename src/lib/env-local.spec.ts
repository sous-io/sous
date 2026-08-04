import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { loadEnvDefaults, loadEnvFiles, loadEnvLocal, parseEnvLocal } from "./env-local.js";
import { makeTmpDir, type TmpDir } from "../test/utils/tmp.js";

// ---------------------------------------------------------------------------
// parseEnvLocal()
// ---------------------------------------------------------------------------

describe("parseEnvLocal()", () => {
  /**
   * parseEnvLocal() should parse a plain KEY=VALUE line.
   *
   * parseEnvLocal("FOO=bar"); // -> { FOO: "bar" }
   */
  it("should parse a plain KEY=VALUE line", () => {
    expect(parseEnvLocal("FOO=bar")).toEqual({ FOO: "bar" });
  });

  /**
   * parseEnvLocal() should parse several lines, including CRLF line endings.
   *
   * parseEnvLocal("A=1\r\nB=2"); // -> { A: "1", B: "2" }
   */
  it("should parse multiple lines and tolerate CRLF endings", () => {
    expect(parseEnvLocal("A=1\r\nB=2\n")).toEqual({ A: "1", B: "2" });
  });

  /**
   * parseEnvLocal() should ignore the `export ` prefix so a file can double as a
   * shell-sourceable script.
   *
   * parseEnvLocal("export FOO=bar"); // -> { FOO: "bar" }
   */
  it("should ignore an export prefix", () => {
    expect(parseEnvLocal("export FOO=bar")).toEqual({ FOO: "bar" });
  });

  /**
   * parseEnvLocal() should skip blank lines and whole-line # comments.
   *
   * parseEnvLocal("# note\n\nFOO=bar\n"); // -> { FOO: "bar" }
   */
  it("should skip blank lines and comment lines", () => {
    expect(parseEnvLocal("# a note\n\n   \n  # indented comment\nFOO=bar\n")).toEqual({
      FOO: "bar",
    });
  });

  /**
   * parseEnvLocal() should strip surrounding double quotes from a value.
   *
   * parseEnvLocal('FOO="bar baz"'); // -> { FOO: "bar baz" }
   */
  it("should unquote a double-quoted value", () => {
    expect(parseEnvLocal('FOO="bar baz"')).toEqual({ FOO: "bar baz" });
  });

  /**
   * parseEnvLocal() should strip surrounding single quotes without interpreting
   * escapes inside them.
   *
   * parseEnvLocal("FOO='a\\nb'"); // -> { FOO: "a\\nb" }  (literal backslash-n)
   */
  it("should unquote a single-quoted value without expanding escapes", () => {
    expect(parseEnvLocal("FOO='a\\nb'")).toEqual({ FOO: "a\\nb" });
  });

  /**
   * parseEnvLocal() should turn \n and \t inside a double-quoted value into real
   * newline and tab characters.
   *
   * parseEnvLocal('FOO="a\\nb"'); // -> { FOO: "a\nb" }
   */
  it("should expand \\n and \\t inside a double-quoted value", () => {
    expect(parseEnvLocal('FOO="line1\\nline2\\tend"')).toEqual({ FOO: "line1\nline2\tend" });
  });

  /**
   * parseEnvLocal() should preserve a `#` that is inside a quoted value rather
   * than treating it as the start of a comment.
   *
   * parseEnvLocal('TOKEN="abc#123"'); // -> { TOKEN: "abc#123" }
   */
  it("should keep a # that appears inside a quoted value", () => {
    expect(parseEnvLocal('TOKEN="abc#123"')).toEqual({ TOKEN: "abc#123" });
  });

  /**
   * parseEnvLocal() should strip a trailing inline comment from an unquoted value.
   *
   * parseEnvLocal("FOO=bar # trailing note"); // -> { FOO: "bar" }
   */
  it("should strip a trailing inline comment from an unquoted value", () => {
    expect(parseEnvLocal("FOO=bar # trailing note")).toEqual({ FOO: "bar" });
  });

  /**
   * parseEnvLocal() should keep a `#` that is part of an unquoted value with no
   * preceding whitespace, since that is not a comment.
   *
   * parseEnvLocal("COLOR=#ff0000"); // -> { COLOR: "#ff0000" }
   */
  it("should keep a # attached to an unquoted value", () => {
    expect(parseEnvLocal("COLOR=#ff0000")).toEqual({ COLOR: "#ff0000" });
  });

  /**
   * parseEnvLocal() should trim whitespace around both the key and an unquoted
   * value.
   *
   * parseEnvLocal("  FOO  =  bar  "); // -> { FOO: "bar" }
   */
  it("should trim whitespace around the key and an unquoted value", () => {
    expect(parseEnvLocal("  FOO  =  bar  ")).toEqual({ FOO: "bar" });
  });

  /**
   * parseEnvLocal() should keep `=` characters that appear inside the value,
   * splitting only on the first `=`.
   *
   * parseEnvLocal("URL=a=b=c"); // -> { URL: "a=b=c" }
   */
  it("should split on the first = only", () => {
    expect(parseEnvLocal("URL=a=b=c")).toEqual({ URL: "a=b=c" });
  });

  /**
   * parseEnvLocal() should produce an empty string for a key with no value.
   *
   * parseEnvLocal("EMPTY="); // -> { EMPTY: "" }
   */
  it("should produce an empty string for a valueless key", () => {
    expect(parseEnvLocal("EMPTY=")).toEqual({ EMPTY: "" });
  });

  /**
   * parseEnvLocal() should ignore lines with no `=`, an empty key, or an invalid
   * key, rather than throwing — a stray note must not break a build.
   *
   * parseEnvLocal("just a note\n=orphan\n1BAD=x\nFOO=bar"); // -> { FOO: "bar" }
   */
  it("should ignore malformed lines instead of throwing", () => {
    expect(parseEnvLocal("just a note\n=orphan\n1BAD=x\nhas space=x\nFOO=bar")).toEqual({
      FOO: "bar",
    });
  });

  /**
   * parseEnvLocal() should let a later duplicate key win.
   *
   * parseEnvLocal("FOO=first\nFOO=second"); // -> { FOO: "second" }
   */
  it("should let the last duplicate key win", () => {
    expect(parseEnvLocal("FOO=first\nFOO=second")).toEqual({ FOO: "second" });
  });

  /**
   * parseEnvLocal() should return an empty object for empty content.
   *
   * parseEnvLocal(""); // -> {}
   */
  it("should return an empty object for empty content", () => {
    expect(parseEnvLocal("")).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// loadEnvLocal()
// ---------------------------------------------------------------------------

describe("loadEnvLocal()", () => {
  let tmp: TmpDir;

  /** Writes .env.local into the temp dir (treated as the .sous/ directory). */
  function writeEnvLocal(content: string): void {
    fs.writeFileSync(path.join(tmp.path, ".env.local"), content, "utf8");
  }

  beforeEach(() => {
    tmp = makeTmpDir("sous-envlocal-");
  });

  afterEach(() => {
    tmp.cleanup();
  });

  /**
   * loadEnvLocal() should report loaded=false, and apply nothing, when the
   * .sous/ directory has no .env.local file.
   *
   * loadEnvLocal("<tmp>", env); // -> { loaded: false, applied: [], skipped: [] }
   */
  it("should do nothing when .env.local does not exist", () => {
    const env: NodeJS.ProcessEnv = {};
    const result = loadEnvLocal(tmp.path, env);
    expect(result.loaded).toBe(false);
    expect(result.applied).toEqual([]);
    expect(env).toEqual({});
    expect(result.filePath).toBe(path.join(tmp.path, ".env.local"));
  });

  /**
   * loadEnvLocal() should inject parsed variables into the supplied environment
   * object and list them in `applied`.
   *
   * // .env.local: FOO=bar
   * loadEnvLocal("<tmp>", env); // -> env.FOO === "bar"; applied === ["FOO"]
   */
  it("should inject parsed variables into the environment", () => {
    writeEnvLocal("FOO=bar\nBAZ=qux\n");
    const env: NodeJS.ProcessEnv = {};
    const result = loadEnvLocal(tmp.path, env);
    expect(env.FOO).toBe("bar");
    expect(env.BAZ).toBe("qux");
    expect(result.loaded).toBe(true);
    expect(result.applied.sort()).toEqual(["BAZ", "FOO"]);
  });

  /**
   * loadEnvLocal() must not overwrite a variable already present in the
   * environment: a real env var (or one set on the command line) always wins.
   *
   * // env.FOO = "from-shell"; .env.local: FOO=from-file
   * loadEnvLocal("<tmp>", env); // -> env.FOO stays "from-shell"; skipped ["FOO"]
   */
  it("should not overwrite variables already set in the environment", () => {
    writeEnvLocal("FOO=from-file\nNEW=added\n");
    const env: NodeJS.ProcessEnv = { FOO: "from-shell" };
    const result = loadEnvLocal(tmp.path, env);
    expect(env.FOO).toBe("from-shell");
    expect(env.NEW).toBe("added");
    expect(result.skipped).toEqual(["FOO"]);
    expect(result.applied).toEqual(["NEW"]);
  });

  /**
   * loadEnvLocal() should treat an existing empty-string value as "already set"
   * and leave it alone, since an empty value can be deliberate.
   *
   * // env.FOO = ""; .env.local: FOO=x
   * loadEnvLocal("<tmp>", env); // -> env.FOO stays ""
   */
  it("should treat an existing empty-string value as already set", () => {
    writeEnvLocal("FOO=x\n");
    const env: NodeJS.ProcessEnv = { FOO: "" };
    loadEnvLocal(tmp.path, env);
    expect(env.FOO).toBe("");
  });

  /**
   * loadEnvLocal() should apply comment and quoting rules from the parser when
   * reading a real file.
   *
   * // .env.local with comments and quoted values
   * loadEnvLocal("<tmp>", env); // -> only real keys injected, values unquoted
   */
  it("should apply parser rules when reading a real file", () => {
    writeEnvLocal(
      [
        "# machine-specific settings",
        "",
        'SOUS_SHARED_PATH="/home/dev/code/sous shared"',
        "export TOKEN=abc123 # keep this secret",
        "",
      ].join("\n")
    );
    const env: NodeJS.ProcessEnv = {};
    loadEnvLocal(tmp.path, env);
    expect(env.SOUS_SHARED_PATH).toBe("/home/dev/code/sous shared");
    expect(env.TOKEN).toBe("abc123");
    expect(Object.keys(env).sort()).toEqual(["SOUS_SHARED_PATH", "TOKEN"]);
  });
});

// ---------------------------------------------------------------------------
// loadEnvDefaults()
// ---------------------------------------------------------------------------

describe("loadEnvDefaults()", () => {
  let tmp: TmpDir;

  /** Writes .env (the committed shared-defaults layer) into the temp dir. */
  function writeEnvDefaults(content: string): void {
    fs.writeFileSync(path.join(tmp.path, ".env"), content, "utf8");
  }

  beforeEach(() => {
    tmp = makeTmpDir("sous-envdefaults-");
  });

  afterEach(() => {
    tmp.cleanup();
  });

  /**
   * loadEnvDefaults() should report loaded=false when the `.sous/` directory has
   * no `.env` file, since the defaults layer is optional.
   *
   * loadEnvDefaults("<tmp>", env); // -> { loaded: false, applied: [] }
   */
  it("should do nothing when .env does not exist", () => {
    const env: NodeJS.ProcessEnv = {};
    const result = loadEnvDefaults(tmp.path, env);
    expect(result.loaded).toBe(false);
    expect(result.applied).toEqual([]);
    expect(env).toEqual({});
  });

  /**
   * loadEnvDefaults() should read `.env`, not `.env.local`, so the two layers
   * stay independent.
   *
   * loadEnvDefaults("<tmp>", env); // -> result.filePath ends in "/.env"
   */
  it("should target the .env file", () => {
    const result = loadEnvDefaults(tmp.path, {});
    expect(result.filePath).toBe(path.join(tmp.path, ".env"));
  });

  /**
   * loadEnvDefaults() should inject `.env` values when nothing else supplied
   * them, which is the whole point of a shared-defaults layer.
   *
   * // .env: FOO=shared
   * loadEnvDefaults("<tmp>", env); // -> env.FOO === "shared"
   */
  it("should inject .env values into the environment", () => {
    writeEnvDefaults("FOO=shared\nBAR=team\n");
    const env: NodeJS.ProcessEnv = {};
    const result = loadEnvDefaults(tmp.path, env);
    expect(env.FOO).toBe("shared");
    expect(env.BAR).toBe("team");
    expect(result.loaded).toBe(true);
    expect(result.applied.sort()).toEqual(["BAR", "FOO"]);
  });

  /**
   * loadEnvDefaults() must not overwrite a value already in the environment, so
   * the shell still beats the committed defaults.
   *
   * // env.FOO = "from-shell"; .env: FOO=shared
   * loadEnvDefaults("<tmp>", env); // -> env.FOO stays "from-shell"
   */
  it("should not overwrite variables already set in the environment", () => {
    writeEnvDefaults("FOO=shared\n");
    const env: NodeJS.ProcessEnv = { FOO: "from-shell" };
    const result = loadEnvDefaults(tmp.path, env);
    expect(env.FOO).toBe("from-shell");
    expect(result.skipped).toEqual(["FOO"]);
  });
});

// ---------------------------------------------------------------------------
// loadEnvFiles() — the two-layer precedence chain
// ---------------------------------------------------------------------------

describe("loadEnvFiles()", () => {
  let tmp: TmpDir;

  function writeEnvDefaults(content: string): void {
    fs.writeFileSync(path.join(tmp.path, ".env"), content, "utf8");
  }

  function writeEnvLocal(content: string): void {
    fs.writeFileSync(path.join(tmp.path, ".env.local"), content, "utf8");
  }

  beforeEach(() => {
    tmp = makeTmpDir("sous-envfiles-");
  });

  afterEach(() => {
    tmp.cleanup();
  });

  /**
   * loadEnvFiles() should work with only `.env` present, so a team can commit
   * shared defaults and no one needs a `.env.local` at all.
   *
   * // .env: FOO=shared  (no .env.local)
   * loadEnvFiles("<tmp>", env); // -> env.FOO === "shared"
   */
  it("should apply .env when no .env.local exists", () => {
    writeEnvDefaults("FOO=shared\nBAR=team\n");
    const env: NodeJS.ProcessEnv = {};
    const result = loadEnvFiles(tmp.path, env);
    expect(env.FOO).toBe("shared");
    expect(env.BAR).toBe("team");
    expect(result.defaults.loaded).toBe(true);
    expect(result.local.loaded).toBe(false);
  });

  /**
   * loadEnvFiles() should still work with only `.env.local` present, preserving
   * the behaviour that existed before the defaults layer was added.
   *
   * // .env.local: FOO=machine  (no .env)
   * loadEnvFiles("<tmp>", env); // -> env.FOO === "machine"
   */
  it("should apply .env.local when no .env exists", () => {
    writeEnvLocal("FOO=machine\n");
    const env: NodeJS.ProcessEnv = {};
    const result = loadEnvFiles(tmp.path, env);
    expect(env.FOO).toBe("machine");
    expect(result.local.loaded).toBe(true);
    expect(result.defaults.loaded).toBe(false);
  });

  /**
   * loadEnvFiles() should let `.env.local` override `.env` for a key set in
   * both: the machine-specific layer outranks the shared defaults.
   *
   * // .env: FOO=shared ; .env.local: FOO=machine
   * loadEnvFiles("<tmp>", env); // -> env.FOO === "machine"
   */
  it("should let .env.local win over .env", () => {
    writeEnvDefaults("FOO=shared\n");
    writeEnvLocal("FOO=machine\n");
    const env: NodeJS.ProcessEnv = {};
    loadEnvFiles(tmp.path, env);
    expect(env.FOO).toBe("machine");
  });

  /**
   * loadEnvFiles() should merge the layers key by key: `.env` supplies the keys
   * `.env.local` does not mention, rather than being discarded wholesale.
   *
   * // .env: A=shared B=shared ; .env.local: B=machine
   * loadEnvFiles("<tmp>", env); // -> { A: "shared", B: "machine" }
   */
  it("should merge the two files per key", () => {
    writeEnvDefaults("A=shared\nB=shared\n");
    writeEnvLocal("B=machine\nC=machine\n");
    const env: NodeJS.ProcessEnv = {};
    loadEnvFiles(tmp.path, env);
    expect(env.A).toBe("shared");
    expect(env.B).toBe("machine");
    expect(env.C).toBe("machine");
  });

  /**
   * loadEnvFiles() should give the real shell environment the highest
   * precedence, beating both files, so `FOO=x xcv build` always wins.
   *
   * // env.FOO = "from-shell" ; .env: FOO=shared ; .env.local: FOO=machine
   * loadEnvFiles("<tmp>", env); // -> env.FOO stays "from-shell"
   */
  it("should let the shell environment win over both files", () => {
    writeEnvDefaults("FOO=shared\n");
    writeEnvLocal("FOO=machine\n");
    const env: NodeJS.ProcessEnv = { FOO: "from-shell" };
    loadEnvFiles(tmp.path, env);
    expect(env.FOO).toBe("from-shell");
  });

  /**
   * loadEnvFiles() should resolve the full three-way chain at once, each key
   * landing at its highest-precedence source.
   *
   * shell > .env.local > .env, per key.
   */
  it("should resolve the full shell > .env.local > .env chain", () => {
    writeEnvDefaults("FROM_DEFAULTS=d\nFROM_LOCAL=d\nFROM_SHELL=d\n");
    writeEnvLocal("FROM_LOCAL=l\nFROM_SHELL=l\n");
    const env: NodeJS.ProcessEnv = { FROM_SHELL: "s" };
    loadEnvFiles(tmp.path, env);
    expect(env.FROM_SHELL).toBe("s");
    expect(env.FROM_LOCAL).toBe("l");
    expect(env.FROM_DEFAULTS).toBe("d");
  });

  /**
   * loadEnvFiles() should report `.env` keys that lost to a higher layer as
   * skipped, so the result stays a truthful record of what was applied.
   *
   * // .env: FOO=shared ; .env.local: FOO=machine
   * loadEnvFiles("<tmp>", env); // -> defaults.skipped === ["FOO"]
   */
  it("should report shadowed .env keys as skipped", () => {
    writeEnvDefaults("FOO=shared\nONLY=here\n");
    writeEnvLocal("FOO=machine\n");
    const result = loadEnvFiles(tmp.path, {});
    expect(result.local.applied).toEqual(["FOO"]);
    expect(result.defaults.skipped).toEqual(["FOO"]);
    expect(result.defaults.applied).toEqual(["ONLY"]);
  });

  /**
   * loadEnvFiles() should do nothing when neither file exists, since both layers
   * are optional and a fresh clone has neither.
   *
   * loadEnvFiles("<tmp>", env); // -> env unchanged
   */
  it("should do nothing when neither file exists", () => {
    const env: NodeJS.ProcessEnv = {};
    const result = loadEnvFiles(tmp.path, env);
    expect(env).toEqual({});
    expect(result.local.loaded).toBe(false);
    expect(result.defaults.loaded).toBe(false);
  });
});
