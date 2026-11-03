/**
 * The `web.*` intents: the editor's data, each built from the plugins that own it. They are
 * internal (the CLI and agents have the owners' own intents), read-only, and parallel, so several
 * tabs can ask at once and any of them can run against a "what if" config.
 */
import { IntentOutputs, jsonSchema, type Context, type Sous } from "@sous-io/plugin-api";
import type {} from "@sous-io/plugin-variables/types";
import { previewBuild, previewContent } from "./build.js";
import { builtinNames, configReport, findDrift, recipeCatalog, recipeDiff, variableFacts } from "./facts.js";
import { resolveIncludes } from "./includes.js";
import { renderFile } from "./render.js";
import { contentOf, scopeOf, toWebFile, visibleScope, workspaceOf } from "./workspace.js";

const object = (properties: Record<string, unknown>, required: string[] = []) => jsonSchema<never>({ type: "object", properties, required } as never);

async function fileOf(ctx: Context, id: string) {
    const workspace = await workspaceOf(ctx);
    const file = workspace.byId.get(id);

    if (!file) throw new Error(`No file has the id ${id}; the project's files may have changed. Reload the page.`);

    return { workspace, file };
}

export function registerWebIntents(sous: Sous): void {
    const add = (intent: string, summary: string, input: ReturnType<typeof object>, handle: (input: never, ctx: Context) => Promise<unknown>) =>
        sous.intents.add({
            intent,
            summary,
            input,
            internal: true,
            readOnly: true,
            parallel: true,
            requiresProject: true,
            handle: async (value: never, ctx: Context) => IntentOutputs.of((await handle(value, ctx)) as object),
        } as never);

    add("web.workspace", "Every source file, where it comes from and what it builds", object({}), async (_input, ctx) => {
        const workspace = await workspaceOf(ctx);

        return { projectName: workspace.projectName, projectRoot: workspace.projectRoot, branch: workspace.branch, files: workspace.files.map(toWebFile) };
    });

    add("web.file", "A file's text, its variables and its first render", object({ id: { type: "string" } }, ["id"]), async (input: { id: string }, ctx) => {
        const { file } = await fileOf(ctx, input.id);
        const content = contentOf(file);

        return {
            content,
            vars: visibleScope(ctx, scopeOf(ctx, file)),
            secretNames: [...ctx.services.get("variables.secrets").declared()],
            render: await renderFile(ctx, file, content),
        };
    });

    add(
        "web.render",
        "Renders a file's text, edited or not, with any values being tried",
        object({ id: { type: "string" }, source: { type: "string" }, overrides: { type: "object" } }, ["id", "source"]),
        async (input: { id: string; source: string; overrides?: Record<string, string> }, ctx) => {
            const { file } = await fileOf(ctx, input.id);

            return renderFile(ctx, file, input.source, input.overrides);
        },
    );

    add("web.includes", "Where each @include line in a file points", object({ id: { type: "string" }, source: { type: "string" } }, ["id", "source"]), async (input: { id: string; source: string }, ctx) => {
        const { workspace, file } = await fileOf(ctx, input.id);

        return { includes: resolveIncludes(ctx, workspace, file, input.source) };
    });

    add("web.build", "A dry-run build of every target, with token counts", object({ rerun: { type: "boolean" } }), (input: { rerun?: boolean }, ctx) => previewBuild(ctx, input.rerun === true));

    add("web.output", "The text the preview build made for one output", object({ path: { type: "string" } }, ["path"]), async (input: { path: string }, ctx) => {
        await previewBuild(ctx, false);

        const content = previewContent(input.path);

        if (content === undefined) throw new Error(`The preview build made no ${input.path}.`);

        return { content };
    });

    add("web.drift", "Hand edits to a file's built output", object({ id: { type: "string" } }, ["id"]), async (input: { id: string }, ctx) => ({ drift: await findDrift(ctx, input.id) }));
    add("web.variables", "Every variable, its value, who answered it and where it is used", object({}), async (_input, ctx) => ({ variables: await variableFacts(ctx) }));
    add("web.builtins", "The variables sous sets itself", object({}), async (_input, ctx) => ({ names: builtinNames(ctx) }));
    add("web.config", "The config's layers and the final settings", object({}), (_input, ctx) => configReport(ctx));
    add("web.recipes", "Every recipe in the store, with the version this project uses", object({}), async (_input, ctx) => ({ recipes: await recipeCatalog(ctx) }));
    add(
        "web.recipe-diff",
        "What a recipe update changes, rendered with this project's variables",
        object({ key: { type: "string" }, from: { type: "string" }, to: { type: "string" } }, ["key", "from", "to"]),
        async (input: { key: string; from: string; to: string }, ctx) => ({ files: await recipeDiff(ctx, input.key, input.from, input.to) }),
    );
}
