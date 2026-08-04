import { describe, it, expect } from "vitest";
import { readConfigFlagFromArgv } from "./base-command.js";

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
});
