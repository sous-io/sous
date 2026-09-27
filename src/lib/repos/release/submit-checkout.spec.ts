/**
 * Unit tests for choosing the checkout `sous repo submit` runs in. Projects,
 * links maps and checkouts are all built in a temporary directory, and the
 * machine-wide sous home is pointed inside it.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTmpDir, type TmpDir } from "../../../test/utils/tmp.js";
import { git, initRepo, writeFile } from "../../../test/utils/git-repo.js";
import { writeProjectLinks } from "../links.js";
import { findSubmitCheckout, type SubmitProject } from "./submit-checkout.js";

let tmp: TmpDir;
let sousDir: string;
let env: NodeJS.ProcessEnv;

/** The project's repositories, as its config would list them. */
const REPOS = {
  "sous-recipes": { url: "https://github.com/sous-io/sous-recipes" },
  "team-recipes": { url: "https://github.com/team/team-recipes" },
};

/** Creates a recipe checkout at a path, with an origin remote. */
function makeCheckout(dir: string, url: string): void {
  fs.mkdirSync(dir, { recursive: true });
  initRepo(dir);
  writeFile(dir, "sous.repo.yaml", "formatVersion: 1\nname: x\nnamespaces: {}\nrecipes: []\n");
  git(dir, "remote", "add", "origin", url);
}

/** Links repositories to checkouts in the project's links map. */
function link(entries: Record<string, string>): void {
  writeProjectLinks(sousDir, {
    formatVersion: 1,
    links: Object.fromEntries(
      Object.entries(entries).map(([name, dir]) => [
        name,
        { path: dir, linkedAt: "2026-09-27T00:00:00.000Z", origin: "clone" as const },
      ])
    ),
  });
}

/** The project handed to the finder. */
function project(): SubmitProject {
  return { sousDir, repos: REPOS };
}

beforeEach(() => {
  tmp = makeTmpDir("sous-submit-checkout-");
  sousDir = path.join(tmp.path, "project", ".sous");
  fs.mkdirSync(sousDir, { recursive: true });
  env = { ...process.env, SOUS_HOME: path.join(tmp.path, "home") };
});

afterEach(() => {
  tmp.cleanup();
});

describe("findSubmitCheckout()", () => {
  /**
   * Inside a recipe repository with no argument, the repository itself is the
   * checkout, as it always was.
   */
  it("should use the recipe repository the working directory is in", async () => {
    const checkout = path.join(tmp.path, "recipes");
    makeCheckout(checkout, "https://github.com/owner/recipes");
    fs.mkdirSync(path.join(checkout, "sub"));

    const found = await findSubmitCheckout({
      cwd: path.join(checkout, "sub"),
      interactive: false,
      env,
    });

    expect(found.rootDir).toBe(checkout);
    expect(found.repo).toBeUndefined();
  });

  /**
   * A named, linked repository is proposed from the checkout its link points at.
   */
  it("should use the checkout a named repository is linked to", async () => {
    const checkout = path.join(tmp.path, "work", "team-recipes");
    makeCheckout(checkout, REPOS["team-recipes"].url);
    link({ "team-recipes": checkout });

    const found = await findSubmitCheckout({
      cwd: path.dirname(sousDir),
      repo: "team-recipes",
      project: project(),
      interactive: false,
      env,
      write: () => {},
    });

    expect(found).toMatchObject({ rootDir: checkout, repo: "team-recipes", notes: [] });
  });

  /**
   * With no argument inside a project, the only linked repository is used and
   * named.
   */
  it("should use the only linked repository when none is named", async () => {
    const checkout = path.join(tmp.path, "work", "team-recipes");
    makeCheckout(checkout, REPOS["team-recipes"].url);
    link({ "team-recipes": checkout });

    const found = await findSubmitCheckout({
      cwd: path.dirname(sousDir),
      project: project(),
      interactive: false,
      env,
    });

    expect(found.repo).toBe("team-recipes");
    expect(found.reason).toMatch(/only repository this project links/);
  });

  /**
   * Several linked repositories are a question; with no terminal the failure
   * names the argument that answers it.
   */
  it("should ask between several linked repositories, and fail without a terminal", async () => {
    const one = path.join(tmp.path, "work", "one");
    const two = path.join(tmp.path, "work", "two");
    makeCheckout(one, REPOS["sous-recipes"].url);
    makeCheckout(two, REPOS["team-recipes"].url);
    link({ "sous-recipes": one, "team-recipes": two });

    await expect(
      findSubmitCheckout({ cwd: path.dirname(sousDir), project: project(), interactive: false, env })
    ).rejects.toThrow(/sous repo submit sous-recipes/);

    const chosen = await findSubmitCheckout({
      cwd: path.dirname(sousDir),
      project: project(),
      interactive: true,
      env,
      choose: async (_message, names) => names[1]!,
    });
    expect(chosen.rootDir).toBe(two);
  });

  /**
   * A repository no longer linked, whose checkout sous cloned is still where
   * `sous repo link` puts one, is proposed from there with a note.
   */
  it("should use a clone that is no longer linked, and say so", async () => {
    const leftover = path.join(sousDir, "repos", "team", "team-recipes");
    makeCheckout(leftover, REPOS["team-recipes"].url);

    const found = await findSubmitCheckout({
      cwd: path.dirname(sousDir),
      repo: "team-recipes",
      project: project(),
      interactive: false,
      env,
      write: () => {},
    });

    expect(found.rootDir).toBe(leftover);
    expect(found.notes.join("\n")).toMatch(/not linked in this project/);
  });

  /**
   * A repository with no working copy at all cannot be proposed from.
   */
  it("should fail when there is no working copy to propose from", async () => {
    await expect(
      findSubmitCheckout({
        cwd: path.dirname(sousDir),
        repo: "sous-recipes",
        project: project(),
        interactive: false,
        env,
        write: () => {},
      })
    ).rejects.toThrow(/no working copy of 'sous-recipes'/);
  });

  /**
   * A name the project does not know is reported as such, listing what it
   * does know.
   */
  it("should refuse a repository the project does not use", async () => {
    await expect(
      findSubmitCheckout({
        cwd: path.dirname(sousDir),
        repo: "nothing",
        project: project(),
        interactive: false,
        env,
      })
    ).rejects.toThrow(/Nothing called 'nothing'[\s\S]*sous-recipes, team-recipes/);
  });

  /**
   * Naming a repository outside any project is refused, with the way out.
   */
  it("should refuse a named repository outside a project", async () => {
    await expect(
      findSubmitCheckout({ cwd: tmp.path, repo: "team-recipes", interactive: false, env })
    ).rejects.toThrow(/not inside a sous project/);
  });
});
