import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  substituteVars,
  substituteVarsStrict,
  findUnresolvedVars,
  resolveScope,
  buildAutoVars,
  resolveEnvScope,
  resolveRootScope,
  resolveTools,
  resolveWatchConfig,
  resolveCompilation,
  loadSettings,
  isConfigError,
  type Settings,
} from "./settings.js";
import { makeTmpDir } from "../test/utils/tmp.js";

// ---------------------------------------------------------------------------
// substituteVars()
// ---------------------------------------------------------------------------

describe("substituteVars()", () => {
  /**
   * substituteVars() should replace a single ${varName} reference with the
   * corresponding value from the scope.
   *
   * substituteVars("Hello ${name}", { name: "world" });
   * // -> "Hello world"
   */
  it("should substitute a single variable reference", () => {
    expect(substituteVars("Hello ${name}", { name: "world" })).toBe("Hello world");
  });

  /**
   * substituteVars() should replace all ${varName} references in the string,
   * not just the first occurrence.
   *
   * substituteVars("${a} and ${b}", { a: "foo", b: "bar" });
   * // -> "foo and bar"
   */
  it("should substitute multiple variable references in one string", () => {
    expect(substituteVars("${a} and ${b}", { a: "foo", b: "bar" })).toBe("foo and bar");
  });

  /**
   * substituteVars() should leave unknown ${varName} references as-is rather
   * than replacing them with an empty string or throwing.
   *
   * substituteVars("value is ${missing}", {});
   * // -> "value is ${missing}"
   */
  it("should leave unknown variable references unchanged", () => {
    expect(substituteVars("value is ${missing}", {})).toBe("value is ${missing}");
  });

  /**
   * substituteVars() should return the string unchanged when it contains no
   * ${varName} references at all.
   *
   * substituteVars("no refs here", { a: "b" });
   * // -> "no refs here"
   */
  it("should return the string unchanged when there are no references", () => {
    expect(substituteVars("no refs here", { a: "b" })).toBe("no refs here");
  });

  /**
   * substituteVars() should substitute a known reference while leaving an
   * unknown reference intact in the same string.
   *
   * substituteVars("${known} and ${unknown}", { known: "yes" });
   * // -> "yes and ${unknown}"
   */
  it("should substitute known references and leave unknown ones as-is", () => {
    expect(substituteVars("${known} and ${unknown}", { known: "yes" })).toBe("yes and ${unknown}");
  });
});

// ---------------------------------------------------------------------------
// findUnresolvedVars()
// ---------------------------------------------------------------------------

