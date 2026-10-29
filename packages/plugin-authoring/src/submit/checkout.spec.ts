import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scriptedPrompter } from "@sous-io/plugin-api";
import type { ResolvedLink } from "@sous-io/plugin-recipes/types";
import { makeTmpDir, writeFile, type TmpDir } from "../../test/support/git-repo.js";
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

    /** Several linked repositories are a question, which names the argument that answers it (L4). */
    it("should ask between several linked repositories, and fail naming the argument without a terminal", async () => {
        const links = memoryLinks([link("a", checkout("a")), link("b", checkout("b"))]);

        await expect(findSubmitCheckout(testTools({ links }), project, undefined)).rejects.toThrow(/<repo>/);

        const found = await findSubmitCheckout(testTools({ links, prompter: scriptedPrompter(["b"]) }), project, undefined);

        expect(found).toMatchObject({ repo: "b", reason: "You chose it." });
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
