import { describe, expect, it } from "vitest";
import { indexOf } from "../../test/utils/ref-fixtures.js";
import { sharedRefResolver } from "./container.js";
import { formatRef, refKey } from "./format.js";
import { CachedIndexLookup } from "./lookups/cached-index-lookup.js";
import type { RefLookup } from "./lookups/ref-lookup.js";
import { RefParser } from "./parser/ref-parser.js";
import { RefResolveArguments } from "./ref-resolve-arguments.js";
import { qualificationOf, RefResolverService } from "./ref-resolver-service.js";
import { RefSource } from "./source.js";
import type { SousRef } from "./types.js";

const resolver = sharedRefResolver();

/** Every place a ref was written before the include line existed. */
const EVERY_SOURCE = [
  RefSource.CommandLine,
  RefSource.Config,
  RefSource.Manifest,
  RefSource.Lockfile,
] as const;

const ALL = [...EVERY_SOURCE];
const LOCATED = [RefSource.CommandLine, RefSource.Manifest];

/**
 * The readings a place keeps that name a namespace, a recipe in a namespace
 * or a repository by location, printed canonically: the forms the old parser
 * knew, which is what the ported cases below compare.
 */
function printed(ref: string, from: RefSource = RefSource.CommandLine): string[] {
  return resolver
    .parse(ref, from)
    .refs.filter(
      (entry) =>
        entry.kind === "namespace" ||
        (entry.kind === "recipe" && entry.namespace !== undefined) ||
        (entry.kind === "repo" && entry.location !== undefined)
    )
    .map((entry) => formatRef(entry));
}

