import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseDocument } from "@sous-io/documents";
import { isSousErrorOfKind } from "@sous-io/plugin-api";
import type { RepositoryHostEntity, ScaffoldOptions } from "@sous-io/plugin-recipes/types";
import type { RepoInitInput } from "../types.js";
import { git, initRepo, makeTmpDir, type TmpDir } from "../../test/support/git-repo.js";
import { indexFileParser, recipeManifestParser, repoManifestParser, testTools } from "../../test/support/standins.js";
import { EXAMPLE_RECIPE_NAME, scaffoldRepo as scaffold } from "./scaffold.js";

const YAML = { parse: (text: string) => parseDocument(text, "yaml").value() as Record<string, unknown> };
const parseIndexFile = (value: unknown, label: string) => indexFileParser.parse(value, label);
const parseRecipeManifest = (value: unknown, label: string) => recipeManifestParser.parse(value, label);
const parseRepoManifest = (value: unknown, label: string) => repoManifestParser.parse(value, label);
const isConfigError = (error: unknown) => isSousErrorOfKind(error, "config");

/** A host stand-in that scaffolds one workflow file, as plugin-github's does. */
function workflowHost(seen: ScaffoldOptions[] = []): RepositoryHostEntity {
  return {
    id: "github",
    features: ["fetch"],
    readStrategies: [],
    readLocation: () => [],
    formatLocator: () => "",
    matches: (url: string) => url.includes("github.com"),
    canonicalize: (url: string) => ({ host: "github.com", owner: "o", name: "r", httpsUrl: url, sshUrl: url }),
    fetchRecipeTree: async () => {},
    scaffoldFiles: (options: ScaffoldOptions) => {
      seen.push(options);
      return [{ path: ".github/workflows/sous-release.yml", content: "name: sous release\non:\n  pull_request:\n" }];
    },
  };
}

/** Scaffolds with the stand-ins, as the intent does. */
function scaffoldRepo(input: RepoInitInput & { sousVersion: string; now?: Date }, hosts: RepositoryHostEntity[] = []) {
  const { sousVersion, now, ...rest } = input;
  return scaffold(testTools({ sousVersion, hosts }), rest, { cwd: process.cwd(), ...(now === undefined ? {} : { now }) });
}

/** The version recorded in scaffolded indexes; any valid semver will do. */
const SOUS_VERSION = "0.1.1";

