import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Liquid, type FS } from "liquidjs";
import { ConfigError, NotFoundError, PluginError } from "@sous-io/plugin-api";
import { engines, plugin, projectAt } from "./helpers.js";
import type { LiquidExtensionContext, LiquidFilterEntity, LiquidTagEntity } from "../src/types.js";

/** A `bulletList` stand-in, the way plugin-compiler adds it. */
const bulletList: LiquidFilterEntity = {
    id: "bulletList",
    filter: () => (items: unknown) => (Array.isArray(items) ? items.map((item) => `- ${String(item)}`).join("\n") : String(items)),
};

/**
 * A `showVars` stand-in: dumps the whole scope, hiding every name the engine was told is secret
 * (the gh-179 fix, which now reads the names from the tag's context).
 */
const showVars: LiquidTagEntity = {
    id: "showVars",
    tag: (ctx) => ({
        render(context: { getAll(): object }) {
            const scope = context.getAll() as Record<string, unknown>;
            const shown = Object.fromEntries(
                Object.entries(scope).map(([name, value]) => [name, ctx.secretNames.has(name) ? "(hidden)" : value]),
            );

            return JSON.stringify(shown);
        },
    }),
};

/** A plugin adding tags and filters. */
function extensions(tags: LiquidTagEntity[], filters: LiquidFilterEntity[] = [], name = "sous-plugin-extras") {
    return plugin(name, (sous) => {
        for (const tag of tags) sous.entities.add("liquid-tag", tag);
        for (const filter of filters) sous.entities.add("liquid-filter", filter);
    });
}

describe("liquid.engine create() (ported from init-liquid-engine.spec.ts)", () => {
    /** create() gives a LiquidJS engine. */
    it("should return a Liquid instance", async () => {
        const liquid = (await engines()).create();

        expect(liquid).toBeInstanceOf(Liquid);
    });

    /** The roots partials are looked up in pass through to the engine. */
    it("should set engine.options.root to the provided paths", async () => {
        const liquid = (await engines()).create({ root: ["/tmp/a", "/tmp/b"] });

        expect(liquid.options.root).toEqual(["/tmp/a", "/tmp/b"]);
    });

    /** With no roots, partials are looked up in the project root. */
    it("should default the roots to the project root", async () => {
        const liquid = (await engines([], { project: projectAt("/home/luke/code/acme") })).create();

        expect(liquid.options.root).toEqual(["/home/luke/code/acme"]);
    });

    /** A filter entity is registered, so `{{ items | bulletList }}` renders bullets. */
    it("should register a filter entity that converts an array to bullet lines", async () => {
        const liquid = (await engines([extensions([], [bulletList])])).create();

        expect(await liquid.parseAndRender("{{ items | bulletList }}", { items: ["x", "y"] })).toBe("- x\n- y");
    });

    /** A tag entity is registered, so `{% showVars %}` dumps the scope. */
    it("should register a tag entity that dumps the scope", async () => {
        const liquid = (await engines([extensions([showVars])])).create();

        expect(await liquid.parseAndRender("{% showVars %}", { name: "sous" })).toBe('{"name":"sous"}');
    });

    /** An empty roots list still gives a working engine. */
    it("should not throw when roots is an empty array", async () => {
        const liquid = (await engines()).create({ root: [] });

        expect(await liquid.parseAndRender("{{ val }}", { val: "ok" })).toBe("ok");
    });

    /** Today's settings hold: unknown variables and filters render as nothing, not an error. */
    it("should be lenient with unknown variables and filters, like today's engine", async () => {
        const liquid = (await engines()).create();

        expect(await liquid.parseAndRender("[{{ missing }}][{{ 'a' | nope }}]")).toBe("[][a]");
    });
});

