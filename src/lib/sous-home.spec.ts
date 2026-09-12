import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GLOBAL_LINKS_FILENAME,
  GLOBAL_REPOS_DIR_NAME,
  STORE_DIR_NAME,
  resolveGlobalLinksPath,
  resolveGlobalReposDir,
  resolveSousHome,
  resolveStoreRoot,
} from "./sous-home.js";

describe("sous-home", () => {
  describe("resolveSousHome()", () => {
    /**
     * resolveSousHome should fall back to `<home>/.sous` when the environment
     * carries no SOUS_HOME.
     *
     * resolveSousHome({});
     * // -> "/home/me/.sous"
     */
    it("should default to .sous under the user's home directory", () => {
      expect(resolveSousHome({})).toBe(path.join(os.homedir(), ".sous"));
    });

    /**
     * resolveSousHome should honour an absolute SOUS_HOME verbatim.
     *
     * resolveSousHome({ SOUS_HOME: "/opt/sous-home" });
     * // -> "/opt/sous-home"
     */
    it("should use an absolute SOUS_HOME as given", () => {
      expect(resolveSousHome({ SOUS_HOME: "/opt/sous-home" })).toBe(
        path.normalize("/opt/sous-home")
      );
    });

    /**
     * resolveSousHome should expand a leading `~`, since SOUS_HOME is commonly
     * written by hand into an env file.
     *
     * resolveSousHome({ SOUS_HOME: "~/sous-home" });
     * // -> "/home/me/sous-home"
     */
    it("should expand a leading tilde", () => {
      expect(resolveSousHome({ SOUS_HOME: "~/sous-home" })).toBe(
        path.join(os.homedir(), "sous-home")
      );
      expect(resolveSousHome({ SOUS_HOME: "~" })).toBe(os.homedir());
    });

    /**
     * resolveSousHome should treat a blank or whitespace-only SOUS_HOME as
     * unset, never as the current directory.
     *
     * resolveSousHome({ SOUS_HOME: "   " });
     * // -> "/home/me/.sous"
     */
    it("should treat a blank SOUS_HOME as unset", () => {
      const expected = path.join(os.homedir(), ".sous");
      expect(resolveSousHome({ SOUS_HOME: "" })).toBe(expected);
      expect(resolveSousHome({ SOUS_HOME: "   " })).toBe(expected);
    });

    /**
     * resolveSousHome should normalize the resolved path, so a value carrying
     * `..` segments collapses before anything joins onto it.
     *
     * resolveSousHome({ SOUS_HOME: "/opt/a/../sous-home" });
     * // -> "/opt/sous-home"
     */
    it("should normalize the resolved path", () => {
      expect(resolveSousHome({ SOUS_HOME: "/opt/a/../sous-home" })).toBe(
        path.normalize("/opt/sous-home")
      );
    });

    /**
     * resolveSousHome should read the live process.env when no environment is
     * passed, because SOUS_HOME is file-settable and is loaded into
     * process.env after this module is imported.
     */
    it("should read process.env at call time by default", () => {
      const previous = process.env.SOUS_HOME;
      try {
        process.env.SOUS_HOME = "/opt/late-binding";
        expect(resolveSousHome()).toBe(path.normalize("/opt/late-binding"));
      } finally {
        if (previous === undefined) delete process.env.SOUS_HOME;
        else process.env.SOUS_HOME = previous;
      }
    });
  });

  describe("resolveStoreRoot()", () => {
    /**
     * resolveStoreRoot should place the recipe store under the user-level
     * directory.
     *
     * resolveStoreRoot({ SOUS_HOME: "/opt/sous-home" });
     * // -> "/opt/sous-home/cache"
     */
    it("should return the cache directory inside the user-level directory", () => {
      expect(resolveStoreRoot({ SOUS_HOME: "/opt/sous-home" })).toBe(
        path.join("/opt/sous-home", STORE_DIR_NAME)
      );
    });
  });

  describe("resolveGlobalReposDir()", () => {
    /**
     * resolveGlobalReposDir should return where `sous repo link --global`
     * clones a working copy.
     *
     * resolveGlobalReposDir({ SOUS_HOME: "/opt/sous-home" });
     * // -> "/opt/sous-home/repos"
     */
    it("should return the repos directory inside the user-level directory", () => {
      expect(resolveGlobalReposDir({ SOUS_HOME: "/opt/sous-home" })).toBe(
        path.join("/opt/sous-home", GLOBAL_REPOS_DIR_NAME)
      );
    });
  });

  describe("resolveGlobalLinksPath()", () => {
    /**
     * resolveGlobalLinksPath should return the machine-wide links map path.
     *
     * resolveGlobalLinksPath({ SOUS_HOME: "/opt/sous-home" });
     * // -> "/opt/sous-home/sous.links.json"
     */
    it("should return the machine-wide links map path", () => {
      expect(resolveGlobalLinksPath({ SOUS_HOME: "/opt/sous-home" })).toBe(
        path.join("/opt/sous-home", GLOBAL_LINKS_FILENAME)
      );
    });
  });
});
