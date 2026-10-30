/**
 * The handlers of plugin-inspect. Each reads only the engine and returns plain data; plugin-cli
 * decides how it looks. Secrets are hidden everywhere (G4).
 */

import nodePath from "node:path";
import { getAtPath, isPathPrefix, parsePath } from "@sous-io/documents";
import "@sous-io/plugin-variables/types";
import "@sous-io/plugin-confd/types";
import {
    NotFoundError,
    SousError,
    type ConfigKeyEntity,
    type Context,
    type JsonObject,
    type JsonValue,
    type Patch,
    type PathSegment,
    type PluginInfo,
    type TimingEntry,
} from "@sous-io/plugin-api";
import { readRawConfigFiles } from "./raw.js";
import { KEY_NAME_POLICY, redactLayer, redactUnder, redactValue, servicePolicy, type SecretPolicy } from "./redact.js";
import type {
    ConfigGetInput,
    ConfigGetResult,
    ConfigShowInput,
    ConfigShowResult,
    ConfigValidateResult,
    ConfigValidateSummary,
    LayerView,
    PluginsShowInput,
    TimingsShowInput,
} from "./types.js";

/** The secret policy: `variables.secrets` when it is loaded, else the key-name rule. */
function policyOf(ctx: Context): SecretPolicy {
    return ctx.services.has("variables.secrets") ? servicePolicy(ctx.services.get("variables.secrets")) : KEY_NAME_POLICY;
}

/** The contributor of the main config file. */
const MAIN_CONTRIBUTOR = "config-files.main";

/** The prefix of the contributors of the patch files beside the main config file. */
const MAIN_PATCH_PREFIX = "config-files/";

/**
 * Every change to a path, in order, with secrets hidden. A change that sets the value itself (or an
 * object around it) says what the value was and became; one that sets the value to what it already
 * was is left out, so each line is a real change.
 */
function layersOf(ctx: Context, path: string, policy: SecretPolicy): LayerView[] {
    const target = parsePath(path);
    const sources = sourcesOf(ctx);
    const views: LayerView[] = [];
    let before: JsonValue | undefined;

    for (const layer of ctx.config.layers(path)) {
        const view: LayerView = { ...redactLayer(layer, policy), ...withSource(sources.get(layer.contributor)) };
        const after = valueAfter(view.patch, target);

        if (after === UNKNOWN) {
            views.push(view);
            continue;
        }

        if (JSON.stringify(after) === JSON.stringify(before)) {
            continue;
        }

        views.push({ ...view, change: { ...(before === undefined ? {} : { from: before }), ...(after === undefined ? {} : { to: after }) } });
        before = after;
    }

    return views;
}

function withSource(source: string | undefined): { source?: string } {
    return source === undefined ? {} : { source };
}

/** Says a change's effect on a value cannot be read from the change alone. */
const UNKNOWN = Symbol("unknown");

/**
 * The value at `target` right after a change, read from the change alone: a change that sets the
 * value, or an object around it, tells it; one inside the value, or a rename, does not.
 */
function valueAfter(patch: Patch, target: readonly PathSegment[]): JsonValue | undefined | typeof UNKNOWN {
    if (patch.op === "renameKey") {
        return UNKNOWN;
    }

    const at = [...parsePath(patch.path), patch.op === "setKey" || patch.op === "deleteKey" ? patch.key : patch.index];

    if (!isPathPrefix(at, target)) {
        return UNKNOWN;
    }

    const rest = target.slice(at.length);

    switch (patch.op) {
        case "setKey":
        case "setIndex":
            return getAtPath(patch.value, rest);
        case "deleteKey":
            return undefined;
        case "insertAt":
        case "removeIndex":
            // Either shifts the items after it, so only a change at the index itself is known.
            return rest.length > 0 ? UNKNOWN : patch.op === "insertAt" ? patch.value : UNKNOWN;
    }
}

/** The config file behind each file contributor, from the `.sous` directory: `conf.d/610-mac.jsonc`. */
function sourcesOf(ctx: Context): Map<string, string> {
    const sources = new Map<string, string>();
    const project = ctx.project;

    if (project === undefined) {
        return sources;
    }

    const fromSousDir = (file: string): string => {
        const relative = nodePath.relative(project.sousDir, file);

        return relative !== "" && !relative.startsWith("..") ? relative : file;
    };

    if (project.configPath !== undefined) {
        sources.set(MAIN_CONTRIBUTOR, fromSousDir(project.configPath));
    }

    for (const contribution of ctx.config.contributions()) {
        if (contribution.contributor.startsWith(MAIN_PATCH_PREFIX)) {
            sources.set(contribution.contributor, fromSousDir(nodePath.join(project.sousDir, contribution.contributor.slice(MAIN_PATCH_PREFIX.length))));
        }
    }

    for (const file of ctx.services.has("confd.files") ? ctx.services.get("confd.files").list() : []) {
        sources.set(file.contributor, fromSousDir(file.path));
    }

    return sources;
}

/** `config.show`: the evaluated config, and with `layers` or `raw`, where it came from. */
export async function configShow(input: ConfigShowInput, ctx: Context): Promise<ConfigShowResult> {
    const policy = policyOf(ctx);

    return {
        config: redactValue(ctx.config.value() as JsonObject, policy),
        passes: ctx.config.passes,
        ...(input.layers === true ? { layers: layersOf(ctx, "", policy) } : {}),
        ...(input.raw === true ? { raw: await readRawConfigFiles(ctx.project, ctx.services, policy) } : {}),
    };
}

