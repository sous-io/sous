import { describe, it, expect } from "vitest";
import {
  createEmptyLockfile,
  lockfileSchema,
  parseLockfile,
  stringifyLockfile,
} from "./lockfile.js";
import { isConfigError } from "../../errors.js";

/**
 * Unit tests for the project lockfile (`.sous/sous.lock.json`), the
 * machine-written record that makes a restore deterministic.
 */

const SOURCE = "/project/.sous/sous.lock.json";
const HASH = `sha256-${"b".repeat(64)}`;

/** A valid lockfile, used as the base for rejection cases. */
function validLockfile() {
  return {
    formatVersion: 1,
    repos: {
      "sous-recipes": {
        url: "https://github.com/sous-io/sous-recipes",
        identity: "github.com/sous-io/sous-recipes",
        indexHash: HASH,
      },
    },
    recipes: {
      "workflow/task-files": {
        repo: "sous-recipes",
        version: "1.2.0",
        hash: HASH,
        requestedBy: ["project"],
        kind: "subscribes",
      },
      "core/sous-skills": {
        repo: "sous-recipes",
        version: "0.2.0",
        hash: HASH,
        requestedBy: ["workflow/task-files"],
        kind: "depends",
      },
    },
  };
}

/** Runs parseLockfile and returns the ConfigError message, or fails. */
function expectRejectMessage(value: unknown): string {
  try {
    parseLockfile(value, SOURCE);
  } catch (error) {
    expect(isConfigError(error)).toBe(true);
    return (error as Error).message;
  }
  throw new Error("expected parseLockfile to throw, but it returned");
}

