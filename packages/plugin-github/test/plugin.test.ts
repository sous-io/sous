import { describe, expect, it } from "vitest";
import { createEngine } from "@sous-io/core";
import { standInPlugins } from "@sous-io/repository-hosts/testing";
import { githubPlugin } from "../src/index.js";

describe("plugin-github in an engine", () => {
    /**
     * Loaded into an engine, the plugin adds the `github` repository-host entity, and the hosts its
     * options name are GitHub's too.
     *
     * plugins.options."@sous-io/plugin-github" = { hosts: ["ghe.example.com"] }
     * // config.entities.get("repository-host", "github").matches("https://ghe.example.com/a/b") -> true
     */
    it("should add the github repository-host entity, with the hosts its options name", async () => {
        const engine = createEngine({ builtIns: [...standInPlugins({ "@sous-io/plugin-github": { hosts: ["ghe.example.com"] } }), githubPlugin] });
        const config = await engine.buildConfig();
        const host = config.entities.get("repository-host", "github");

        expect(host?.features).toEqual(["fetch", "submit", "proposals"]);
        expect(host?.matches("https://ghe.example.com/a/b")).toBe(true);
        expect(host?.matches("https://github.com/a/b")).toBe(true);
        expect(host?.readStrategies.map((strategy) => strategy.id)).toEqual(["http-token", "http", "git"]);
        expect(config.entities.describe("repository-host")[0]?.plugin).toBe("@sous-io/plugin-github");
    });

    /**
     * Without options, only github.com matches.
     *
     * // no options -> matches("https://ghe.example.com/a/b") -> false
     */
    it("should work without options", async () => {
        const engine = createEngine({ builtIns: [...standInPlugins(), githubPlugin] });
        const host = (await engine.buildConfig()).entities.get("repository-host", "github");

        expect(host?.matches("https://ghe.example.com/a/b")).toBe(false);
        expect(host?.matches("https://github.com/a/b")).toBe(true);
    });
});
