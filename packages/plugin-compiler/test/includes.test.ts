/**
 * Include resolution through the real compile path, ported from today's integration tests
 * `include-globs`, `alias-includes`, `alias-render`, `namespace-includes` and `get-files-tag`.
 * Aliases are `_aliases` (or, for a `#name`, a `hash-name` entity), the include scope is `_vars`,
 * and the namespace resolver is the `compiler.namespace-resolver` service.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HashNameEntity } from "@sous-io/plugin-refs/types";
import type { NamespaceResolver } from "../src/types.js";
import { makeCompiler, makeProject, type TestProject } from "./helpers.js";
import { StaticNamespaceResolver } from "./namespace-resolver.js";

let project: TestProject;

afterEach(() => {
    project?.remove();
});

const write = (rel: string, content: string) => project.write(rel, content);
const at = (rel: string) => project.at(rel);

/** Compiles one entry to `out/OUT.md`; returns whether it passed, the output and every message. */
async function compileEntry(
    entry: string,
    options: { resolver?: NamespaceResolver; aliases?: Record<string, string[]>; includeScope?: Record<string, string>; vars?: Record<string, string> } = {},
): Promise<{ ok: boolean; output: string; log: string }> {
    const dest = at("out/OUT.md");
    const aliases = options.aliases ?? {};
    const hashNames: HashNameEntity[] = Object.entries(aliases)
        .filter(([name]) => name.startsWith("#"))
        .map(([name, bases]) => ({ id: name.slice(1), description: name, bases: () => bases }));
    const userAliases = Object.fromEntries(Object.entries(aliases).filter(([name]) => !name.startsWith("#")));
    const compiler = await makeCompiler(project, {
        hashNames,
        config: {
            ...(Object.keys(userAliases).length > 0 ? { _aliases: userAliases } : {}),
            ...(options.includeScope ? { _vars: options.includeScope } : {}),
            compilation: { targets: [{ entryPoint: entry, outputs: [{ destinationFile: dest, ...(options.vars ? { _vars: options.vars } : {}) }] }] },
        },
        register: (sous) => {
            if (options.resolver) {
                const resolver = options.resolver;

                sous.services.add("compiler.namespace-resolver", () => resolver);
            }
        },
    });
    const result = await compiler.compile();

    return { ok: result.ok, output: fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : "", log: compiler.output() };
}

/** Two recipes with memories, and a library with none. */
function seedRecipes(): StaticNamespaceResolver {
    write("store/alpha/one/memories/a.md", "ONE-A");
    write("store/alpha/one/memories/b.md", "ONE-B");
    write("store/alpha/one/other/c.md", "ONE-C");
    write("store/beta/two/memories/z.md", "TWO-Z");
    write("store/beta/lib/readme.md", "LIB-README");

    return new StaticNamespaceResolver({
        recipes: { "alpha/one": at("store/alpha/one"), "beta/two": at("store/beta/two"), "beta/lib": at("store/beta/lib") },
        dependencies: { "alpha/one": ["beta/lib"] },
    });
}

