/**
 * `repo.release` end to end, against real git repositories: what one run plans, writes, commits,
 * tags and pushes, and what `--check`, `--ci` and the other flags change. Ported from the old CLI
 * integration test (src/test/integration/repo-release.test.ts), run through the handler instead of
 * a child process.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BufferedReporter, nonInteractivePrompter, scriptedPrompter, type Prompter } from "@sous-io/plugin-api";
import type { IndexFile } from "@sous-io/plugin-formats/types";
import { commitAll, git, initRepo, makeTmpDir, writeFile, type TmpDir } from "../../test/support/git-repo.js";
import { testTools } from "../../test/support/standins.js";
import type { RepoReleaseInput } from "../types.js";
import { runRelease } from "./release.js";

let tmp: TmpDir;
let repo: string;
let reporter: BufferedReporter;

beforeEach(() => {
    tmp = makeTmpDir("sous-release-run-");
    repo = path.join(tmp.path, "recipes");
    fs.mkdirSync(repo);
    initRepo(repo);
    writeFile(repo, "sous.repo.yaml", "formatVersion: 1\nname: test-repo\nnamespaces:\n  core:\n    description: Core.\nrecipes:\n  - recipes/core/example\n");
    writeRecipe("example", "0.1.0");
    commitAll(repo, "scaffold the repository");
    reporter = new BufferedReporter();
});

afterEach(() => {
    tmp.cleanup();
});

/** Writes a recipe's manifest and one file of its own. */
function writeRecipe(name: string, version: string, extra = ""): void {
    writeFile(repo, `recipes/core/${name}/sous.recipe.yaml`, `formatVersion: 1\nnamespace: core\nname: ${name}\nversion: ${version}\ndescription: The ${name} recipe.\n${extra}`);
    writeFile(repo, `recipes/core/${name}/skills/${name}.md`, `${name}\n`);
}

/** Adds a recipe folder to the repository manifest. */
function listRecipe(name: string): void {
    const manifest = path.join(repo, "sous.repo.yaml");

    fs.writeFileSync(manifest, `${fs.readFileSync(manifest, "utf8").trimEnd()}\n  - recipes/core/${name}\n`);
}

/** Runs a release in the repository. */
function release(input: RepoReleaseInput = {}, prompter: Prompter = nonInteractivePrompter) {
    return runRelease(testTools({ reporter, prompter, sousVersion: "1.2.3" }), input, { cwd: repo, now: new Date("2026-10-29T12:00:00.000Z") });
}

/** The committed index. */
function readIndex(): IndexFile {
    return JSON.parse(fs.readFileSync(path.join(repo, "sous.index.json"), "utf8")) as IndexFile;
}

/** The release tags. */
const tags = () => git(repo, "tag", "--list").split("\n").filter(Boolean);

/** Publishes the example recipe at its declared version. */
async function publishFirst(): Promise<void> {
    await release({ yes: true });
}

