import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTmpDir, type TmpDir } from "../../test/utils/tmp.js";
import { makeSettings } from "../../test/utils/settings.js";
import {
  listLockedRecipes,
  mapLinkedRecipes,
  projectSubscriptionRefs,
  readProjectLockfile,
  readRecipeManifestIn,
} from "./locked-recipes.js";
import { createProjectNamespaceResolver } from "./locked-namespace-resolver.js";

let tmp: TmpDir;
let sousDir: string;
let storeRoot: string;

/** Writes a file, creating its parent directories. */
function write(filePath: string, contents: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
  return filePath;
}

/** Writes a recipe manifest into a directory and returns that directory. */
function writeRecipe(
  dir: string,
  options: { namespace: string; name: string; version?: string; depends?: string[] }
): string {
  const manifest = {
    formatVersion: 1,
    namespace: options.namespace,
    name: options.name,
    version: options.version ?? "1.0.0",
    ...(options.depends === undefined ? {} : { depends: options.depends }),
    contents: [],
  };
  write(path.join(dir, "sous.recipe.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

/** Writes a lockfile pinning the given recipes to one repository. */
function writeLock(
  entries: Array<{ key: string; version?: string; requestedBy?: string[] }>,
  repo = "fixtures"
): void {
  const recipes: Record<string, unknown> = {};
  for (const entry of entries) {
    recipes[entry.key] = {
      repo,
      version: entry.version ?? "1.0.0",
      hash: `sha256-${"a".repeat(64)}`,
      requestedBy: entry.requestedBy ?? ["project"],
      kind: "subscribes",
    };
  }
  write(
    path.join(sousDir, "sous.lock.json"),
    JSON.stringify(
      {
        formatVersion: 1,
        repos: { [repo]: { url: "https://example.com/owner/fixtures" } },
        recipes,
      },
      null,
      2
    )
  );
}

beforeEach(() => {
  tmp = makeTmpDir("sous-locked-");
  sousDir = path.join(tmp.path, "project", ".sous");
  storeRoot = path.join(tmp.path, "home", "cache");
  fs.mkdirSync(sousDir, { recursive: true });
});

afterEach(() => {
  tmp.cleanup();
});

describe("readProjectLockfile()", () => {
  /**
   * readProjectLockfile should return an empty lockfile for a project that has
   * locked nothing yet, rather than failing, because that is the ordinary state
   * of every project that uses no repositories.
   *
   * readProjectLockfile("/a/project/.sous");
   * // -> { formatVersion: 1, repos: {}, recipes: {} }
   */
  it("should return an empty lockfile when there is no file", () => {
    expect(readProjectLockfile(sousDir)).toEqual({
      formatVersion: 1,
      repos: {},
      recipes: {},
    });
  });
});

describe("listLockedRecipes()", () => {
  /**
   * listLockedRecipes should locate each locked recipe in the machine-wide
   * store, at the exact version the lockfile pins, and report whether the
   * directory is actually there yet.
   *
   * listLockedRecipes({ sousDir, storeRoot });
   * // -> [{ key: "workflow/task-files", dir: "<store>/fixtures/workflow/task-files/1.0.0", present: true }]
   */
  it("should locate a locked recipe in the store at its pinned version", () => {
    writeLock([{ key: "workflow/task-files" }]);
    const recipeDir = path.join(storeRoot, "fixtures", "workflow", "task-files", "1.0.0");
    writeRecipe(recipeDir, { namespace: "workflow", name: "task-files" });

    const located = listLockedRecipes({ sousDir, storeRoot });

    expect(located).toHaveLength(1);
    expect(located[0]!.key).toBe("workflow/task-files");
    expect(located[0]!.dir).toBe(recipeDir);
    expect(located[0]!.linked).toBe(false);
    expect(located[0]!.present).toBe(true);
  });

  /**
   * listLockedRecipes should report a recipe the store does not hold yet as
   * absent rather than failing, so a fresh clone can be restored instead of
   * being refused.
   *
   * listLockedRecipes({ sousDir, storeRoot }); // -> [{ present: false, ... }]
   */
  it("should report a recipe the store does not hold as absent", () => {
    writeLock([{ key: "workflow/task-files" }]);
    const located = listLockedRecipes({ sousDir, storeRoot });
    expect(located[0]!.present).toBe(false);
  });

  /**
   * listLockedRecipes should read a LINKED repository from its working copy
   * instead of the store, because a link is a deliberate instruction to bypass
   * versions and the lockfile.
   *
   * listLockedRecipes({ sousDir, storeRoot });
   * // -> [{ dir: "<checkout>/recipes/workflow/task-files", linked: true }]
   */
  it("should read a linked repository from its working copy", () => {
    writeLock([{ key: "workflow/task-files" }]);
    // The store copy exists too, so this proves the link wins rather than
    // merely filling a gap.
    writeRecipe(path.join(storeRoot, "fixtures", "workflow", "task-files", "1.0.0"), {
      namespace: "workflow",
      name: "task-files",
    });

    const checkout = path.join(tmp.path, "checkout");
    write(
      path.join(checkout, "sous.repo.json"),
      JSON.stringify({
        formatVersion: 1,
        name: "fixtures",
        namespaces: { workflow: {} },
        recipes: ["recipes/workflow/task-files"],
      })
    );
    const linkedDir = writeRecipe(path.join(checkout, "recipes/workflow/task-files"), {
      namespace: "workflow",
      name: "task-files",
    });

    write(
      path.join(sousDir, "sous.links.json"),
      JSON.stringify({
        formatVersion: 1,
        links: {
          fixtures: { path: checkout, linkedAt: "2026-01-01T00:00:00.000Z", origin: "path" },
        },
      })
    );

    const located = listLockedRecipes({ sousDir, storeRoot, env: {} });
    expect(located[0]!.dir).toBe(linkedDir);
    expect(located[0]!.linked).toBe(true);
  });
});

describe("mapLinkedRecipes()", () => {
  /**
   * mapLinkedRecipes should skip a folder the repo manifest lists that holds no
   * readable recipe manifest, because a working copy is edited by hand and is
   * allowed to be mid-change.
   *
   * mapLinkedRecipes(checkout); // -> { "workflow/task-files": "<checkout>/recipes/a" }
   */
  it("should skip a listed folder with no recipe manifest", () => {
    const checkout = path.join(tmp.path, "checkout");
    write(
      path.join(checkout, "sous.repo.json"),
      JSON.stringify({
        formatVersion: 1,
        name: "fixtures",
        namespaces: { workflow: {} },
        recipes: ["recipes/a", "recipes/half-written"],
      })
    );
    writeRecipe(path.join(checkout, "recipes/a"), {
      namespace: "workflow",
      name: "task-files",
    });
    fs.mkdirSync(path.join(checkout, "recipes/half-written"), { recursive: true });

    expect(Object.keys(mapLinkedRecipes(checkout))).toEqual(["workflow/task-files"]);
  });
});

describe("projectSubscriptionRefs()", () => {
  /**
   * projectSubscriptionRefs should merge the subscriptions written in the config
   * with the lockfile entries the project itself holds, so a subscription
   * recorded in either place is in scope for the project's own templates.
   *
   * projectSubscriptionRefs(settings, located); // -> ["core", "workflow/task-files"]
   */
  it("should merge configured subscriptions with lockfile holders", () => {
    writeLock([
      { key: "workflow/task-files", requestedBy: ["project"] },
      { key: "workflow/shared", requestedBy: ["workflow/task-files"] },
    ]);
    const located = listLockedRecipes({ sousDir, storeRoot });
    const settings = makeSettings({ subscriptions: { core: {} } });

    expect(projectSubscriptionRefs(settings, located)).toEqual([
      "core",
      "workflow/task-files",
    ]);
  });
});

describe("createProjectNamespaceResolver()", () => {
  /**
   * createProjectNamespaceResolver should return undefined for a project that
   * locks nothing, so `~` in an include line keeps meaning an alias and nothing
   * else for every project that uses no repositories.
   *
   * createProjectNamespaceResolver({ sousDir, settings }); // -> undefined
   */
  it("should return undefined when the project locks no recipes", () => {
    expect(
      createProjectNamespaceResolver({ sousDir, settings: makeSettings() })
    ).toBeUndefined();
  });

  /**
   * createProjectNamespaceResolver should resolve a namespace reference made
   * from one of the project's own templates to the pinned recipe directory.
   *
   * resolver.resolve({ namespace: "workflow", rest: "task-files/x.md", fromFile });
   * // -> { kind: "candidates", candidates: ["<store>/.../1.0.0/x.md"] }
   */
  it("should resolve a subscribed recipe from a project template", () => {
    writeLock([{ key: "workflow/task-files" }]);
    const recipeDir = path.join(storeRoot, "fixtures", "workflow", "task-files", "1.0.0");
    writeRecipe(recipeDir, { namespace: "workflow", name: "task-files" });

    const resolver = createProjectNamespaceResolver({
      sousDir,
      settings: makeSettings({ subscriptions: { "workflow/task-files": {} } }),
      locked: listLockedRecipes({ sousDir, storeRoot }),
    })!;

    expect(
      resolver.resolve({
        namespace: "workflow",
        rest: "task-files/partials/x.md",
        fromFile: path.join(sousDir, "prompts", "root.md"),
      })
    ).toEqual({
      kind: "candidates",
      candidates: [path.join(recipeDir, "partials/x.md")],
    });
  });

  /**
   * createProjectNamespaceResolver should refuse a reference from inside one
   * recipe to another recipe it does not declare as a dependency, which is the
   * scoping rule the whole sigil rests on.
   *
   * resolver.resolve({ namespace: "workflow", rest: "other/x.md", fromFile: insideA });
   * // -> { kind: "not-a-dependency", includingRecipe: "workflow/task-files" }
   */
  it("should refuse a recipe the including recipe does not declare", () => {
    writeLock([{ key: "workflow/task-files" }, { key: "workflow/other" }]);
    const taskFiles = path.join(storeRoot, "fixtures", "workflow", "task-files", "1.0.0");
    writeRecipe(taskFiles, { namespace: "workflow", name: "task-files" });
    writeRecipe(path.join(storeRoot, "fixtures", "workflow", "other", "1.0.0"), {
      namespace: "workflow",
      name: "other",
    });

    const resolver = createProjectNamespaceResolver({
      sousDir,
      settings: makeSettings(),
      locked: listLockedRecipes({ sousDir, storeRoot }),
    })!;

    expect(
      resolver.resolve({
        namespace: "workflow",
        rest: "other/x.md",
        fromFile: path.join(taskFiles, "SKILL.md"),
      })
    ).toEqual({
      kind: "not-a-dependency",
      recipe: "workflow/other",
      includingRecipe: "workflow/task-files",
    });
  });

  /**
   * createProjectNamespaceResolver should allow a reference from inside a recipe
   * to something that recipe's manifest declares under `depends`.
   *
   * resolver.resolve({ namespace: "workflow", rest: "other/x.md", fromFile: insideA });
   * // -> { kind: "candidates", ... }
   */
  it("should allow a recipe the including recipe declares", () => {
    writeLock([{ key: "workflow/task-files" }, { key: "workflow/other" }]);
    const taskFiles = path.join(storeRoot, "fixtures", "workflow", "task-files", "1.0.0");
    writeRecipe(taskFiles, {
      namespace: "workflow",
      name: "task-files",
      depends: ["workflow/other"],
    });
    const other = path.join(storeRoot, "fixtures", "workflow", "other", "1.0.0");
    writeRecipe(other, { namespace: "workflow", name: "other" });

    const resolver = createProjectNamespaceResolver({
      sousDir,
      settings: makeSettings(),
      locked: listLockedRecipes({ sousDir, storeRoot }),
    })!;

    expect(
      resolver.resolve({
        namespace: "workflow",
        rest: "other/x.md",
        fromFile: path.join(taskFiles, "SKILL.md"),
      })
    ).toEqual({ kind: "candidates", candidates: [path.join(other, "x.md")] });
  });
});

describe("readRecipeManifestIn()", () => {
  /**
   * readRecipeManifestIn should return undefined for a directory that holds no
   * recipe manifest, since a recipe that is not restored yet is an ordinary
   * state rather than an error.
   *
   * readRecipeManifestIn("/nowhere"); // -> undefined
   */
  it("should return undefined when there is no manifest", () => {
    expect(readRecipeManifestIn(path.join(tmp.path, "nowhere"))).toBeUndefined();
  });
});