describe("include globs and the # sigil", () => {
    /** A relative glob includes every match, in sorted order. */
    it("should include every file a relative glob matches in sorted order", async () => {
        project = makeProject();
        write("p/parts/b.md", "BBB");
        write("p/parts/a.md", "AAA");
        write("p/parts/c.md", "CCC");
        write("p/parts/skip.txt", "NOPE");
        const { ok, output } = await compileEntry(write("p/ENTRY.md", "top\n\n@parts/*.md\n"));

        expect(ok).toBe(true);
        expect(output.indexOf("AAA")).toBeLessThan(output.indexOf("BBB"));
        expect(output.indexOf("BBB")).toBeLessThan(output.indexOf("CCC"));
        expect(output).not.toContain("NOPE");
    });

    /** A file reached through a glob has its own includes expanded. */
    it("should expand include lines inside files a glob reaches", async () => {
        project = makeProject();
        write("p/parts/a.md", "AAA\n@../deep/x.md\n");
        write("p/deep/x.md", "DEEP");
        const { ok, output } = await compileEntry(write("p/ENTRY.md", "@parts/**/*.md\n"));

        expect(ok).toBe(true);
        expect(output).toContain("AAA");
        expect(output).toContain("DEEP");
    });

    /** A glob over recipes reaches the same folder in every recipe. */
    it("should include a folder from every recipe a recipe glob matches", async () => {
        project = makeProject();
        const resolver = seedRecipes();
        const { ok, output } = await compileEntry(write("project/ENTRY.md", "@~*/*/memories/*.md\n"), { resolver });

        expect(ok).toBe(true);
        expect(output.indexOf("ONE-A")).toBeLessThan(output.indexOf("ONE-B"));
        expect(output.indexOf("ONE-B")).toBeLessThan(output.indexOf("TWO-Z"));
        expect(output).not.toContain("LIB-README");
        expect(output).not.toContain("ONE-C");
    });

    /** Inside a recipe, a recipe glob reaches only its declared dependencies. */
    it("should limit a recipe glob inside a recipe to its declared dependencies", async () => {
        project = makeProject();
        const resolver = seedRecipes();

        write("store/alpha/one/SKILL.md", "@~*/*/readme.md\n");

        const { ok, output } = await compileEntry(at("store/alpha/one/SKILL.md"), { resolver });

        expect(ok).toBe(true);
        expect(output).toContain("LIB-README");
        expect(output).not.toContain("TWO-Z");
    });

    it("should fail the build when a glob matches nothing", async () => {
        project = makeProject();
        const { ok, log } = await compileEntry(write("p/ENTRY.md", "@missing/*.md\n"));

        expect(ok).toBe(false);
        expect(log).toContain("Include matched no files: @missing/*.md");
    });

    it("should fail the build when a recipe glob matches nothing", async () => {
        project = makeProject();
        const resolver = seedRecipes();
        const { ok, log } = await compileEntry(write("project/ENTRY.md", "@~*/*/nothing-here/*.md\n"), { resolver });

        expect(ok).toBe(false);
        expect(log).toContain("Include matched no files");
    });

    it("should include the same file twice", async () => {
        project = makeProject();
        write("p/shared.md", "SHARED");
        const { ok, output } = await compileEntry(write("p/ENTRY.md", "@shared.md\n\nmiddle\n\n@shared.md\n"));

        expect(ok).toBe(true);
        expect(output.match(/SHARED/g)).toHaveLength(2);
    });

    it("should include a file a glob matches even when it was already included", async () => {
        project = makeProject();
        write("p/parts/a.md", "AAA");
        const { output } = await compileEntry(write("p/ENTRY.md", "@parts/a.md\n\n@parts/*.md\n"));

        expect(output.match(/AAA/g)).toHaveLength(2);
    });

    it("should still catch a cycle", async () => {
        project = makeProject();
        write("p/a.md", "A\n@b.md\n");
        write("p/b.md", "B\n@a.md\n");
        const { ok, log } = await compileEntry(write("p/ENTRY.md", "@a.md\n"));

        expect(ok).toBe(false);
        expect(log).toContain("Circular dependency detected");
    });

    it("should catch a glob that matches the file including it", async () => {
        project = makeProject();
        const { ok, log } = await compileEntry(write("p/parts/ENTRY.md", "@*.md\n"));

        expect(ok).toBe(false);
        expect(log).toContain("Circular dependency detected");
    });

    it("should fail the build on a malformed include line", async () => {
        project = makeProject();
        const { ok, log, output } = await compileEntry(write("p/ENTRY.md", "top\n\n@docs/notes.txt\n"));

        expect(ok).toBe(false);
        expect(output).toBe("");
        expect(log).toContain("Malformed include line: @docs/notes.txt");
        expect(log).toContain("line 3");
        expect(log).toContain("ENTRY.md");
    });

    it("should name the included file of a malformed include line", async () => {
        project = makeProject();
        write("p/inner.md", "ok\n@~/bad path.md\n@broken/\n");
        const { ok, log } = await compileEntry(write("p/ENTRY.md", "@inner.md\n"));

        expect(ok).toBe(false);
        expect(log).toContain("inner.md, line 3");
    });

    it("should pass a prose line that starts with @ through as text", async () => {
        project = makeProject();
        const { ok, output } = await compileEntry(
            write("p/ENTRY.md", "@alice thanks for the review\n\n@alice\n\n@bob,\n\n@docs and @more words/with a slash\n"),
        );

        expect(ok).toBe(true);
        expect(output).toContain("@alice thanks for the review");
        expect(output).toContain("@alice\n");
        expect(output).toContain("@bob,");
        expect(output).toContain("@docs and @more words/with a slash");
    });

    it("should leave a malformed-looking line inside a fence alone", async () => {
        project = makeProject();
        const { ok, output } = await compileEntry(write("p/ENTRY.md", "```\n@docs/notes.txt\n```\n"));

        expect(ok).toBe(true);
        expect(output).toContain("@docs/notes.txt");
    });

    it("should accept a query on an include line", async () => {
        project = makeProject();
        write("p/part.md", "PART");
        const { ok, output } = await compileEntry(write("p/ENTRY.md", "@part.md?mood=calm\n"));

        expect(ok).toBe(true);
        expect(output).toContain("PART");
    });

    /** `#project` is the project root, from plugin-refs' `hash-name` entity. */
    it("should resolve a #project include from the project's own hash-name", async () => {
        project = makeProject();
        write("notes/a.md", "ROOT NOTE");
        const { ok, output } = await compileEntry(write("elsewhere/ENTRY.md", "@#project/notes/a.md\n"));

        expect(ok).toBe(true);
        expect(output).toContain("ROOT NOTE");
    });

    it("should resolve a glob under #project", async () => {
        project = makeProject();
        write("root/notes/a.md", "NOTE-A");
        write("root/notes/b.md", "NOTE-B");
        const { output } = await compileEntry(write("elsewhere/ENTRY.md", "@#project/notes/*.md\n"), { aliases: { "#project": [at("root")] } });

        expect(output).toContain("NOTE-A");
        expect(output).toContain("NOTE-B");
    });

    it("should no longer treat ~project as the project root", async () => {
        project = makeProject();
        write("root/notes/a.md", "ROOT NOTE");
        const resolver = seedRecipes();
        const { ok, log, output } = await compileEntry(write("project/ENTRY.md", "@~project/notes/a.md\n"), {
            resolver,
            aliases: { "#project": [at("root")] },
        });

        expect(ok).toBe(false);
        expect(output).not.toContain("ROOT NOTE");
        expect(log).toContain('no recipe namespace named "project"');
    });

    it("should explain an unknown # name", async () => {
        project = makeProject();
        const { ok, log } = await compileEntry(write("p/ENTRY.md", "@#nope/x.md\n"));

        expect(ok).toBe(false);
        expect(log).toContain('There is no built-in name "#nope"');
        expect(log).toContain("Available names: #project.");
    });

    it("should render a partial named by #project", async () => {
        project = makeProject();
        write("root/x.md", "RENDERED FROM ROOT");
        const { ok, output } = await compileEntry(write("p/ENTRY.tpl.md", `{% render "#project/x.md" %}`), { aliases: { "#project": [at("root")] } });

        expect(ok).toBe(true);
        expect(output).toContain("RENDERED FROM ROOT");
    });

    /** A view (`#memories`) lists files; an include selects among them, and a glob over it may match nothing. */
    it("should include from a #name view, and let a glob over it match nothing", async () => {
        project = makeProject();
        const file = write("store/a/c/memories/m.md", "MEMORY BODY");
        const view: HashNameEntity = { id: "memories", description: "memories", bases: () => [], view: () => [{ path: "a/c/m.md", file }] };
        const compiler = await makeCompiler(project, {
            hashNames: [view],
            config: {
                compilation: {
                    targets: [
                        { entryPoint: write("ONE.md", "@#memories/a/c/m.md\n"), outputs: [{ destinationFile: at("out/one.md") }] },
                        { entryPoint: write("TWO.md", "before\n@#memories/zzz/*.md\nafter\n"), outputs: [{ destinationFile: at("out/two.md") }] },
                        { entryPoint: write("THREE.md", "@#memories/a/nope.md\n"), outputs: [{ destinationFile: at("out/three.md") }] },
                    ],
                },
            },
        });
        const result = await compiler.compile();

        expect(project.read("out/one.md")).toContain("MEMORY BODY");
        expect(project.read("out/two.md")).toBe("before\nafter\n");
        expect(project.exists("out/three.md")).toBe(false);
        expect(compiler.output()).toContain('The view "#memories" lists no file at "a/nope.md".');
        expect(result.ok).toBe(false);
    });

    /** A user alias starting with `#` or `~` is refused when the config is checked. */
    it("should refuse a user alias that starts with # or ~", async () => {
        project = makeProject();

        await expect(makeCompiler(project, { config: { _aliases: { "#x": "/somewhere" } } })).rejects.toMatchObject({
            details: [expect.stringMatching(/_aliases.*reserved/)],
        });
        await expect(makeCompiler(project, { config: { _aliases: { "~y": "/somewhere" } } })).rejects.toMatchObject({
            details: [expect.stringMatching(/reserved/)],
        });

        const fine = await makeCompiler(project, { config: { _aliases: { docs: "/docs" } } });

        expect(fine.engine.handle.config.services.get("compiler.aliases").all()).toEqual({ "#project": [project.root], docs: ["/docs"] });
    });

    it("should not find a recipe through the wrong repository qualifier", async () => {
        project = makeProject();
        const resolver = seedRecipes();
        const { ok, log } = await compileEntry(write("project/ENTRY.md", "@~other-repo:alpha/one/memories/a.md\n"), { resolver });

        expect(ok).toBe(false);
        expect(log).toContain("Include not found");
    });

    it("should prefer the exact spelling of a recipe name", async () => {
        project = makeProject();
        write("store/alpha/thing/f.md", "LOWER");
        write("store/alpha/Thing/f.md", "UPPER");
        const resolver = new StaticNamespaceResolver({ recipes: { "alpha/thing": at("store/alpha/thing") } });
        const { output } = await compileEntry(write("project/ENTRY.md", "@~alpha/thing/f.md\n"), { resolver });

        expect(output).toContain("LOWER");
    });

    it("should explain a recipe reference with a version range", async () => {
        project = makeProject();
        const resolver = seedRecipes();
        const { ok } = await compileEntry(write("project/ENTRY.md", "@~alpha/one/memories/a.md@^1\n"), { resolver });

        expect(ok).toBe(false);
    });

    it("should keep the not-a-dependency rule", async () => {
        project = makeProject();
        const resolver = seedRecipes();

        write("store/alpha/one/SKILL.md", "@~beta/two/memories/z.md\n");

        const { ok, log } = await compileEntry(at("store/alpha/one/SKILL.md"), { resolver });

        expect(ok).toBe(false);
        expect(log).toContain('does not declare "beta/two"');
    });

    it("should keep the escape protection", async () => {
        project = makeProject();
        const resolver = seedRecipes();

        write("store/secret.md", "SECRET");

        const { ok, log, output } = await compileEntry(write("project/ENTRY.md", "@~alpha/one/../../secret.md\n"), { resolver });

        expect(ok).toBe(false);
        expect(output).not.toContain("SECRET");
        expect(log).toContain("points outside the recipe");
    });
});

