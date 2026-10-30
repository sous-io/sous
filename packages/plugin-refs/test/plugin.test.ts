/**
 * What plugin-refs registers: its services, its entity kinds, the built-in splitters, pruners and
 * `#project`, and how it stands with nothing above it loaded.
 */

import { ConfigError, definePlugin } from "@sous-io/plugin-api";
import { describe, expect, it } from "vitest";
import { buildRefs } from "./fixtures.js";

describe("plugin-refs", () => {
    /**
     * Every service the contract names is provided, and every entity kind defined.
     *
     * services.has("refs.resolver") // -> true
     */
    it("should provide its services and define its entity kinds", async () => {
        const { ctx } = await buildRefs();

        for (const name of ["refs.parser", "refs.resolver", "refs.picker", "refs.format", "refs.locations"]) {
            expect(ctx.services.has(name), name).toBe(true);
        }

        expect(ctx.entities.kinds()).toEqual(expect.arrayContaining(["ref-splitter", "ref-pruner", "ref-lookup", "hash-name"]));
    });

    /**
     * The built-in splitters run in the documented order, and a pruner exists for each built-in place.
     *
     * entities.list("ref-splitter") // -> query 10, range 20, location 30, qualifier 40, env var 50, name/path 60
     */
    it("should add the built-in splitters, pruners and #project", async () => {
        const { ctx } = await buildRefs();

        expect(ctx.entities.list("ref-splitter").map((entry) => `${entry.id} ${entry.order}`)).toEqual([
            "query 10",
            "range 20",
            "location 30",
            "repo-qualifier 40",
            "env-var 50",
            "name-path 60",
        ]);
        expect(ctx.entities.list("ref-pruner").map((entry) => entry.source)).toEqual(["commandLine", "config", "manifest", "lockfile", "include"]);
        expect(ctx.entities.list("hash-name").map((entry) => entry.id)).toEqual(["project"]);
    });

    /**
     * Hosts are read from `repository-host` entities, so with no host plugin loaded short refs still
     * work and locations are refused with a reason (an entity read needs no dependency).
     *
     * parse("workflow/alpha") with no hosts // -> the recipe
     */
    it("should work with no host plugin loaded", async () => {
        const refs = await buildRefs({ hosts: [] });

        expect(refs.resolver.parse("workflow/alpha").refs.map((ref) => ref.kind)).toEqual(["recipe"]);
        expect(() => refs.resolver.parse("https://github.com/o/r/w")).toThrow(/does not recognize the host 'github.com'/);
        expect(refs.locations.hosts()).toEqual([]);
        expect(refs.locations.fromUrl("https://github.com/o/r")).toBeUndefined();
    });

    /**
     * A splitter entity missing its method is refused when the config is built.
     *
     * add("ref-splitter", { id: "x", order: 1 }) // build fails
     */
    it("should check entities against their kind", async () => {
        const broken = definePlugin({
            name: "test-broken",
            version: "1.0.0",
            register: (sous) => sous.entities.add("ref-splitter", { id: "x", order: 1 } as never),
        });
        const error = (await buildRefs({ plugins: [broken] }).catch((caught: unknown) => caught)) as ConfigError;

        expect(error).toBeInstanceOf(ConfigError);
        expect(error.message).toContain('"ref-splitter" entity "x" that does not match its schema');
    });

    /**
     * A plugin may replace a service, and the others then use the replacement.
     *
     * replace("refs.locations") // -> the resolver's location splitter reads the replacement
     */
    it("should let the other services use a replaced refs.locations", async () => {
        const seen: string[] = [];
        const replacing = definePlugin({
            name: "test-replace",
            version: "1.0.0",
            register: (sous) =>
                sous.services.wrap("refs.locations", (inner) => ({
                    ...inner,
                    hosts: () => {
                        seen.push("hosts");

                        return inner.hosts();
                    },
                })),
        });
        const refs = await buildRefs({ plugins: [replacing] });

        refs.resolver.parse("github://o/r/w");
        expect(seen.length).toBeGreaterThan(0);
    });
});
