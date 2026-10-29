import { BufferedReporter, isSousErrorOfKind, nonInteractivePrompter, scriptedPrompter } from "@sous-io/plugin-api";
import { describe, expect, it } from "vitest";
import { builtConfig, memoryManaged, serviceReader } from "../../test/part-a/helpers.js";
import type { MissingRepo } from "../types.js";
import { Trust } from "./trust.js";

const locations = {
    identity: (url: string) => {
        const match = /^https:\/\/([^/]+)\/(.+?)(\.git)?$/.exec(url);

        if (!match) {
            throw new Error(`no host reads ${url}`);
        }

        return `${match[1]}/${match[2]}`.toLowerCase();
    },
};

function setup() {
    const managed = memoryManaged();
    const services = serviceReader({ "confd.managed": managed, "refs.locations": locations });
    const config = builtConfig({
        repos: {
            "sous-recipes": { url: "https://github.com/sous-io/sous-recipes", addedBy: "sous" },
            acme: { url: "https://github.com/Acme/Recipes" },
            off: { url: "https://github.com/x/off", enabled: false },
        },
    });

    return { trust: new Trust(config, services), managed };
}

const missing: MissingRepo = { name: "extra", url: "https://github.com/x/extra", requiredBy: [{ ref: "extra:a/b", requestedBy: "workflow/a" }] };

describe("recipes.trust", () => {
    /** Trusted means in the merged `repos` map and not switched off. */
    it("should list trusted repositories", () => {
        expect(Object.keys(setup().trust.trusted())).toEqual(["sous-recipes", "acme"]);
    });

    /** A repository is found by short name, URL or identity, ignoring case. */
    it("should find a repository by name, URL or identity", () => {
        const { trust } = setup();

        expect(trust.nameOf("acme")).toBe("acme");
        expect(trust.nameOf("https://github.com/acme/recipes.git")).toBe("acme");
        expect(trust.nameOf("github.com/acme/recipes")).toBe("acme");
        expect(trust.isTrusted("off")).toBe(false);
        expect(trust.isTrusted("https://github.com/x/off")).toBe(false);
    });

    /** With `--yes`, nothing is asked and each repository is written to conf.d/500, naming who needed it. */
    it("should trust without asking when told to", async () => {
        const { trust, managed } = setup();
        const result = await trust.confirm([missing], { yes: true }, { prompter: nonInteractivePrompter, reporter: new BufferedReporter() });

        expect(result.added).toEqual(["extra"]);
        expect(managed.files["500-repos.jsonc"]).toMatchObject({ repos: { extra: { url: missing.url, addedBy: "workflow/a" } } });
    });

    /** A run that cannot ask fails naming --yes and the command that trusts each repository (L4). */
    it("should fail naming --yes when it cannot ask", async () => {
        const { trust } = setup();
        const failure = trust.confirm([missing], {}, { prompter: nonInteractivePrompter, reporter: new BufferedReporter() });

        await expect(failure).rejects.toSatisfy((error: unknown) => isSousErrorOfKind(error, "non-interactive"));
        await expect(failure).rejects.toMatchObject({ answeredBy: "--yes", details: expect.arrayContaining(["  sous repo add https://github.com/x/extra --name extra --yes"]) });
    });

    /** One question for the round; declining installs nothing. */
    it("should ask once and stop when declined", async () => {
        const { trust, managed } = setup();
        const prompter = scriptedPrompter([false]);
        const reporter = new BufferedReporter();

        await expect(trust.confirm([missing, { ...missing, name: "more" }], {}, { prompter, reporter })).rejects.toThrow(/trust was declined for 'extra', 'more'/);
        expect(prompter.asked).toEqual(["Do you trust these 2 repositories?"]);
        expect(reporter.at("notice").join("\n")).toMatch(/every namespace and every recipe/);
        expect(managed.files["500-repos.jsonc"]).toBeUndefined();
    });

    /** A repository named by short name only has no URL to trust; it is returned for the caller to explain. */
    it("should return repositories with no URL", async () => {
        const { trust } = setup();
        const result = await trust.confirm([{ name: "nameonly", requiredBy: [] }], { yes: true }, { prompter: nonInteractivePrompter, reporter: new BufferedReporter() });

        expect(result).toMatchObject({ added: [], needUrl: ["nameonly"] });
    });

    /** A dry run asks nothing and writes nothing. */
    it("should write nothing on a dry run", async () => {
        const { trust, managed } = setup();

        await trust.confirm([missing], { dryRun: true }, { prompter: nonInteractivePrompter, reporter: new BufferedReporter() });
        expect(managed.files["500-repos.jsonc"]).toBeUndefined();
    });
});
