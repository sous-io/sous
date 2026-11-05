import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Lockfile } from "@sous-io/plugin-formats/types";
import { globSync } from "glob";
import { afterEach, describe, expect, it } from "vitest";
import { builtConfig, memoryLock } from "../../test/part-a/helpers.js";
import type { ActiveRecipeEntity } from "../types.js";
import { RecipeContents } from "./contents.js";
import { ActiveRecipes, reachableKeys } from "./active.js";

const hash = "sha256-aa" as const;
const dirs: string[] = [];

afterEach(() => {
    while (dirs.length > 0) {
        fs.rmSync(dirs.pop()!, { recursive: true, force: true });
    }
});

const lock: Lockfile = {
    formatVersion: 1,
    repos: { r: { url: "https://github.com/acme/r", identity: "github.com/acme/r" }, gone: { url: "https://github.com/acme/gone" } },
    recipes: {
        "tool-usage/automated-browser-tasks": { repo: "r", version: "1.0.0", hash, requestedBy: ["project"], kind: "subscribes" },
        "tool-usage/helper": { repo: "r", version: "1.0.0", hash, requestedBy: ["tool-usage/automated-browser-tasks"], kind: "depends" },
        "workflow/task-files": { repo: "r", version: "2.0.0", hash, requestedBy: ["project"], kind: "subscribes" },
        "workflow/missing": { repo: "r", version: "2.0.0", hash, requestedBy: ["project"], kind: "subscribes" },
        "old/thing": { repo: "gone", version: "1.0.0", hash, requestedBy: ["project"], kind: "subscribes" },
        "stray/one": { repo: "r", version: "1.0.0", hash, requestedBy: ["project"], kind: "subscribes" },
    },
};

function entity(id: string, dir: string, manifest: Partial<ActiveRecipeEntity["manifest"]> = {}): ActiveRecipeEntity {
    const [namespace, name] = id.split("/") as [string, string];

    return {
        id,
        namespace,
        name,
        repo: "r",
        identity: "github.com/acme/r",
        version: "2.0.0",
        hash,
        kind: "subscribes",
        requestedBy: ["project"],
        dir,
        source: "store",
        manifest: { formatVersion: 1, namespace, name, version: "2.0.0", contents: [], ...manifest },
    };
}