describe("alias @include and {% render %} resolution", () => {
    it("resolves a #name include from a directory outside the entry's tree", async () => {
        project = makeProject();
        write("shared/snippet.md", "SHARED SNIPPET BODY");
        const { ok, output } = await compileEntry(write("project/AGENTS.tpl.md", "# Top\n\n@#lib/snippet.md\n"), { aliases: { "#lib": [at("shared")] } });

        expect(ok).toBe(true);
        expect(output).toContain("SHARED SNIPPET BODY");
    });

    it("resolves a ${var}-absolute include", async () => {
        project = makeProject();
        write("ext/note.md", "EXTERNAL NOTE");
        const { ok, output } = await compileEntry(write("p/entry.tpl.md", "@${extRoot}/note.md\n"), { includeScope: { extRoot: at("ext") } });

        expect(ok).toBe(true);
        expect(output).toContain("EXTERNAL NOTE");
    });

    /** A target's own `_vars` reach its include paths too. */
    it("resolves an include path from the target's own variables", async () => {
        project = makeProject();
        write("ext/note.md", "TARGET NOTE");
        const entry = write("p/entry.md", "@${noteDir}/note.md\n");
        const compiler = await makeCompiler(project, {
            config: { compilation: { targets: [{ _vars: { noteDir: at("ext") }, entryPoint: entry, outputs: [{ destinationFile: at("out/x.md") }] }] } },
        });

        expect((await compiler.compile()).ok).toBe(true);
        expect(project.read("out/x.md")).toContain("TARGET NOTE");
    });

    it("falls through alias miss to a real relative dir of the same name (augment)", async () => {
        project = makeProject();
        write("aliasbase/other.md", "WRONG");
        write("p/stuff/one.md", "RELATIVE WINS");
        const { ok, output } = await compileEntry(write("p/entry.tpl.md", "@stuff/one.md\n"), { aliases: { stuff: [at("aliasbase")] } });

        expect(ok).toBe(true);
        expect(output).toContain("RELATIVE WINS");
    });

    it("tries an alias's bases in order", async () => {
        project = makeProject();
        write("second/one.md", "SECOND");
        write("third/one.md", "THIRD");
        const { output } = await compileEntry(write("p/entry.md", "@docs:one.md\n"), { aliases: { docs: [at("first"), at("second"), at("third")] } });

        expect(output).toBe("SECOND\n");
    });

    it("errors and writes nothing when no candidate exists", async () => {
        project = makeProject();
        const { ok, output } = await compileEntry(write("p/entry.tpl.md", "before\n@#lib/missing.md\nafter\n"), { aliases: { "#lib": [at("shared")] } });

        expect(ok).toBe(false);
        expect(output).toBe("");
    });

    it("renders a partial referenced by #name from outside the entry tree", async () => {
        project = makeProject();
        write("lib/partial.md", "RENDERED VIA ALIAS");
        const { ok, output } = await compileEntry(write("p/entry.tpl.md", `{% render "@#lib/partial.md" %}`), { aliases: { "#lib": [at("lib")] } });

        expect(ok).toBe(true);
        expect(output).toContain("RENDERED VIA ALIAS");
    });

    it("still resolves a standard relative {% render %}", async () => {
        project = makeProject();
        write("p/child.md", "RELATIVE CHILD");
        const { ok, output } = await compileEntry(write("p/entry.tpl.md", `{% render "child.md" %}`));

        expect(ok).toBe(true);
        expect(output).toContain("RELATIVE CHILD");
    });
});

