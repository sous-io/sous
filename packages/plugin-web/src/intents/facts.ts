/**
 * The editor's other pages, each from the plugin that owns the facts: variables from
 * `vars.list` and `variables.resolver`, config layers from `config.show --layers`, recipes from
 * `recipes.active` and `recipes.store`, hand edits from the preview build.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Context, JsonValue } from "@sous-io/plugin-api";
import type {} from "@sous-io/plugin-formats/types";
import type {} from "@sous-io/plugin-inspect/types";
import type {} from "@sous-io/plugin-recipe-answers/types";
import type { CatalogRecipe, ConfigReport, Drift, RecipeFileDiff, VarFact } from "../types.js";
import { previewBuild, previewContent } from "./build.js";
import { renderFile } from "./render.js";
import { contentOf, scopeOf, visibleScope, workspaceOf, type WorkspaceFile } from "./workspace.js";

// ---------------------------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------------------------

export async function variableFacts(ctx: Context): Promise<VarFact[]> {
    const workspace = await workspaceOf(ctx);
    const facts = new Map<string, VarFact>();
    const listed = (await ctx.run("vars.list", {})).toPlain();

    for (const item of listed.variables) {
        const definition = item.variable.definition;
        const fact: VarFact = {
            name: definition.name,
            recipe: `${item.variable.recipe.namespace}/${item.variable.recipe.name}@${item.variable.recipe.version}`,
            description: definition.description ?? definition.prompt,
            type: definition.type,
            secret: definition.secret === true,
            value: item.answered ? (item.value ?? null) : null,
            usedIn: [],
        };

        if (item.source) {
            fact.answeredBy = `${item.source.file === "shell" ? "your shell" : item.source.file} (${item.source.envName})`;
            fact.envName = item.source.envName;
        }

        facts.set(definition.name, fact);
    }

    // Every other variable in scope: built in, or set in the config's _vars.
    const resolver = ctx.services.get("variables.resolver");
    const origins = resolver.origins();
    const shown = visibleScope(ctx, resolver.scope());
    const secrets = ctx.services.get("variables.secrets");

    for (const [name, value] of Object.entries(shown)) {
        if (facts.has(name)) continue;

        const from = origins[name]?.from;

        facts.set(name, {
            name,
            secret: secrets.hasSecretName(name),
            value,
            answeredBy: from === "auto" ? "built in to sous" : from === "_env" ? "the environment (_env)" : from ? `the config (${from})` : "the config",
            usedIn: [],
        });
    }

    // Where each one is used: the variables each template reads, as plugin-liquid finds them.
    const regions = ctx.services.get("liquid.regions");

    for (const file of workspace.files) {
        if (!file.isTpl) continue;

        let uses: string[] | undefined;

        try {
            uses = regions.uses(contentOf(file));
        } catch {
            continue;
        }

        for (const name of uses ?? []) facts.get(name.split(".")[0]!)?.usedIn.push(file.id);
    }

    return [...facts.values()].sort((a, b) => b.usedIn.length - a.usedIn.length || a.name.localeCompare(b.name));
}

export function builtinNames(ctx: Context): string[] {
    return [...Object.keys(ctx.services.get("variables.resolver").autoVariables()), "sousTemplatePath", "sousTemplateDir"];
}

// ---------------------------------------------------------------------------------------------
// Config layers
// ---------------------------------------------------------------------------------------------

const SECRET_KEY = /(secret|token|password|api[_-]?key|private)/i;

function shown(key: string, value: JsonValue | undefined): string {
    if (SECRET_KEY.test(key)) return '"••••••"';

    const text = JSON.stringify(value) ?? "undefined";

    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function flatten(value: unknown, prefix: string, out: Map<string, string>): void {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        const entries = Object.entries(value as Record<string, unknown>);

        if (entries.length === 0 && prefix) out.set(prefix, "{}");

        for (const [key, inner] of entries) flatten(inner, prefix ? `${prefix}.${key}` : key, out);
    } else {
        out.set(prefix, shown(prefix, value as JsonValue));
    }
}

type AnyPatch = { op: string; path: string; key?: string; index?: number | "end"; value?: JsonValue; to?: string; patches?: AnyPatch[] };

/** The keys a contributor's patch set changed, as dotted paths with their new values. */
function changesOf(patch: AnyPatch, out: { key: string; value: string }[]): void {
    if (Array.isArray(patch.patches)) {
        for (const inner of patch.patches) changesOf(inner, out);

        return;
    }

    const base = patch.path === "" || patch.path === undefined ? "" : `${patch.path}.`;

    switch (patch.op) {
        case "setKey":
            out.push({ key: `${base}${patch.key}`, value: shown(`${base}${patch.key}`, patch.value) });
            break;
        case "deleteKey":
            out.push({ key: `${base}${patch.key}`, value: "(removed)" });
            break;
        case "renameKey":
            out.push({ key: `${base}${patch.key}`, value: `(renamed to ${patch.to})` });
            break;
        default:
            out.push({ key: `${patch.path}[${patch.index}]`, value: patch.op === "removeIndex" ? "(removed)" : shown(patch.path, patch.value) });
    }
}

