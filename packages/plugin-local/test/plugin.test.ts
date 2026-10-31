import { describe, expect, it } from "vitest";
import { createEngine } from "@sous-io/core";
import { standInPlugins } from "@sous-io/repository-hosts/testing";
import { localPlugin } from "../src/index.js";

describe("plugin-local in an engine", () => {
    /**
     * Loaded into an engine, the plugin adds the `local` repository-host entity.
     *
     * config.entities.get("repository-host", "local").matches("/home/me/recipes") // -> true
     */
    it("should add the local repository-host entity", async () => {
        const engine = createEngine({ builtIns: [...standInPlugins(), localPlugin] });
        const host = (await engine.buildConfig()).entities.get("repository-host", "local");

        expect(host?.features).toEqual(["fetch"]);
        expect(host?.matches("/home/me/recipes")).toBe(true);
        expect(host?.readStrategies.map((strategy) => strategy.id)).toEqual(["file", "git"]);
    });
});
