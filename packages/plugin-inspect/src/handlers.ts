/**
 * The handlers of plugin-inspect. Each reads only the engine and returns plain data; plugin-cli
 * decides how it looks. Secrets are hidden everywhere (G4).
 */

import {
    NotFoundError,
    type ConfigKeyEntity,
    type Context,
    type JsonObject,
    type JsonValue,
    type PluginInfo,
    type TimingEntry,
} from "@sous-io/plugin-api";
import { readRawConfigFiles } from "./raw.js";
import { HIDDEN, isSecretKey, redactLayer, redactValue } from "./redact.js";
import type {
    ConfigGetInput,
    ConfigGetResult,
    ConfigShowInput,
    ConfigShowResult,
    ConfigValidateResult,
    LayerView,
    PluginsShowInput,
    TimingsShowInput,
} from "./types.js";

/** Every change to a path, in order, with secrets hidden. */
function layersOf(ctx: Context, path: string): LayerView[] {
    return ctx.config.layers(path).map((layer) => redactLayer(layer));
}

/** `config.show`: the evaluated config, and with `layers` or `raw`, where it came from. */
export async function configShow(input: ConfigShowInput, ctx: Context): Promise<ConfigShowResult> {
    return {
        config: redactValue(ctx.config.value() as JsonObject),
        passes: ctx.config.passes,
        ...(input.layers === true ? { layers: layersOf(ctx, "") } : {}),
        ...(input.raw === true ? { raw: await readRawConfigFiles(ctx.project) } : {}),
    };
}

/** `config.get`: one value by path. A path with nothing at it gives `exists: false`. */
export async function configGet(input: ConfigGetInput, ctx: Context): Promise<ConfigGetResult> {
    const exists = ctx.config.has(input.path);
    const value = exists ? ctx.config.get<JsonValue>(input.path) : undefined;
    const lastKey = input.path.split(/[.[\]"]+/).filter((part) => part !== "").pop() ?? "";
    const shown = value === undefined ? undefined : isSecretKey(lastKey) ? HIDDEN : redactValue(value);

    return {
        path: input.path,
        exists,
        value: shown,
        passes: ctx.config.passes,
        ...(input.layers === true ? { layers: layersOf(ctx, input.path) } : {}),
        ...(input.raw === true ? { raw: await readRawConfigFiles(ctx.project) } : {}),
    };
}

/** `config.validate`: checks each config key's value against its schema, naming who set it. */
export async function configValidate(_input: unknown, ctx: Context): Promise<ConfigValidateResult> {
    const issues: string[] = [];

    for (const key of ctx.entities.list("config-key") as ConfigKeyEntity[]) {
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

    return { ok: issues.length === 0, issues };
}

/** `plugins.show`: every loaded plugin, or the one named. */
export function pluginsShow(input: PluginsShowInput, ctx: Context): PluginInfo[] {
    const plugins = ctx.engine.plugins();

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
