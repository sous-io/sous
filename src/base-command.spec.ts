import { describe, it, expect } from "vitest";
import { readConfigFlagFromArgv, readLongFlagFromArgv } from "./base-command.js";

/**
 * BaseCommand.init() must inject `.sous/.env.local` into process.env BEFORE any
 * variable resolution, which is earlier than oclif's parse() runs. So it reads
 * `--config` straight out of argv. These tests cover that reader.
 */
describe("readConfigFlagFromArgv()", () => {
  /**
   * readConfigFlagFromArgv() should read the value that follows `--config`.
   *
   * readConfigFlagFromArgv(["--config", "/a/b.js"]); // -> "/a/b.js"
   */
  it("should read a space-separated --config value", () => {
    expect(readConfigFlagFromArgv(["--config", "/a/b.js"])).toBe("/a/b.js");
  });

  /**
   * readConfigFlagFromArgv() should support the `--config=VALUE` form.
   *
   * readConfigFlagFromArgv(["--config=/a/b.js"]); // -> "/a/b.js"
   */
  it("should read a --config=VALUE form", () => {
    expect(readConfigFlagFromArgv(["--config=/a/b.js"])).toBe("/a/b.js");
  });

  /**
   * readConfigFlagFromArgv() should support the short `-c VALUE` form.
   *
   * readConfigFlagFromArgv(["-c", "/a/b.js"]); // -> "/a/b.js"
   */
  it("should read a space-separated -c value", () => {
    expect(readConfigFlagFromArgv(["-c", "/a/b.js"])).toBe("/a/b.js");
  });

  /**
   * readConfigFlagFromArgv() should support the attached `-cVALUE` form.
   *
   * readConfigFlagFromArgv(["-c/a/b.js"]); // -> "/a/b.js"
   */
  it("should read an attached -cVALUE form", () => {
    expect(readConfigFlagFromArgv(["-c/a/b.js"])).toBe("/a/b.js");
  });

  /**
   * readConfigFlagFromArgv() should find the flag among other arguments rather
   * than only at the start.
   *
   * readConfigFlagFromArgv(["build", "--watch", "--config", "/x.js"]); // -> "/x.js"
   */
  it("should find the flag among other arguments", () => {
    expect(readConfigFlagFromArgv(["build", "--watch", "--config", "/x.js"])).toBe("/x.js");
  });

  /**
   * readConfigFlagFromArgv() should return undefined when the flag is absent, so
   * discovery takes over.
   *
   * readConfigFlagFromArgv(["build", "--watch"]); // -> undefined
   */
  it("should return undefined when the flag is absent", () => {
    expect(readConfigFlagFromArgv(["build", "--watch"])).toBeUndefined();
  });

  /**
   * readConfigFlagFromArgv() should not mistake an unrelated flag that happens to
   * start with "-c" for the short form... but it also must not mistake
   * `--continuous` for `-c`.
   *
   * readConfigFlagFromArgv(["--continuous"]); // -> undefined
   */
  it("should not treat --continuous as the -c short flag", () => {
    expect(readConfigFlagFromArgv(["--continuous"])).toBeUndefined();
  });

  /**
   * readConfigFlagFromArgv() should return undefined when `--config` is the last
   * argument with no value, letting oclif's own parser report the problem.
   *
   * readConfigFlagFromArgv(["--config"]); // -> undefined
   */
  it("should return undefined when --config has no value", () => {
    expect(readConfigFlagFromArgv(["--config"])).toBeUndefined();
  });

  /**
   * readConfigFlagFromArgv() should stop scanning at a bare `--`: everything
   * after it belongs to the launched tool (launch's pass-through args), so a
   * tool flag like claude's `-c` must not be read as sous's config flag.
   *
   * readConfigFlagFromArgv(["launch", "claude", "--", "-c"]); // -> undefined
   */
  it("should ignore a -c that appears after --", () => {
    expect(readConfigFlagFromArgv(["launch", "claude", "--", "-c"])).toBeUndefined();
    expect(readConfigFlagFromArgv(["launch", "claude", "--", "--config", "/x.js"])).toBeUndefined();
  });

  /**
   * readConfigFlagFromArgv() should still read a config flag that appears
   * before the `--` separator.
   *
   * readConfigFlagFromArgv(["launch", "claude", "-c", "/a.js", "--", "-c"]); // -> "/a.js"
   */
  it("should read a config flag that appears before --", () => {
    expect(readConfigFlagFromArgv(["launch", "claude", "-c", "/a.js", "--", "-c"])).toBe("/a.js");
  });
});

