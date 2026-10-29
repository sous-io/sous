/**
 * A release against the real plugins authoring depends on (host, git, refs, formats, variables),
 * with only plugin-recipes stood in: the stand-ins in `support/` must not hide a difference from the
 * real owners.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine } from "@sous-io/core";
import { BufferedReporter, definePlugin } from "@sous-io/plugin-api";
import type { IndexFile } from "@sous-io/plugin-formats/types";
import formatsPlugin from "@sous-io/plugin-formats";
import gitPlugin from "@sous-io/plugin-git";
import hostPlugin from "@sous-io/plugin-host";
import refsPlugin from "@sous-io/plugin-refs";
import variablesPlugin from "@sous-io/plugin-variables";
import { authoringPlugin } from "../src/index.js";
import { commitAll, git, initRepo, makeTmpDir, writeFile, type TmpDir } from "./support/git-repo.js";

let tmp: TmpDir;
let repo: string;

beforeEach(() => {
    tmp = makeTmpDir("sous-authoring-real-");
    repo = tmp.path;
    initRepo(repo);
});

afterEach(() => {
    tmp.cleanup();
});

/** plugin-recipes, stood in: it only defines the `repository-host` kind here. */
const recipesStandIn = definePlugin({
    name: "@sous-io/plugin-recipes",
    version: "0.2.34",
    register(sous) {
        if (!sous.entities.kinds().includes("repository-host")) {
            sous.entities.define("repository-host", { "~standard": { version: 1, vendor: "test", validate: (value: unknown) => ({ value }) } });
        }
    },
});

describe("plugin-authoring with the real plugins", () => {
    /** Validation, the plan, the bump, the dependency-first tags and the resolved index, end to end. */
    it("should release a repository with a sibling dependency", async () => {
        writeFile(repo, "sous.repo.yaml", "formatVersion: 1\nname: test-repo\nnamespaces:\n  core: {}\nrecipes:\n  - recipes/core/user\n  - recipes/core/base\n");
        writeFile(repo, "recipes/core/user/sous.recipe.yaml", "formatVersion: 1\nnamespace: core\nname: user\nversion: 1.0.0\ndepends:\n  - core/base@^2\n");
        writeFile(repo, "recipes/core/user/skills/user.md", "user\n");
        writeFile(repo, "recipes/core/base/sous.recipe.yaml", "formatVersion: 1\nnamespace: core\nname: base\nversion: 2.0.0\n");
        writeFile(repo, "recipes/core/base/skills/base.md", "base\n");
        commitAll(repo, "two recipes");

        const engine = createEngine({
            builtIns: [hostPlugin, gitPlugin, refsPlugin, formatsPlugin, variablesPlugin, recipesStandIn, authoringPlugin],
            reporter: new BufferedReporter(),
            env: { HOME: tmp.path, SOUS_HOME: path.join(tmp.path, ".sous-home"), PATH: process.env.PATH },
            app: { name: "sous", version: "1.0.0-test" },
        });

        await engine.buildConfig();

        const first = await engine.handle.submit({ intent: "repo.release", input: { directory: repo, yes: true } });

        expect(first.tagged).toEqual(["core/base@2.0.0", "core/user@1.0.0"]);

        const index = JSON.parse(fs.readFileSync(path.join(repo, "sous.index.json"), "utf8")) as IndexFile;

        expect(index.recipes["core/user"]!.versions["1.0.0"]!.dependencies).toEqual({
            "core/base": { version: "2.0.0", declared: "core/base@^2", kind: "depends" },
        });

        writeFile(repo, "recipes/core/base/skills/base.md", "edited\n");
        commitAll(repo, "edit base");

        const second = await engine.handle.submit({ intent: "repo.release", input: { directory: repo, yes: true, bump: "minor" } });

        expect(second.tagged).toEqual(["core/base@2.1.0"]);
        expect(git(repo, "status", "--porcelain")).toBe("");

        const check = await engine.handle.submit({ intent: "repo.release", input: { directory: repo, check: true } });

        expect(check.indexChanged).toBe(false);
    });
});