describe("secret names (gh-179)", () => {
    /** Names handed over are hidden by a scope-dumping tag, and are not in the template scope. */
    it("should hand the secret names to tags, outside the template scope", async () => {
        const liquid = (await engines([extensions([showVars])])).create({ secretNames: ["apiToken"] });
        const out = await liquid.parseAndRender("{% showVars %}", { apiToken: "ghp_x", name: "sous" });

        expect(JSON.parse(out)).toEqual({ apiToken: "(hidden)", name: "sous" });
    });

    /** A template that names a secret on purpose still renders it. */
    it("should still render a secret the template names explicitly", async () => {
        const liquid = (await engines([extensions([showVars])])).create({ secretNames: ["apiToken"] });

        expect(await liquid.parseAndRender("{{ apiToken }}", { apiToken: "ghp_x" })).toBe("ghp_x");
    });

    /** With no names given, the names `variables.secrets` declares are used. */
    it("should default to the names variables.secrets declares", async () => {
        const variables = plugin("@sous-io/plugin-variables", (sous) => {
            sous.services.add("variables.secrets", () => ({ declared: () => new Set(["password"]) }) as never);
        });
        const liquid = (await engines([variables, extensions([showVars])])).create();
        const out = await liquid.parseAndRender("{% showVars %}", { password: "hunter2", user: "luke" });

        expect(JSON.parse(out)).toEqual({ password: "(hidden)", user: "luke" });
    });

    /** Without plugin-variables and no names, nothing is declared secret. */
    it("should declare nothing secret without plugin-variables", async () => {
        let seen: ReadonlySet<string> | undefined;
        const spy: LiquidTagEntity = { id: "spy", tag: (ctx) => ((seen = ctx.secretNames), { render: () => "" }) };

        (await engines([extensions([spy])])).create();

        expect([...(seen ?? ["unset"])]).toEqual([]);
    });
});

describe("purposes", () => {
    const plainTag: LiquidTagEntity = { id: "plain", tag: () => ({ render: () => "plain" }) };
    const exprTag: LiquidTagEntity = { id: "exprOnly", purposes: ["config-expression"], tag: () => ({ render: () => "expr" }) };
    const upper: LiquidFilterEntity = { id: "upper2", filter: () => (value: unknown) => String(value).toUpperCase() };
    const docsFilter: LiquidFilterEntity = { id: "docsOnly", purposes: ["docs"], filter: () => () => "docs" };

    /** Tags skip config expressions unless they ask for them; filters go everywhere by default. */
    it("should register tags and filters by purpose", async () => {
        const service = await engines([extensions([plainTag, exprTag], [upper, docsFilter])]);

        expect(service.available()).toEqual({ tags: ["plain"], filters: ["upper2"] });
        expect(service.available("config-expression")).toEqual({ tags: ["exprOnly"], filters: ["upper2"] });
        expect(service.available("docs")).toEqual({ tags: ["plain"], filters: ["upper2", "docsOnly"] });

        const expr = service.create({ purpose: "config-expression" });

        expect(await expr.parseAndRender("{{ 'a' | upper2 }}{% exprOnly %}")).toBe("Aexpr");
        await expect(expr.parseAndRender("{% plain %}")).rejects.toThrow(/plain/);
    });

    /** The context tells each factory the purpose, and hands over the caller's data. */
    it("should give factories the purpose, the data and the project", async () => {
        let seen: LiquidExtensionContext | undefined;
        const spy: LiquidTagEntity = { id: "spy", purposes: ["docs"], tag: (ctx) => ((seen = ctx), { render: () => "" }) };
        const project = projectAt("/p");

        (await engines([extensions([spy])], { project })).create({ purpose: "docs", data: { fromFile: "/p/a.md" } });

        expect(seen?.purpose).toBe("docs");
        expect(seen?.data).toEqual({ fromFile: "/p/a.md" });
        expect(seen?.project).toEqual(project);
        expect(Object.isFrozen(seen)).toBe(true);
    });
});

