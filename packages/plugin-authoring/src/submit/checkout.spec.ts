import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scriptedPrompter } from "@sous-io/plugin-api";
import type { ResolvedLink } from "@sous-io/plugin-recipes/types";
import { git, initRepo, makeTmpDir, writeFile, type TmpDir } from "../../test/support/git-repo.js";
import { memoryLinks, testTools } from "../../test/support/standins.js";
import { findSubmitCheckout } from "./checkout.js";

let tmp: TmpDir;
let project: string;

beforeEach(() => {
    tmp = makeTmpDir("sous-submit-checkout-");
    project = path.join(tmp.path, "project");
    fs.mkdirSync(project);
});

afterEach(() => {
    tmp.cleanup();
});

/** A recipe repository checkout. */
function checkout(name: string): string {
    const root = path.join(tmp.path, name);

    writeFile(root, "sous.repo.yaml", `formatVersion: 1\nname: ${name}\nnamespaces: {}\nrecipes: []\n`);

    return root;
}

/** A project link to a checkout. */
function link(repo: string, target: string): ResolvedLink {
    return { repo, path: target, origin: "clone", linkedAt: "now", scope: "project" };
}

describe("findSubmitCheckout()", () => {
    /** Inside a recipe repository with no argument, that repository. */
    it("should use the recipe repository the working directory is in", async () => {
        const root = checkout("recipes");
        const found = await findSubmitCheckout(testTools(), path.join(root, "sub"), undefined);

        expect(found).toEqual({ rootDir: root, reason: "The working directory is inside it." });
    });

    /** Inside a project, a named repository is proposed from the checkout it is linked to. */
    it("should use the checkout a named repository is linked to", async () => {
        const root = checkout("recipes");
        const found = await findSubmitCheckout(testTools({ links: memoryLinks([link("sous-recipes", root)]) }), project, "sous-recipes");

        expect(found).toMatchObject({ rootDir: root, repo: "sous-recipes" });
    });

    /** With no argument, the only linked repository. */
    it("should use the only linked repository when none is named", async () => {
        const root = checkout("recipes");
        const found = await findSubmitCheckout(testTools({ links: memoryLinks([link("sous-recipes", root)]) }), project, undefined);

        expect(found.reason).toBe("It is the only repository this project links.");
    });

    /** Several linked repositories are a question, which names the argument that answers it. */
    it("should ask between several linked repositories, and fail naming the argument without a terminal", async () => {
        const links = memoryLinks([link("a", checkout("a")), link("b", checkout("b"))]);

        await expect(findSubmitCheckout(testTools({ links }), project, undefined)).rejects.toThrow(/<repo>/);

        const found = await findSubmitCheckout(testTools({ links, prompter: scriptedPrompter(["b"]) }), project, undefined);

        expect(found).toMatchObject({ repo: "b", reason: "You chose it." });
    });

    /**
     * A repository no longer linked, whose checkout `sous repo link` cloned is still where it clones
     * them, is proposed from that checkout, with a note saying why.
     */
    it("should use the checkout sous cloned earlier when the repository is no longer linked", async () => {
        const clones = path.join(tmp.path, "clones");
        const root = path.join(clones, "acme", "recipes");

        writeFile(root, "sous.repo.yaml", "formatVersion: 1\nname: recipes\nnamespaces: {}\nrecipes: []\n");
        initRepo(root);
        git(root, "remote", "add", "origin", "git@github.com:acme/recipes.git");

        const url = "https://github.com/acme/recipes";
        const known = [
            {
                kind: "repo" as const,
                name: "team-recipes",
                location: { provider: "github", host: "github.com", repoPath: "acme/recipes", identity: "github.com/acme/recipes", url },
            },
        ];
        const tools = testTools({ links: memoryLinks(), known: known as never, cloneDirectories: [clones] });
        const found = await findSubmitCheckout(tools, project, "team-recipes");

        expect(found).toEqual({ rootDir: root, repo: "team-recipes", reason: "Sous cloned 'team-recipes' into this checkout earlier." });
    });

    /** A link whose checkout is gone has no working copy to propose from. */
    it("should fail when there is no working copy to propose from", async () => {
        const links = memoryLinks([link("gone", path.join(tmp.path, "gone"))]);

        await expect(findSubmitCheckout(testTools({ links }), project, "gone")).rejects.toThrow(/no working copy of 'gone'[\s\S]*does not exist/);
    });

    /** A repository the project does not use is refused, naming what it links. */
    it("should refuse a repository the project does not use", async () => {
        const links = memoryLinks([link("sous-recipes", checkout("recipes"))]);

        await expect(findSubmitCheckout(testTools({ links }), project, "nope")).rejects.toMatchObject({
            details: [expect.stringContaining("This project links: sous-recipes")],
        });
    });

    /** A named repository outside a project is refused. */
    it("should refuse a named repository outside a project", async () => {
        await expect(findSubmitCheckout(testTools(), project, "sous-recipes")).rejects.toThrow(/not inside a sous project/);
    });
});