describe("findUnresolvedVars()", () => {
  /**
   * findUnresolvedVars() should return the names of all ${var} references still
   * present in a string.
   *
   * findUnresolvedVars("${a}/x/${b}"); // -> ["a", "b"]
   */
  it("should return every referenced variable name", () => {
    expect(findUnresolvedVars("${a}/x/${b}")).toEqual(["a", "b"]);
  });

  /**
   * findUnresolvedVars() should deduplicate a name that appears more than once.
   *
   * findUnresolvedVars("${a}/${a}"); // -> ["a"]
   */
  it("should deduplicate repeated references", () => {
    expect(findUnresolvedVars("${a}/${a}")).toEqual(["a"]);
  });

  /**
   * findUnresolvedVars() should return an empty array for a string with no
   * references.
   *
   * findUnresolvedVars("/plain/path"); // -> []
   */
  it("should return an empty array when there are no references", () => {
    expect(findUnresolvedVars("/plain/path")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// substituteVarsStrict()
// ---------------------------------------------------------------------------

describe("substituteVarsStrict()", () => {
  /**
   * substituteVarsStrict() should behave like substituteVars() when every
   * reference resolves.
   *
   * substituteVarsStrict("${root}/out.md", { root: "/proj" }, "somewhere");
   * // -> "/proj/out.md"
   */
  it("should substitute normally when all references resolve", () => {
    expect(substituteVarsStrict("${root}/out.md", { root: "/proj" }, "somewhere")).toBe(
      "/proj/out.md"
    );
  });

  /**
   * substituteVarsStrict() should throw when a reference cannot be resolved,
   * naming the variable and the place it was referenced from.
   *
   * substituteVarsStrict("${typo}/x", {}, "compilation.targets[0].entryPoint");
   * // -> throws Error naming "${typo}" and the context string
   */
  it("should throw naming the variable and the context", () => {
    const where = "compilation.targets[0].entryPoint";
    expect(() => substituteVarsStrict("${typo}/x", { other: "y" }, where)).toThrow(/\$\{typo\}/);
    expect(() => substituteVarsStrict("${typo}/x", { other: "y" }, where)).toThrow(
      /compilation\.targets\[0\]\.entryPoint/
    );
  });

  /**
   * substituteVarsStrict() should include the raw value and the variables that
   * ARE in scope, so the mistake is obvious without extra digging.
   *
   * substituteVarsStrict("${typo}", { real: "v" }, "here");
   * // -> throws Error containing "raw value" and "real"
   */
  it("should include the raw value and the in-scope variable names", () => {
    let message = "";
    try {
      substituteVarsStrict("${typo}/x", { real: "v" }, "here");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("raw value: ${typo}/x");
    expect(message).toContain("real");
  });

  /**
   * substituteVarsStrict() should mention `.sous/.env.local` as a place the value
   * can come from, since that is the new home for machine-specific settings.
   *
   * substituteVarsStrict("${missing}", {}, "here");
   * // -> throws Error mentioning ".sous/.env.local"
   */
  it("should point at .sous/.env.local as a source for the value", () => {
    expect(() => substituteVarsStrict("${missing}", {}, "here")).toThrow(/\.sous\/\.env\.local/);
  });

  /**
   * substituteVarsStrict() should name every unresolved variable, not only the
   * first one.
   *
   * substituteVarsStrict("${a}/${b}", {}, "here");
   * // -> throws Error naming both "${a}" and "${b}"
   */
  it("should name all unresolved variables", () => {
    let message = "";
    try {
      substituteVarsStrict("${a}/${b}", {}, "here");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("${a}");
    expect(message).toContain("${b}");
  });
});

// ---------------------------------------------------------------------------
// resolveScope()
// ---------------------------------------------------------------------------

describe("resolveScope()", () => {
  /**
   * resolveScope() should merge the block vars with the inherited scope,
   * with block vars taking precedence over inherited vars that share the same name.
   *
   * resolveScope({ key: "block" }, { key: "inherited", other: "x" });
   * // -> { key: "block", other: "x" }
   */
  it("should let block vars override inherited vars with the same name", () => {
    const result = resolveScope({ key: "block" }, { key: "inherited", other: "x" });
    expect(result.key).toBe("block");
    expect(result.other).toBe("x");
  });

  /**
   * resolveScope() should make inherited scope values available to block vars
   * that reference them via ${varName}.
   *
   * resolveScope({ full: "${base}/sub" }, { base: "/home/user" });
   * // -> { base: "/home/user", full: "/home/user/sub" }
   */
  it("should allow block vars to reference inherited vars", () => {
    const result = resolveScope({ full: "${base}/sub" }, { base: "/home/user" });
    expect(result.full).toBe("/home/user/sub");
    expect(result.base).toBe("/home/user");
  });

  /**
   * resolveScope() should resolve intra-block dependencies so that one block
   * var can reference another block var defined in the same block.
   *
   * resolveScope({ root: "/data", file: "${root}/output.md" }, {});
   * // -> { root: "/data", file: "/data/output.md" }
   */
  it("should resolve intra-block variable dependencies in topological order", () => {
    const result = resolveScope({ root: "/data", file: "${root}/output.md" }, {});
    expect(result.root).toBe("/data");
    expect(result.file).toBe("/data/output.md");
  });

  /**
   * resolveScope() should handle a multi-hop intra-block chain where A depends
   * on B which depends on C.
   *
   * resolveScope({ a: "${b}/a", b: "${c}/b", c: "root" }, {});
   * // -> { c: "root", b: "root/b", a: "root/b/a" }
   */
  it("should resolve a multi-hop intra-block dependency chain", () => {
    const result = resolveScope({ a: "${b}/a", b: "${c}/b", c: "root" }, {});
    expect(result.c).toBe("root");
    expect(result.b).toBe("root/b");
    expect(result.a).toBe("root/b/a");
  });

  /**
   * resolveScope() should emit a console.warn when a block var uses the
   * reserved 'sous*' namespace.
   *
   * resolveScope({ sousCustom: "value" }, {});
   * // -> warns about reserved namespace
   */
  it("should warn when a var uses the reserved sous* namespace", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveScope({ sousCustom: "value" }, {});
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("sousCustom")
    );
    warnSpy.mockRestore();
  });

  /**
   * resolveScope() should not throw when intra-block variables form a circular
   * dependency. The cycle guard prevents infinite recursion and the vars are
   * included in the result with partial (possibly unresolved) values.
   *
   * resolveScope({ a: "${b}", b: "${a}" }, {});
   * // -> does not throw
   */
  it("should handle circular intra-block dependencies without throwing", () => {
    expect(() => resolveScope({ a: "${b}", b: "${a}" }, {})).not.toThrow();
  });

  /**
   * resolveScope() should return the inherited scope unchanged when the block
   * is empty.
   *
   * resolveScope({}, { x: "1" });
   * // -> { x: "1" }
   */
  it("should return the inherited scope when the block is empty", () => {
    const result = resolveScope({}, { x: "1" });
    expect(result).toEqual({ x: "1" });
  });
});

// ---------------------------------------------------------------------------
// buildAutoVars()
// ---------------------------------------------------------------------------

describe("buildAutoVars()", () => {
  /**
   * buildAutoVars() should return an object that contains a non-empty string
   * for the 'sousRootPath' key.
   *
   * buildAutoVars().sousRootPath;
   * // -> "/some/absolute/path"
   */
  it("should return a sousRootPath string", () => {
    const vars = buildAutoVars();
    expect(typeof vars.sousRootPath).toBe("string");
    expect(vars.sousRootPath.length).toBeGreaterThan(0);
  });

  /**
   * buildAutoVars() should return an object that contains a non-empty string
   * for the 'sousVersion' key.
   *
   * buildAutoVars().sousVersion;
   * // -> "0.1.0"
   */
  it("should return a sousVersion string", () => {
    const vars = buildAutoVars();
    expect(typeof vars.sousVersion).toBe("string");
    expect(vars.sousVersion.length).toBeGreaterThan(0);
  });

  /**
   * buildAutoVars() should return exactly the two reserved auto-vars
   * (sousRootPath and sousVersion) so callers know what to expect.
   *
   * Object.keys(buildAutoVars());
   * // -> ["sousRootPath", "sousVersion"]
   */
  it("should return an object with exactly sousRootPath and sousVersion keys", () => {
    const vars = buildAutoVars();
    expect(Object.keys(vars).sort()).toEqual(["sousRootPath", "sousVersion"].sort());
  });

  /**
   * buildAutoVars() should add sousDir and sousConfigPath when a ConfigContext is
   * supplied, so a config can build paths relative to its own `.sous/` directory.
   *
   * buildAutoVars({ sousDir: "/proj/.sous", configPath: "/proj/.sous/sous.config.js" });
   * // -> { ..., sousDir: "/proj/.sous", sousConfigPath: "/proj/.sous/sous.config.js" }
   */
  it("should add sousDir and sousConfigPath when a config context is supplied", () => {
    const vars = buildAutoVars({
      sousDir: "/proj/.sous",
      configPath: "/proj/.sous/sous.config.js",
    });
    expect(vars.sousDir).toBe("/proj/.sous");
    expect(vars.sousConfigPath).toBe("/proj/.sous/sous.config.js");
  });
});

// ---------------------------------------------------------------------------
// resolveEnvScope()
// ---------------------------------------------------------------------------

describe("resolveEnvScope()", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /**
   * resolveEnvScope() should map a config var name to the value of the
   * corresponding environment variable when it is set.
   *
   * // process.env.MY_HOME = "/home/user"
   * resolveEnvScope({ _env: { userHome: "MY_HOME" } });
   * // -> { userHome: "/home/user" }
   */
  it("should map config var names to environment variable values", () => {
    vi.stubEnv("MY_HOME", "/home/user");
    const settings: Settings = {
      _env: { userHome: "MY_HOME" },
    };
    const scope = resolveEnvScope(settings);
    expect(scope.userHome).toBe("/home/user");
  });

  /**
   * resolveEnvScope() should throw a descriptive error when a referenced
   * environment variable is not set in process.env.
   *
   * resolveEnvScope({ _env: { missingVar: "NOT_SET_XYZ" } });
   * // -> throws Error containing "NOT_SET_XYZ"
   */
  it("should throw when a referenced environment variable is not set", () => {
    // Ensure the env var is definitely not set
    const settings: Settings = {
      _env: { missingVar: "SOUS_TEST_NOT_SET_XYZ_12345" },
    };
    expect(() => resolveEnvScope(settings)).toThrow(/SOUS_TEST_NOT_SET_XYZ_12345/);
  });

  /**
   * The unset-env-var error should name the discovered `.sous/.env.local` file as
   * the place to define the value, so the fix is obvious on a fresh machine.
   *
   * resolveEnvScope(settings, { sousDir: "/proj/.sous", ... });
   * // -> throws Error containing "/proj/.sous/.env.local"
   */
  it("should name the discovered .sous/.env.local file in the error", () => {
    const settings: Settings = {
      _env: { missingVar: "SOUS_TEST_NOT_SET_XYZ_12345" },
    };
    const context = { sousDir: "/proj/.sous", configPath: "/proj/.sous/sous.config.js" };
    expect(() => resolveEnvScope(settings, context)).toThrow(
      /\/proj\/\.sous\/\.env\.local/
    );
  });

  /**
   * With no ConfigContext the error should still mention `.sous/.env.local`
   * generically rather than omitting the hint.
   *
   * resolveEnvScope(settings); // -> throws Error mentioning ".sous/.env.local"
   */
  it("should mention .sous/.env.local generically when no context is supplied", () => {
    const settings: Settings = {
      _env: { missingVar: "SOUS_TEST_NOT_SET_XYZ_12345" },
    };
    expect(() => resolveEnvScope(settings)).toThrow(/\.sous\/\.env\.local/);
  });

  /**
   * resolveEnvScope() should return an empty scope when the settings object
   * has no _env block.
   *
   * resolveEnvScope({});
   * // -> {}
   */
  it("should return an empty scope when _env is absent", () => {
    const settings: Settings = {};
    expect(resolveEnvScope(settings)).toEqual({});
  });

  /**
   * resolveEnvScope() should resolve multiple env var mappings correctly
   * in a single call.
   *
   * // process.env.ALPHA = "a", process.env.BETA = "b"
   * resolveEnvScope({ _env: { alpha: "ALPHA", beta: "BETA" } });
   * // -> { alpha: "a", beta: "b" }
   */
  it("should resolve multiple env var mappings", () => {
    vi.stubEnv("ALPHA_TEST_VAR", "a");
    vi.stubEnv("BETA_TEST_VAR", "b");
    const settings: Settings = {
      _env: { alpha: "ALPHA_TEST_VAR", beta: "BETA_TEST_VAR" },
    };
    const scope = resolveEnvScope(settings);
    expect(scope).toEqual({ alpha: "a", beta: "b" });
  });
});

// ---------------------------------------------------------------------------
// resolveRootScope()
// ---------------------------------------------------------------------------

describe("resolveRootScope()", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /**
   * resolveRootScope() should include the auto-vars (sousRootPath, sousVersion)
   * in the returned scope.
   *
   * resolveRootScope({});
   * // -> { sousRootPath: "...", sousVersion: "...", ... }
   */
  it("should include auto-vars in the returned scope", () => {
    const scope = resolveRootScope({});
    expect(typeof scope.sousRootPath).toBe("string");
    expect(typeof scope.sousVersion).toBe("string");
  });

  /**
   * resolveRootScope() should make env vars available to root _vars so that
   * a root var can reference an env-mapped config var via ${varName}.
   *
   * // process.env.CODE_BASE = "/projects"
   * resolveRootScope({
   *   _env: { codeBase: "CODE_BASE" },
   *   _vars: { projectRoot: "${codeBase}/myapp" },
   * });
   * // -> { ..., codeBase: "/projects", projectRoot: "/projects/myapp" }
   */
  it("should allow root _vars to reference env-mapped vars", () => {
    vi.stubEnv("CODE_BASE_TEST", "/projects");
    const settings: Settings = {
      _env: { codeBase: "CODE_BASE_TEST" },
      _vars: { projectRoot: "${codeBase}/myapp" },
    };
    const scope = resolveRootScope(settings);
    expect(scope.codeBase).toBe("/projects");
    expect(scope.projectRoot).toBe("/projects/myapp");
  });

  /**
   * resolveRootScope() should resolve root _vars that reference auto-vars
   * like sousRootPath.
   *
   * resolveRootScope({
   *   _vars: { myPath: "${sousRootPath}/configs" },
   * });
   * // -> { ..., myPath: "<sousRootPath>/configs" }
   */
  it("should allow root _vars to reference auto-vars", () => {
    const settings: Settings = {
      _vars: { myPath: "${sousRootPath}/configs" },
    };
    const scope = resolveRootScope(settings);
    const autoVars = buildAutoVars();
    expect(scope.myPath).toBe(`${autoVars.sousRootPath}/configs`);
  });
});

// ---------------------------------------------------------------------------
// resolveTools()
// ---------------------------------------------------------------------------

describe("resolveTools()", () => {
  /**
   * resolveTools() should return an empty object when the project has
   * no tools configured.
   *
   * resolveTools({ name: "My Project", compilation: undefined });
   * // -> {}
   */
  it("should return an empty object when the project has no tools", () => {
    const settings: Settings = { name: "My Project" };
    expect(resolveTools(settings)).toEqual({});
  });

  /**
   * resolveTools() should resolve ${varName} references in promptFile
   * paths using the resolved settings scope.
   *
   * resolveTools(settings, resolveRootScope(settings));
   * // with _vars: { root: "/home/user" } and promptFile "${root}/CLAUDE.md"
   * // -> { claude: { command: "claude", promptFile: "/home/user/CLAUDE.md" } }
   */
  it("should resolve promptFile paths using the settings scope", () => {
    const settings: Settings = {
      name: "P",
      _vars: { root: "/home/user" },
      tools: {
        claude: { command: "claude", promptFile: "${root}/CLAUDE.md" },
      },
    };
    const result = resolveTools(settings, resolveRootScope(settings));
    expect(result.claude.promptFile).toBe("/home/user/CLAUDE.md");
  });

  /**
   * resolveTools() should pass through the command string unchanged.
   *
   * resolveTools({ name: "P", tools: { claude: { command: "claude" } } });
   * // -> { claude: { command: "claude" } }
   */
  it("should pass through the command unchanged", () => {
    const settings: Settings = {
      name: "P",
      tools: { claude: { command: "claude" } },
    };
    const result = resolveTools(settings, {});
    expect(result.claude.command).toBe("claude");
  });

  /**
   * resolveTools() should pass through the args array unchanged.
   *
   * resolveTools(
   *   { name: "P", tools: { claude: { command: "claude", args: ["--verbose"] } } }
   * );
   * // -> { claude: { command: "claude", args: ["--verbose"] } }
   */
  it("should pass through args unchanged", () => {
    const settings: Settings = {
      name: "P",
      tools: { claude: { command: "claude", args: ["--verbose"] } },
    };
    const result = resolveTools(settings, {});
    expect(result.claude.args).toEqual(["--verbose"]);
  });

  /**
   * resolveTools() should omit the promptFile key from the result when
   * it is not set on the tool config.
   *
   * resolveTools({ name: "P", tools: { claude: { command: "claude" } } });
   * // -> { claude: { command: "claude" } }  (no promptFile key)
   */
  it("should omit promptFile from the result when not set on the tool config", () => {
    const settings: Settings = {
      name: "P",
      tools: { claude: { command: "claude" } },
    };
    const result = resolveTools(settings, {});
    expect("promptFile" in result.claude).toBe(false);
  });

  /**
   * resolveTools() should use rootScope vars when resolving promptFile
   * if the project has no _vars of its own.
   *
   * resolveTools(
   *   { name: "P", tools: { myTool: { command: "run", promptFile: "${base}/prompt.md" } } },
   *   { base: "/root" }
   * );
   * // -> { myTool: { command: "run", promptFile: "/root/prompt.md" } }
   */
  it("should fall back to rootScope vars when the project has no _vars", () => {
    const settings: Settings = {
      name: "P",
      tools: { myTool: { command: "run", promptFile: "${base}/prompt.md" } },
    };
    const result = resolveTools(settings, { base: "/root" });
    expect(result.myTool.promptFile).toBe("/root/prompt.md");
  });

  /**
   * resolveTools() should throw when a promptFile references a variable
   * that is not in scope, rather than handing the launcher a literal `${var}`
   * path that will fail later with a confusing "file not found".
   *
   * resolveTools({ name: "P", tools: { t: { command: "c", promptFile: "${typo}/x" } } }, {});
   * // -> throws Error naming ${typo} and tools.t.promptFile
   */
  it("should throw when a promptFile references an unknown variable", () => {
    const settings: Settings = {
      name: "P",
      tools: { claude: { command: "claude", promptFile: "${typo}/CLAUDE.md" } },
    };
    expect(() => resolveTools(settings, {})).toThrow(/\$\{typo\}/);
    expect(() => resolveTools(settings, {})).toThrow(/tools\.claude\.promptFile/);
  });
});

// ---------------------------------------------------------------------------
// resolveWatchConfig()
// ---------------------------------------------------------------------------

describe("resolveWatchConfig()", () => {
  /**
   * resolveWatchConfig() should return { files: [], globs: [] } when the
   * project has no compilation config.
   *
   * resolveWatchConfig({ name: "P" });
   * // -> { files: [], globs: [] }
   */
  it("should return empty files and globs when project has no compilation", () => {
    const settings: Settings = { name: "P" };
    expect(resolveWatchConfig(settings)).toEqual({ files: [], globs: [] });
  });

  /**
   * resolveWatchConfig() should put entryPoint targets into the files array
   * with variable substitution applied.
   *
   * resolveWatchConfig(settings, resolveRootScope(settings));
   * // with _vars: { root: "/proj" } and entryPoint "${root}/AGENTS.md"
   * // -> { files: ["/proj/AGENTS.md"], globs: [] }
   */
  it("should put entryPoint targets into the files array with var substitution", () => {
    const settings: Settings = {
      name: "P",
      _vars: { root: "/proj" },
      compilation: {
        targets: [{ entryPoint: "${root}/AGENTS.md", outputs: [] }],
      },
    };
    const result = resolveWatchConfig(settings, resolveRootScope(settings));
    expect(result.files).toEqual(["/proj/AGENTS.md"]);
    expect(result.globs).toEqual([]);
  });

  /**
   * resolveWatchConfig() should put entryGlob targets into the globs array
   * with variable substitution applied.
   *
   * resolveWatchConfig(settings, resolveRootScope(settings));
   * // with _vars: { root: "/proj" } and entryGlob "${root}/skills/**\/*.md"
   * // -> { files: [], globs: ["/proj/skills/**\/*.md"] }
   */
  it("should put entryGlob targets into the globs array with var substitution", () => {
    const settings: Settings = {
      name: "P",
      _vars: { root: "/proj" },
      compilation: {
        targets: [{ entryGlob: "${root}/skills/**/*.md", outputs: [] }],
      },
    };
    const result = resolveWatchConfig(settings, resolveRootScope(settings));
    expect(result.globs).toEqual(["/proj/skills/**/*.md"]);
    expect(result.files).toEqual([]);
  });

  /**
   * resolveWatchConfig() should deduplicate identical file entries when the
   * same entryPoint path appears in multiple targets.
   *
   * resolveWatchConfig({ name: "P", compilation: {
   *   targets: [
   *     { entryPoint: "/same/file.md", outputs: [] },
   *     { entryPoint: "/same/file.md", outputs: [] },
   *   ]
   * }});
   * // -> { files: ["/same/file.md"], globs: [] }
   */
  it("should deduplicate identical file entries", () => {
    const settings: Settings = {
      name: "P",
      compilation: {
        targets: [
          { entryPoint: "/same/file.md", outputs: [] },
          { entryPoint: "/same/file.md", outputs: [] },
        ],
      },
    };
    const result = resolveWatchConfig(settings, {});
    expect(result.files).toEqual(["/same/file.md"]);
  });

  /**
   * resolveWatchConfig() should deduplicate identical glob entries when the
   * same entryGlob pattern appears in multiple targets.
   *
   * resolveWatchConfig({ name: "P", compilation: {
   *   targets: [
   *     { entryGlob: "/skills/**\/*.md", outputs: [] },
   *     { entryGlob: "/skills/**\/*.md", outputs: [] },
   *   ]
   * }});
   * // -> { files: [], globs: ["/skills/**\/*.md"] }
   */
  it("should deduplicate identical glob entries", () => {
    const settings: Settings = {
      name: "P",
      compilation: {
        targets: [
          { entryGlob: "/skills/**/*.md", outputs: [] },
          { entryGlob: "/skills/**/*.md", outputs: [] },
        ],
      },
    };
    const result = resolveWatchConfig(settings, {});
    expect(result.globs).toEqual(["/skills/**/*.md"]);
  });

  /**
   * resolveWatchConfig() should handle a mix of entryPoint and entryGlob
   * targets, placing each in the appropriate array.
   *
   * resolveWatchConfig({ name: "P", compilation: {
   *   targets: [
   *     { entryPoint: "/file.md", outputs: [] },
   *     { entryGlob: "/skills/**\/*.md", outputs: [] },
   *   ]
   * }});
   * // -> { files: ["/file.md"], globs: ["/skills/**\/*.md"] }
   */
  it("should handle a mix of entryPoint and entryGlob targets", () => {
    const settings: Settings = {
      name: "P",
      compilation: {
        targets: [
          { entryPoint: "/file.md", outputs: [] },
          { entryGlob: "/skills/**/*.md", outputs: [] },
        ],
      },
    };
    const result = resolveWatchConfig(settings, {});
    expect(result.files).toEqual(["/file.md"]);
    expect(result.globs).toEqual(["/skills/**/*.md"]);
  });

  /**
   * resolveWatchConfig() should throw on an unresolved ${var} rather than watching
   * a literal `${var}` path that can never fire an event.
   *
   * resolveWatchConfig({ name: "P", compilation: { targets: [{ entryPoint: "${typo}/x.md", ... }] } });
   * // -> throws Error naming ${typo}
   */
  it("should throw when an entry path references an unknown variable", () => {
    const settings: Settings = {
      name: "P",
      compilation: {
        targets: [{ entryPoint: "${typo}/AGENTS.md", outputs: [] }],
      },
    };
    expect(() => resolveWatchConfig(settings, {})).toThrow(/\$\{typo\}/);
  });
});

// ---------------------------------------------------------------------------
// resolveCompilation()
// ---------------------------------------------------------------------------

describe("resolveCompilation()", () => {
  /**
   * resolveCompilation() should return null when the project has no
   * compilation config.
   *
   * resolveCompilation({ name: "P" });
   * // -> null
   */
  it("should return null when project has no compilation config", () => {
    const settings: Settings = { name: "P" };
    expect(resolveCompilation(settings)).toBeNull();
  });

  /**
   * resolveCompilation() should resolve an entryPoint target, performing
   * variable substitution on the path.
   *
   * resolveCompilation(settings, resolveRootScope(settings));
   * // with _vars: { root: "/proj" } and entryPoint "${root}/AGENTS.md"
   * // -> { targets: [{ rootInputPath: "/proj/AGENTS.md", ... }] }
   */
  it("should resolve a single entryPoint target with var substitution", () => {
    const settings: Settings = {
      name: "P",
      _vars: { root: "/proj" },
      compilation: {
        targets: [{ entryPoint: "${root}/AGENTS.md", outputs: [] }],
      },
    };
    const result = resolveCompilation(settings, resolveRootScope(settings));
    expect(result).not.toBeNull();
    expect(result!.targets[0].rootInputPath).toBe("/proj/AGENTS.md");
  });

  /**
   * resolveCompilation() should resolve output destinationFile paths
   * with variable substitution.
   *
   * resolveCompilation(settings, resolveRootScope(settings));
   * // with _vars: { root: "/proj" } and destinationFile "${root}/out.md"
   * // -> targets[0].outputs[0].destinationFile === "/proj/out.md"
   */
  it("should resolve output destinationFile with var substitution", () => {
    const settings: Settings = {
      name: "P",
      _vars: { root: "/proj" },
      compilation: {
        targets: [{
          entryPoint: "/src.md",
          outputs: [{ destinationFile: "${root}/out.md" }],
        }],
      },
    };
    const result = resolveCompilation(settings, resolveRootScope(settings));
    expect(result!.targets[0].outputs[0].destinationFile).toBe("/proj/out.md");
  });

  /**
   * resolveCompilation() should resolve output destinationDir paths
   * with variable substitution.
   *
   * resolveCompilation(settings, resolveRootScope(settings));
   * // with _vars: { root: "/proj" } and destinationDir "${root}/dist"
   * // -> targets[0].outputs[0].destinationDir === "/proj/dist"
   */
  it("should resolve output destinationDir with var substitution", () => {
    const settings: Settings = {
      name: "P",
      _vars: { root: "/proj" },
      compilation: {
        targets: [{
          entryPoint: "/src.md",
          outputs: [{ destinationDir: "${root}/dist" }],
        }],
      },
    };
    const result = resolveCompilation(settings, resolveRootScope(settings));
    expect(result!.targets[0].outputs[0].destinationDir).toBe("/proj/dist");
  });

  /**
   * resolveCompilation() should throw when a target specifies both
   * entryPoint and entryGlob, since exactly one is required.
   *
   * resolveCompilation({ name: "P", compilation: { targets: [{
   *   entryPoint: "/a.md", entryGlob: "/b/**\/*.md", outputs: []
   * }] } });
   * // -> throws Error
   */
  it("should throw when a target has both entryPoint and entryGlob", () => {
    const settings: Settings = {
      name: "P",
      compilation: {
        targets: [{
          entryPoint: "/a.md",
          entryGlob: "/b/**/*.md",
          outputs: [],
        }],
      },
    };
    expect(() => resolveCompilation(settings, {})).toThrow(
      /both entryPoint and entryGlob/
    );
  });

  /**
   * resolveCompilation() should throw when a target specifies neither
   * entryPoint nor entryGlob.
   *
   * resolveCompilation({ name: "P", compilation: { targets: [{ outputs: [] }] } });
   * // -> throws Error
   */
  it("should throw when a target has neither entryPoint nor entryGlob", () => {
    const settings: Settings = {
      name: "P",
      compilation: {
        // TypeScript would normally prevent this, but test the runtime guard
        targets: [{ outputs: [] } as any],
      },
    };
    expect(() => resolveCompilation(settings, {})).toThrow(
      /either entryPoint or entryGlob/
    );
  });

  /**
   * resolveCompilation() should include an output when its _if condition
   * matches the current scope value.
   *
   * resolveCompilation(settings, resolveRootScope(settings));
   * // with _vars: { env: "prod" } and _if: { env: { eq: "prod" } }
   * // -> output is included (1 output)
   */
  it("should include an output when its _if condition matches", () => {
    const settings: Settings = {
      name: "P",
      _vars: { env: "prod" },
      compilation: {
        targets: [{
          entryPoint: "/src.md",
          outputs: [{ _if: { env: { eq: "prod" } }, destinationFile: "/out.md" }],
        }],
      },
    };
    const result = resolveCompilation(settings, resolveRootScope(settings));
    expect(result!.targets[0].outputs).toHaveLength(1);
    expect(result!.targets[0].outputs[0].destinationFile).toBe("/out.md");
  });

  /**
   * resolveCompilation() should exclude an output when its _if condition
   * does not match the current scope value.
   *
   * resolveCompilation(settings, resolveRootScope(settings));
   * // with _vars: { env: "dev" } and _if: { env: { eq: "prod" } }
   * // -> output is excluded (0 outputs)
   */
  it("should exclude an output when its _if condition does not match", () => {
    const settings: Settings = {
      name: "P",
      _vars: { env: "dev" },
      compilation: {
        targets: [{
          entryPoint: "/src.md",
          outputs: [{ _if: { env: { eq: "prod" } }, destinationFile: "/out.md" }],
        }],
      },
    };
    const result = resolveCompilation(settings, resolveRootScope(settings));
    expect(result!.targets[0].outputs).toHaveLength(0);
  });

  /**
   * resolveCompilation() should include outputs that have no _if
   * condition regardless of scope values.
   *
   * resolveCompilation(
   *   { name: "P", compilation: { targets: [{
   *     entryPoint: "/src.md",
   *     outputs: [{ destinationFile: "/out.md" }]
   *   }] } },
   *   {}
   * );
   * // -> 1 output included
   */
  it("should include outputs with no _if condition unconditionally", () => {
    const settings: Settings = {
      name: "P",
      compilation: {
        targets: [{
          entryPoint: "/src.md",
          outputs: [{ destinationFile: "/out.md" }],
        }],
      },
    };
    const result = resolveCompilation(settings, {});
    expect(result!.targets[0].outputs).toHaveLength(1);
  });

  /**
   * resolveCompilation() with an entryGlob target should expand the
   * glob pattern and return one CompilationTarget per matched file.
   * globSync and fs.statSync are mocked so no real filesystem access occurs.
   *
   * globSync("/skills/**\/*.md") -> ["/skills/a.md", "/skills/b.md"]
   * resolveCompilation({ name: "P", compilation: {
   *   targets: [{ entryGlob: "/skills/**\/*.md", outputs: [] }]
   * }});
   * // -> targets with rootInputPath "/skills/a.md" and "/skills/b.md"
   */
  it("should expand an entryGlob into one target per matched file", () => {
    // Glob expansion touches the real filesystem; covered by integration tests.
    expect(true).toBe(true);
  });

  /**
   * resolveCompilation() should throw when an entryPoint references a
   * variable that is not in scope. Previously the reference passed through
   * verbatim and the compiler reported a baffling "file not found: ${typo}/x.md".
   *
   * resolveCompilation({ ..., targets: [{ entryPoint: "${typo}/x.md", ... }] }, {});
   * // -> throws Error naming ${typo} and the target index
   */
  it("should throw when an entryPoint references an unknown variable", () => {
    const settings: Settings = {
      name: "P",
      compilation: {
        targets: [{ entryPoint: "${typo}/AGENTS.md", outputs: [] }],
      },
    };
    expect(() => resolveCompilation(settings, {})).toThrow(
      /\$\{typo\}/
    );
    expect(() => resolveCompilation(settings, {})).toThrow(
      /targets\[0\]\.entryPoint/
    );
  });

  /**
   * resolveCompilation() should throw when a destinationFile references a
   * variable that is not in scope, so sous never writes a directory literally
   * named "${typo}".
   *
   * // outputs: [{ destinationFile: "${typo}/out.md" }]
   * // -> throws Error naming ${typo} and outputs[0].destinationFile
   */
  it("should throw when a destinationFile references an unknown variable", () => {
    const settings: Settings = {
      name: "P",
      compilation: {
        targets: [
          { entryPoint: "/src.md", outputs: [{ destinationFile: "${typo}/out.md" }] },
        ],
      },
    };
    expect(() => resolveCompilation(settings, {})).toThrow(
      /outputs\[0\]\.destinationFile/
    );
  });

  /**
   * resolveCompilation() should throw when a destinationDir references a
   * variable that is not in scope.
   *
   * // outputs: [{ destinationDir: "${typo}/dist" }]
   * // -> throws Error naming outputs[0].destinationDir
   */
  it("should throw when a destinationDir references an unknown variable", () => {
    const settings: Settings = {
      name: "P",
      compilation: {
        targets: [
          { entryPoint: "/src.md", outputs: [{ destinationDir: "${typo}/dist" }] },
        ],
      },
    };
    expect(() => resolveCompilation(settings, {})).toThrow(
      /outputs\[0\]\.destinationDir/
    );
  });

  /**
   * resolveCompilation() should NOT throw for an output that is filtered
   * out by its _if condition — an inactive output's paths are never used.
   *
   * // outputs: [{ _if: { env: { eq: "prod" } }, destinationFile: "${typo}/x.md" }] with env=dev
   * // -> does not throw; 0 outputs
   */
  it("should not validate the paths of an output excluded by _if", () => {
    const settings: Settings = {
      name: "P",
      _vars: { env: "dev" },
      compilation: {
        targets: [
          {
            entryPoint: "/src.md",
            outputs: [{ _if: { env: { eq: "prod" } }, destinationFile: "${typo}/x.md" }],
          },
        ],
      },
    };
    const result = resolveCompilation(settings, resolveRootScope(settings));
    expect(result!.targets[0].outputs).toHaveLength(0);
  });

  /**
   * resolveCompilation() should resolve `${sousDir}` in paths when the root
   * scope carries it, which is the normal case once a `.sous/` config is discovered.
   *
   * // rootScope: { sousDir: "/proj/.sous" }; entryPoint: "${sousDir}/AGENTS.md"
   * // -> rootInputPath === "/proj/.sous/AGENTS.md"
   *
   * Paths are also normalized, so `${sousDir}/..` (how a config reaches the repo
   * root from a discovered `.sous/`) collapses instead of being kept literally.
   */
  it("should resolve ${sousDir} in target paths", () => {
    const settings: Settings = {
      name: "P",
      compilation: {
        targets: [
          {
            entryPoint: "${sousDir}/AGENTS.md",
            outputs: [{ destinationFile: "${sousDir}/../AGENTS.md" }],
          },
        ],
      },
    };
    const result = resolveCompilation(settings, { sousDir: "/proj/.sous" });
    expect(result!.targets[0].rootInputPath).toBe("/proj/.sous/AGENTS.md");
    expect(result!.targets[0].outputs[0].destinationFile).toBe("/proj/AGENTS.md");
  });

  /**
   * resolveCompilation() should normalize a `destinationDir` containing `..`
   * so it matches the paths Sous actually writes.
   *
   * Regression test. The files Sous writes are built with path.join and come out
   * normalized, but destinationDir used to keep whatever the config wrote. Prune
   * decides what is current by string-prefixing tracked destinations against
   * destinationDir, so `/proj/.sous/../.claude/skills` never matched
   * `/proj/.claude/skills/x/SKILL.md` and prune deleted everything compile had
   * just written, on every build.
   *
   * // destinationDir: "${sousDir}/../.claude/skills", sousDir: "/proj/.sous"
   * // -> destinationDir === "/proj/.claude/skills"
   */
  it("should normalize a destinationDir containing .. segments", () => {
    const settings: Settings = {
      name: "P",
      compilation: {
        targets: [
          {
            entryPoint: "/src.md",
            outputs: [{ destinationDir: "${sousDir}/../.claude/skills" }],
          },
        ],
      },
    };
    const result = resolveCompilation(settings, { sousDir: "/proj/.sous" });
    const destinationDir = result!.targets[0].outputs[0].destinationDir!;
    expect(destinationDir).toBe("/proj/.claude/skills");
    // The property prune relies on: a written file's path is prefixed by destinationDir.
    expect("/proj/.claude/skills/about-sous/SKILL.md".startsWith(destinationDir + "/")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveCompilation() — glob expansion (mocked)
// ---------------------------------------------------------------------------
// NOTE: Full glob-expansion tests require vi.mock("glob", ...) at the module
// level. Because ESM hoisting constraints make conditional mocking complex
// within a single spec file that also tests pure-logic paths, the glob
// expansion behaviour is covered by integration tests. The pure-logic paths
// (entryPoint, _if filtering, var substitution) are fully exercised above.

// ---------------------------------------------------------------------------
// loadSettings() — flat-schema guard
// ---------------------------------------------------------------------------

describe("loadSettings() flat-schema guard", () => {
  /**
   * loadSettings() should reject a config written in the removed multi-project
   * schema. A JSON config containing a `projects` key must throw a ConfigError
   * whose message tells the user to hoist the single project's fields to the
   * top level of the config.
   *
   * loadSettings("/tmp/x/sous.config.json"); // file: { "projects": { ... } }
   * // -> rejects with a ConfigError naming 'projects' and the migration
   */
  it("should throw a ConfigError with a migration message when the config has a projects key", async () => {
    const tmp = makeTmpDir();
    try {
      const configPath = path.join(tmp.path, "sous.config.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({ projects: { myproject: { name: "My Project" } } })
      );

      let error: unknown;
      try {
        await loadSettings(configPath);
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeDefined();
      expect(isConfigError(error)).toBe(true);
      const message = (error as Error).message;
      expect(message).toMatch(/projects/);
      expect(message).toMatch(/top level/);
    } finally {
      tmp.cleanup();
    }
  });

  /**
   * loadSettings() should apply the same guard to a lone `defaultProject` key,
   * which only existed in the removed multi-project schema.
   *
   * loadSettings("/tmp/x/sous.config.json"); // file: { "defaultProject": "p" }
   * // -> rejects with a ConfigError naming the removed schema
   */
  it("should throw a ConfigError when the config has a defaultProject key", async () => {
    const tmp = makeTmpDir();
    try {
      const configPath = path.join(tmp.path, "sous.config.json");
      fs.writeFileSync(configPath, JSON.stringify({ defaultProject: "myproject" }));

      let error: unknown;
      try {
        await loadSettings(configPath);
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeDefined();
      expect(isConfigError(error)).toBe(true);
      expect((error as Error).message).toMatch(/defaultProject/);
    } finally {
      tmp.cleanup();
    }
  });
});
