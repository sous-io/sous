import { describe, it, expect } from "vitest";
import {
  chooseVersion,
  defaultRange,
  parseRegistryMetadata,
  type ChooseVersionInput,
} from "./versions.js";

/** A published history spanning 0.x, a 1.x line with prereleases, and a 2.0 prerelease. */
const VERSIONS = [
  "0.2.18",
  "0.2.30",
  "0.2.34",
  "0.3.0",
  "0.4.0-beta.1",
  "1.0.0-rc.1",
  "1.0.0",
  "1.2.0",
  "1.3.0-beta.2",
  "2.0.0-alpha.1",
];
const DIST_TAGS = { latest: "1.2.0", next: "2.0.0-alpha.1" };

/** Builds a chooseVersion input over the fixture history. */
function input(overrides: Partial<ChooseVersionInput>): ChooseVersionInput {
  return {
    current: "0.2.30",
    versions: VERSIONS,
    distTags: DIST_TAGS,
    request: { kind: "default" },
    ...overrides,
  };
}

describe("parseRegistryMetadata()", () => {
  /**
   * parseRegistryMetadata should read the version keys (newest first, dropping
   * any that are not valid semver) and the dist-tags (dropping any that point at
   * an invalid version), ignoring every other field.
   *
   * parseRegistryMetadata('{"name":"@sous-io/sous","dist-tags":{"latest":"0.2.30"},
   *   "versions":{"0.2.18":{},"0.2.30":{}}}', url)
   * // -> { name: "@sous-io/sous", versions: ["0.2.30", "0.2.18"], distTags: { latest: "0.2.30" } }
   */
  it("should read versions newest first and keep only valid dist-tags", () => {
    const text = JSON.stringify({
      name: "@sous-io/sous",
      modified: "2026-09-30T00:00:00.000Z",
      "dist-tags": { latest: "0.2.30", broken: "not-a-version" },
      versions: { "0.2.18": {}, "0.2.30": {}, "junk": {}, "0.10.0": {} },
    });
    expect(parseRegistryMetadata(text, "https://r/x")).toEqual({
      name: "@sous-io/sous",
      versions: ["0.10.0", "0.2.30", "0.2.18"],
      distTags: { latest: "0.2.30" },
    });
  });

  /**
   * parseRegistryMetadata should treat missing dist-tags as none.
   *
   * parseRegistryMetadata('{"name":"x","versions":{"1.0.0":{}}}', url).distTags
   * // -> {}
   */
  it("should default missing dist-tags to an empty map", () => {
    const parsed = parseRegistryMetadata(JSON.stringify({ name: "x", versions: { "1.0.0": {} } }), "u");
    expect(parsed.distTags).toEqual({});
  });

  /**
   * parseRegistryMetadata should throw a ConfigError naming the source for a
   * body that is not JSON.
   *
   * parseRegistryMetadata("<html>", "https://r/x") // throws "... from https://r/x is not JSON."
   */
  it("should throw a ConfigError naming the source when the body is not JSON", () => {
    expect(() => parseRegistryMetadata("<html>", "https://r/x")).toThrow(
      /from https:\/\/r\/x is not JSON/
    );
  });

  /**
   * parseRegistryMetadata should throw a ConfigError naming each bad field for
   * JSON that is not a package document.
   *
   * parseRegistryMetadata('{"name":"x"}', url) // throws, naming "versions"
   */
  it("should throw a ConfigError naming the bad field when versions is missing", () => {
    expect(() => parseRegistryMetadata(JSON.stringify({ name: "x" }), "u")).toThrow(
      /not a package document[\s\S]*versions/
    );
  });

  /**
   * parseRegistryMetadata should name the top level when the body is JSON but
   * not an object.
   *
   * parseRegistryMetadata("[]", url) // throws, naming "(top level)"
   */
  it("should name the top level when the body is not an object", () => {
    expect(() => parseRegistryMetadata("[]", "u")).toThrow(/\(top level\)/);
  });
});

describe("defaultRange()", () => {
  /**
   * defaultRange should span from the installed version to below the next
   * major and its prereleases, which for a 0.x version is 1.0.0 (not caret
   * semantics).
   *
   * defaultRange("0.2.30") -> ">=0.2.30 <1.0.0-0"
   * defaultRange("1.2.0")  -> ">=1.2.0 <2.0.0-0"
   */
  it("should stop below the next major, including for 0.x", () => {
    expect(defaultRange("0.2.30")).toBe(">=0.2.30 <1.0.0-0");
    expect(defaultRange("1.2.0")).toBe(">=1.2.0 <2.0.0-0");
  });
});

