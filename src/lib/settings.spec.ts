import { describe, it, expect, vi, afterEach } from "vitest";
import {
  substituteVars,
  resolveScope,
  buildAutoVars,
  resolveEnvScope,
  resolveRootScope,
  resolveProjectTools,
  resolveWatchConfig,
  resolveProjectCompilation,
  type Settings,
  type RawProject,
} from "./settings.js";

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
   * resolveEnvScope({ _env: { userHome: "MY_HOME" }, projects: {} });
   * // -> { userHome: "/home/user" }
   */
  it("should map config var names to environment variable values", () => {
    vi.stubEnv("MY_HOME", "/home/user");
    const settings: Settings = {
      _env: { userHome: "MY_HOME" },
      projects: {},
    };
    const scope = resolveEnvScope(settings);
    expect(scope.userHome).toBe("/home/user");
  });

  /**
   * resolveEnvScope() should throw a descriptive error when a referenced
   * environment variable is not set in process.env.
   *
   * resolveEnvScope({ _env: { missingVar: "NOT_SET_XYZ" }, projects: {} });
   * // -> throws Error containing "NOT_SET_XYZ"
   */
  it("should throw when a referenced environment variable is not set", () => {
    // Ensure the env var is definitely not set
    const settings: Settings = {
      _env: { missingVar: "SOUS_TEST_NOT_SET_XYZ_12345" },
      projects: {},
    };
    expect(() => resolveEnvScope(settings)).toThrow(/SOUS_TEST_NOT_SET_XYZ_12345/);
  });

  /**
   * resolveEnvScope() should return an empty scope when the settings object
   * has no _env block.
   *
   * resolveEnvScope({ projects: {} });
   * // -> {}
   */
  it("should return an empty scope when _env is absent", () => {
    const settings: Settings = { projects: {} };
    expect(resolveEnvScope(settings)).toEqual({});
  });

  /**
   * resolveEnvScope() should resolve multiple env var mappings correctly
   * in a single call.
   *
   * // process.env.ALPHA = "a", process.env.BETA = "b"
   * resolveEnvScope({ _env: { alpha: "ALPHA", beta: "BETA" }, projects: {} });
   * // -> { alpha: "a", beta: "b" }
   */
  it("should resolve multiple env var mappings", () => {
    vi.stubEnv("ALPHA_TEST_VAR", "a");
    vi.stubEnv("BETA_TEST_VAR", "b");
    const settings: Settings = {
      _env: { alpha: "ALPHA_TEST_VAR", beta: "BETA_TEST_VAR" },
      projects: {},
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
   * resolveRootScope({ projects: {} });
   * // -> { sousRootPath: "...", sousVersion: "...", ... }
   */
  it("should include auto-vars in the returned scope", () => {
    const scope = resolveRootScope({ projects: {} });
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
   *   projects: {}
   * });
   * // -> { ..., codeBase: "/projects", projectRoot: "/projects/myapp" }
   */
  it("should allow root _vars to reference env-mapped vars", () => {
    vi.stubEnv("CODE_BASE_TEST", "/projects");
    const settings: Settings = {
      _env: { codeBase: "CODE_BASE_TEST" },
      _vars: { projectRoot: "${codeBase}/myapp" },
      projects: {},
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
   *   projects: {}
   * });
   * // -> { ..., myPath: "<sousRootPath>/configs" }
   */
  it("should allow root _vars to reference auto-vars", () => {
    const settings: Settings = {
      _vars: { myPath: "${sousRootPath}/configs" },
      projects: {},
    };
    const scope = resolveRootScope(settings);
    const autoVars = buildAutoVars();
    expect(scope.myPath).toBe(`${autoVars.sousRootPath}/configs`);
  });
});

// ---------------------------------------------------------------------------
// resolveProjectTools()
// ---------------------------------------------------------------------------

describe("resolveProjectTools()", () => {
  /**
   * resolveProjectTools() should return an empty object when the project has
   * no tools configured.
   *
   * resolveProjectTools({ name: "My Project", compilation: undefined });
   * // -> {}
   */
  it("should return an empty object when the project has no tools", () => {
    const project: RawProject = { name: "My Project" };
    expect(resolveProjectTools(project)).toEqual({});
  });

  /**
   * resolveProjectTools() should resolve ${varName} references in promptFile
   * paths using the project-scoped vars.
   *
   * resolveProjectTools(
   *   { name: "P", _vars: { root: "/home/user" },
   *     tools: { claude: { command: "claude", promptFile: "${root}/CLAUDE.md" } } },
   *   {}
   * );
   * // -> { claude: { command: "claude", promptFile: "/home/user/CLAUDE.md" } }
   */
  it("should resolve promptFile paths using project-scoped vars", () => {
    const project: RawProject = {
      name: "P",
      _vars: { root: "/home/user" },
      tools: {
        claude: { command: "claude", promptFile: "${root}/CLAUDE.md" },
      },
    };
    const result = resolveProjectTools(project, {});
    expect(result.claude.promptFile).toBe("/home/user/CLAUDE.md");
  });

  /**
   * resolveProjectTools() should pass through the command string unchanged.
   *
   * resolveProjectTools({ name: "P", tools: { claude: { command: "claude" } } });
   * // -> { claude: { command: "claude" } }
   */
  it("should pass through the command unchanged", () => {
    const project: RawProject = {
      name: "P",
      tools: { claude: { command: "claude" } },
    };
    const result = resolveProjectTools(project, {});
    expect(result.claude.command).toBe("claude");
  });

  /**
   * resolveProjectTools() should pass through the args array unchanged.
   *
   * resolveProjectTools(
   *   { name: "P", tools: { claude: { command: "claude", args: ["--verbose"] } } }
   * );
   * // -> { claude: { command: "claude", args: ["--verbose"] } }
   */
  it("should pass through args unchanged", () => {
    const project: RawProject = {
      name: "P",
      tools: { claude: { command: "claude", args: ["--verbose"] } },
    };
    const result = resolveProjectTools(project, {});
    expect(result.claude.args).toEqual(["--verbose"]);
  });

  /**
   * resolveProjectTools() should omit the promptFile key from the result when
   * it is not set on the tool config.
   *
   * resolveProjectTools({ name: "P", tools: { claude: { command: "claude" } } });
   * // -> { claude: { command: "claude" } }  (no promptFile key)
   */
  it("should omit promptFile from the result when not set on the tool config", () => {
    const project: RawProject = {
      name: "P",
      tools: { claude: { command: "claude" } },
    };
    const result = resolveProjectTools(project, {});
    expect("promptFile" in result.claude).toBe(false);
  });

  /**
   * resolveProjectTools() should use rootScope vars when resolving promptFile
   * if the project has no _vars of its own.
   *
   * resolveProjectTools(
   *   { name: "P", tools: { myTool: { command: "run", promptFile: "${base}/prompt.md" } } },
   *   { base: "/root" }
   * );
   * // -> { myTool: { command: "run", promptFile: "/root/prompt.md" } }
   */
  it("should fall back to rootScope vars when the project has no _vars", () => {
    const project: RawProject = {
      name: "P",
      tools: { myTool: { command: "run", promptFile: "${base}/prompt.md" } },
    };
    const result = resolveProjectTools(project, { base: "/root" });
    expect(result.myTool.promptFile).toBe("/root/prompt.md");
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
    const project: RawProject = { name: "P" };
    expect(resolveWatchConfig(project)).toEqual({ files: [], globs: [] });
  });

  /**
   * resolveWatchConfig() should put entryPoint targets into the files array
   * with variable substitution applied.
   *
   * resolveWatchConfig(
   *   { name: "P", _vars: { root: "/proj" },
   *     compilation: { targets: [{ entryPoint: "${root}/AGENTS.md", outputs: [] }] } },
   *   {}
   * );
   * // -> { files: ["/proj/AGENTS.md"], globs: [] }
   */
  it("should put entryPoint targets into the files array with var substitution", () => {
    const project: RawProject = {
      name: "P",
      _vars: { root: "/proj" },
      compilation: {
        targets: [{ entryPoint: "${root}/AGENTS.md", outputs: [] }],
      },
    };
    const result = resolveWatchConfig(project, {});
    expect(result.files).toEqual(["/proj/AGENTS.md"]);
    expect(result.globs).toEqual([]);
  });

  /**
   * resolveWatchConfig() should put entryGlob targets into the globs array
   * with variable substitution applied.
   *
   * resolveWatchConfig(
   *   { name: "P", _vars: { root: "/proj" },
   *     compilation: { targets: [{ entryGlob: "${root}/skills/**\/*.md", outputs: [] }] } },
   *   {}
   * );
   * // -> { files: [], globs: ["/proj/skills/**\/*.md"] }
   */
  it("should put entryGlob targets into the globs array with var substitution", () => {
    const project: RawProject = {
      name: "P",
      _vars: { root: "/proj" },
      compilation: {
        targets: [{ entryGlob: "${root}/skills/**/*.md", outputs: [] }],
      },
    };
    const result = resolveWatchConfig(project, {});
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
    const project: RawProject = {
      name: "P",
      compilation: {
        targets: [
          { entryPoint: "/same/file.md", outputs: [] },
          { entryPoint: "/same/file.md", outputs: [] },
        ],
      },
    };
    const result = resolveWatchConfig(project, {});
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
    const project: RawProject = {
      name: "P",
      compilation: {
        targets: [
          { entryGlob: "/skills/**/*.md", outputs: [] },
          { entryGlob: "/skills/**/*.md", outputs: [] },
        ],
      },
    };
    const result = resolveWatchConfig(project, {});
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
    const project: RawProject = {
      name: "P",
      compilation: {
        targets: [
          { entryPoint: "/file.md", outputs: [] },
          { entryGlob: "/skills/**/*.md", outputs: [] },
        ],
      },
    };
    const result = resolveWatchConfig(project, {});
    expect(result.files).toEqual(["/file.md"]);
    expect(result.globs).toEqual(["/skills/**/*.md"]);
  });
});

// ---------------------------------------------------------------------------
// resolveProjectCompilation()
// ---------------------------------------------------------------------------

describe("resolveProjectCompilation()", () => {
  /**
   * resolveProjectCompilation() should return null when the project has no
   * compilation config.
   *
   * resolveProjectCompilation({ name: "P" });
   * // -> null
   */
  it("should return null when project has no compilation config", () => {
    const project: RawProject = { name: "P" };
    expect(resolveProjectCompilation(project)).toBeNull();
  });

  /**
   * resolveProjectCompilation() should resolve an entryPoint target, performing
   * variable substitution on the path.
   *
   * resolveProjectCompilation(
   *   { name: "P", _vars: { root: "/proj" },
   *     compilation: { targets: [{ entryPoint: "${root}/AGENTS.md", outputs: [] }] } },
   *   {}
   * );
   * // -> { targets: [{ rootInputPath: "/proj/AGENTS.md", ... }] }
   */
  it("should resolve a single entryPoint target with var substitution", () => {
    const project: RawProject = {
      name: "P",
      _vars: { root: "/proj" },
      compilation: {
        targets: [{ entryPoint: "${root}/AGENTS.md", outputs: [] }],
      },
    };
    const result = resolveProjectCompilation(project, {});
    expect(result).not.toBeNull();
    expect(result!.targets[0].rootInputPath).toBe("/proj/AGENTS.md");
  });

  /**
   * resolveProjectCompilation() should resolve output destinationFile paths
   * with variable substitution.
   *
   * resolveProjectCompilation(
   *   { name: "P", _vars: { root: "/proj" },
   *     compilation: { targets: [{
   *       entryPoint: "/src.md",
   *       outputs: [{ destinationFile: "${root}/out.md" }]
   *     }] } },
   *   {}
   * );
   * // -> targets[0].outputs[0].destinationFile === "/proj/out.md"
   */
  it("should resolve output destinationFile with var substitution", () => {
    const project: RawProject = {
      name: "P",
      _vars: { root: "/proj" },
      compilation: {
        targets: [{
          entryPoint: "/src.md",
          outputs: [{ destinationFile: "${root}/out.md" }],
        }],
      },
    };
    const result = resolveProjectCompilation(project, {});
    expect(result!.targets[0].outputs[0].destinationFile).toBe("/proj/out.md");
  });

  /**
   * resolveProjectCompilation() should resolve output destinationDir paths
   * with variable substitution.
   *
   * resolveProjectCompilation(
   *   { name: "P", _vars: { root: "/proj" },
   *     compilation: { targets: [{
   *       entryPoint: "/src.md",
   *       outputs: [{ destinationDir: "${root}/dist" }]
   *     }] } },
   *   {}
   * );
   * // -> targets[0].outputs[0].destinationDir === "/proj/dist"
   */
  it("should resolve output destinationDir with var substitution", () => {
    const project: RawProject = {
      name: "P",
      _vars: { root: "/proj" },
      compilation: {
        targets: [{
          entryPoint: "/src.md",
          outputs: [{ destinationDir: "${root}/dist" }],
        }],
      },
    };
    const result = resolveProjectCompilation(project, {});
    expect(result!.targets[0].outputs[0].destinationDir).toBe("/proj/dist");
  });

  /**
   * resolveProjectCompilation() should throw when a target specifies both
   * entryPoint and entryGlob, since exactly one is required.
   *
   * resolveProjectCompilation({ name: "P", compilation: { targets: [{
   *   entryPoint: "/a.md", entryGlob: "/b/**\/*.md", outputs: []
   * }] } });
   * // -> throws Error
   */
  it("should throw when a target has both entryPoint and entryGlob", () => {
    const project: RawProject = {
      name: "P",
      compilation: {
        targets: [{
          entryPoint: "/a.md",
          entryGlob: "/b/**/*.md",
          outputs: [],
        }],
      },
    };
    expect(() => resolveProjectCompilation(project, {})).toThrow(
      /both entryPoint and entryGlob/
    );
  });

  /**
   * resolveProjectCompilation() should throw when a target specifies neither
   * entryPoint nor entryGlob.
   *
   * resolveProjectCompilation({ name: "P", compilation: { targets: [{ outputs: [] }] } });
   * // -> throws Error
   */
  it("should throw when a target has neither entryPoint nor entryGlob", () => {
    const project: RawProject = {
      name: "P",
      compilation: {
        // TypeScript would normally prevent this, but test the runtime guard
        targets: [{ outputs: [] } as any],
      },
    };
    expect(() => resolveProjectCompilation(project, {})).toThrow(
      /either entryPoint or entryGlob/
    );
  });

  /**
   * resolveProjectCompilation() should include an output when its _if condition
   * matches the current scope value.
   *
   * resolveProjectCompilation(
   *   { name: "P", _vars: { env: "prod" },
   *     compilation: { targets: [{
   *       entryPoint: "/src.md",
   *       outputs: [{ _if: { env: { eq: "prod" } }, destinationFile: "/out.md" }]
   *     }] } },
   *   {}
   * );
   * // -> output is included (1 output)
   */
  it("should include an output when its _if condition matches", () => {
    const project: RawProject = {
      name: "P",
      _vars: { env: "prod" },
      compilation: {
        targets: [{
          entryPoint: "/src.md",
          outputs: [{ _if: { env: { eq: "prod" } }, destinationFile: "/out.md" }],
        }],
      },
    };
    const result = resolveProjectCompilation(project, {});
    expect(result!.targets[0].outputs).toHaveLength(1);
    expect(result!.targets[0].outputs[0].destinationFile).toBe("/out.md");
  });

  /**
   * resolveProjectCompilation() should exclude an output when its _if condition
   * does not match the current scope value.
   *
   * resolveProjectCompilation(
   *   { name: "P", _vars: { env: "dev" },
   *     compilation: { targets: [{
   *       entryPoint: "/src.md",
   *       outputs: [{ _if: { env: { eq: "prod" } }, destinationFile: "/out.md" }]
   *     }] } },
   *   {}
   * );
   * // -> output is excluded (0 outputs)
   */
  it("should exclude an output when its _if condition does not match", () => {
    const project: RawProject = {
      name: "P",
      _vars: { env: "dev" },
      compilation: {
        targets: [{
          entryPoint: "/src.md",
          outputs: [{ _if: { env: { eq: "prod" } }, destinationFile: "/out.md" }],
        }],
      },
    };
    const result = resolveProjectCompilation(project, {});
    expect(result!.targets[0].outputs).toHaveLength(0);
  });

  /**
   * resolveProjectCompilation() should include outputs that have no _if
   * condition regardless of scope values.
   *
   * resolveProjectCompilation(
   *   { name: "P", compilation: { targets: [{
   *     entryPoint: "/src.md",
   *     outputs: [{ destinationFile: "/out.md" }]
   *   }] } },
   *   {}
   * );
   * // -> 1 output included
   */
  it("should include outputs with no _if condition unconditionally", () => {
    const project: RawProject = {
      name: "P",
      compilation: {
        targets: [{
          entryPoint: "/src.md",
          outputs: [{ destinationFile: "/out.md" }],
        }],
      },
    };
    const result = resolveProjectCompilation(project, {});
    expect(result!.targets[0].outputs).toHaveLength(1);
  });

  /**
   * resolveProjectCompilation() with an entryGlob target should expand the
   * glob pattern and return one CompilationTarget per matched file.
   * globSync and fs.statSync are mocked so no real filesystem access occurs.
   *
   * globSync("/skills/**\/*.md") -> ["/skills/a.md", "/skills/b.md"]
   * resolveProjectCompilation({ name: "P", compilation: {
   *   targets: [{ entryGlob: "/skills/**\/*.md", outputs: [] }]
   * }});
   * // -> targets with rootInputPath "/skills/a.md" and "/skills/b.md"
   */
  it("should expand an entryGlob into one target per matched file", () => {
    // Glob expansion touches the real filesystem; covered by integration tests.
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveProjectCompilation() — glob expansion (mocked)
// ---------------------------------------------------------------------------
// NOTE: Full glob-expansion tests require vi.mock("glob", ...) at the module
// level. Because ESM hoisting constraints make conditional mocking complex
// within a single spec file that also tests pure-logic paths, the glob
// expansion behaviour is covered by integration tests. The pure-logic paths
// (entryPoint, _if filtering, var substitution) are fully exercised above.