function setup(recipeDir = "/nowhere") {
    const globs = {
        matchSync: (pattern: string, options: { cwd: string; dot?: boolean; ignore?: readonly string[] }) =>
            globSync(pattern, { cwd: options.cwd, dot: options.dot ?? false, nodir: true, ignore: [...(options.ignore ?? [])] }),
        sortBytewise: (items: Iterable<string>) => [...items].sort(),
        toPosix: (file: string) => file.split(path.sep).join("/"),
        hasGlob: (text: string) => /[*?{[]/.test(text),
        staticBase: (pattern: string) => pattern.split("/").slice(0, pattern.split("/").findIndex((part) => /[*?{[]/.test(part))).join("/") || "/",
    };
    const config = builtConfig(
        {
            repos: { r: { url: "https://github.com/acme/r" } },
            subscriptions: { "tool-usage/automated-browser-tasks": { enabled: false }, workflow: {} },
        },
        {
            services: { "recipes.lock": memoryLock(lock), "host.globs": globs, "recipes.contents": new RecipeContents({ get: () => globs } as never) },
            entities: {
                "active-recipe": [
                    entity("workflow/task-files", recipeDir, {
                        contents: [{ kind: "skills", include: ["skills/**/*.md"], exclude: ["skills/draft.md"] }],
                        variables: [{ name: "apiUrl", type: "url", prompt: "Where?", description: "", example: "https://x", required: true, secret: false, scope: "shared" }],
                    }),
                ],
            },
            layers: { "subscriptions.tool-usage/automated-browser-tasks.enabled": ["confd/510-subscriptions.jsonc", "confd/610-mac.jsonc"] },
        },
    );

    return new ActiveRecipes(config, config.services);
}

describe("recipes.active", () => {
    /** Only the locked recipes reached from subscriptions switched on count. */
    it("should reach recipes only from subscriptions switched on", () => {
        expect(reachableKeys(lock, { "tool-usage/automated-browser-tasks": { enabled: false }, workflow: {} })).toEqual(["workflow/missing", "workflow/task-files"]);
    });

    /** One line per skipped recipe, saying why, naming the file that switched it off. */
    it("should say why each locked recipe is skipped", () => {
        const skipped = setup().skipped();
        const byKey = Object.fromEntries(skipped.map((entry) => [entry.key, entry]));

        expect(byKey["tool-usage/automated-browser-tasks"]).toEqual({
            key: "tool-usage/automated-browser-tasks",
            reason: "subscription-disabled",
            subscription: "tool-usage/automated-browser-tasks",
            setBy: "conf.d/610-mac.jsonc",
            message: "Skipped tool-usage/automated-browser-tasks: its subscription is switched off (conf.d/610-mac.jsonc).",
        });
        expect(byKey["tool-usage/helper"]).toEqual({
            key: "tool-usage/helper",
            reason: "subscription-disabled",
            subscription: "tool-usage/automated-browser-tasks",
            indirect: true,
            setBy: "conf.d/610-mac.jsonc",
            message: "Skipped tool-usage/helper: reached only through tool-usage/automated-browser-tasks, which is switched off (conf.d/610-mac.jsonc).",
        });
        expect(byKey["workflow/missing"]?.reason).toBe("missing");
        expect(byKey["old/thing"]?.reason).toBe("untrusted");
        expect(byKey["stray/one"]?.reason).toBe("not-reached");
        expect(byKey["workflow/task-files"]).toBeUndefined();
    });

    /** Contents of one kind list their files bytewise, excludes left out; variables name their recipe. */
    it("should list contents and variables", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sous-active-"));

        dirs.push(dir);

        for (const file of ["skills/b.md", "skills/a/SKILL.md", "skills/draft.md"]) {
            fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
            fs.writeFileSync(path.join(dir, file), "x");
        }

        const active = setup(dir);
        const [content] = active.contents("skills");

        expect(content?.files.map((file) => file.path)).toEqual(["skills/a/SKILL.md", "skills/b.md"]);
        expect(content?.files[0]?.file).toBe(path.join(dir, "skills/a/SKILL.md"));
        expect(content?.files[0]?.base).toBe(path.join(dir, "skills"));
        expect(active.contents("memories")).toEqual([]);
        expect(active.variables().map((entry) => `${entry.recipe.id}.${entry.definition.name}`)).toEqual(["workflow/task-files.apiUrl"]);
        expect(active.list().map((recipe) => recipe.id)).toEqual(["workflow/task-files"]);
        expect(active.get("workflow/task-files")?.version).toBe("2.0.0");
    });
});

describe("recipes.active switchedOffButBuilt()", () => {
    /**
     * A switched-off subscription whose recipe enabled recipes depend on is still built; one line
     * says so and names them (#204 bug 24).
     *
     * // acme/base switched off; acme/widget and acme/gadget depend on it
     * active.switchedOffButBuilt();
     * // -> "acme/base is switched off but still built: acme/gadget and acme/widget depend on it."
     */
    it("should name the enabled recipes that keep a switched-off recipe built", () => {
        const based: Lockfile = {
            formatVersion: 1,
            repos: { r: { url: "https://github.com/acme/r", identity: "github.com/acme/r" } },
            recipes: {
                "acme/base": { repo: "r", version: "1.0.0", hash, requestedBy: ["project", "acme/widget", "acme/gadget"], kind: "subscribes" },
                "acme/widget": { repo: "r", version: "1.0.0", hash, requestedBy: ["project"], kind: "subscribes" },
                "acme/gadget": { repo: "r", version: "1.0.0", hash, requestedBy: ["project"], kind: "subscribes" },
                "acme/alone": { repo: "r", version: "1.0.0", hash, requestedBy: ["project"], kind: "subscribes" },
            },
        };
        const config = builtConfig(
            {
                repos: { r: { url: "https://github.com/acme/r" } },
                subscriptions: { "acme/base": { enabled: false }, "acme/widget": {}, "acme/gadget": {}, "acme/alone": { enabled: false } },
            },
            {
                services: { "recipes.lock": memoryLock(based) },
                entities: { "active-recipe": ["acme/base", "acme/widget", "acme/gadget"].map((id) => entity(id, "/nowhere")) },
                layers: { "subscriptions.acme/base.enabled": ["confd/520-local.jsonc"] },
            },
        );

        expect(new ActiveRecipes(config, config.services).switchedOffButBuilt()).toEqual([
            {
                key: "acme/base",
                subscription: "acme/base",
                neededBy: ["acme/gadget", "acme/widget"],
                setBy: "conf.d/520-local.jsonc",
                message: "acme/base is switched off but still built: acme/gadget and acme/widget depend on it.",
            },
        ]);
    });
});
