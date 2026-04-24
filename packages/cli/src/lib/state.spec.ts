import { describe, it, expect, vi, beforeEach } from "vitest";
import { vol } from "memfs";
import path from "node:path";
import {
  hashContent,
  hashFile,
  recordDirCreation,
  didSousCreateDir,
  StateService,
  type StateFile,
} from "./state.js";

vi.mock("node:fs", async () => {
  const { fs } = await import("memfs");
  return { default: fs, ...fs };
});

beforeEach(() => {
  vol.reset();
});

// Helper: produce a minimal valid StateFile
const emptyState = (): StateFile => ({
  lastBuild: "",
  resolvedVars: {},
  dirs: [],
  files: [],
});

// ---- hashContent ----------------------------------------------------------------------------

describe("hashContent()", () => {
  /**
   * hashContent() should return a hex-encoded SHA-256 digest of the
   * given string. The result should be a 64-character lowercase hex string.
   *
   * hashContent("hello");
   * // -> "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
   */
  it("should return a 64-character hex SHA-256 digest", () => {
    expect(hashContent("hello")).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * hashContent() should return the same hash every time for the same input.
   *
   * hashContent("hello") === hashContent("hello");
   * // -> true
   */
  it("should return a consistent hash for the same input", () => {
    expect(hashContent("hello")).toBe(hashContent("hello"));
  });

  /**
   * hashContent() should return different hashes for different inputs.
   *
   * hashContent("hello") !== hashContent("world");
   * // -> true
   */
  it("should return different hashes for different inputs", () => {
    expect(hashContent("hello")).not.toBe(hashContent("world"));
  });
});

// ---- hashFile -------------------------------------------------------------------------------

describe("hashFile()", () => {
  /**
   * hashFile() should return a SHA-256 hex digest of the file's contents,
   * consistent with hashContent() for the same data.
   *
   * // given a file containing "hello":
   * hashFile("/test/file.md");
   * // -> same result as hashContent("hello")
   */
  it("should return a hash consistent with hashContent() for the same data", async () => {
    vol.fromJSON({ "/test/file.md": "hello" });
    const result = await hashFile("/test/file.md");
    expect(result).toBe(hashContent("hello"));
  });

  /**
   * hashFile() should return different hashes for files with different content.
   *
   * hashFile("/a.md") !== hashFile("/b.md")  // when their contents differ
   */
  it("should return different hashes for files with different content", async () => {
    vol.fromJSON({ "/test/a.md": "content A", "/test/b.md": "content B" });
    const a = await hashFile("/test/a.md");
    const b = await hashFile("/test/b.md");
    expect(a).not.toBe(b);
  });
});

// ---- recordDirCreation ----------------------------------------------------------------------

describe("recordDirCreation()", () => {
  /**
   * recordDirCreation() should append the directory path to state.dirs.
   *
   * recordDirCreation("/some/dir", state);
   * state.dirs; // -> ["/some/dir"]
   */
  it("should add the directory to state.dirs", () => {
    const state = emptyState();
    recordDirCreation("/some/dir", state);
    expect(state.dirs).toContain("/some/dir");
  });

  /**
   * recordDirCreation() should not add a duplicate when the directory
   * is already tracked in state.dirs.
   *
   * recordDirCreation("/some/dir", state);
   * recordDirCreation("/some/dir", state);
   * state.dirs.length; // -> 1
   */
  it("should not add a directory that is already tracked", () => {
    const state = emptyState();
    recordDirCreation("/some/dir", state);
    recordDirCreation("/some/dir", state);
    expect(state.dirs).toHaveLength(1);
  });
});

// ---- didSousCreateDir -----------------------------------------------------------------------

describe("didSousCreateDir()", () => {
  /**
   * didSousCreateDir() should return true when the directory path
   * is present in state.dirs.
   *
   * state.dirs = ["/tracked/dir"];
   * didSousCreateDir("/tracked/dir", state); // -> true
   */
  it("should return true when the directory is tracked in state", () => {
    const state = emptyState();
    state.dirs.push("/tracked/dir");
    expect(didSousCreateDir("/tracked/dir", state)).toBe(true);
  });

  /**
   * didSousCreateDir() should return false when the directory path
   * is not present in state.dirs.
   *
   * didSousCreateDir("/untracked/dir", state); // -> false
   */
  it("should return false when the directory is not tracked in state", () => {
    expect(didSousCreateDir("/untracked/dir", emptyState())).toBe(false);
  });
});

// ---- StateService.getFilePath ---------------------------------------------------------------

describe("StateService.getFilePath()", () => {
  const service = new StateService();

  /**
   * getFilePath() should return the stateFilePath var directly when it
   * is explicitly set in projectVars, bypassing any derivation.
   *
   * getFilePath("myproject", { stateFilePath: "/custom/state.json" });
   * // -> "/custom/state.json"
   */
  it("should return stateFilePath directly when set in vars", () => {
    const result = service.getFilePath("myproject", { stateFilePath: "/custom/state.json" });
    expect(result).toBe("/custom/state.json");
  });

  /**
   * getFilePath() should derive the path from configsRoot when
   * stateFilePath is not set.
   *
   * getFilePath("myproject", { configsRoot: "/configs" });
   * // -> "/configs/projects/myproject/sous.state.json"
   */
  it("should derive the path from configsRoot when stateFilePath is not set", () => {
    const result = service.getFilePath("myproject", { configsRoot: "/configs" });
    expect(result).toBe("/configs/projects/myproject/sous.state.json");
  });

  /**
   * getFilePath() should fall back to a path next to the cwd when
   * no vars are provided.
   *
   * getFilePath("myproject");
   * // -> "<cwd>/myproject.sous.state.json"
   */
  it("should fall back to process.cwd() when no vars are provided", () => {
    const result = service.getFilePath("myproject");
    expect(result).toBe(path.join(process.cwd(), "myproject.sous.state.json"));
  });
});

// ---- StateService.load ----------------------------------------------------------------------

describe("StateService.load()", () => {
  const service = new StateService();

  /**
   * load() should return null when the state file does not exist on disk.
   *
   * load("/nonexistent/state.json"); // -> null
   */
  it("should return null when the file does not exist", async () => {
    const result = await service.load("/nonexistent/state.json");
    expect(result).toBeNull();
  });

  /**
   * load() should parse and return the StateFile when a valid JSON file exists.
   *
   * // given a valid state file at "/state/sous.state.json":
   * load("/state/sous.state.json"); // -> StateFile object
   */
  it("should return the parsed StateFile when the file exists and is valid JSON", async () => {
    const state: StateFile = {
      lastBuild: "2024-01-01T00:00:00.000Z",
      resolvedVars: { foo: "bar" },
      dirs: ["/some/dir"],
      files: [],
    };
    vol.fromJSON({ "/state/sous.state.json": JSON.stringify(state) });
    const result = await service.load("/state/sous.state.json");
    expect(result).toEqual(state);
  });

  /**
   * load() should return null when the file exists but contains invalid JSON,
   * rather than throwing.
   *
   * // given a corrupt state file:
   * load("/state/sous.state.json"); // -> null
   */
  it("should return null when the file contains invalid JSON", async () => {
    vol.fromJSON({ "/state/sous.state.json": "not-valid-json{{{" });
    const result = await service.load("/state/sous.state.json");
    expect(result).toBeNull();
  });
});

// ---- StateService.save ----------------------------------------------------------------------

describe("StateService.save()", () => {
  const service = new StateService();

  /**
   * save() should write the state object to disk as formatted JSON.
   *
   * save("/state/sous.state.json", state);
   * // file at "/state/sous.state.json" contains JSON.stringify(state, null, 2)
   */
  it("should write the state file as formatted JSON", async () => {
    vol.mkdirSync("/state", { recursive: true });
    const state: StateFile = {
      lastBuild: "2024-01-01T00:00:00.000Z",
      resolvedVars: {},
      dirs: [],
      files: [],
    };
    await service.save("/state/sous.state.json", state);
    const written = vol.readFileSync("/state/sous.state.json", "utf8") as string;
    expect(JSON.parse(written)).toEqual(state);
  });

  /**
   * save() should create all necessary parent directories before writing
   * the state file when they do not yet exist.
   *
   * save("/deep/nested/path/sous.state.json", state);
   * // directory "/deep/nested/path" is created
   */
  it("should create parent directories if they do not exist", async () => {
    await service.save("/deep/nested/path/sous.state.json", emptyState());
    expect(vol.existsSync("/deep/nested/path")).toBe(true);
  });
});
