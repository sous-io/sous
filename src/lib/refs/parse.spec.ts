import { describe, expect, it } from "vitest";
import {
  formatRef,
  isBrowsedReading,
  isNamedReading,
  isRepositoryReading,
  looksLikeLocation,
  namespaceOfKey,
  parseRef,
  parseShortRef,
  refKey,
  splitRecipeKey,
  type RefReading,
} from "./parse.js";
import { RefSource } from "./scopes.js";

/** Every place a ref can be written. */
const EVERY_SOURCE = [
  RefSource.CommandLine,
  RefSource.Config,
  RefSource.Manifest,
  RefSource.Lockfile,
] as const;

/** Each reading of a ref, printed in its canonical form. */
function printed(ref: string, from: RefSource = RefSource.CommandLine): string[] {
  return parseRef(ref, from).map((reading) => formatRef(reading));
}

/** The message a ref raises in a place, or undefined when it parses there. */
function refusal(ref: string, from: RefSource): string | undefined {
  try {
    parseRef(ref, from);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

/**
 * Checks one form in every place: parsed to `expected` where it is allowed,
 * and refused with a message containing `instead` where it is not.
 */
function checkEverywhere(
  ref: string,
  expected: string[],
  allowed: RefSource[],
  instead: Partial<Record<RefSource, string>> = {}
): void {
  for (const from of EVERY_SOURCE) {
    if (allowed.includes(from)) {
      expect(printed(ref, from), `${ref} ${from}`).toEqual(expected);
      continue;
    }
    const message = refusal(ref, from);
    expect(message, `${ref} should be refused in ${from}`).toBeDefined();
    expect(message).toContain("Write ");
    if (instead[from] !== undefined) expect(message).toContain(instead[from]);
  }
}

const ALL = [...EVERY_SOURCE];
const LOCATED = [RefSource.CommandLine, RefSource.Manifest];

describe("parseRef()", () => {
  describe("the forms, in every place", () => {
    /**
     * A bare namespace is read in every place.
     *
     * parseRef("workflow", from) // -> [{ namespace: "workflow" }]
     */
    it("should read a bare namespace everywhere", () => {
      checkEverywhere("workflow", ["workflow"], ALL);
      expect(parseRef("workflow")).toEqual([{ namespace: "workflow" }]);
    });

    /**
     * A namespace and a recipe are read in every place.
     *
     * parseRef("workflow/alpha", from) // -> [{ namespace: "workflow", recipe: "alpha" }]
     */
    it("should read a namespace and a recipe everywhere", () => {
      checkEverywhere("workflow/alpha", ["workflow/alpha"], ALL);
    });

    /**
     * `namespace/*` spells a whole namespace out. It is read on the command
     * line and in a manifest; a stored key is the name alone.
     *
     * parseRef("workflow/*") // -> [{ namespace: "workflow" }]
     */
    it("should read the /* spelling of a namespace where it is allowed", () => {
      checkEverywhere("workflow/*", ["workflow"], LOCATED, {
        [RefSource.Config]: "'workflow'",
        [RefSource.Lockfile]: "'workflow'",
      });
    });

    /**
     * A `repo:` qualifier is read on the command line only. A manifest is told
     * to name the repository by location, and a config file to drop it.
     *
     * parseRef("repo:workflow/alpha") // -> [{ repo: "repo", namespace: "workflow", recipe: "alpha" }]
     */
    it("should read a repo qualifier on the command line only", () => {
      checkEverywhere("repo:workflow/alpha", ["repo:workflow/alpha"], [RefSource.CommandLine], {
        [RefSource.Manifest]: "github://owner/repository/workflow/alpha",
        [RefSource.Config]: "sous subscribe repo:workflow/alpha",
        [RefSource.Lockfile]: "'workflow/alpha'",
      });
    });

    /**
     * A version range is read on the command line and in a manifest; a config
     * file keeps it in the entry's own `range` field.
     *
     * parseRef("workflow/alpha@^1.2")[0].range // -> "^1.2"
     */
    it("should read a version range where it is allowed", () => {
      checkEverywhere("workflow/alpha@^1.2", ["workflow/alpha@^1.2"], LOCATED, {
        [RefSource.Config]: "range: '^1.2'",
        [RefSource.Lockfile]: "'workflow/alpha'",
      });
    });

    /**
     * A provider-scheme locator for a namespace names the repository and the
     * namespace in it.
     *
     * parseRef("github://owner/repo/workflow")
     * // -> [{ location: github.com/owner/repo, namespace: "workflow" }]
     */
    it("should read a provider-scheme locator for a namespace", () => {
      checkEverywhere("github://owner/repo/workflow", ["github://owner/repo/workflow"], LOCATED, {
        [RefSource.Config]: "sous subscribe github://owner/repo/workflow",
      });
      const [reading] = parseRef("github://owner/repo/workflow") as [RefReading];
      expect(reading).toEqual({
        location: {
          provider: "github",
          host: "github.com",
          repoPath: "owner/repo",
          identity: "github.com/owner/repo",
          url: "https://github.com/owner/repo",
        },
        namespace: "workflow",
      });
    });

    /**
     * The same with an explicit wildcard.
     *
     * parseRef("github://owner/repo/workflow/*") // -> the namespace "workflow"
     */
    it("should read a locator with an explicit wildcard", () => {
      checkEverywhere("github://owner/repo/workflow/*", ["github://owner/repo/workflow"], LOCATED);
    });

    /**
     * A provider-scheme locator for a recipe, with a range.
     *
     * parseRef("github://owner/repo/workflow/alpha@^1")
     */
    it("should read a provider-scheme locator for a recipe", () => {
      checkEverywhere(
        "github://owner/repo/workflow/alpha@^1",
        ["github://owner/repo/workflow/alpha@^1"],
        LOCATED
      );
    });

    /**
     * An HTTPS URL reads the same as the provider-scheme locator.
     *
     * parseRef("https://github.com/owner/repo/workflow/alpha")
     * // printed -> "github://owner/repo/workflow/alpha"
     */
    it("should read an HTTPS URL", () => {
      checkEverywhere(
        "https://github.com/owner/repo/workflow/alpha",
        ["github://owner/repo/workflow/alpha"],
        LOCATED
      );
      checkEverywhere("http://github.com/owner/repo/workflow", ["github://owner/repo/workflow"], LOCATED);
    });

    /**
     * A host path with no scheme reads the same.
     *
     * parseRef("github.com/owner/repo/workflow/alpha")
     */
    it("should read a scheme-less host path", () => {
      checkEverywhere(
        "github.com/owner/repo/workflow/alpha",
        ["github://owner/repo/workflow/alpha"],
        LOCATED
      );
    });

    /**
     * An SSH remote names a repository. On the command line that is a
     * repository reading; a manifest needs something inside it.
     *
     * parseRef("git@github.com:owner/repo.git") // -> [{ location, repository: true }]
     */
    it("should read an SSH remote", () => {
      checkEverywhere("git@github.com:owner/repo.git", ["github://owner/repo"], [RefSource.CommandLine]);
      expect(refusal("git@github.com:owner/repo.git", RefSource.Manifest)).toContain(
        "nothing inside it"
      );
      expect(isRepositoryReading(parseRef("git@github.com:owner/repo.git")[0]!)).toBe(true);
      checkEverywhere(
        "git@github.com:owner/repo.git/workflow/alpha",
        ["github://owner/repo/workflow/alpha"],
        LOCATED
      );
      checkEverywhere(
        "ssh://git@github.com/owner/repo.git/workflow",
        ["github://owner/repo/workflow"],
        LOCATED
      );
    });

    /**
     * A browser URL from GitHub's file view reads as a browsed path, settled
     * later through the index.
     *
     * parseRef("https://github.com/owner/repo/tree/main/recipes/workflow/alpha")
     * // -> [{ location, browsed: "main/recipes/workflow/alpha" }]
     */
    it("should read a browser URL as a browsed path", () => {
      const url = "https://github.com/owner/repo/tree/main/recipes/workflow/alpha";
      checkEverywhere(url, ["github://owner/repo/tree/main/recipes/workflow/alpha"], LOCATED);
      const [reading] = parseRef(url) as [RefReading];
      expect(isBrowsedReading(reading)).toBe(true);
      expect(reading).toMatchObject({ browsed: "main/recipes/workflow/alpha" });
      expect(
        parseRef("https://github.com/owner/repo/blob/main/recipes/workflow/alpha/SKILL.md")[0]
      ).toMatchObject({ browsed: "main/recipes/workflow/alpha/SKILL.md" });
    });

    /**
     * A `.git` suffix on the repository is dropped, in every URL form.
     *
     * parseRef("https://github.com/owner/repo.git/workflow/alpha")
     * // printed -> "github://owner/repo/workflow/alpha"
     */
    it("should drop a .git suffix on the repository", () => {
      for (const ref of [
        "https://github.com/owner/repo.git/workflow/alpha",
        "github://owner/repo.git/workflow/alpha",
        "github.com/owner/repo.git/workflow/alpha",
      ]) {
        checkEverywhere(ref, ["github://owner/repo/workflow/alpha"], LOCATED);
      }
    });

    /**
     * A GitLab URL with the `/-/` separator names its project exactly, and a
     * browser path after it.
     *
     * parseRef("https://gitlab.com/group/repo/-/tree/main/recipes/workflow/alpha")
     */
    it("should read a GitLab URL with the /-/ separator", () => {
      checkEverywhere(
        "https://gitlab.com/group/sub/repo/-/tree/main/recipes/workflow/alpha",
        ["gitlab://group/sub/repo/-/tree/main/recipes/workflow/alpha"],
        LOCATED
      );
      checkEverywhere(
        "gitlab://group/sub/repo/-/workflow/alpha",
        ["gitlab://group/sub/repo/-/workflow/alpha"],
        LOCATED
      );
    });

    /**
     * The GitLab equivalents of the GitHub forms, nested groups included. A
     * nested group without a separator reads every way it can.
     *
     * parseRef("https://gitlab.com/a/b/c/d")
     * // printed -> ["gitlab://a/b/-/c/d", "gitlab://a/b/c/-/d"]
     */
    it("should read every GitLab form, with every reading of a nested group", () => {
      const both = ["gitlab://a/b/-/c/d", "gitlab://a/b/c/-/d"];
      for (const ref of [
        "https://gitlab.com/a/b/c/d",
        "gitlab://a/b/c/d",
        "gitlab.com/a/b/c/d",
      ]) {
        checkEverywhere(ref, both, LOCATED);
      }
      checkEverywhere("gitlab://a/b/c/d/*", ["gitlab://a/b/c/-/d"], LOCATED);
      checkEverywhere("git@gitlab.com:a/b/c.git/d", ["gitlab://a/b/c/-/d"], LOCATED);
      checkEverywhere("gitlab://a/b.git/c/d", ["gitlab://a/b/-/c/d"], LOCATED);
      checkEverywhere(
        "gitlab://gitlab.example.com/a/b/-/c/d@^2",
        ["gitlab://gitlab.example.com/a/b/-/c/d@^2"],
        LOCATED
      );
      checkEverywhere(
        "https://gitlab.example.com/a/b/-/c/d",
        ["gitlab://gitlab.example.com/a/b/-/c/d"],
        LOCATED
      );
    });

    /**
     * A range after a nested group leaves only the readings that name a recipe.
     *
     * parseRef("gitlab://a/b/c/d@^1") // printed -> ["gitlab://a/b/-/c/d@^1"]
     */
    it("should keep only recipe readings when a range is given", () => {
      expect(printed("gitlab://a/b/c/d@^1")).toEqual(["gitlab://a/b/-/c/d@^1"]);
    });
  });

  describe("names", () => {
    /**
     * The command line keeps names as typed; matching settles the case later.
     *
     * parseRef("Workflow/Alpha") // -> [{ namespace: "Workflow", recipe: "Alpha" }]
     */
    it("should keep names as typed on the command line", () => {
      expect(parseRef("Workflow/Alpha")).toEqual([{ namespace: "Workflow", recipe: "Alpha" }]);
    });

    /**
     * A manifest is published, and published names are lowercase, so its names
     * are stored lowercase.
     *
     * parseRef("Workflow/Alpha", RefSource.Manifest) // -> [{ namespace: "workflow", recipe: "alpha" }]
     */
    it("should lowercase a manifest's names", () => {
      expect(parseRef("Workflow/Alpha", RefSource.Manifest)).toEqual([
        { namespace: "workflow", recipe: "alpha" },
      ]);
      expect(printed("github://Owner/Repo/Workflow/Alpha", RefSource.Manifest)).toEqual([
        "github://Owner/Repo/workflow/alpha",
      ]);
    });

    /**
     * A stored key is lowercase; anything else is refused, naming the key.
     *
     * parseRef("Workflow", RefSource.Lockfile) // throws "Write 'workflow' instead."
     */
    it("should refuse a stored key that is not lowercase", () => {
      expect(refusal("Workflow", RefSource.Lockfile)).toContain("Write 'workflow' instead.");
      expect(refusal("Workflow/Alpha", RefSource.Config)).toContain(
        "Write 'workflow/alpha' instead."
      );
    });

    /**
     * A name that is not kebab-case is not a name anywhere.
     *
     * parseRef("work_flow") // throws
     */
    it("should refuse a name that is not kebab-case", () => {
      for (const from of EVERY_SOURCE) {
        expect(refusal("work_flow", from)).toContain("must be kebab-case");
        expect(refusal("workflow/1alpha", from)).toContain("must be kebab-case");
      }
      expect(refusal("github://owner/repo/work_flow", RefSource.Manifest)).toContain(
        "must be kebab-case"
      );
    });
  });

  describe("refusals and malformed refs", () => {
    /**
     * A local repository is not a published location, so a manifest is told to
     * name the published one; elsewhere, it is added by its path.
     *
     * parseRef("local:///x/workflow/alpha", RefSource.Manifest) // throws
     */
    it("should refuse a local location, saying what to write instead", () => {
      expect(refusal("local:///x/y/workflow/alpha", RefSource.Manifest)).toContain(
        "the recipe's published location"
      );
      expect(refusal("file:///x/y/workflow/alpha", RefSource.CommandLine)).toContain(
        "sous repo add <path>"
      );
    });

    /**
     * A config file and a stored key never name a location; the config refusal
     * names the command that does it properly.
     *
     * parseRef("https://github.com/o/r/w", RefSource.Config)
     * // throws "... run 'sous subscribe https://github.com/o/r/w' ..."
     */
    it("should refuse a location in a config file and in a stored key", () => {
      expect(refusal("https://github.com/o/r/w", RefSource.Config)).toContain(
        "sous subscribe https://github.com/o/r/w"
      );
      expect(refusal("https://github.com/o/r/w", RefSource.Lockfile)).toContain(
        "never names a location"
      );
    });

    /**
     * A scheme that is neither a URL nor a provider is refused, listing the
     * providers.
     *
     * parseRef("bitbucket://o/r/w") // throws "... sous ships these: github, gitlab ..."
     */
    it("should refuse an unknown scheme", () => {
      expect(refusal("bitbucket://o/r/w", RefSource.Manifest)).toContain(
        "sous ships these: github, gitlab"
      );
    });

    /**
     * A host no provider recognizes is refused, naming the provider-scheme
     * spelling a self-hosted instance uses.
     *
     * parseRef("https://git.example.com/o/r/w") // throws "... gitlab://git.example.com/..."
     */
    it("should refuse an unrecognized host", () => {
      expect(refusal("https://git.example.com/o/r/w", RefSource.CommandLine)).toContain(
        "://git.example.com/owner/repository/namespace/recipe"
      );
    });

    /**
     * Too many segments after a repository name a folder, which is written as
     * the browser URL instead.
     *
     * parseRef("github://o/r/a/b/c") // throws
     */
    it("should refuse too many segments after a repository", () => {
      expect(refusal("github://o/r/a/b/c", RefSource.Manifest)).toContain(
        "copied from the browser"
      );
      expect(refusal("a/b/c", RefSource.CommandLine)).toContain("copied from the browser");
    });

    /**
     * A range needs a recipe, and must be a real range.
     *
     * parseRef("workflow@^1") // throws
     */
    it("should refuse a range on a namespace and a range that is not one", () => {
      expect(refusal("workflow@^1", RefSource.CommandLine)).toContain("namespaces are not versioned");
      expect(refusal("github://o/r/workflow@^1", RefSource.Manifest)).toContain(
        "namespaces are not versioned"
      );
      expect(refusal("workflow/alpha@nope", RefSource.Manifest)).toContain("is not a version range");
      expect(refusal("github://o/r/workflow/alpha@nope", RefSource.Manifest)).toContain(
        "is not a version range"
      );
      expect(refusal("workflow/alpha@", RefSource.CommandLine)).toContain("not followed");
      expect(refusal("github://o/r/w/a@", RefSource.CommandLine)).toContain("not followed");
      expect(refusal("a@1@2", RefSource.CommandLine)).toContain("at most one '@'");
    });

    /**
     * Empty refs, sigils and doubled qualifiers are malformed everywhere.
     *
     * parseRef("") // throws
     */
    it("should refuse malformed refs everywhere", () => {
      for (const from of EVERY_SOURCE) {
        expect(refusal("", from)).toContain("must not be empty");
        expect(refusal("@workflow", from)).toContain("no '@' prefix");
        expect(refusal("~workflow", from)).toContain("no '~' prefix");
        expect(refusal("/alpha", from)).toContain("namespace is empty");
        expect(refusal("workflow/", from)).toContain("recipe name after '/' is empty");
      }
      expect(refusal("a:b:c", RefSource.CommandLine)).toContain("at most one 'repo:'");
      expect(refusal(":workflow", RefSource.CommandLine)).toContain("qualifier before ':' is empty");
      expect(refusal("re_po:workflow", RefSource.CommandLine)).toContain("must be kebab-case");
      expect(refusal(42 as unknown as string, RefSource.CommandLine)).toContain("must be a string");
      expect(refusal("https://", RefSource.CommandLine)).toBeDefined();
    });
  });
});

describe("looksLikeLocation()", () => {
  /**
   * A location carries a scheme, an SSH `user@host:` prefix, or a dotted first
   * segment; a short ref carries none of them.
   *
   * looksLikeLocation("github.com/o/r") // -> true
   * looksLikeLocation("repo:workflow/alpha") // -> false
   */
  it("should tell a location from a short ref", () => {
    expect(looksLikeLocation("https://github.com/o/r")).toBe(true);
    expect(looksLikeLocation("git@github.com:o/r")).toBe(true);
    expect(looksLikeLocation("github.com/o/r")).toBe(true);
    expect(looksLikeLocation("repo:workflow/alpha@^1.0")).toBe(false);
    expect(looksLikeLocation("workflow/task-files.taskFileRoot")).toBe(false);
  });
});

describe("parseShortRef()", () => {
  /**
   * parseShortRef returns the one short reading, and refuses a location.
   *
   * parseShortRef("workflow/alpha") // -> { namespace: "workflow", recipe: "alpha" }
   */
  it("should return the short reading and refuse a location", () => {
    expect(parseShortRef("workflow/alpha", RefSource.Config)).toEqual({
      namespace: "workflow",
      recipe: "alpha",
    });
    expect(() => parseShortRef("github://o/r/workflow")).toThrow(/names a location/);
  });
});

describe("splitRecipeKey() and namespaceOfKey()", () => {
  /**
   * A stored key splits into its namespace and name through the one parser.
   *
   * splitRecipeKey("workflow/alpha") // -> { namespace: "workflow", name: "alpha" }
   */
  it("should split a stored key", () => {
    expect(splitRecipeKey("workflow/alpha")).toEqual({ namespace: "workflow", name: "alpha" });
    expect(namespaceOfKey("workflow/alpha")).toBe("workflow");
    expect(namespaceOfKey("workflow")).toBe("workflow");
  });

  /**
   * A namespace alone is not a recipe key.
   *
   * splitRecipeKey("workflow") // throws
   */
  it("should refuse a namespace as a recipe key", () => {
    expect(() => splitRecipeKey("workflow")).toThrow(/names a namespace and a recipe/);
  });
});

describe("formatRef() and refKey()", () => {
  /**
   * The canonical form of a short ref round-trips, and a located one prints as
   * its provider's canonical locator whatever form was typed.
   *
   * formatRef(parseRef("https://github.com/o/r/w/a@^1")[0]) // -> "github://o/r/w/a@^1"
   */
  it("should print the canonical form", () => {
    expect(printed(" repo:workflow/alpha@^1.0 ")).toEqual(["repo:workflow/alpha@^1.0"]);
    expect(printed("https://github.com/o/r/w/a@^1")).toEqual(["github://o/r/w/a@^1"]);
    expect(printed("github://github.com/o/r/w")).toEqual(["github://o/r/w"]);
  });

  /**
   * refKey drops the repository and the range.
   *
   * refKey({ repo: "r", namespace: "w", recipe: "a", range: "^1" }) // -> "w/a"
   */
  it("should key a reading without its repository and range", () => {
    const [reading] = parseRef("repo:workflow/alpha@^1") as [RefReading];
    expect(isNamedReading(reading) && refKey(reading)).toBe("workflow/alpha");
  });
});