/** The message a ref raises in a place, or undefined when it parses there. */
function refusal(ref: string, from: RefSource): string | undefined {
  try {
    resolver.parse(ref, from);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

/**
 * Checks one form in every place: parsed to `expected` where it is allowed,
 * and refused with a message saying what to write instead where it is not.
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

describe("RefResolverService.parse() (the forms, ported from the old parser)", () => {
  /**
   * A bare namespace is read in every place.
   *
   * parse("workflow", from) // -> the namespace workflow
   */
  it("should read a bare namespace everywhere", () => {
    checkEverywhere("workflow", ["workflow"], ALL);
  });

  /**
   * A namespace and a recipe are read in every place.
   *
   * parse("workflow/alpha", from) // -> the recipe workflow/alpha
   */
  it("should read a namespace and a recipe everywhere", () => {
    checkEverywhere("workflow/alpha", ["workflow/alpha"], ALL);
  });

  /**
   * `namespace/*` spells a namespace out: read on the command line and in a
   * manifest, while a stored key is the name alone.
   *
   * parse("workflow/*") // -> the namespace workflow
   */
  it("should read the /* spelling of a namespace where it is allowed", () => {
    checkEverywhere("workflow/*", ["workflow"], LOCATED, {
      [RefSource.Config]: "'workflow'",
      [RefSource.Lockfile]: "'workflow'",
    });
  });

  /**
   * A `repo:` qualifier is read on the command line only.
   *
   * parse("repo:workflow/alpha") // -> repo:workflow/alpha
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
   * parse("workflow/alpha@^1.2")[0].range // -> "^1.2"
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
   * parse("github://owner/repo/workflow") // -> namespace workflow at github.com/owner/repo
   */
  it("should read a provider-scheme locator for a namespace", () => {
    checkEverywhere("github://owner/repo/workflow", ["github://owner/repo/workflow"], LOCATED, {
      [RefSource.Config]: "sous subscribe github://owner/repo/workflow",
    });
    const [ref] = resolver.parse("github://owner/repo/workflow").refs.filter((r) => r.kind === "namespace");
    expect(ref).toEqual({
      kind: "namespace",
      name: "workflow",
      repo: {
        kind: "repo",
        location: {
          provider: "github",
          host: "github.com",
          repoPath: "owner/repo",
          identity: "github.com/owner/repo",
          url: "https://github.com/owner/repo",
        },
      },
    });
  });

  /**
   * The same with an explicit wildcard, and for a recipe with a range.
   *
   * parse("github://owner/repo/workflow/alpha@^1")
   */
  it("should read a locator with a wildcard, and for a recipe", () => {
    checkEverywhere("github://owner/repo/workflow/*", ["github://owner/repo/workflow"], LOCATED);
    checkEverywhere(
      "github://owner/repo/workflow/alpha@^1",
      ["github://owner/repo/workflow/alpha@^1"],
      LOCATED
    );
  });

  /**
   * An HTTPS URL, with or without a scheme, reads like the locator.
   *
   * parse("https://github.com/owner/repo/workflow/alpha")
   */
  it("should read an HTTPS URL and a scheme-less host path", () => {
    checkEverywhere(
      "https://github.com/owner/repo/workflow/alpha",
      ["github://owner/repo/workflow/alpha"],
      LOCATED
    );
    checkEverywhere("http://github.com/owner/repo/workflow", ["github://owner/repo/workflow"], LOCATED);
    checkEverywhere(
      "github.com/owner/repo/workflow/alpha",
      ["github://owner/repo/workflow/alpha"],
      LOCATED
    );
  });

  /**
   * An SSH remote names a repository: a repository reading on the command
   * line, and something a manifest cannot use without a namespace after it.
   *
   * parse("git@github.com:owner/repo.git") // -> a repository
   */
  it("should read an SSH remote", () => {
    checkEverywhere("git@github.com:owner/repo.git", ["github://owner/repo"], [RefSource.CommandLine]);
    expect(refusal("git@github.com:owner/repo.git", RefSource.Manifest)).toContain("nothing inside it");
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
   * A browser URL reads as a browsed repository path, settled later through
   * the index.
   *
   * parse("https://github.com/owner/repo/tree/main/recipes/workflow/alpha")
   */
  it("should read a browser URL as a browsed path", () => {
    const url = "https://github.com/owner/repo/tree/main/recipes/workflow/alpha";
    expect(resolver.parse(url).refs).toContainEqual(
      expect.objectContaining({ kind: "repo", browsed: "main/recipes/workflow/alpha" })
    );
    expect(resolver.parse(url, RefSource.Manifest).refs).toHaveLength(1);
    expect(
      resolver.parse("https://github.com/owner/repo/blob/main/recipes/workflow/alpha/SKILL.md").refs
    ).toContainEqual(
      expect.objectContaining({ kind: "repo", browsed: "main/recipes/workflow/alpha/SKILL.md" })
    );
  });

  /**
   * A `.git` suffix on the repository is dropped, in every URL form.
   *
   * parse("https://github.com/owner/repo.git/workflow/alpha")
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
   * GitLab: the `/-/` separator names the project exactly, and a nested group
   * without one reads every way it can. A range keeps only recipe readings.
   *
   * parse("https://gitlab.com/a/b/c/d") // -> projects a/b and a/b/c
   */
  it("should read every GitLab form, with every reading of a nested group", () => {
    checkEverywhere(
      "https://gitlab.com/group/sub/repo/-/tree/main/recipes/workflow/alpha",
      ["gitlab://group/sub/repo/-/tree/main/recipes/workflow/alpha"],
      LOCATED
    );
    checkEverywhere("gitlab://group/sub/repo/-/workflow/alpha", ["gitlab://group/sub/repo/-/workflow/alpha"], LOCATED);
    const both = ["gitlab://a/b/c/-/d", "gitlab://a/b/-/c/d"];
    for (const ref of ["https://gitlab.com/a/b/c/d", "gitlab://a/b/c/d", "gitlab.com/a/b/c/d"]) {
      expect(printed(ref).sort(), ref).toEqual([...both].sort());
    }
    checkEverywhere("gitlab://a/b/c/d/*", ["gitlab://a/b/c/-/d"], LOCATED);
    checkEverywhere("git@gitlab.com:a/b/c.git/d", ["gitlab://a/b/c/-/d"], LOCATED);
    checkEverywhere("gitlab://a/b.git/c/d", ["gitlab://a/b/-/c/d"], LOCATED);
    checkEverywhere("gitlab://gitlab.example.com/a/b/-/c/d@^2", ["gitlab://gitlab.example.com/a/b/-/c/d@^2"], LOCATED);
    checkEverywhere("https://gitlab.example.com/a/b/-/c/d", ["gitlab://gitlab.example.com/a/b/-/c/d"], LOCATED);
    expect(printed("gitlab://a/b/c/d@^1")).toEqual(["gitlab://a/b/-/c/d@^1"]);
  });

  /**
   * The command line keeps names as typed; a manifest, being published,
   * stores them lowercase; a stored key must already be lowercase.
   *
   * parse("Workflow/Alpha", Manifest) // -> workflow/alpha
   */
  it("should keep, lowercase and refuse the case of names by place", () => {
    expect(printed("Workflow/Alpha")).toEqual(["Workflow/Alpha"]);
    expect(printed("Workflow/Alpha", RefSource.Manifest)).toEqual(["workflow/alpha"]);
    expect(printed("github://Owner/Repo/Workflow/Alpha", RefSource.Manifest)).toEqual([
      "github://Owner/Repo/workflow/alpha",
    ]);
    expect(refusal("Workflow", RefSource.Lockfile)).toContain("Write 'workflow' instead.");
    expect(refusal("Workflow/Alpha", RefSource.Config)).toContain("Write 'workflow/alpha' instead.");
  });

  /**
   * A name that is not kebab-case is not a name anywhere; on the command line
   * it is still an environment variable name.
   *
   * parse("work_flow") // -> an envVar on the command line, refused elsewhere
   */
  it("should refuse a name that is not kebab-case", () => {
    expect(resolver.parse("work_flow").refs.map((ref) => ref.kind)).toEqual(["envVar"]);
    for (const from of [RefSource.Config, RefSource.Manifest, RefSource.Lockfile]) {
      expect(refusal("work_flow", from)).toContain("must be kebab-case");
    }
    for (const from of EVERY_SOURCE) {
      expect(refusal("workflow/1alpha", from)).toContain("must be kebab-case");
    }
    expect(refusal("github://owner/repo/work_flow", RefSource.Manifest)).toContain("must be kebab-case");
  });

  /**
   * A local repository is not a published location: a manifest is told to
   * name the published one, elsewhere it is added by its path.
   *
   * parse("local:///x/workflow/alpha", Manifest) // throws
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
   * A config file and a stored key never name a location.
   *
   * parse("https://github.com/o/r/w", Config) // throws "... run 'sous subscribe ...'"
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
   * An unknown scheme and an unrecognized host are refused, naming what is
   * accepted.
   *
   * parse("bitbucket://o/r/w") // throws "... sous ships these: github, gitlab ..."
   */
  it("should refuse an unknown scheme and an unrecognized host", () => {
    expect(refusal("bitbucket://o/r/w", RefSource.Manifest)).toContain("sous ships these: github, gitlab");
    expect(refusal("https://git.example.com/o/r/w", RefSource.CommandLine)).toContain(
      "://git.example.com/owner/repository/namespace/recipe"
    );
  });

  /**
   * Too many segments name a file inside a recipe, which a short ref cannot
   * be: the writer is told to copy the URL from the browser.
   *
   * parse("a/b/c") // throws, on the command line
   */
  it("should refuse too many segments, pointing at the browser URL", () => {
    expect(refusal("github://o/r/a/b/c", RefSource.Manifest)).toContain("copied from the browser");
    expect(refusal("a/b/c", RefSource.CommandLine)).toContain("copied from the browser");
  });

  /**
   * A range needs a recipe and must be a real range.
   *
   * parse("workflow@^1", Manifest) // throws
   */
  it("should refuse a range on a namespace and a range that is not one", () => {
    expect(refusal("workflow@^1", RefSource.Manifest)).toContain("namespaces are not versioned");
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
   * parse("") // throws
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

  /**
   * The canonical form of a ref round-trips, and refKey drops the range but
   * keeps the repository.
   *
   * formatRef(parse(" repo:workflow/alpha@^1.0 ")) // -> "repo:workflow/alpha@^1.0"
   */
  it("should print the canonical form and key", () => {
    expect(printed(" repo:workflow/alpha@^1.0 ")).toEqual(["repo:workflow/alpha@^1.0"]);
    expect(printed("https://github.com/o/r/w/a@^1")).toEqual(["github://o/r/w/a@^1"]);
    expect(printed("github://github.com/o/r/w")).toEqual(["github://o/r/w"]);
    const [ref] = resolver.parse("repo:workflow/alpha@^1").refs;
    expect(refKey(ref!)).toBe("repo:workflow/alpha");
  });
});

describe("RefResolverService.parse() (the new forms)", () => {
  /**
   * Query values are kept on the ref and printed back.
   *
   * parse("workflow/alpha?x=a%20b").first().vars // -> { x: "a b" }
   */
  it("should keep query values on the ref", () => {
    const ref = resolver.parse("workflow/alpha?x=a%20b").first()!;
    expect(ref.vars).toEqual({ x: "a b" });
    expect(formatRef(ref)).toBe("workflow/alpha?x=a%20b");
  });

  /**
   * A variable is written `namespace/recipe.name`; an environment variable
   * name is held whole.
   *
   * parse("workflow/task-files.apiUrl") // -> a variable
   */
  it("should read a variable and an environment variable name on the command line", () => {
    expect(resolver.parse("workflow/task-files.apiUrl").refs.map((ref) => ref.kind)).toEqual([
      "variable",
    ]);
    expect(resolver.parse("SOUS_VAR_API_URL").refs).toEqual([
      { kind: "envVar", name: "SOUS_VAR_API_URL" },
    ]);
  });

  /**
   * An include line takes a file inside a recipe, glob allowed.
   *
   * parse("workflow/task-files/_partials/*.md", Include) // -> a recipeFile
   */
  it("should read a recipe file in an include line", () => {
    const ref = resolver.parse("workflow/task-files/_partials/*.md", RefSource.Include).first();
    expect(ref).toMatchObject({ kind: "recipeFile", path: "_partials/*.md", glob: true });
  });

  /**
   * Refs come best first: a fully qualified spelling before a bare one, and
   * an environment variable name last.
   *
   * parse("workflow") // -> repo, namespace, recipe, variable, envVar
   */
  it("should list readings by qualification, then kind", () => {
    expect(resolver.parse("workflow").refs.map((ref) => ref.kind)).toEqual([
      "repo",
      "namespace",
      "recipe",
      "variable",
      "envVar",
    ]);
    expect(qualificationOf(resolver.parse("r:w/a").first()!)).toBe(0);
    expect(qualificationOf(resolver.parse("w/a").first()!)).toBe(1);
    expect(qualificationOf(resolver.parse("w").refs[1]!)).toBe(2);
    expect(qualificationOf(resolver.parse("SOUS_VAR_X").first()!)).toBe(3);
  });

  /**
   * Nothing left after pruning is one error listing every reason.
   *
   * parse("workflow/*", Config) // throws, listing why each reading was refused
   */
  it("should list every dropped reason when nothing is left", () => {
    const message = refusal("workflow/*", RefSource.Config)!;
    expect(message).toContain("cannot be written as a subscription key in a config file. Every way it reads is refused");
    expect(message).toContain("Write 'workflow' instead.");
    expect(refusal("workflow", RefSource.Include)).toContain(
      "Write 'namespace/recipe/path/to/file.md' instead."
    );
  });

  /**
   * A service with no pruner for a place says so.
   *
   * new RefResolverService(parser, []).parse("x") // throws
   */
  it("should name a place no pruner speaks for", () => {
    const bare = new RefResolverService(new RefParser([]), []);
    expect(() => bare.parse("workflow")).toThrow(/No pruner is registered/);
  });
});

describe("RefResolverService.resolve()", () => {
  const lookup = new CachedIndexLookup(
    new Map([
      ["one", indexOf(["workflow/task-files", "workflow/alpha"])],
      ["two", indexOf(["tools/task-files"])],
    ]),
    { order: ["one", "two"] }
  );

  /**
   * With no lookup, resolve returns the readings the place allows.
   *
   * resolve({ input: "workflow/alpha" }) // -> the recipe, unsettled, usedLookup false
   */
  it("should return the pruned readings when there is no lookup", async () => {
    const result = await resolver.resolve(new RefResolveArguments({ input: "workflow/alpha" }));
    expect(result.usedLookup).toBe(false);
    expect(result.isUnique).toBe(true);
    expect(result.dropped).toEqual([]);
  });

  /**
   * With a lookup, readings narrow to what exists, in the published
   * spelling, and an ambiguous bare name keeps every match in listing order.
   *
   * resolve("task-files") // -> one:workflow/task-files, two:tools/task-files
   */
  it("should narrow to known refs and list them best first", async () => {
    const result = await resolver.resolve(
      new RefResolveArguments({ input: "task-files", lookup })
    );
    expect(result.usedLookup).toBe(true);
    expect(result.isUnique).toBe(false);
    expect(result.refs.map((ref) => refKey(ref))).toEqual([
      "one:workflow/task-files",
      "two:tools/task-files",
    ]);
    expect(result.first()).toBe(result.refs[0]);
  });

  /**
   * Exact-spelling matches win over case-insensitive ones, and the known
   * spelling comes back.
   *
   * resolve("Workflow/Alpha") // -> workflow/alpha, the only match
   * resolve("workflow") // -> the namespace, exactly spelled
   */
  it("should prefer exact spelling and return the published one", async () => {
    const folded = await resolver.resolve(new RefResolveArguments({ input: "Workflow/Alpha", lookup }));
    expect(folded.refs.map((ref) => refKey(ref))).toEqual(["one:workflow/alpha"]);

    const exact = await resolver.resolve(new RefResolveArguments({ input: "workflow", lookup }));
    expect(exact.refs.map((ref) => refKey(ref))).toEqual(["one:workflow"]);
  });

  /**
   * A ref nothing knows comes back with no refs, which is for the caller to
   * report; the lookup is still marked used.
   *
   * resolve("nothing") // -> isEmpty
   */
  it("should return no refs for a ref nothing knows", async () => {
    const result = await resolver.resolve(new RefResolveArguments({ input: "nothing", lookup }));
    expect(result.isEmpty).toBe(true);
    expect(result.first()).toBeUndefined();
  });

  /**
   * A lookup that fails makes resolve fail; the error is never swallowed.
   *
   * resolve({ lookup: throwing }) // rejects
   */
  it("should let a failing lookup throw", async () => {
    const failing: RefLookup = {
      find: async () => {
        throw new Error("offline");
      },
    };
    await expect(
      resolver.resolve(new RefResolveArguments({ input: "workflow", lookup: failing }))
    ).rejects.toThrow("offline");
  });

  /**
   * The same ref found by two readings is returned once.
   *
   * a lookup answering every candidate with the same namespace // one ref
   */
  it("should return a ref found twice only once", async () => {
    const same: SousRefLookup = {
      find: async () => [
        { ref: { kind: "namespace", name: "workflow" }, exactSpelling: true },
      ],
    };
    const result = await resolver.resolve(new RefResolveArguments({ input: "workflow", lookup: same }));
    expect(result.refs).toHaveLength(1);
  });
});

/** A lookup, spelled out for the test above. */
type SousRefLookup = RefLookup;

describe("RefResolverService helpers", () => {
  /**
   * isValidRef should say whether a place allows a ref.
   *
   * isValidRef("workflow/alpha", Config) // -> true
   */
  it("should tell a valid ref from an invalid one", () => {
    expect(resolver.isValidRef("workflow/alpha", RefSource.Config)).toBe(true);
    expect(resolver.isValidRef("workflow/alpha@^1", RefSource.Config)).toBe(false);
    expect(resolver.isValidRef("", RefSource.CommandLine)).toBe(false);
  });

  /**
   * getRefsInString should find the refs among the words of a text, with the
   * punctuation around each taken off.
   *
   * getRefsInString("see 'workflow/task-files', then") // -> workflow/task-files at index 5
   */
  it("should find the refs inside a string", () => {
    const found = resolver.getRefsInString("see 'workflow/task-files', then (a b/c/d.md) ok");
    const texts = found.map((entry) => entry.text);
    expect(texts).toContain("workflow/task-files");
    expect(found.find((entry) => entry.text === "workflow/task-files")?.index).toBe(5);
    expect(texts).not.toContain("(a");
    const include = resolver.getRefsInString("x w/a/b.md y", RefSource.Include);
    expect(include.map((entry) => entry.text)).toEqual(["w/a/b.md"]);
  });
});

describe("RefResolverService.resolveSync and inspect", () => {
  /** A lookup that knows one recipe file, answering both ways. */
  const lookup = {
    findSync: (candidate: SousRef) =>
      candidate.kind === "recipeFile" && candidate.recipe.name === "alpha"
        ? [{ ref: candidate, exactSpelling: true }]
        : [],
    find: async () => [],
  };

  /**
   * resolveSync should narrow the readings against a lookup without waiting.
   *
   * resolveSync({ input: "w/alpha/f.md", from: Include, lookup }) // -> the recipe file
   */
  it("should narrow readings against a synchronous lookup", () => {
    const found = resolver.resolveSync(
      new RefResolveArguments({ input: "w/alpha/f.md", from: RefSource.Include, lookup })
    );
    expect(found.refs.map((ref) => ref.kind)).toEqual(["recipeFile"]);
    const none = resolver.resolveSync(
      new RefResolveArguments({ input: "w/beta/f.md", from: RefSource.Include, lookup })
    );
    expect(none.isEmpty).toBe(true);
  });

  /**
   * A lookup with no findSync cannot be used synchronously, and a refused ref
   * raises the place's refusal, as resolve does.
   *
   * resolveSync with { find } only // throws
   */
  it("should refuse a lookup that cannot answer synchronously and a refused ref", () => {
    expect(() =>
      resolver.resolveSync(
        new RefResolveArguments({
          input: "w/alpha/f.md",
          from: RefSource.Include,
          lookup: { find: async () => [] },
        })
      )
    ).toThrow(/findSync/);
    expect(() =>
      resolver.resolveSync(
        new RefResolveArguments({ input: "w/alpha", from: RefSource.Include, lookup })
      )
    ).toThrow(/names a file inside a recipe/);
  });

  /**
   * inspect returns what a place dropped, so a caller can explain a refusal
   * in its own words.
   *
   * inspect("w/a/../f.md", Include) // -> kept [], dropped one recipeFile
   */
  it("should return the dropped readings with the reason", () => {
    const { kept, dropped } = resolver.inspect("w/a/../f.md", RefSource.Include);
    expect(kept).toEqual([]);
    expect(dropped[0]?.ref.kind).toBe("recipeFile");
    expect(dropped[0]?.reason).toContain("'.' or '..'");
  });
});
