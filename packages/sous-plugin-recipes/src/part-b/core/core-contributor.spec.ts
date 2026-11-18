import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanTemp, startEngine, tempDir } from "../../../test/part-b/helpers.js";
import { CORE_RECIPE_KEY, OFFICIAL_REPO_IDENTITY, OFFICIAL_REPO_URL } from "../constants.js";

const VERSION = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../../../../sous/package.json"), "utf8")).version as string;

afterEach(() => cleanTemp());

describe("recipes.core", () => {
    it("should add the official repository and the core subscription at exactly the running version", async () => {
        const { engine } = await startEngine({ root: tempDir(), home: tempDir() });

        expect(engine.config.get("repos.sous-recipes")).toMatchObject({ url: OFFICIAL_REPO_URL, provider: "github", addedBy: "sous" });
        expect(engine.config.get("subscriptions.core")).toEqual({ range: VERSION, addedBy: "sous" });
    });

    it("should seed the store with the packaged recipe while the config is built", async () => {
        const home = tempDir();

        await startEngine({ root: tempDir(), home });

        expect(fs.existsSync(path.join(home, "cache", ...OFFICIAL_REPO_IDENTITY.split("/"), "core", "sous-skills", VERSION, "sous.recipe.yaml"))).toBe(true);

        const index = JSON.parse(fs.readFileSync(path.join(home, "cache", "_indexes", "github.com", "sous-io", "sous-recipes.json"), "utf8"));

        expect(index.recipes[CORE_RECIPE_KEY].versions[VERSION].seeded).toBe(true);
    });

    it("should drop the core subscription when the project switches the official repository off", async () => {
        const { engine } = await startEngine({ root: tempDir(), home: tempDir(), data: () => ({ repos: { "sous-recipes": { enabled: false } } }) });

        expect(engine.config.get("repos.sous-recipes")).toMatchObject({ enabled: false, url: OFFICIAL_REPO_URL });
        expect(engine.config.get("subscriptions.core")).toBeUndefined();
    });

    it("should let the project's own fields win, field by field", async () => {
        const { engine } = await startEngine({
            root: tempDir(),
            home: tempDir(),
            data: () => ({ repos: { "sous-recipes": { url: "https://github.com/acme/mirror" } }, subscriptions: { core: { enabled: false } } }),
        });

        expect(engine.config.get("repos.sous-recipes")).toMatchObject({ url: "https://github.com/acme/mirror", provider: "github", addedBy: "sous" });
        expect(engine.config.get("subscriptions.core")).toEqual({ range: VERSION, addedBy: "sous", enabled: false });
    });
});