describe("only", () => {
    const a: LiquidTagEntity = { id: "a", tag: () => ({ render: () => "A" }) };
    const b: LiquidTagEntity = { id: "b", purposes: ["other"], tag: () => ({ render: () => "B" }) };

    /** `only` registers just the named ones, whatever their purposes. */
    it("should register only the named tags and filters", async () => {
        const liquid = (await engines([extensions([a, b], [bulletList])])).create({ only: { tags: ["b"], filters: [] } });

        expect(await liquid.parseAndRender("{% b %}")).toBe("B");
        await expect(liquid.parseAndRender("{% a %}")).rejects.toThrow();
        expect(await liquid.parseAndRender("{{ x | bulletList }}", { x: [1] })).toBe("1");
    });

    /** Naming one that no plugin adds is an error naming it. */
    it("should refuse an unknown name", async () => {
        const service = await engines([extensions([a])]);

        expect(() => service.create({ only: { tags: ["nope"] } })).toThrow(NotFoundError);
        expect(() => service.create({ only: { tags: ["nope"] } })).toThrow('No plugin provides the Liquid tag "nope".');
    });
});

describe("engine options", () => {
    /** `{% render %}` reads through the file system handed over (the compiler's include resolution). */
    it("should read partials through the given file system", async () => {
        const fs: FS = {
            resolve: (_dir, file) => `/virtual/${file}`,
            exists: async () => true,
            existsSync: () => true,
            readFile: async (file) => `from ${file}`,
            readFileSync: (file) => `from ${file}`,
            dirname: (file) => path.dirname(file),
            sep: "/",
        };
        const liquid = (await engines()).create({ fs, root: ["/virtual"] });

        expect(await liquid.parseAndRender('{% render "@docs/x.md" %}')).toBe("from /virtual/@docs/x.md");
    });

    /** Partials resolve against the roots with no extension added. */
    it("should render a partial from the roots without adding an extension", async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "plugin-liquid-"));

        writeFileSync(path.join(dir, "part.md"), "hello {{ who }}");

        const liquid = (await engines()).create({ root: [dir] });

        expect(await liquid.parseAndRender('{% render "part.md", who: "sous" %}')).toBe("hello sous");
    });

    /** Any other LiquidJS option passes through and overrides the defaults. */
    it("should pass other LiquidJS options through", async () => {
        const liquid = (await engines()).create({ liquid: { strictFilters: true } });

        await expect(liquid.parseAndRender("{{ 'a' | nope }}")).rejects.toThrow(/nope/);
    });

    /** Each engine is separate: registering on one does not change the next. */
    it("should build a separate engine each time", async () => {
        const service = await engines();
        const first = service.create();

        first.registerFilter("only1", () => "x");

        expect(await service.create().parseAndRender("{{ 'a' | only1 }}")).toBe("a");
    });
});

describe("entity kinds", () => {
    /** An entry whose factory is not a function stops the build, naming it. */
    it("should refuse a tag without a factory function", async () => {
        const bad = plugin("sous-plugin-bad", (sous) => sous.entities.add("liquid-tag", { id: "broken", tag: "nope" } as never));

        await expect(engines([bad])).rejects.toThrow(ConfigError);
    });

    /** A factory that throws is reported with the plugin that added it. */
    it("should name the plugin whose factory throws", async () => {
        const throwing: LiquidFilterEntity = {
            id: "boom",
            filter: () => {
                throw new Error("no luck");
            },
        };
        const service = await engines([extensions([], [throwing], "sous-plugin-boom")]);
        const error = (() => {
            try {
                service.create();
            } catch (caught) {
                return caught as PluginError;
            }
        })();

        expect(error).toBeInstanceOf(PluginError);
        expect(error?.plugin).toBe("sous-plugin-boom");
        expect(error?.message).toBe('The Liquid filter "boom" from sous-plugin-boom could not be made.');
        expect(error?.details).toEqual(["no luck"]);
    });

    /** Tags and filters from several plugins all reach one engine. */
    it("should gather tags and filters from every plugin", async () => {
        const one = extensions([showVars], [], "sous-plugin-one");
        const two = extensions([], [bulletList], "sous-plugin-two");
        const service = await engines([one, two]);

        expect(service.available()).toEqual({ tags: ["showVars"], filters: ["bulletList"] });
    });
});