/**
 * The `--sous-config`, `--sous-dir` and `--sous-confd` aliases (Phase 5) are
 * read off raw argv by readLongFlagFromArgv() for the same reason as `--config`:
 * they locate the config (and thus `.env.local`) before oclif's parse() runs.
 * These tests cover that reader for all three long-only flags.
 */
describe("readLongFlagFromArgv()", () => {
  for (const flag of ["sous-config", "sous-dir", "sous-confd"]) {
    /**
     * readLongFlagFromArgv() should read the value that follows `--<flag>`.
     *
     * readLongFlagFromArgv(["--sous-dir", "/a/.sous"], "sous-dir"); // -> "/a/.sous"
     */
    it(`should read a space-separated --${flag} value`, () => {
      expect(readLongFlagFromArgv(["--" + flag, "/a/b"], flag)).toBe("/a/b");
    });

    /**
     * readLongFlagFromArgv() should support the `--<flag>=VALUE` form.
     *
     * readLongFlagFromArgv(["--sous-dir=/a/.sous"], "sous-dir"); // -> "/a/.sous"
     */
    it(`should read a --${flag}=VALUE form`, () => {
      expect(readLongFlagFromArgv(["--" + flag + "=/a/b"], flag)).toBe("/a/b");
    });

    /**
     * readLongFlagFromArgv() should find the flag among other arguments, not just
     * at the start.
     */
    it(`should find --${flag} among other arguments`, () => {
      expect(readLongFlagFromArgv(["build", "--watch", "--" + flag, "/x"], flag)).toBe("/x");
    });

    /**
     * readLongFlagFromArgv() should return undefined when the flag is absent, so
     * env vars / discovery take over.
     */
    it(`should return undefined when --${flag} is absent`, () => {
      expect(readLongFlagFromArgv(["build", "--watch"], flag)).toBeUndefined();
    });

    /**
     * readLongFlagFromArgv() should return undefined when the flag is last with no
     * value, letting oclif's own parser report the problem.
     */
    it(`should return undefined when --${flag} has no value`, () => {
      expect(readLongFlagFromArgv(["--" + flag], flag)).toBeUndefined();
    });

    /**
     * readLongFlagFromArgv() should stop scanning at a bare `--`: everything after
     * it belongs to a launched tool, so `xcv launch claude -- --sous-config x`
     * forwards `--sous-config` to the tool rather than consuming it as sous's.
     */
    it(`should ignore --${flag} that appears after --`, () => {
      expect(
        readLongFlagFromArgv(["launch", "claude", "--", "--" + flag, "x"], flag)
      ).toBeUndefined();
    });

    /**
     * readLongFlagFromArgv() should still read a value that appears BEFORE the
     * bare `--` separator.
     */
    it(`should read --${flag} that appears before --`, () => {
      expect(
        readLongFlagFromArgv(["launch", "claude", "--" + flag, "/a", "--", "x"], flag)
      ).toBe("/a");
    });
  }

  /**
   * readLongFlagFromArgv() only reads its own named flag: `--sous-dir` must not
   * be picked up when asking for `--sous-config`, and vice versa (the three
   * aliases must not bleed into one another).
   */
  it("should not confuse one sous-* flag for another", () => {
    const argv = ["--sous-dir", "/d", "--sous-confd", "/c"];
    expect(readLongFlagFromArgv(argv, "sous-config")).toBeUndefined();
    expect(readLongFlagFromArgv(argv, "sous-dir")).toBe("/d");
    expect(readLongFlagFromArgv(argv, "sous-confd")).toBe("/c");
  });

  /**
   * The `--config`/`-c` reader and the long-alias reader scan argv independently,
   * so `-c` and `--sous-config` can coexist on the same command line: each reader
   * returns its own flag's value.
   */
  it("should coexist with -c: each reader returns its own flag's value", () => {
    const argv = ["build", "-c", "/short.js", "--sous-config", "/long.js"];
    expect(readConfigFlagFromArgv(argv)).toBe("/short.js");
    expect(readLongFlagFromArgv(argv, "sous-config")).toBe("/long.js");
  });
});
