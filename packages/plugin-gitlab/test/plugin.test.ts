import { describe, expect, it } from "vitest";
import { createEngine } from "@sous-io/core";
import { standInPlugins } from "@sous-io/repository-hosts/testing";
import { gitlabPlugin } from "../src/index.js";

describe("plugin-gitlab in an engine", () => {
    /**
     * Loaded into an engine, the plugin adds the `gitlab` repository-host entity, and the hosts its
     * options name are GitLab's too.
     *
     * plugins.options."@sous-io/plugin-gitlab" = { hosts: ["git.example.com"] }
     * // config.entities.get("repository-host", "gitlab").matches("https://git.example.com/a/b") -> true
     */
    it("should add the gitlab repository-host entity, with the hosts its options name", async () => {
        const engine = createEngine({ builtIns: [...standInPlugins({ "@sous-io/plugin-gitlab": { hosts: ["git.example.com"] } }), gitlabPlugin] });
        const config = await engine.buildConfig();
        const host = config.entities.get("repository-host", "gitlab");

        expect(host?.features).toEqual(["fetch", "submit", "proposals"]);
        expect(host?.matches("https://git.example.com/a/b")).toBe(true);
        expect(host?.matches("https://gitlab.com/a/b")).toBe(true);
        expect(host?.readStrategies.map((strategy) => strategy.id)).toEqual(["http-token", "http", "git"]);
        expect(config.entities.describe("repository-host")[0]?.plugin).toBe("@sous-io/plugin-gitlab");
    });

    /**
     * Without options, only gitlab.com and `gitlab.` hosts match.
     *
     * // no options -> matches("https://git.example.com/a/b") -> false
     */
    it("should work without options", async () => {
        const engine = createEngine({ builtIns: [...standInPlugins(), gitlabPlugin] });
        const host = (await engine.buildConfig()).entities.get("repository-host", "gitlab");

        expect(host?.matches("https://git.example.com/a/b")).toBe(false);
        expect(host?.matches("https://gitlab.example.com/a/b")).toBe(true);
    });
});