describe("~namespace includes", () => {
    function seedStore(): void {
        write("store/workflow/task-files/_partials/resume.md", "RESUME PARTIAL BODY");
        write("store/workflow/github-projects/partial.md", "GITHUB PARTIAL BODY");
        write("store/core/sous-skills/notes.md", "CORE NOTES BODY");
    }

    function makeResolver(overrides: { dependencies?: Record<string, string[]>; projectScope?: string[] } = {}) {
        return new StaticNamespaceResolver({
            recipes: {
                "workflow/task-files": at("store/workflow/task-files"),
                "workflow/github-projects": at("store/workflow/github-projects"),
                "core/sous-skills": at("store/core/sous-skills"),
            },
            ...overrides,
        });
    }

    it("should inline a recipe file addressed by namespace from a project template", async () => {
        project = makeProject();
        seedStore();
        const { ok, output } = await compileEntry(write("project/AGENTS.md", "# Top\n\n@~workflow/task-files/_partials/resume.md\n"), { resolver: makeResolver() });

        expect(ok).toBe(true);
        expect(output).toContain("RESUME PARTIAL BODY");
    });

    it("should resolve a bare @relative/path.md locally without consulting the resolver", async () => {
        project = makeProject();
        seedStore();
        write("project/workflow/local.md", "LOCAL RELATIVE BODY");
        const inner = makeResolver();
        const calls: string[] = [];
        const spied: NamespaceResolver = {
            resolve: (request) => {
                calls.push(request.reference);

                return inner.resolve(request);
            },
        };
        const { ok, output } = await compileEntry(write("project/AGENTS.md", "@workflow/local.md\n"), { resolver: spied });

        expect(ok).toBe(true);
        expect(calls).toEqual([]);
        expect(output).toContain("LOCAL RELATIVE BODY");
    });

    it("should keep the # project alias and a ~project namespace apart", async () => {
        project = makeProject();
        write("shared/recipe/recipe-file.md", "ALIAS FILE");
        write("store/project/recipe/recipe-file.md", "NAMESPACE FILE");
        const resolver = new StaticNamespaceResolver({ recipes: { "project/recipe": at("store/project/recipe") } });
        const { ok, output } = await compileEntry(write("project/AGENTS.md", "@#project/recipe/recipe-file.md\n\n@~project/recipe/recipe-file.md\n"), {
            resolver,
            aliases: { "#project": [at("shared")] },
        });

        expect(ok).toBe(true);
        expect(output).toContain("ALIAS FILE");
        expect(output).toContain("NAMESPACE FILE");
    });

    it("should resolve a namespace include from inside a recipe that declares the dependency", async () => {
        project = makeProject();
        seedStore();
        const entry = write("store/core/sous-skills/SKILL.md", "# Skill\n\n@~workflow/task-files/_partials/resume.md\n");
        const { ok, output } = await compileEntry(entry, { resolver: makeResolver({ dependencies: { "core/sous-skills": ["workflow/task-files"] } }) });

        expect(ok).toBe(true);
        expect(output).toContain("RESUME PARTIAL BODY");
    });

    it("should refuse a namespace include the including recipe does not declare", async () => {
        project = makeProject();
        seedStore();
        const entry = write("store/core/sous-skills/SKILL.md", "before\n@~workflow/github-projects/partial.md\nafter\n");
        const { output, log } = await compileEntry(entry, { resolver: makeResolver({ dependencies: { "core/sous-skills": ["workflow/task-files"] } }) });

        expect(log).toContain("Include not found: @~workflow/github-projects/partial.md");
        expect(log).toContain(`in file: ${entry}`);
        expect(log).toContain("namespace: workflow");
        expect(log).toContain("recipe: workflow/github-projects");
        expect(log).toContain('The recipe "core/sous-skills" does not declare "workflow/github-projects" as a dependency.');
        expect(log).toContain('Add "workflow/github-projects" to the "depends" list');
        expect(output).toBe("");
    });

    it("should report an unknown namespace and list the available ones", async () => {
        project = makeProject();
        seedStore();
        const { log } = await compileEntry(write("project/AGENTS.md", "@~nosuch/recipe/file.md\n"), { resolver: makeResolver() });

        expect(log).toContain("Include not found: @~nosuch/recipe/file.md");
        expect(log).toContain('There is no recipe namespace named "nosuch" available here.');
        expect(log).toContain("Available namespaces: core, workflow.");
        expect(log).toContain("tried:");
    });

    it("should detect a circular include that runs through namespace references", async () => {
        project = makeProject();
        seedStore();
        write("store/workflow/task-files/a.md", "A\n@~workflow/task-files/b.md\n");
        write("store/workflow/task-files/b.md", "B\n@~workflow/task-files/a.md\n");
        const { log, output } = await compileEntry(write("project/AGENTS.md", "@~workflow/task-files/a.md\n"), { resolver: makeResolver() });

        expect(log).toContain("Circular dependency detected");
        expect(output).toBe("");
    });

    it("should render a partial addressed by namespace", async () => {
        project = makeProject();
        seedStore();
        const { ok, output } = await compileEntry(write("project/AGENTS.tpl.md", `{% render "~workflow/task-files/_partials/resume.md" %}`), { resolver: makeResolver() });

        expect(ok).toBe(true);
        expect(output).toContain("RESUME PARTIAL BODY");
    });

    it("should explain a refused namespace in a {% render %} path", async () => {
        project = makeProject();
        seedStore();
        const { log } = await compileEntry(write("project/AGENTS.tpl.md", `{% render "~workflow/task-files/_partials/resume.md" %}`), {
            resolver: makeResolver({ projectScope: ["core/sous-skills"] }),
        });

        expect(log).toContain("Template rendering error");
        expect(log).toContain(`The project's own templates may not address "workflow/task-files".`);
    });
});