describe("scaffoldRepo()", () => {
  let tmp: TmpDir;
  let target: string;

  beforeEach(() => {
    tmp = makeTmpDir("sous-scaffold-");
    target = path.join(tmp.path, "my-recipes");
    fs.mkdirSync(target, { recursive: true });
  });

  afterEach(() => {
    tmp.cleanup();
  });

  /**
   * scaffoldRepo should write every file a new repository needs, and report
   * them in the order they were written.
   *
   * await scaffoldRepo({ directory: "/tmp/my-recipes", sousVersion: "0.1.1" });
   * // -> writes sous.repo.yaml, sous.index.json, the example recipe, a README,
   * //    CONTRIBUTING.md, CLAUDE.md, AGENTS.md, the release workflow and a
   * //    .gitignore
   */
  it("should write every file a new repository needs", async () => {
    const result = await scaffoldRepo({ directory: target, sousVersion: SOUS_VERSION });

    for (const relative of result.files) {
      expect(fs.existsSync(path.join(target, relative))).toBe(true);
    }

    expect(result.files).toContain("sous.repo.yaml");
    expect(result.files).toContain("sous.index.json");
    expect(result.files).toContain("README.md");
    expect(result.files).toContain("CONTRIBUTING.md");
    expect(result.files).toContain("CLAUDE.md");
    expect(result.files).toContain("AGENTS.md");
    expect(result.files).toContain(".gitignore");
    // No host was named or found, so no CI workflow: that is the host plugin's to write.
    expect(result.files.some((file) => file.startsWith(".github/"))).toBe(false);
    expect(result.files).toContain(
      `recipes/my-recipes/${EXAMPLE_RECIPE_NAME}/sous.recipe.yaml`
    );
    expect(result.files).toContain(
      `recipes/my-recipes/${EXAMPLE_RECIPE_NAME}/skills/example-skill/SKILL.tpl.md`
    );
  });

  /**
   * The placeholder skill should be a template, as every skill is, and end with
   * the footer naming the recipe it comes from.
   *
   * await scaffoldRepo({ directory: "/tmp/my-recipes" });
   * // -> .../skills/example-skill/SKILL.tpl.md, ending "## Source for this Skill"
   */
  it("should write the placeholder skill as a template with the recipe footer", async () => {
    await scaffoldRepo({ directory: target, sousVersion: SOUS_VERSION });

    const skill = fs.readFileSync(
      path.join(
        target,
        "recipes/my-recipes",
        EXAMPLE_RECIPE_NAME,
        "skills/example-skill/SKILL.tpl.md"
      ),
      "utf8"
    );

    expect(skill).toContain("## Source for this Skill");
    expect(skill).toContain(`\`my-recipes/${EXAMPLE_RECIPE_NAME}\` recipe`);
    expect(skill).toContain("- Source Path: {{ sousTemplatePath }}");
  });

  /**
   * The scaffolded CLAUDE.md should be the entry point for an agent: it names
   * the repository, the core skills that teach how a recipe repository works,
   * and where those skills can be read online.
   */
  it("should write a CLAUDE.md that points an agent at the core skills", async () => {
    await scaffoldRepo({ directory: target, sousVersion: SOUS_VERSION });

    const claude = fs.readFileSync(path.join(target, "CLAUDE.md"), "utf8");

    expect(claude.startsWith("# my-recipes\n")).toBe(true);
    expect(claude).toContain("`about-sous-repos`");
    expect(claude).toContain("`about-sous-recipes`");
    expect(claude).toContain(
      "https://github.com/sous-io/sous-recipes/tree/main/recipes/core/sous-skills/skills"
    );

    const agents = fs.readFileSync(path.join(target, "AGENTS.md"), "utf8");
    expect(agents).toContain("`CLAUDE.md`");
  });

  /**
   * The scaffolded CONTRIBUTING.md should name the repository and send an
   * agent without the core skills to CLAUDE.md; the README should point at
   * both.
   */
  it("should write a CONTRIBUTING.md that points at CLAUDE.md", async () => {
    await scaffoldRepo({ directory: target, sousVersion: SOUS_VERSION });

    const contributing = fs.readFileSync(path.join(target, "CONTRIBUTING.md"), "utf8");
    expect(contributing.startsWith("# Contributing to my-recipes\n")).toBe(true);
    expect(contributing).toContain("starts at `CLAUDE.md`");

    const readme = fs.readFileSync(path.join(target, "README.md"), "utf8");
    expect(readme).toContain("## Contributing");
    expect(readme).toContain("`CONTRIBUTING.md` says why");
    expect(readme).toContain("## License");
  });

  /**
   * No scaffolded file should contain an em-dash, which sous's writing
   * standard forbids everywhere, generated files included.
   */
  it("should write no em-dash in any file", async () => {
    const result = await scaffoldRepo({ directory: target, sousVersion: SOUS_VERSION });

    for (const relative of result.files) {
      const text = fs.readFileSync(path.join(target, relative), "utf8");
      expect(text.includes("\u2014"), relative).toBe(false);
    }
  });

  /**
   * Everything the scaffold writes should parse through the very schemas sous
   * uses to read a published repository. A scaffold sous cannot read would be
   * worse than no scaffold at all.
   */
  it("should write files that round-trip through the real parsers", async () => {
    await scaffoldRepo({ directory: target, sousVersion: SOUS_VERSION });

    const manifestPath = path.join(target, "sous.repo.yaml");
    const manifest = parseRepoManifest(
      YAML.parse(fs.readFileSync(manifestPath, "utf8")),
      manifestPath
    );
    expect(manifest.name).toBe("my-recipes");
    expect(Object.keys(manifest.namespaces)).toEqual(["my-recipes"]);
    expect(manifest.recipes).toEqual([`recipes/my-recipes/${EXAMPLE_RECIPE_NAME}`]);

    const recipePath = path.join(target, manifest.recipes[0]!, "sous.recipe.yaml");
    const recipe = parseRecipeManifest(
      YAML.parse(fs.readFileSync(recipePath, "utf8")),
      recipePath
    );
    expect(recipe.namespace).toBe("my-recipes");
    expect(recipe.name).toBe(EXAMPLE_RECIPE_NAME);
    expect(recipe.version).toBe("0.1.0");
    expect(recipe.contents[0]!.kind).toBe("skills");

    const indexPath = path.join(target, "sous.index.json");
    const index = parseIndexFile(
      JSON.parse(fs.readFileSync(indexPath, "utf8")),
      indexPath
    );
    expect(index.name).toBe("my-recipes");
    expect(index.generator).toBe(SOUS_VERSION);
    expect(index.recipes).toEqual({});
    expect(Object.keys(index.namespaces)).toEqual(["my-recipes"]);
  });

  /**
   * The recipe manifest should carry the variables section as a commented-out
   * example, so an author sees the shape without the scaffold declaring a
   * variable nobody asked for.
   */
  it("should show the variables section as a commented example", async () => {
    await scaffoldRepo({ directory: target, sousVersion: SOUS_VERSION });

    const text = fs.readFileSync(
      path.join(target, "recipes/my-recipes", EXAMPLE_RECIPE_NAME, "sous.recipe.yaml"),
      "utf8"
    );

    expect(text).toContain("# variables:");
    expect(text).toContain("#   - name: apiBaseUrl");
    // Commented out, so the parsed manifest declares no variables at all.
    const parsed = YAML.parse(text) as Record<string, unknown>;
    expect(parsed.variables).toBeUndefined();
  });

  /**
   * The CI workflow comes from the repository host named with --host: its files are written
   * beside the scaffold's own, and the README names the workflow.
   */
  it("should write the CI files of the host it is given", async () => {
    const seen: ScaffoldOptions[] = [];
    const result = await scaffoldRepo({ directory: target, sousVersion: SOUS_VERSION, host: "github" }, [workflowHost(seen)]);

    expect(result.host).toBe("github");
    expect(result.files).toContain(".github/workflows/sous-release.yml");
    expect(seen).toEqual([{ name: "my-recipes", namespace: "my-recipes", sousVersion: SOUS_VERSION }]);
    expect(fs.readFileSync(path.join(target, ".github/workflows/sous-release.yml"), "utf8")).toContain("pull_request");
    expect(fs.readFileSync(path.join(target, "README.md"), "utf8")).toContain("`.github/workflows/sous-release.yml`");
  });

  /** With no --host, the host reading the directory's origin remote scaffolds its files. */
  it("should take the host from the git remote when none is named", async () => {
    initRepo(target);
    git(target, "remote", "add", "origin", "https://github.com/o/r.git");

    const result = await scaffoldRepo({ directory: target, sousVersion: SOUS_VERSION }, [workflowHost()]);

    expect(result.host).toBe("github");
    expect(result.files).toContain(".github/workflows/sous-release.yml");
  });

  /** With no --host and no remote, GitHub's CI is written, as today's command always did. */
  it("should write GitHub's CI files when no host is named or found", async () => {
    const result = await scaffoldRepo({ directory: target, sousVersion: SOUS_VERSION }, [workflowHost()]);

    expect(result.host).toBe("github");
    expect(result.files).toContain(".github/workflows/sous-release.yml");
  });

  /** A host nobody adds is a readable error naming the hosts there are. */
  it("should refuse a host no plugin adds", async () => {
    await expect(scaffoldRepo({ directory: target, sousVersion: SOUS_VERSION, host: "bitbucket" }, [workflowHost()])).rejects.toThrow(
      /No repository host is called 'bitbucket'[\s\S]*github/,
    );
  });

  /**
   * scaffoldRepo should take the repository name from the directory when no
   * name is given, and should accept explicit name and namespace overrides.
   *
   * await scaffoldRepo({ directory, name: "custom", namespace: "core" });
   * // -> recipes/core/example/sous.recipe.yaml, declaring namespace "core"
   */
  it("should honour explicit name and namespace overrides", async () => {
    const result = await scaffoldRepo({
      directory: target,
      name: "custom-name",
      namespace: "core",
      sousVersion: SOUS_VERSION,
    });

    expect(result.name).toBe("custom-name");
    expect(result.namespace).toBe("core");

    const manifestPath = path.join(target, "sous.repo.yaml");
    const manifest = parseRepoManifest(
      YAML.parse(fs.readFileSync(manifestPath, "utf8")),
      manifestPath
    );
    expect(manifest.name).toBe("custom-name");
    expect(Object.keys(manifest.namespaces)).toEqual(["core"]);
    expect(manifest.recipes).toEqual([`recipes/core/${EXAMPLE_RECIPE_NAME}`]);
  });

  /**
   * A directory whose own name is not kebab-case should be lower-cased where
   * that is enough, and rejected with an explanation where it is not.
   *
   * await scaffoldRepo({ directory: ".../My-Recipes" }); // -> name "my-recipes"
   * await scaffoldRepo({ directory: ".../my recipes" }); // throws ConfigError
   */
  it("should lower-case a usable directory name and reject an unusable one", async () => {
    const upper = path.join(tmp.path, "My-Recipes");
    fs.mkdirSync(upper, { recursive: true });
    expect((await scaffoldRepo({ directory: upper, sousVersion: SOUS_VERSION })).name).toBe(
      "my-recipes"
    );

    const spaced = path.join(tmp.path, "my recipes");
    fs.mkdirSync(spaced, { recursive: true });
    let caught: unknown;
    try {
      await scaffoldRepo({ directory: spaced, sousVersion: SOUS_VERSION });
    } catch (error) {
      caught = error;
    }
    expect(isConfigError(caught)).toBe(true);
    expect((caught as Error).message).toContain("--name");
  });

  /**
   * scaffoldRepo should refuse to write over a directory that is already a
   * repository, and should say how to do it anyway.
   */
  it("should refuse to overwrite an existing repository without --force", async () => {
    await scaffoldRepo({ directory: target, sousVersion: SOUS_VERSION });

    let caught: unknown;
    try {
      await scaffoldRepo({ directory: target, sousVersion: SOUS_VERSION });
    } catch (error) {
      caught = error;
    }
    expect(isConfigError(caught)).toBe(true);
    expect((caught as Error).message).toContain("--force");
  });

  /**
   * With force, scaffoldRepo should write over the existing repository, so a
   * half-edited scaffold can be reset deliberately.
   */
  it("should overwrite an existing repository when forced", async () => {
    await scaffoldRepo({ directory: target, sousVersion: SOUS_VERSION });
    fs.writeFileSync(path.join(target, "README.md"), "edited\n", "utf8");

    await scaffoldRepo({ directory: target, force: true, sousVersion: SOUS_VERSION });

    expect(fs.readFileSync(path.join(target, "README.md"), "utf8")).not.toBe("edited\n");
  });

  /**
   * A dry run should report exactly the files it would write and write none of
   * them.
   *
   * await scaffoldRepo({ directory, dryRun: true }); // -> { dryRun: true, files: [...] }
   */
  it("should write nothing on a dry run", async () => {
    const result = await scaffoldRepo({
      directory: target,
      dryRun: true,
      sousVersion: SOUS_VERSION,
    });

    expect(result.dryRun).toBe(true);
    expect(result.files.length).toBeGreaterThan(0);
    expect(fs.readdirSync(target)).toEqual([]);
  });

  /**
   * The generated index should carry the timestamp it was given, so a caller
   * can make the output reproducible.
   */
  it("should record the given timestamp in the index", async () => {
    const now = new Date("2026-09-09T14:03:11.482Z");
    await scaffoldRepo({ directory: target, sousVersion: SOUS_VERSION, now });

    const index = JSON.parse(
      fs.readFileSync(path.join(target, "sous.index.json"), "utf8")
    ) as { generatedAt: string };
    expect(index.generatedAt).toBe("2026-09-09T14:03:11.482Z");
  });
});
