import path from "node:path";
import fs from "node:fs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { PidService } from "../../lib/pid-service.js";

describe("PidService", () => {
  let tmp: TmpDir;
  let service: PidService;

  beforeEach(() => {
    tmp = makeTmpDir();
    service = new PidService();
  });

  afterEach(() => {
    tmp.cleanup();
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // getFilePath()
  // ---------------------------------------------------------------------------

  describe("getFilePath()", () => {
    /**
     * When projectVars contains a configsRoot, getFilePath() derives the PID
     * file path as: <configsRoot>/projects/<key>/sous.pid
     *
     * Example: getFilePath("myproj", { configsRoot: "/some/path" })
     *   → "/some/path/projects/myproj/sous.pid"
     */
    it("should return the configsRoot-relative path when configsRoot is provided", () => {
      const result = service.getFilePath("myproj", { configsRoot: "/some/path" });
      expect(result).toBe("/some/path/projects/myproj/sous.pid");
    });

    /**
     * When no projectVars (or no configsRoot) is supplied, getFilePath() falls
     * back to a cwd-relative path: <cwd>/<key>.sous.pid
     *
     * Example: getFilePath("myproj") → "/current/working/dir/myproj.sous.pid"
     */
    it("should return the cwd-relative fallback path when configsRoot is absent", () => {
      const result = service.getFilePath("myproj");
      expect(result).toBe(path.join(process.cwd(), "myproj.sous.pid"));
    });
  });

  // ---------------------------------------------------------------------------
  // acquire()
  // ---------------------------------------------------------------------------

  describe("acquire()", () => {
    /**
     * When no PID file exists, acquire() creates one containing the current
     * process's PID as a plain string.
     *
     * Example: acquire("/tmp/sous-test-xxx/sous.pid")
     *   → file exists; content === String(process.pid)
     */
    it("should create a PID file containing the current process PID when none exists", async () => {
      const pidFilePath = path.join(tmp.path, "sous.pid");

      await service.acquire(pidFilePath);

      expect(fs.existsSync(pidFilePath)).toBe(true);
      expect(fs.readFileSync(pidFilePath, "utf8")).toBe(String(process.pid));
    });

    /**
     * acquire() creates any intermediate directories that do not yet exist so
     * callers never need to pre-create the parent directory.
     *
     * Example: pidFilePath = "<tmpdir>/projects/myproj/sous.pid" where
     * "projects/myproj/" does not exist yet — both dirs are created and the
     * file is written successfully.
     */
    it("should create intermediate directories when the parent dir does not exist", async () => {
      const pidFilePath = path.join(tmp.path, "projects", "myproj", "sous.pid");

      await service.acquire(pidFilePath);

      expect(fs.existsSync(path.dirname(pidFilePath))).toBe(true);
      expect(fs.existsSync(pidFilePath)).toBe(true);
    });

    /**
     * When a PID file exists and the recorded process is still alive,
     * acquire() throws an Error whose message contains "already running".
     *
     * Example: spy on _isProcessAlive to return true; call acquire() twice.
     * The second call must throw.
     */
    it("should throw when the existing PID file belongs to a live process", async () => {
      const pidFilePath = path.join(tmp.path, "sous.pid");

      vi.spyOn(service, "_isProcessAlive").mockReturnValue(true);

      // First acquire writes the file
      await service.acquire(pidFilePath);

      // Second acquire should detect the live PID and throw
      await expect(service.acquire(pidFilePath)).rejects.toThrow(/already running/i);
    });

    /**
     * When a PID file exists but the recorded PID is no longer alive (stale),
     * acquire() silently overwrites the file with the current PID rather than
     * throwing.
     *
     * Example: write a PID file with the (non-existent) PID 99999999; spy on
     * _isProcessAlive to return false; call acquire() — file is overwritten
     * with String(process.pid) and no error is thrown.
     */
    it("should overwrite a stale PID file when the recorded process is no longer alive", async () => {
      const pidFilePath = path.join(tmp.path, "sous.pid");
      const fakeStalePid = 99999999;

      fs.writeFileSync(pidFilePath, String(fakeStalePid), "utf8");

      vi.spyOn(service, "_isProcessAlive").mockReturnValue(false);

      await expect(service.acquire(pidFilePath)).resolves.toBeUndefined();

      expect(fs.readFileSync(pidFilePath, "utf8")).toBe(String(process.pid));
    });
  });

  // ---------------------------------------------------------------------------
  // release()
  // ---------------------------------------------------------------------------

  describe("release()", () => {
    /**
     * release() deletes the PID file created by acquire(), leaving no trace on
     * disk.
     *
     * Example: acquire() then release() on the same path → file does not exist.
     */
    it("should delete the PID file after it has been acquired", async () => {
      const pidFilePath = path.join(tmp.path, "sous.pid");

      await service.acquire(pidFilePath);
      expect(fs.existsSync(pidFilePath)).toBe(true);

      await service.release(pidFilePath);
      expect(fs.existsSync(pidFilePath)).toBe(false);
    });

    /**
     * release() is idempotent — calling it on a path that does not exist must
     * not throw, so callers can safely call it during cleanup without guarding.
     *
     * Example: release() on a path that was never acquired → no error thrown.
     */
    it("should not throw when the PID file does not exist", async () => {
      const pidFilePath = path.join(tmp.path, "nonexistent.pid");

      await expect(service.release(pidFilePath)).resolves.toBeUndefined();
    });
  });
});