describe("runRelease()", () => {
    /** A dry run prints the plan and stops: no bump, no index, no commit and no tag. */
    it("should print the plan and change nothing on a dry run", async () => {
        const result = await release({ dryRun: true });

        expect(result.dryRun).toBe(true);
        expect(result.plan.map((entry) => [entry.key, entry.to, entry.bump])).toEqual([["core/example", "0.1.0", "first"]]);
        expect(result.plan[0]!.hash).toMatch(/^sha256-/);
        expect(fs.existsSync(path.join(repo, "sous.index.json"))).toBe(false);
        expect(tags()).toEqual([]);
        expect(reporter.at("notice").join("\n")).toContain("this was a dry run");
    });

    /** With nothing to ask and no --yes, nothing is published, and the error names --yes. */
    it("should refuse to publish with nothing to ask and no --yes", async () => {
        await expect(release()).rejects.toThrow(/--yes/);
        expect(tags()).toEqual([]);
    });

    /** Declining the plan writes nothing. */
    it("should write nothing when the plan is declined", async () => {
        const result = await release({}, scriptedPrompter([false]));

        expect(result.cancelled).toBe(true);
        expect(tags()).toEqual([]);
    });

    /** One run regenerates the index, commits it, and tags each version. */
    it("should regenerate, commit and tag in one run", async () => {
        const result = await release({ yes: true });

        expect(result.tagged).toEqual(["core/example@0.1.0"]);
        expect(result.indexChanged).toBe(true);
        expect(result.committed).toBe(true);
        expect(tags()).toEqual(["core/example@0.1.0"]);
        expect(git(repo, "log", "-1", "--format=%s")).toBe("Release core/example@0.1.0");
        expect(readIndex().recipes["core/example"]!.versions["0.1.0"]!.tag).toBe("core/example@0.1.0");
        expect(readIndex().generator).toBe("1.2.3");
        expect(git(repo, "status", "--porcelain")).toBe("");
    });

    /** --check passes while the committed index is current, and writes nothing. */
    it("should pass --check while the committed index is current", async () => {
        await publishFirst();

        const result = await release({ check: true });

        expect(result.indexChanged).toBe(false);
        expect(result.drift).toEqual([]);
        expect(git(repo, "status", "--porcelain")).toBe("");
    });

    /** --check reports the drift a merge will rewrite, and does not fail on it. */
    it("should pass --check and report the drift a merge will rewrite", async () => {
        await publishFirst();
        const index = readIndex();
        index.generator = "0.0.1";
        index.recipes["core/example"]!.description = "An outdated description.";
        fs.writeFileSync(path.join(repo, "sous.index.json"), `${JSON.stringify(index, null, 2)}\n`);
        commitAll(repo, "let the index fall behind");

        const result = await release({ check: true });
        const notes = reporter.at("notice").join("\n");

        expect(result.indexChanged).toBe(true);
        expect(notes).toContain("Merging rewrites the committed sous.index.json");
        expect(notes).toContain("generated by sous 0.0.1");
        expect(notes).toContain("the description of 'core/example' has changed");
    });

    /** --check lists the versions a merge publishes. */
    it("should list under --check the versions a merge publishes", async () => {
        await publishFirst();
        writeRecipe("example", "0.2.0");
        commitAll(repo, "raise the example recipe");

        const result = await release({ check: true });

        expect(result.plan.map((entry) => entry.tag)).toEqual(["core/example@0.2.0"]);
    });

    /** --check fails a change to a recipe that takes no proposals. */
    it("should fail --check on a change to a recipe that takes no proposals", async () => {
        writeRecipe("example", "0.1.0", "submissions:\n  allowed: false\n  instead: Change it upstream.\n");
        commitAll(repo, "decline proposals");
        await publishFirst();
        writeRecipe("example", "0.2.0", "submissions:\n  allowed: false\n  instead: Change it upstream.\n");
        writeFile(repo, "recipes/core/example/skills/example.md", "edited\n");
        commitAll(repo, "edit it");

        await expect(release({ check: true })).rejects.toThrow(/cannot be merged[\s\S]*1 recipe/);
        expect(reporter.at("error").join("\n")).toContain("Instead: Change it upstream.");
    });

    /** Nothing changed since the last tag: nothing is released. */
    it("should release nothing when nothing has changed", async () => {
        await publishFirst();

        const result = await release({ yes: true });

        expect(result.plan).toEqual([]);
        expect(result.skipped?.map((entry) => entry.key)).toEqual(["core/example"]);
    });

    /** A changed recipe is patch-bumped, its manifest rewritten, and the new version published. */
    it("should patch-bump a changed recipe and publish it", async () => {
        await publishFirst();
        writeFile(repo, "recipes/core/example/skills/example.md", "edited\n");
        commitAll(repo, "edit");

        const result = await release({ yes: true });

        expect(result.plan[0]).toMatchObject({ key: "core/example", from: "0.1.0", to: "0.1.1", bump: "patch", reason: "changed" });
        expect(fs.readFileSync(path.join(repo, "recipes/core/example/sous.recipe.yaml"), "utf8")).toContain("version: 0.1.1");
        expect(tags()).toContain("core/example@0.1.1");
        expect(Object.keys(readIndex().recipes["core/example"]!.versions).sort()).toEqual(["0.1.0", "0.1.1"]);
    });

    /** --bump names how far. */
    it("should raise a changed recipe by the level --bump names", async () => {
        await publishFirst();
        writeFile(repo, "recipes/core/example/skills/example.md", "edited\n");
        commitAll(repo, "edit");

        const result = await release({ yes: true, bump: "minor" });

        expect(result.tagged).toEqual(["core/example@0.2.0"]);
    });

    /** Under --ci a changed recipe whose version was never raised is an error. */
    it("should fail under --ci when a changed recipe was never bumped", async () => {
        await publishFirst();
        writeFile(repo, "recipes/core/example/skills/example.md", "edited\n");
        commitAll(repo, "edit");

        await expect(release({ ci: true })).rejects.toThrow(/cannot be released yet/);
        expect(reporter.at("error").join("\n")).toContain("Raise the version in this manifest");
    });

    /** Under --ci a version raised in the merged change is published without asking. */
    it("should publish a pending version under --ci without asking", async () => {
        await publishFirst();
        writeRecipe("example", "0.2.0");
        commitAll(repo, "raise it");

        const result = await release({ ci: true });

        expect(result.tagged).toEqual(["core/example@0.2.0"]);
        expect(result.plan[0]!.bump).toBe("none");
    });

    /** --include-unchanged releases a recipe whose files did not change. */
    it("should release an unchanged recipe with --include-unchanged", async () => {
        await publishFirst();

        const result = await release({ yes: true, includeUnchanged: true });

        expect(result.plan[0]).toMatchObject({ to: "0.1.1", reason: "included" });
    });

    /** On a branch other than the default one, the release commits but cuts no tags; --tag cuts them. */
    it("should cut no tags on a branch unless --tag says so", async () => {
        const upstream = path.join(tmp.path, "upstream.git");

        git(tmp.path, "init", "--quiet", "--bare", "--initial-branch", "main", upstream);
        git(repo, "remote", "add", "origin", upstream);
        git(repo, "push", "--quiet", "origin", "main");
        git(repo, "remote", "set-head", "origin", "main");
        git(repo, "switch", "--quiet", "-c", "work");

        const untagged = await release({ yes: true });

        expect(untagged.tagged).toEqual([]);
        expect(untagged.committed).toBe(true);
        expect(reporter.at("notice").join("\n")).toContain("No tags were cut");

        writeFile(repo, "recipes/core/example/skills/example.md", "edited\n");
        commitAll(repo, "edit");

        const tagged = await release({ yes: true, tag: true });

        expect(tagged.tagged.length).toBe(1);
    });

    /** --push pushes the branch and exactly the tags the run made. */
    it("should push the commit and the tags with --push", async () => {
        const upstream = path.join(tmp.path, "upstream.git");

        git(tmp.path, "init", "--quiet", "--bare", "--initial-branch", "main", upstream);
        git(repo, "remote", "add", "origin", upstream);

        const result = await release({ yes: true, push: true });

        expect(result.pushed).toBe(true);
        expect(git(upstream, "tag", "--list")).toBe("core/example@0.1.0");
        expect(git(upstream, "log", "-1", "--format=%s", "main")).toBe("Release core/example@0.1.0");
    });

    /** --push with no origin is a readable error, after the release was made. */
    it("should say how to push when there is no origin", async () => {
        await expect(release({ yes: true, push: true })).rejects.toThrow(/no 'origin' remote/);
        expect(tags()).toEqual(["core/example@0.1.0"]);
    });

    /** The scope narrows the run; a scope that names nothing is refused before anything runs. */
    it("should release only what the scope names, and refuse a scope that names nothing", async () => {
        writeRecipe("other", "1.0.0");
        listRecipe("other");
        commitAll(repo, "add other");

        const result = await release({ yes: true, recipe: ["core/other"] });

        expect(result.tagged).toEqual(["core/other@1.0.0"]);
        await expect(release({ recipe: ["core/nope"] })).rejects.toThrow(/cannot be released yet/);
        expect(reporter.at("error").join("\n")).toContain("publishes no recipe called 'core/nope'");
    });

    /** Tags are cut dependency-first, and the index records the version each dependency resolved to. */
    it("should tag dependency-first and record the resolved dependency", async () => {
        writeFile(repo, "sous.repo.yaml", "formatVersion: 1\nname: test-repo\nnamespaces:\n  core: {}\nrecipes:\n  - recipes/core/user\n  - recipes/core/base\n");
        writeRecipe("user", "1.0.0", "depends:\n  - core/base\n");
        writeRecipe("base", "2.0.0");
        fs.rmSync(path.join(repo, "recipes/core/example"), { recursive: true });
        commitAll(repo, "two related recipes");

        const result = await release({ yes: true });

        expect(result.tagged).toEqual(["core/base@2.0.0", "core/user@1.0.0"]);
        expect(readIndex().recipes["core/user"]!.versions["1.0.0"]!.dependencies).toEqual({
            "core/base": { version: "2.0.0", declared: "core/base", kind: "depends" },
        });
    });

    /** A sibling never published, outside the scope, stops the release. */
    it("should refuse to release a recipe whose sibling has never been published", async () => {
        writeRecipe("example", "0.1.0", "depends:\n  - core/fresh\n");
        writeRecipe("fresh", "1.0.0");
        listRecipe("fresh");
        commitAll(repo, "depend on a fresh recipe");

        await expect(release({ yes: true, recipe: ["core/example"] })).rejects.toThrow(/cannot be released yet/);
        expect(reporter.at("error").join("\n")).toContain("which has never been published");
    });

    /** Anything uncommitted stops a release before anything is written. */
    it("should refuse to release while anything is uncommitted", async () => {
        writeFile(repo, "scratch.md", "scratch\n");

        await expect(release({ yes: true })).rejects.toThrow(/uncommitted changes[\s\S]*scratch\.md/);
        expect(tags()).toEqual([]);
    });

    /** Flags that would mean two things at once are refused. */
    it("should refuse flags that disagree", async () => {
        await expect(release({ check: true, ci: true })).rejects.toThrow(/'--check' and '--ci'/);
        await expect(release({ check: true, push: true })).rejects.toThrow(/'--check' changes nothing/);
        await expect(release({ ci: true, bump: "minor" })).rejects.toThrow(/'--bump' and '--no-bump'/);
    });

    /** Outside a recipe repository the error says how to make one. */
    it("should refuse to run outside a recipe repository", async () => {
        await expect(runRelease(testTools(), {}, { cwd: tmp.path })).rejects.toThrow(/sous repo init/);
    });
});