describe("parseLockfile()", () => {
  /**
   * A complete lockfile parses and is returned intact, including a direct
   * subscription and a recipe held only by a dependency.
   */
  it("should accept a lockfile using every field", () => {
    const lock = validLockfile();
    expect(parseLockfile(lock, SOURCE)).toEqual(lock);
  });

  /**
   * An empty lockfile is valid; a project may have subscribed to nothing yet.
   */
  it("should accept an empty lockfile", () => {
    expect(parseLockfile(createEmptyLockfile(), SOURCE)).toEqual({
      formatVersion: 1,
      repos: {},
      recipes: {},
    });
  });

  /**
   * A lockfile written before the store was keyed by identity records only the
   * URL of each repository. It must still load, with the identity worked out
   * from that URL through the provider that handles it; the next write fills the
   * field in for good.
   */
  it("should derive a missing identity from a hosted repository url", () => {
    const lock = validLockfile();
    delete (lock.repos["sous-recipes"] as { identity?: string }).identity;

    const parsed = parseLockfile(lock, SOURCE);

    expect(parsed.repos["sous-recipes"]!.identity).toBe("github.com/sous-io/sous-recipes");
  });

  /**
   * The same migration for a repository read off this machine: the local
   * provider's identity is `localhost` followed by the absolute path, lowercased.
   */
  it("should derive a missing identity from a local path", () => {
    const parsed = parseLockfile(
      {
        formatVersion: 1,
        repos: { local: { url: "/srv/Team/My-Recipes" } },
        recipes: {},
      },
      SOURCE
    );

    expect(parsed.repos["local"]!.identity).toBe("localhost/srv/team/my-recipes");
  });

  /**
   * The lockfile is machine-written, so an unknown key is a bug rather than an
   * extension.
   */
  it("should reject an unknown key", () => {
    const message = expectRejectMessage({ ...validLockfile(), pinned: {} });
    expect(message).toContain(`Invalid lockfile at ${SOURCE}:`);
    expect(message).toContain("unknown key 'pinned'");
  });

  /**
   * A locked recipe naming a repo the lockfile does not describe cannot be
   * restored, so the mismatch is reported rather than deferred to fetch time.
   */
  it("should reject a recipe pointing at an undescribed repo", () => {
    const lock = validLockfile();
    const message = expectRejectMessage({ ...lock, repos: {} });
    expect(message).toContain("recipes.workflow/task-files.repo:");
    expect(message).toContain("which this lockfile does not describe");
  });

  /**
   * A locked version is exact, never a range; the range lives in the
   * subscription, and the lock records what it resolved to.
   */
  it("should reject a locked version that is a range", () => {
    const lock = validLockfile();
    const message = expectRejectMessage({
      ...lock,
      recipes: {
        ...lock.recipes,
        "workflow/task-files": { ...lock.recipes["workflow/task-files"], version: "^1.2.0" },
      },
    });
    expect(message).toContain("must be an exact semantic version");
  });

  /**
   * An entry with no holders would never be garbage collected, so refcounting
   * requires at least one.
   */
  it("should reject an entry with no holders", () => {
    const lock = validLockfile();
    const message = expectRejectMessage({
      ...lock,
      recipes: {
        ...lock.recipes,
        "workflow/task-files": { ...lock.recipes["workflow/task-files"], requestedBy: [] },
      },
    });
    expect(message).toContain("must name at least one holder");
  });

  /**
   * `kind` records whether the holder relationship is a co-subscription or a
   * build dependency; nothing else is allowed.
   */
  it("should reject an unknown kind", () => {
    const lock = validLockfile();
    const message = expectRejectMessage({
      ...lock,
      recipes: {
        ...lock.recipes,
        "workflow/task-files": { ...lock.recipes["workflow/task-files"], kind: "requires" },
      },
    });
    expect(message).toContain("recipes.workflow/task-files.kind:");
  });

  /**
   * A repo URL must be a URL.
   */
  it("should reject a repo entry whose url is not a URL", () => {
    const message = expectRejectMessage({
      ...validLockfile(),
      repos: { "sous-recipes": { url: "sous-io/sous-recipes" } },
    });
    expect(message).toContain("repos.sous-recipes.url:");
  });

  /**
   * Repo keys are the short names used by the `repo:` ref qualifier, so they
   * follow the same kebab-case rule.
   */
  it("should reject a repo key that is not kebab-case", () => {
    const message = expectRejectMessage({
      ...validLockfile(),
      repos: { "Sous Recipes": { url: "https://example.com/x" } },
      recipes: {},
    });
    expect(message).toContain("invalid key; a repo name must be lowercase kebab-case");
  });
});

describe("stringifyLockfile()", () => {
  /**
   * The lockfile is written with every key sorted and a trailing newline, so a
   * regenerated lockfile changes only when its content genuinely does.
   *
   * JSON.parse(stringifyLockfile(lock));  // -> the same lockfile
   */
  it("should write sorted, round-trippable JSON", () => {
    const lock = parseLockfile(validLockfile(), SOURCE);
    const text = stringifyLockfile(lock);
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual(lock);
    expect(text.indexOf('"core/sous-skills"')).toBeLessThan(
      text.indexOf('"workflow/task-files"')
    );
  });

  /**
   * The same lockfile with its keys inserted in a different order serializes
   * identically, which is what keeps the committed diff quiet.
   */
  it("should serialize identically regardless of insertion order", () => {
    const a = parseLockfile(validLockfile(), SOURCE);
    const shuffled = validLockfile();
    const recipes = shuffled.recipes;
    shuffled.recipes = {
      "core/sous-skills": recipes["core/sous-skills"],
      "workflow/task-files": recipes["workflow/task-files"],
    };
    expect(stringifyLockfile(parseLockfile(shuffled, SOURCE))).toBe(stringifyLockfile(a));
  });
});

describe("lockfileSchema", () => {
  /**
   * The schema is exported for callers that want zod's safeParse result.
   */
  it("should be usable directly through safeParse", () => {
    expect(lockfileSchema.safeParse(validLockfile()).success).toBe(true);
    expect(lockfileSchema.safeParse({}).success).toBe(false);
  });
});