describe("getFiles tag", () => {
    /** A template lists tasks by importing each file's `meta`; files without it, or that fail, are left out. */
    it("renders a meta-driven manifest by importing each task file", async () => {
        project = makeProject();
        const tasksDir = at("tasks");

        write("tasks/get-thing.mjs", `export const meta = { name: "get-thing", description: "Fetch a thing" };\n`);
        write("tasks/do-other.mjs", `export const meta = { name: "do-other", description: "Do the other" };\n`);
        write("tasks/helper.mjs", `export function help() {}\n`);
        write("tasks/broken.mjs", `:::not valid:::\n`);

        const entry = write(
            "INDEX.tpl.md",
            [
                "# Tasks",
                "",
                `{% getFiles tasks root=tasksDir include="*.mjs" import="meta" %}`,
                "{% for t in tasks %}- {{ t.meta.name }}: {{ t.meta.description }}",
                "{% endfor %}",
            ].join("\n"),
        );
        const { ok, output } = await compileEntry(entry, { vars: { tasksDir } });

        expect(ok).toBe(true);
        expect(output).toContain("- do-other: Do the other");
        expect(output).toContain("- get-thing: Fetch a thing");
        expect(output).not.toContain("helper");
        expect(output).not.toContain("broken");
    });

    /** `listFiles`, `showVars`, `exportScalarVarsJs` and `bulletList` reach templates through plugin-liquid. */
    it("gives templates every built-in tag and filter", async () => {
        project = makeProject();
        write("list/a.md", "");
        write("list/b.md", "");
        const entry = write(
            "ALL.tpl.md",
            `{% listFiles root=listDir %}\n{{ names | split: "," | bulletList }}\n{% exportScalarVarsJs %}\n{% showVars %}`,
        );
        const { ok, output } = await compileEntry(entry, { vars: { listDir: at("list"), names: "x,y", apiToken: "abc" } });

        expect(ok).toBe(true);
        expect(output).toContain("- a.md\n- b.md");
        expect(output).toContain("- x\n- y");
        expect(output).toContain(`"listDir": "${at("list")}"`);
        expect(output).toContain('"apiToken": "(hidden)"');
        expect(output).toContain("# Sous Debug: Variable Dump");
    });
});
