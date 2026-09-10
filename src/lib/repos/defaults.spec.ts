import { describe, expect, it } from "vitest";
import type { Settings } from "../settings.js";
import { OFFICIAL_REPO_NAME, OFFICIAL_REPO_URL } from "./core-recipe.js";
import {
  BUILT_IN_ADDED_BY,
  applyRepoDefaults,
  enabledRepos,
  enabledSubscriptions,
  isBuiltInEntry,
} from "./defaults.js";

describe("applyRepoDefaults()", () => {
  /**
   * A project that says nothing about repositories still gets the official one
   * and the core namespace, marked as sous's own so every listing can say so.
   */
  it("adds the built-in repository and the core subscription", () => {
    const result = applyRepoDefaults({}, "1.2.3");

    expect(result.repos?.[OFFICIAL_REPO_NAME]).toEqual({
      url: OFFICIAL_REPO_URL,
      provider: "github",
      addedBy: BUILT_IN_ADDED_BY,
    });
    expect(result.subscriptions?.core).toEqual({
      range: "1.2.3",
      addedBy: BUILT_IN_ADDED_BY,
    });
  });

  /**
   * The core range is the exact running version, not a caret range: core is
   * published in lockstep with the CLI.
   */
  it("pins core to the exact running version", () => {
    expect(applyRepoDefaults({}, "0.9.0").subscriptions?.core?.range).toBe("0.9.0");
  });

  /**
   * Whatever the config layers wrote wins, field by field: a project repointing
   * the repository changes the URL and nothing else.
   */
  it("lets a project's own fields win over the default's", () => {
    const settings: Settings = {
      repos: { [OFFICIAL_REPO_NAME]: { url: "https://example.test/mirror" } },
      subscriptions: { core: { range: "^0" } },
    };

    const result = applyRepoDefaults(settings, "1.2.3");

    expect(result.repos?.[OFFICIAL_REPO_NAME]?.url).toBe("https://example.test/mirror");
    expect(result.repos?.[OFFICIAL_REPO_NAME]?.provider).toBe("github");
    expect(result.subscriptions?.core?.range).toBe("^0");
  });

  /**
   * The shortest opt-out a project can write has to be a complete entry once the
   * built-in fields are underneath it, or the config would not even validate.
   */
  it("fills in the built-in fields under a bare opt-out", () => {
    const settings: Settings = {
      repos: { [OFFICIAL_REPO_NAME]: { enabled: false } as never },
    };

    const result = applyRepoDefaults(settings, "1.2.3");

    expect(result.repos?.[OFFICIAL_REPO_NAME]).toEqual({
      url: OFFICIAL_REPO_URL,
      provider: "github",
      addedBy: BUILT_IN_ADDED_BY,
      enabled: false,
    });
  });

  /** Everything else a project declared is carried through untouched. */
  it("keeps the project's other repositories and subscriptions", () => {
    const settings: Settings = {
      repos: { theirs: { url: "https://example.test/theirs" } },
      subscriptions: { "workflow/task-files": { range: "^1" } },
    };

    const result = applyRepoDefaults(settings, "1.2.3");

    expect(Object.keys(result.repos ?? {}).sort()).toEqual([OFFICIAL_REPO_NAME, "theirs"]);
    expect(Object.keys(result.subscriptions ?? {}).sort()).toEqual([
      "core",
      "workflow/task-files",
    ]);
  });

  /**
   * Switching the repository off has to switch the core subscription off with
   * it, or the project would be left subscribed to a namespace nothing can
   * resolve.
   */
  it("adds no core subscription when the built-in repository is switched off", () => {
    const settings: Settings = {
      repos: { [OFFICIAL_REPO_NAME]: { url: OFFICIAL_REPO_URL, enabled: false } },
    };

    const result = applyRepoDefaults(settings, "1.2.3");

    expect(result.subscriptions).toBeUndefined();
    expect(result.repos?.[OFFICIAL_REPO_NAME]?.enabled).toBe(false);
  });
});

describe("enabledRepos() and enabledSubscriptions()", () => {
  /** An entry switched off takes part in nothing. */
  it("drop the entries switched off with enabled: false", () => {
    const settings: Settings = {
      repos: {
        kept: { url: "https://example.test/kept" },
        dropped: { url: "https://example.test/dropped", enabled: false },
      },
      subscriptions: {
        core: { enabled: false },
        "workflow/task-files": { range: "^1" },
      },
    };

    expect(Object.keys(enabledRepos(settings))).toEqual(["kept"]);
    expect(Object.keys(enabledSubscriptions(settings))).toEqual(["workflow/task-files"]);
  });

  /** `enabled: true` and an absent field mean the same thing. */
  it("keep an entry that says nothing about being enabled", () => {
    const settings: Settings = {
      repos: { a: { url: "https://example.test/a" }, b: { url: "u", enabled: true } },
    };

    expect(Object.keys(enabledRepos(settings)).sort()).toEqual(["a", "b"]);
  });

  /** A config with neither key produces empty maps rather than undefined. */
  it("handle a config that declares neither", () => {
    expect(enabledRepos({})).toEqual({});
    expect(enabledSubscriptions(undefined)).toEqual({});
  });
});

describe("isBuiltInEntry()", () => {
  it("recognizes an entry sous provided itself", () => {
    expect(isBuiltInEntry({ addedBy: BUILT_IN_ADDED_BY })).toBe(true);
    expect(isBuiltInEntry({ addedBy: "user" })).toBe(false);
    expect(isBuiltInEntry(undefined)).toBe(false);
  });
});
