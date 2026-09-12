import { describe, it, expect } from "vitest";
import {
  createEmptyLinksMap,
  linksMapSchema,
  mergeLinksMaps,
  parseLinksMap,
  stringifyLinksMap,
} from "./links-map.js";
import { isConfigError } from "../../errors.js";

/**
 * Unit tests for the links map (`sous.links.json`), which redirects a repo's
 * resolution at a local working copy so recipes can be edited outside the store.
 */

const SOURCE = "/project/.sous/sous.links.json";

/** A valid links map, used as the base for rejection cases. */
function validMap() {
  return {
    formatVersion: 1,
    links: {
      "sous-recipes": {
        path: "/home/me/Projects/sous-recipes",
        linkedAt: "2026-09-09T14:03:11.482Z",
        origin: "clone",
      },
    },
  };
}

/** Runs parseLinksMap and returns the ConfigError message, or fails. */
function expectRejectMessage(value: unknown): string {
  try {
    parseLinksMap(value, SOURCE);
  } catch (error) {
    expect(isConfigError(error)).toBe(true);
    return (error as Error).message;
  }
  throw new Error("expected parseLinksMap to throw, but it returned");
}

describe("parseLinksMap()", () => {
  /**
   * A complete links map parses and is returned intact.
   */
  it("should accept a map using every field", () => {
    const map = validMap();
    expect(parseLinksMap(map, SOURCE)).toEqual(map);
  });

  /**
   * An empty map is valid; nothing is linked in most projects.
   */
  it("should accept an empty map", () => {
    expect(parseLinksMap(createEmptyLinksMap(), SOURCE)).toEqual({
      formatVersion: 1,
      links: {},
    });
  });

  /**
   * The map is machine-written, so an unknown key is a bug.
   */
  it("should reject an unknown key", () => {
    expect(expectRejectMessage({ ...validMap(), linked: {} })).toContain(
      "unknown key 'linked'"
    );
  });

  /**
   * A link points at a working copy on this machine, so the path is absolute; a
   * relative path would mean different things from different directories.
   */
  it("should reject a relative link path", () => {
    const message = expectRejectMessage({
      formatVersion: 1,
      links: {
        "sous-recipes": {
          path: "../sous-recipes",
          linkedAt: "2026-09-09T14:03:11.482Z",
          origin: "path",
        },
      },
    });
    expect(message).toContain("links.sous-recipes.path: must be an absolute path");
  });

  /**
   * Only the two documented origins are accepted.
   */
  it("should reject an unknown origin", () => {
    const map = validMap();
    const message = expectRejectMessage({
      formatVersion: 1,
      links: { "sous-recipes": { ...map.links["sous-recipes"], origin: "symlink" } },
    });
    expect(message).toContain("links.sous-recipes.origin:");
  });

  /**
   * Link keys are repo short names, so they follow the same kebab-case rule as
   * the `repo:` ref qualifier.
   */
  it("should reject a link key that is not kebab-case", () => {
    const map = validMap();
    const message = expectRejectMessage({
      formatVersion: 1,
      links: { "Sous Recipes": map.links["sous-recipes"] },
    });
    expect(message).toContain("invalid key; a repo name must be lowercase kebab-case");
  });
});

describe("mergeLinksMaps()", () => {
  /**
   * The project map wins over the machine-wide map for the same repo, which is
   * the precedence `sous repo link` documents.
   *
   * mergeLinksMaps(globalMap, projectMap)["sous-recipes"].path;
   * // -> the project's path
   */
  it("should let the project map win on conflict", () => {
    const global = parseLinksMap(
      {
        formatVersion: 1,
        links: {
          "sous-recipes": {
            path: "/home/me/.sous/repos/sous-io/sous-recipes",
            linkedAt: "2026-09-01T10:00:00.000Z",
            origin: "clone",
          },
          "team-recipes": {
            path: "/home/me/.sous/repos/team/recipes",
            linkedAt: "2026-09-01T10:00:00.000Z",
            origin: "clone",
          },
        },
      },
      SOURCE
    );
    const project = parseLinksMap(validMap(), SOURCE);

    const merged = mergeLinksMaps(global, project);
    expect(merged["sous-recipes"]?.path).toBe("/home/me/Projects/sous-recipes");
    expect(merged["team-recipes"]?.path).toBe("/home/me/.sous/repos/team/recipes");
  });

  /**
   * Either map may be missing entirely, and the merge still returns a usable
   * object.
   *
   * mergeLinksMaps(undefined, undefined);  // -> {}
   */
  it("should tolerate a missing map on either side", () => {
    const project = parseLinksMap(validMap(), SOURCE);
    expect(mergeLinksMaps(undefined, undefined)).toEqual({});
    expect(Object.keys(mergeLinksMaps(undefined, project))).toEqual(["sous-recipes"]);
    expect(Object.keys(mergeLinksMaps(project, undefined))).toEqual(["sous-recipes"]);
  });
});

describe("stringifyLinksMap()", () => {
  /**
   * The map is written with sorted keys and a trailing newline.
   */
  it("should write sorted, round-trippable JSON", () => {
    const map = parseLinksMap(validMap(), SOURCE);
    const text = stringifyLinksMap(map);
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual(map);
  });
});

describe("linksMapSchema", () => {
  /**
   * The schema is exported for callers that want zod's safeParse result.
   */
  it("should be usable directly through safeParse", () => {
    expect(linksMapSchema.safeParse(validMap()).success).toBe(true);
    expect(linksMapSchema.safeParse({}).success).toBe(false);
  });
});
