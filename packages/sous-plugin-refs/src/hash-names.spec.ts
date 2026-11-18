import { ConfigError, definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import { describe, expect, it } from "vitest";
import { buildRefs } from "../test/fixtures.js";
import type { HashNameContext, HashNameEntity } from "./types.js";

/** A plugin adding one `hash-name` entity. */
function namePlugin(entry: Record<string, unknown>): PluginDefinition {
    return definePlugin({ name: "test-names", version: "1.0.0", register: (sous) => sous.entities.add("hash-name", entry as unknown as HashNameEntity) });
}

const project = { root: "/p", sousDir: "/p/.sous", configPath: undefined, confDir: "/p/.sous/conf.d" };

describe("the #project name", () => {
    /**
     * `#project` stands for the project root, the directory holding `.sous/`, and for nothing outside a project.
     *
     * bases(ctx with project root "/p") // -> ["/p"]
     */
    it("should stand for the project root, and nothing outside a project", async () => {
        const inside = await buildRefs({ project });
        const name = inside.ctx.entities.get("hash-name", "project")!;

        expect(name.description).toBe("the root directory of the project being built.");
        expect(name.bases?.({ ...inside.ctx, scope: {} } as HashNameContext)).toEqual(["/p"]);

        const outside = await buildRefs();

        expect(outside.ctx.entities.get("hash-name", "project")!.bases?.({ ...outside.ctx, scope: {} } as HashNameContext)).toEqual([]);
    });
});

describe("hash-name entities", () => {
    /**
     * A plugin adds a name, a view among them, beside `#project`.
     *
     * entities.list("hash-name") // -> project, memories
     */
    it("should list a name a plugin adds", async () => {
        const refs = await buildRefs({
            plugins: [namePlugin({ id: "memories", description: "every recipe's memories.", view: () => [{ path: "a.md", file: "/x/a.md" }] })],
        });
        const names = refs.ctx.entities.list("hash-name");

        expect(names.map((entry) => entry.id)).toEqual(["project", "memories"]);
        expect(names[1]!.view?.({ ...refs.ctx, scope: {} })).toEqual([{ path: "a.md", file: "/x/a.md" }]);
    });

    /**
     * A name that is not lowercase kebab case, or that both stands for directories and lists files, is refused.
     *
     * add("hash-name", { id: "Bad Name" }) // build fails, naming the entity
     */
    it("should refuse an invalid name and one that is both bases and a view", async () => {
        const bad = (await buildRefs({ plugins: [namePlugin({ id: "Bad Name", description: "x", bases: () => [] })] }).catch((error: unknown) => error)) as ConfigError;

        expect(bad).toBeInstanceOf(ConfigError);
        expect(bad.details.join("\n")).toContain("The name '#Bad Name' is invalid");

        const both = (await buildRefs({ plugins: [namePlugin({ id: "both", description: "x", bases: () => [], view: () => [] })] }).catch((error: unknown) => error)) as ConfigError;

        expect(both.details.join("\n")).toContain("either stands for directories ('bases') or lists files ('view')");

        const bare = (await buildRefs({ plugins: [namePlugin({ id: "bare" })] }).catch((error: unknown) => error)) as ConfigError;

        expect(bare.details.join("\n")).toContain("description: Required, but missing.");
    });
});