export async function configReport(ctx: Context): Promise<ConfigReport> {
    const root = ctx.project?.root ?? ctx.cwd;
    const sousDir = ctx.project?.sousDir ?? root;
    const result = (await ctx.run("config.show", { layers: true })).toPlain();
    const layers: ConfigReport["layers"] = [];
    const setBy = new Map<string, string>();

    for (const layer of result.layers ?? []) {
        const changes: { key: string; value: string }[] = [];

        changesOf(layer.patch as unknown as AnyPatch, changes);

        if (changes.length === 0) continue;

        const file = layer.source ? path.resolve(sousDir, layer.source) : undefined;
        const display = file ? path.relative(root, file) : `${layer.contributor} (${layer.plugin})`;
        const kind = layer.source?.startsWith("conf.d") ? "conf.d" : file === ctx.project?.configPath ? "primary" : layer.plugin.includes("recipe") ? "recipe" : file ? "other" : "plugin";
        const entry: ConfigReport["layers"][number] = { path: file ?? layer.contributor, display, kind, changes };

        if (file && existsSync(file)) {
            entry.text = readFileSync(file, "utf8")
                .split("\n")
                .map((line) => (SECRET_KEY.test(line) && /[:=]/.test(line) ? line.replace(/([:=]\s*).+$/, "$1••••••") : line))
                .join("\n");
        }

        for (const change of changes) setBy.set(change.key, display);

        layers.push(entry);
    }

    const final = new Map<string, string>();

    flatten(result.config, "", final);

    const settings = [...final.entries()].map(([key, value]) => {
        // A key set inside an object a layer set whole is credited to the nearest key a layer set.
        let owner = setBy.get(key);

        for (let probe = key; owner === undefined && probe.includes("."); probe = probe.slice(0, probe.lastIndexOf("."))) owner = setBy.get(probe);

        return { key, value, layer: owner ?? "" };
    });

    return { layers, settings };
}

// ---------------------------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------------------------

function compareVersions(a: string, b: string): number {
    const pa = a.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
    const pb = b.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);

    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const difference = (pa[i] ?? 0) - (pb[i] ?? 0);

        if (difference !== 0) return difference;
    }

    return 0;
}

function countMarkdown(dir: string): number {
    let count = 0;

    try {
        for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
            if (entry.isFile() && entry.name.endsWith(".md")) count++;
        }
    } catch {
        // An unreadable folder counts as empty.
    }

    return count;
}

/** Every recipe in the store, newest version first, with the version this project uses. */
export async function recipeCatalog(ctx: Context): Promise<CatalogRecipe[]> {
    const store = ctx.services.get("recipes.store");
    const manifests = ctx.services.get("formats.manifests");
    const active = new Map(ctx.services.get("recipes.active").list().map((recipe) => [`${recipe.identity}/${recipe.namespace}/${recipe.name}`, recipe]));
    const grouped = new Map<string, { identity: string; namespace: string; name: string; versions: string[] }>();

    for (const entry of await store.list()) {
        const key = `${entry.repo}/${entry.namespace}/${entry.name}`;
        const group = grouped.get(key) ?? { identity: entry.repo, namespace: entry.namespace, name: entry.name, versions: [] };

        group.versions.push(entry.version);
        grouped.set(key, group);
    }

    // A recipe this project uses from a linked checkout is not in the store, but still listed.
    for (const [key, recipe] of active) {
        if (!grouped.has(key)) grouped.set(key, { identity: recipe.identity, namespace: recipe.namespace, name: recipe.name, versions: [recipe.version] });
    }

    const recipes: CatalogRecipe[] = [];

    for (const [key, group] of grouped) {
        const versions = [...new Set(group.versions)].sort((a, b) => compareVersions(b, a));
        const using = active.get(key);
        const shownVersion = using?.version ?? versions[0]!;
        const dir = using?.dir ?? store.entryDir({ identity: group.identity, namespace: group.namespace, name: group.name, version: shownVersion });
        const manifest = using?.manifest ?? (await manifests.readRecipe(dir).catch(() => undefined))?.manifest;
        const [, owner = "", repo = ""] = group.identity.split("/");
        const recipe: CatalogRecipe = {
            key,
            repo: `${owner}/${repo}`,
            namespace: group.namespace,
            name: group.name,
            versions,
            latest: versions[0]!,
            kinds: [...new Set((manifest?.contents ?? []).map((content) => content.kind).filter((kind): kind is NonNullable<typeof kind> => Boolean(kind)))].map(String),
            variables: (manifest?.variables ?? []).map((variable) => ({
                name: variable.name,
                description: variable.description,
                secret: variable.secret === true,
                required: variable.default === undefined,
            })),
            depends: manifest?.depends ?? [],
            files: countMarkdown(dir),
            acceptsProposals: manifest?.submissions?.allowed !== false,
        };

        if (manifest?.description) recipe.description = manifest.description.trim();
        if (using) recipe.using = using.version;
        if (manifest?.submissions?.instead) recipe.proposalsInstead = manifest.submissions.instead;

        recipes.push(recipe);
    }

    return recipes.sort((a, b) => Number(Boolean(b.using)) - Number(Boolean(a.using)) || a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
}

function listFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true, recursive: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
}