describe("chooseVersion()", () => {
  describe("default request", () => {
    /**
     * The default request should pick the newest stable version below the next
     * major; for 0.x that crosses minors (0.2.30 -> 0.3.0), unlike a caret range.
     *
     * chooseVersion({ current: "0.2.30", request: { kind: "default" }, ... })
     * // -> { target: "0.3.0", direction: "upgrade", prerelease: false }
     */
    it("should pick the newest stable version in the 0.x major", () => {
      expect(chooseVersion(input({}))).toEqual({
        target: "0.3.0",
        direction: "upgrade",
        prerelease: false,
      });
    });

    /**
     * The default request should include prereleases when asked, picking
     * 0.4.0-beta.1 over 0.3.0 for a 0.2.30 install, but never a prerelease of
     * the next major (1.0.0-rc.1 sorts below 1.0.0).
     *
     * chooseVersion({ current: "0.2.30", prerelease: true, ... }).target
     * // -> "0.4.0-beta.1"
     */
    it("should include prereleases of the same major when the flag is on", () => {
      expect(chooseVersion(input({ prerelease: true })).target).toBe("0.4.0-beta.1");
    });

    /**
     * The default request should turn prereleases on by default when the
     * installed version is itself a prerelease.
     *
     * chooseVersion({ current: "1.0.0-rc.1", ... })
     * // -> { target: "1.3.0-beta.2", prerelease: true, ... }
     */
    it("should default prereleases on when the installed version is a prerelease", () => {
      const choice = chooseVersion(input({ current: "1.0.0-rc.1" }));
      expect(choice.prerelease).toBe(true);
      expect(choice.target).toBe("1.3.0-beta.2");
    });

    /**
     * The default request should honor prereleases switched off explicitly,
     * even for a prerelease install.
     *
     * chooseVersion({ current: "1.0.0-rc.1", prerelease: false, ... }).target
     * // -> "1.2.0"
     */
    it("should keep prereleases off when switched off explicitly", () => {
      const choice = chooseVersion(input({ current: "1.0.0-rc.1", prerelease: false }));
      expect(choice).toEqual({ target: "1.2.0", direction: "upgrade", prerelease: false });
    });

    /**
     * The default request should report "current" when nothing newer exists in
     * the major, even though a newer major is published.
     *
     * chooseVersion({ current: "1.2.0", ... })
     * // -> { target: "1.2.0", direction: "current", ... }
     */
    it("should report current when nothing newer is in the major", () => {
      expect(chooseVersion(input({ current: "1.2.0" }))).toMatchObject({
        target: "1.2.0",
        direction: "current",
      });
    });

    /**
     * The default request should never downgrade: an install newer than
     * anything published stays where it is.
     *
     * chooseVersion({ current: "1.9.0", ... }) -> { target: "1.9.0", direction: "current" }
     */
    it("should never downgrade an install newer than anything published", () => {
      expect(chooseVersion(input({ current: "1.9.0" }))).toMatchObject({
        target: "1.9.0",
        direction: "current",
      });
    });
  });

  describe("major request", () => {
    /**
     * The major request should pick the newest stable version whatever its
     * major.
     *
     * chooseVersion({ current: "0.2.30", request: { kind: "major" } }).target -> "1.2.0"
     */
    it("should pick the newest stable version across majors", () => {
      expect(chooseVersion(input({ request: { kind: "major" } }))).toMatchObject({
        target: "1.2.0",
        direction: "upgrade",
      });
    });

    /**
     * The major request should pick the newest prerelease across majors when
     * prereleases are on.
     *
     * chooseVersion({ request: { kind: "major" }, prerelease: true }).target -> "2.0.0-alpha.1"
     */
    it("should pick a prerelease of a newer major when prereleases are on", () => {
      expect(chooseVersion(input({ request: { kind: "major" }, prerelease: true })).target).toBe(
        "2.0.0-alpha.1"
      );
    });

    /**
     * The major request should never downgrade.
     *
     * chooseVersion({ current: "3.0.0", request: { kind: "major" } })
     * // -> { target: "3.0.0", direction: "current" }
     */
    it("should never downgrade", () => {
      expect(chooseVersion(input({ current: "3.0.0", request: { kind: "major" } }))).toMatchObject({
        target: "3.0.0",
        direction: "current",
      });
    });
  });

  describe("spec request", () => {
    /**
     * An exact published version should be taken as named, and a lower one is
     * a downgrade that says so.
     *
     * chooseVersion({ current: "0.2.30", request: { kind: "spec", spec: "0.2.18" } })
     * // -> { target: "0.2.18", direction: "downgrade", specKind: "version" }
     */
    it("should take an exact version and report a downgrade", () => {
      expect(chooseVersion(input({ request: { kind: "spec", spec: "0.2.18" } }))).toEqual({
        target: "0.2.18",
        direction: "downgrade",
        prerelease: false,
        specKind: "version",
      });
    });

    /**
     * An exact version should accept a leading "v" and be stored canonically;
     * a prerelease named exactly is taken even with prereleases off.
     *
     * chooseVersion({ request: { kind: "spec", spec: "v1.3.0-beta.2" } }).target
     * // -> "1.3.0-beta.2"
     */
    it("should accept a leading v and an exact prerelease with prereleases off", () => {
      const choice = chooseVersion(input({ request: { kind: "spec", spec: " v1.3.0-beta.2 " } }));
      expect(choice).toMatchObject({ target: "1.3.0-beta.2", direction: "upgrade", specKind: "version" });
    });

    /**
     * Naming the installed version exactly should report "current".
     *
     * chooseVersion({ current: "0.2.30", request: { kind: "spec", spec: "0.2.30" } }).direction
     * // -> "current"
     */
    it("should report current when the spec names the installed version", () => {
      expect(chooseVersion(input({ request: { kind: "spec", spec: "0.2.30" } })).direction).toBe(
        "current"
      );
    });

    /**
     * An exact version that is not published should be an error listing the
     * dist-tags and the newest versions.
     *
     * chooseVersion({ request: { kind: "spec", spec: "0.2.99" } })
     * // throws 'The requested version "0.2.99" is not a published version.' ...
     */
    it("should throw for an exact version that is not published", () => {
      expect(() => chooseVersion(input({ request: { kind: "spec", spec: "0.2.99" } }))).toThrow(
        /"0\.2\.99" is not a published version\.[\s\S]*latest: 1\.2\.0[\s\S]*next: 2\.0\.0-alpha\.1[\s\S]*newest published versions are 2\.0\.0-alpha\.1, 1\.3\.0-beta\.2, 1\.2\.0, 1\.0\.0, 1\.0\.0-rc\.1\./
      );
    });

    /**
     * A dist-tag name should resolve to the version it points at, whatever the
     * prerelease setting.
     *
     * chooseVersion({ request: { kind: "spec", spec: "next" } })
     * // -> { target: "2.0.0-alpha.1", specKind: "dist-tag", direction: "upgrade" }
     */
    it("should resolve a dist-tag", () => {
      expect(chooseVersion(input({ request: { kind: "spec", spec: "next" } }))).toMatchObject({
        target: "2.0.0-alpha.1",
        direction: "upgrade",
        specKind: "dist-tag",
      });
    });

    /**
     * A range should resolve to the newest stable version it admits; with
     * prereleases on, the newest version of any kind.
     *
     * chooseVersion({ request: { kind: "spec", spec: "^1.0.0" } }).target -> "1.2.0"
     * chooseVersion({ request: { kind: "spec", spec: "^1.0.0" }, prerelease: true }).target
     * // -> "1.3.0-beta.2"
     */
    it("should resolve a range, with and without prereleases", () => {
      expect(chooseVersion(input({ request: { kind: "spec", spec: "^1.0.0" } }))).toMatchObject({
        target: "1.2.0",
        specKind: "range",
      });
      expect(
        chooseVersion(input({ request: { kind: "spec", spec: "^1.0.0" }, prerelease: true })).target
      ).toBe("1.3.0-beta.2");
    });

    /**
     * A range may downgrade, and the result says so.
     *
     * chooseVersion({ current: "1.2.0", request: { kind: "spec", spec: "0.2.x" } })
     * // -> { target: "0.2.34", direction: "downgrade" }
     */
    it("should allow a range to downgrade", () => {
      expect(
        chooseVersion(input({ current: "1.2.0", request: { kind: "spec", spec: "0.2.x" } }))
      ).toMatchObject({ target: "0.2.34", direction: "downgrade" });
    });

    /**
     * A range that admits only prereleases should fail with prereleases off,
     * saying that stable versions were the ones considered.
     *
     * chooseVersion({ request: { kind: "spec", spec: ">=2.0.0-0" } })
     * // throws '... matches no published version that is not a prerelease.'
     */
    it("should throw for a range that admits only prereleases when they are off", () => {
      expect(() => chooseVersion(input({ request: { kind: "spec", spec: ">=2.0.0-0" } }))).toThrow(
        /matches no published version that is not a prerelease\./
      );
    });

    /**
     * A range that admits nothing at all should fail with prereleases on.
     *
     * chooseVersion({ request: { kind: "spec", spec: ">=9" }, prerelease: true })
     * // throws '... matches no published version.'
     */
    it("should throw for a range that admits nothing", () => {
      expect(() =>
        chooseVersion(input({ request: { kind: "spec", spec: ">=9" }, prerelease: true }))
      ).toThrow(/"\>=9" matches no published version\./);
    });

    /**
     * A spec that is no version, range or dist-tag should fail, and an empty
     * history should say the registry lists nothing.
     *
     * chooseVersion({ versions: [], distTags: {}, request: { kind: "spec", spec: "banana" } })
     * // throws '"banana" is not a version, a range or a dist-tag. ... lists no published versions.'
     */
    it("should throw for a spec that names nothing", () => {
      expect(() =>
        chooseVersion(input({ versions: [], distTags: {}, request: { kind: "spec", spec: "banana" } }))
      ).toThrow(/"banana" is not a version, a range or a dist-tag\.\n  The registry lists no published versions\./);
    });
  });

  /**
   * chooseVersion should throw a ConfigError when the installed version is not
   * a version.
   *
   * chooseVersion({ current: "unknown", ... }) // throws
   */
  it("should throw when the installed version is not a version", () => {
    expect(() => chooseVersion(input({ current: "unknown" }))).toThrow(/"unknown" is not a version/);
  });
});
