import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTmpDir, type TmpDir } from "../test/utils/tmp.js";
import {
  isVersionRequest,
  printVersionReport,
  readVersionFacts,
  type VersionFacts,
} from "./version-report.js";

const FACTS: VersionFacts = {
  name: "@sous-io/sous",
  version: "1.2.3",
  root: "/opt/sous",
  platform: "linux-x64",
  node: "v22.0.0",
};

/** Strips ANSI color so the lines can be compared as text. */
function plain(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\[[0-9;]*m/g, "");
}

describe("version-report", () => {
  describe("isVersionRequest()", () => {
    /**
     * Only `--version` as the first word is a version request, the way oclif
     * reads it; the same flag later on the line belongs to a command.
     * Example: ["--version", "--verbose"] is one; ["build", "--version"] is not.
     */
    it("should recognize --version only as the first word", () => {
      expect(isVersionRequest(["--version"])).toBe(true);
      expect(isVersionRequest(["--version", "--verbose"])).toBe(true);
      expect(isVersionRequest(["build", "--version"])).toBe(false);
      expect(isVersionRequest([])).toBe(false);
    });
  });

  describe("printVersionReport()", () => {
    /**
     * Plain, the report is the version alone with a leading v and nothing else.
     * Example: version 1.2.3 prints exactly "v1.2.3".
     */
    it("should print the version alone when not verbose", () => {
      const lines: string[] = [];
      printVersionReport(FACTS, false, (line) => lines.push(line));
      expect(lines).toEqual(["v1.2.3"]);
    });

    /**
     * Verbose, the version is followed by the package, install path, platform
     * and Node build as an aligned key and value list.
     * Example: the second line reads "    Package:  @sous-io/sous".
     */
    it("should print the facts under the version when verbose", () => {
      const lines: string[] = [];
      printVersionReport(FACTS, true, (line) => lines.push(line));
      expect(lines.map(plain)).toEqual([
        "v1.2.3",
        "    Package : @sous-io/sous",
        "    Install : /opt/sous",
        "    Platform: linux-x64",
        "    Node    : v22.0.0",
      ]);
    });
  });

  describe("readVersionFacts()", () => {
    let tmp: TmpDir;

    beforeEach(() => {
      tmp = makeTmpDir("sous-version-report-");
    });

    afterEach(() => {
      tmp.cleanup();
    });

    /**
     * The name and version come from the install's package.json; the rest
     * from the running process.
     * Example: a package.json naming 9.9.9 yields version "9.9.9" and the current Node.
     */
    it("should read the name and version from the install's package.json", () => {
      fs.writeFileSync(
        path.join(tmp.path, "package.json"),
        JSON.stringify({ name: "@sous-io/sous", version: "9.9.9" })
      );
      const facts = readVersionFacts(tmp.path);
      expect(facts.name).toBe("@sous-io/sous");
      expect(facts.version).toBe("9.9.9");
      expect(facts.root).toBe(tmp.path);
      expect(facts.node).toBe(process.version);
      expect(facts.platform).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
    });
  });
});