/** What a recipe update changes for this project: both versions' files, rendered with its variables. */
export async function recipeDiff(ctx: Context, key: string, from: string, to: string): Promise<RecipeFileDiff[]> {
    const parts = key.split("/");

    if (parts.length < 5 || parts.some((part) => !part || part === ".." || part.includes("\\"))) throw new Error("That is not a recipe key (host/owner/repo/namespace/name).");
    if (![from, to].every((version) => /^[\w.+-]+$/.test(version))) throw new Error("That is not a version.");

    const name = parts.pop()!;
    const namespace = parts.pop()!;
    const identity = parts.join("/");
    const store = ctx.services.get("recipes.store");
    const dirA = store.entryDir({ identity, namespace, name, version: from });
    const dirB = store.entryDir({ identity, namespace, name, version: to });

    if (!existsSync(dirA) || !existsSync(dirB)) throw new Error("Both versions must be in the recipe store.");

    const pseudo = (file: string): WorkspaceFile => ({ id: "diff", path: file, display: file, origin: { kind: "external" }, isTpl: true, role: "entry", outputs: [] });
    const render = async (file: string, text: string) => {
        if (!/\.tpl\./.test(path.basename(file))) return text;

        // Rendered with the variables of this recipe's scope.
        const result = await renderFile(ctx, pseudo(file), text, { ...scopeOf(ctx, { ...pseudo(file), origin: { kind: "recipe", host: "", owner: "", repo: "", namespace, recipe: name, version: to, recipePath: "", source: "store" } }) });

        return result.error ? text : result.output;
    };
    const filesA = new Set(listFiles(dirA));
    const filesB = new Set(listFiles(dirB));
    const all = [...new Set([...filesA, ...filesB])].filter((file) => file.endsWith(".md") || file.endsWith(".yaml")).sort();
    const result: RecipeFileDiff[] = [];

    for (const rel of all) {
        const textA = filesA.has(rel) ? readFileSync(path.join(dirA, rel), "utf8") : undefined;
        const textB = filesB.has(rel) ? readFileSync(path.join(dirB, rel), "utf8") : undefined;
        const before = textA === undefined ? undefined : await render(path.join(dirA, rel), textA);
        const after = textB === undefined ? undefined : await render(path.join(dirB, rel), textB);
        const diff: RecipeFileDiff = {
            path: rel,
            status:
                textA === undefined
                    ? "added"
                    : textB === undefined
                      ? "removed"
                      : before === after
                        ? "same"
                        : before!.split(dirA).join(dirB) === after
                          ? "path-only"
                          : "changed",
            sourceChanged: textA !== textB,
        };

        if (before !== undefined) diff.before = before;
        if (after !== undefined) diff.after = after;

        result.push(diff);
    }

    return result;
}

// ---------------------------------------------------------------------------------------------
// Hand edits
// ---------------------------------------------------------------------------------------------

/** Two hand edits made to the sample's (simulated) output on disk. */
const SAMPLE_EDITS: [string, string][] = [
    ["Put the cursor inside any highlighted section to see its Liquid source, edit it,", "Click any highlighted section to see its Liquid source and edit it,"],
    ["Agents in this project open pull requests without asking.", "Agents in this project open pull requests without asking, and link the issue each one fixes."],
];

/**
 * A built output someone edited by hand: on disk it differs from what a fresh build writes, so
 * the next build would throw the edit away. The sample has no output on disk, so its copy is
 * simulated.
 */
export async function findDrift(ctx: Context, id: string): Promise<Drift | null> {
    const workspace = await workspaceOf(ctx);
    const file = workspace.byId.get(id);

    if (!file) return null;

    if (file.origin.kind === "sample") {
        const render = await renderFile(ctx, file, contentOf(file));
        let disk = render.output;

        for (const [before, after] of SAMPLE_EDITS) disk = disk.replace(before, after);

        return { output: "poc-samples/liquid-showcase.md", built: render.output, disk, simulated: true };
    }

    const build = await previewBuild(ctx, false);
    const stale = build.outputs.find((output) => output.entryId === id && output.status === "stale");

    if (!stale) return null;

    const built = previewContent(stale.output);
    const real = path.join(workspace.projectRoot, stale.output);

    if (built === undefined || !existsSync(real)) return null;

    return { output: stale.output, built, disk: readFileSync(real, "utf8"), simulated: false };
}