/** `config.get`: one value by path. A path with nothing at it gives `exists: false`. */
export async function configGet(input: ConfigGetInput, ctx: Context): Promise<ConfigGetResult> {
    const exists = ctx.config.has(input.path);
    const value = exists ? ctx.config.get<JsonValue>(input.path) : undefined;
    const lastKey = input.path.split(/[.[\]"]+/).filter((part) => part !== "").pop() ?? "";
    const policy = policyOf(ctx);
    const shown = value === undefined ? undefined : redactUnder(lastKey, value, policy);

    return {
        path: input.path,
        exists,
        value: shown,
        passes: ctx.config.passes,
        ...(input.layers === true ? { layers: layersOf(ctx, input.path, policy) } : {}),
        ...(input.raw === true ? { raw: await readRawConfigFiles(ctx.project, ctx.services, policy) } : {}),
    };
}

/**
 * `config.validate`: checks each config key's value against its schema, naming who set it, then
 * resolves every `${var}` the way a build does, so a cycle or a name defined nowhere shows here
 * instead of in the middle of a build. A key the config does not hold is not checked: the build
 * already filled in every default it has.
 */
export async function configValidate(_input: unknown, ctx: Context): Promise<ConfigValidateResult> {
    const issues: string[] = [];

    for (const key of ctx.entities.list("config-key") as ConfigKeyEntity[]) {
        if (!ctx.config.has(key.id)) {
            continue;
        }

        const value = ctx.config.get(key.id);
        const result = await key.schema["~standard"].validate(value);

        if (result.issues === undefined) {
            continue;
        }

        const setBy = [...new Set(ctx.config.layers(key.id).map((layer) => layer.contributor))];
        const who = setBy.length > 0 ? ` (set by ${setBy.join(", ")})` : "";

        for (const issue of result.issues) {
            const inner = (issue.path ?? []).map((segment) => String(typeof segment === "object" ? segment.key : segment));
            const at = [key.id, ...inner].join(".");

            issues.push(`${at}: ${issue.message}${who}`);
        }
    }

    issues.push(...variableIssues(ctx));

    return { ok: issues.length === 0, issues, summary: summaryOf(ctx) };
}

/** Resolves the root scope, then each target's and output's scope and values, as a build would. */
function variableIssues(ctx: Context): string[] {
    if (!ctx.services.has("variables.resolver")) {
        return [];
    }

    const resolver = ctx.services.get("variables.resolver");
    const targets = ctx.config.get<JsonValue[]>("compilation.targets") ?? [];
    const issues: string[] = [];
    const attempt = (work: () => void): boolean => {
        try {
            work();

            return true;
        } catch (error) {
            if (!(error instanceof SousError)) {
                throw error;
            }

            issues.push([error.message, ...error.details].join("\n"));

            return false;
        }
    };

    if (!attempt(() => resolver.scope({ level: "root" }))) {
        return issues;
    }

    for (const [target, value] of targets.entries()) {
        const { outputs, ...own } = (value ?? {}) as JsonObject;

        attempt(() => resolver.substituteValue(withoutVars(own), resolver.scope({ level: "target", target }), `compilation.targets[${target}]`));

        for (const [output, outputValue] of (Array.isArray(outputs) ? outputs : []).entries()) {
            attempt(() =>
                resolver.substituteValue(
                    withoutVars((outputValue ?? {}) as JsonObject),
                    resolver.scope({ level: "output", target, output }),
                    `compilation.targets[${target}].outputs[${output}]`,
                ),
            );
        }
    }

    return issues;
}

/** A value without its `_vars` block, which the scope already resolved. */
function withoutVars(value: JsonObject): JsonObject {
    const { _vars: _ignored, ...rest } = value;

    return rest;
}

/** The facts `config validate` prints under "Config is valid". */
function summaryOf(ctx: Context): ConfigValidateSummary {
    const confd = ctx.services.has("confd.files") ? ctx.services.get("confd.files").list().length : 0;
    const main = ctx.project?.configPath === undefined ? 0 : 1;
    const tools = ctx.config.get<JsonObject>("tools") ?? {};

    return {
        configFile: ctx.project?.configPath,
        layers: main + confd,
        targets: (ctx.config.get<JsonValue[]>("compilation.targets") ?? []).length,
        tools: Object.keys(tools),
    };
}

/** `plugins.show`: every loaded plugin, or the one named, with secrets in its options hidden. */
export function pluginsShow(input: PluginsShowInput, ctx: Context): PluginInfo[] {
    const policy = policyOf(ctx);
    const plugins = ctx.engine.plugins().map((plugin) => (plugin.options === undefined ? plugin : { ...plugin, options: redactValue(plugin.options, policy) }));

    if (input.name === undefined) {
        return plugins;
    }

    const found = plugins.filter((plugin) => plugin.name === input.name);

    if (found.length === 0) {
        throw new NotFoundError("plugin", input.name, `No plugin named "${input.name}" is loaded.`, {
            details: ["Run 'sous plugins show' to see every loaded plugin."],
        });
    }

    return found;
}

/** `timings.show`: every timing so far, slowest total first. */
export function timingsShow(input: TimingsShowInput, ctx: Context): TimingEntry[] {
    return ctx.engine.timings
        .entries()
        .filter((entry) => (input.overBudget !== true || entry.overBudget > 0) && (input.category === undefined || entry.category === input.category))
        .sort((a, b) => b.totalMs - a.totalMs);
}
