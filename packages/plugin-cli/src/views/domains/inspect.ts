/**
 * The views of plugin-inspect's intents (`config show`, `config get`, `config validate`,
 * `plugins show`, `timings show`) and of `version`. Ported from today's `src/commands/config/*.ts`,
 * `src/lib/config-inspect.ts` and `src/lib/version-report.ts`; `--layers` and `plugins show` follow
 * The output of `sous config show`, `get` and `plugins show`.
 */

import os from "node:os";
import { ConfigError, type ConfigLayer, type JsonObject, type JsonValue, type Patch, type PluginInfo, type TimingEntry } from "@sous-io/plugin-api";
import type { CliViewContext, CliViewEntity } from "../../types.js";
import { renderTimings } from "../../views.js";
import { isScalar, renderJson, truncateJson } from "../json.js";
import type { Printer } from "../printer.js";

/** One contributor's change, as plugin-inspect returns it. */
export interface LayerView extends ConfigLayer {
    readonly annotations?: Readonly<Record<string, unknown>>;
    /** The config file the contributor reads, from the `.sous` directory. */
    readonly source?: string;
    /** What the value was and became; a missing side means not set. */
    readonly change?: { readonly from?: JsonValue; readonly to?: JsonValue };
}

/** One config file as written. */
export interface RawConfigFile {
    readonly contributor: string;
    readonly path: string;
    readonly text: string;
}

/** The result of `config.show`. */
export interface ConfigShowResult {
    readonly config: JsonObject;
    readonly passes: number;
    readonly layers?: readonly LayerView[];
    readonly raw?: readonly RawConfigFile[];
}

/** The result of `config.get`. */
export interface ConfigGetResult {
    readonly path: string;
    readonly exists: boolean;
    readonly value: JsonValue | undefined;
    readonly passes: number;
    readonly layers?: readonly LayerView[];
    readonly raw?: readonly RawConfigFile[];
}

/** The result of `config.validate`. */
export interface ConfigValidateResult {
    readonly ok: boolean;
    readonly issues: readonly string[];
    readonly summary?: {
        readonly configFile: string | undefined;
        readonly layers: number;
        readonly targets: number;
        readonly tools: readonly string[];
    };
}

/**
 * `sous config show`: the config as pretty JSON, colored on a terminal so a pipe still gets valid
 * JSON. `--layers` shows every contributor's changes instead, and `--raw` each file as written.
 */
export function configShowView(result: ConfigShowResult, view: CliViewContext): string {
    if (!result.layers && !result.raw) {
        return `${renderJson(result.config, view.style)}\n`;
    }

    const out = view.printer();

    if (result.raw) {
        rawFiles(out, result.raw);
    }

    if (result.layers) {
        layerTree(out, result.layers);
        out.log(`${view.style.label("result")}  ${view.style.muted(`settled after ${plural(result.passes, "pass", "passes")}`)}`);
    }

    return out.text();
}

/**
 * `sous config get <path>`: a scalar prints raw (no quotes), so the output is usable as it is;
 * objects and arrays print as pretty JSON. A path with no value is a `ConfigError`, as before.
 * `--layers` shows each contributor's change to the value, then the result.
 *
 * ```text
 * $ sous config get name --layers
 * config-files/sous.config.jsonc   "demo"
 * confd/610-mac.jsonc              "demo-mac"
 * result                           "demo-mac"   (settled after 1 pass)
 * ```
 */
export function configGetView(result: ConfigGetResult, view: CliViewContext): string {
    const out = view.printer();

    if (result.raw) {
        rawFiles(out, result.raw);
    }

    if (result.layers) {
        if (!result.exists && result.layers.length === 0) {
            throw missingInLayers(result.path);
        }

        layerColumns(out, result, view);

        return out.text();
    }

    if (!result.exists || result.value === undefined) {
        throw missingValue(result.path);
    }

    out.log(isScalar(result.value) ? String(result.value) : renderJson(result.value, view.style));

    return out.text();
}

/**
 * `sous config validate`: "Config is valid" and what was checked, or each problem and exit code 1.
 *
 * ```text
 * ▶ Config is valid:
 *     Config File: /work/app/.sous/sous.config.json
 *     Layers     : 3
 *     Targets    : 2
 *     Tools      : claude
 * ```
 */
export function configValidateView(result: ConfigValidateResult, view: CliViewContext) {
    const out = view.printer();

    if (result.ok) {
        out.heading("Config is valid");

        if (result.summary) {
            out.variables({
                "Config File": result.summary.configFile ?? "(none)",
                Layers: result.summary.layers,
                Targets: result.summary.targets,
                Tools: result.summary.tools.length > 0 ? result.summary.tools.join(", ") : "(none)",
            });
        }

        out.footer();

        return out.text();
    }

    out.heading(`The config has ${plural(result.issues.length, "problem")}`);
    out.blank();

    for (const issue of result.issues) {
        const [first = "", ...rest] = issue.split("\n");

        out.paragraph(`${view.style.error("✗")} ${first}`, { indent: 4 });

        for (const line of rest) {
            out.log(line.trim() === "" ? "" : `      ${line}`);
        }
    }

    out.footer();

    return { stdout: out.text(), exitCode: 1 };
}

/** What each kind of registration is called in `plugins show`. */
const REGISTRATION_LABELS: Readonly<Record<string, string>> = {
    intent: "intents",
    "intent wrapper": "wraps intents",
    service: "services",
    "service replacement": "replaces",
    "service wrapper": "wraps",
    "entity kind": "entity kinds",
    entity: "entities",
    contributor: "contributors",
    "front end": "front ends",
    listener: "listeners",
};

/** The width of the label column in `plugins show`. */
const PLUGIN_LABEL_WIDTH = 17;

/**
 * `sous plugins show`: every plugin, and what it registered, wrapped or replaced.
 *
 * ```text
 * plugin-claude-code (built in)
 *   entities           harness: claude    skill-target: claude-code
 *   listeners          build.after
 * sous-plugin-mcp-extras (loaded by sous-plugin-claude-code)
 *   options            { "port": 7801 }
 * ```
 */
export function pluginsShowView(result: readonly PluginInfo[], view: CliViewContext): string {
    const out = view.printer();
    const style = view.style;

    for (const plugin of result) {
        const notes = [plugin.builtIn ? "built in" : plugin.loadedBy ? `loaded by ${plugin.loadedBy}` : undefined, plugin.active ? undefined : "inactive"].filter(
            (note): note is string => note !== undefined,
        );
        const version = plugin.version ? ` ${style.muted(plugin.version)}` : "";

        out.log(`${style.value(plugin.name)}${version}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`);

        const groups = new Map<string, string[]>();

        for (const registration of plugin.registrations) {
            const label = REGISTRATION_LABELS[registration.kind] ?? registration.kind;
            const names = groups.get(label) ?? [];

            names.push(registration.name);
            groups.set(label, names);
        }

        for (const [label, names] of groups) {
            pluginRow(out, label, names);
        }

        if (plugin.options && Object.keys(plugin.options).length > 0) {
            pluginRow(out, "options", [JSON.stringify(plugin.options, null, 1).replace(/\n\s*/g, " ")]);
        }
    }

    return out.text();
}

/** `sous timings show`: one line per timing, slowest first. */
export function timingsShowView(result: readonly TimingEntry[]): string {
    return result.length === 0 ? "No timings yet.\n" : renderTimings(result);
}

/**
 * `sous version`: `v1.2.3`, as `sous --version` printed before the refactor; with `--verbose`, the
 * package, where it is installed, the platform and the Node build under it.
 */
export function versionView(result: string | { name: string; version: string; root?: string }, view: CliViewContext): string {
    if (typeof result === "string") {
        return `v${result}\n`;
    }

    const out = view.printer();

    out.log(`v${result.version}`);
    out.variables({ Package: result.name, ...(result.root === undefined ? {} : { Install: result.root }), Platform: `${os.platform()}-${os.arch()}`, Node: process.version });

    return out.text();
}

/** The views of this domain, by intent. */
export const views: Record<string, CliViewEntity["render"]> = {
    "config.show": configShowView,
    "config.get": configGetView,
    "config.validate": configValidateView,
    "plugins.show": pluginsShowView,
    "timings.show": timingsShowView,
    version: versionView,
};

// ------------------------------------------------------------------ helpers

function missingValue(path: string): ConfigError {
    return new ConfigError(`No value at config path '${path}'.`, {
        details: ["It is not present in the built config.", "Run 'sous config show' to see the whole config."],
    });
}

function missingInLayers(path: string): ConfigError {
    return new ConfigError(`No value at config path '${path}' in any config layer.`, {
        details: ["Run 'sous config show' to see the whole config."],
    });
}

/** One row of `plugins show`: the label, then the items four spaces apart, as many to a line as fit. */
function pluginRow(out: Printer, label: string, items: readonly string[]): void {
    const pad = 2 + PLUGIN_LABEL_WIDTH + 2;
    const width = Math.max(20, out.wrapWidth - pad);
    const lines: string[] = [];

    for (const item of items) {
        const last = lines.at(-1);

        if (last !== undefined && last.length + 4 + item.length <= width) {
            lines[lines.length - 1] = `${last}    ${item}`;
        } else {
            lines.push(item);
        }
    }

    lines.forEach((line, index) => {
        out.log(index === 0 ? `  ${out.style.label(label.padEnd(PLUGIN_LABEL_WIDTH))}  ${line}` : `${" ".repeat(pad)}${line}`);
    });
}

function rawFiles(out: Printer, files: readonly RawConfigFile[]): void {
    for (const file of files) {
        out.log(out.style.muted(`# ${file.path} (${file.contributor})`));
        out.log(file.text.replace(/\n$/, ""));
        out.log("");
    }
}

/**
 * `config show --layers`: each contributor with its apply order, then the helpers around each
 * change and the change itself, indented under them. When `before` or `after` moved the
 * contributor, both numbers show.
 *
 * ```text
 * conf.d/620-no-diagrams.js (confd/620-no-diagrams.js, @sous-io/plugin-confd, apply order 90620)
 *   removeWhere
 *     removeIndex compilation.targets[7]
 * claude-code/late-fixups (plugin-claude-code, apply order 0, moved to 90621)
 *   setKey compilation.overwriteUntracked = false
 * ```
 */
function layerTree(out: Printer, layers: readonly LayerView[]): void {
    const style = out.style;
    let contributor: string | undefined;
    let open: string[] = [];

    for (const layer of layers) {
        if (layer.contributor !== contributor) {
            contributor = layer.contributor;
            open = [];
            const details = [...(layer.source ? [layer.contributor] : []), layer.plugin, ...applyOrderText(layer)];

            out.log(`${style.value(layer.source ?? layer.contributor)} ${style.muted(`(${details.join(", ")})`)}`);
        }

        let depth = 0;

        while (depth < open.length && depth < layer.helpers.length && open[depth] === layer.helpers[depth]) {
            depth++;
        }

        open = open.slice(0, depth);

        for (; depth < layer.helpers.length; depth++) {
            out.log(`${"  ".repeat(depth + 1)}${style.label(layer.helpers[depth]!)}`);
            open.push(layer.helpers[depth]!);
        }

        out.log(`${"  ".repeat(layer.helpers.length + 1)}${describePatch(layer.patch, style.muted)}`);
        annotationLines(out, layer, "  ".repeat(layer.helpers.length + 2));
    }
}

/** `apply order 50`, or `apply order 10, moved to 51` when `before` or `after` moved it. */
function applyOrderText(layer: LayerView): string[] {
    return layer.actualApplyOrder === layer.applyOrder
        ? [`apply order ${layer.applyOrder}`]
        : [`apply order ${layer.applyOrder}, moved to ${layer.actualApplyOrder}`];
}

/**
 * `config get --layers`: each config file (or contributor) that changed the value on the left, what
 * the value was and became on the right, then the result.
 */
function layerColumns(out: Printer, result: ConfigGetResult, view: CliViewContext): void {
    const style = view.style;
    const layers = result.layers ?? [];
    const labelOf = (layer: LayerView): string => layer.source ?? layer.contributor;
    const width = Math.max("result".length, ...layers.map((layer) => labelOf(layer).length)) + 3;

    for (const layer of layers) {
        const text = layer.change ? `${shownOrUnset(layer.change, "from")} ${style.muted("->")} ${shownOrUnset(layer.change, "to")}` : changeAt(layer.patch, result.path);

        out.log(`${style.label(labelOf(layer).padEnd(width))}${text}`);
        annotationLines(out, layer, " ".repeat(width));
    }

    const shown = result.exists && result.value !== undefined ? truncateJson(result.value) : "(not set)";
    const passes = style.muted(`(settled after ${plural(result.passes, "pass", "passes")})`);

    out.log(`${style.label("result".padEnd(width))}${style.value(shown)}   ${passes}`);
}

/** One side of a change: the value as short JSON, or `(unset)`. */
function shownOrUnset(change: NonNullable<LayerView["change"]>, side: "from" | "to"): string {
    return side in change && change[side] !== undefined ? truncateJson(change[side]) : "(unset)";
}

/** What one change did, read from the value's own path: the value set, or the operation. */
function changeAt(patch: Patch, path: string): string {
    const target = targetOf(patch);

    if (target === path) {
        switch (patch.op) {
            case "setKey":
            case "setIndex":
            case "insertAt":
                return truncateJson(patch.value);
            case "deleteKey":
            case "removeIndex":
                return "(not set)";
            case "renameKey":
                return `(renamed to ${patch.to})`;
        }
    }

    return describePatch(patch, (text) => text);
}

/** A change as one line: `setKey name = "demo"`. */
function describePatch(patch: Patch, muted: (text: string) => string): string {
    const target = targetOf(patch);

    switch (patch.op) {
        case "setKey":
        case "setIndex":
        case "insertAt":
            return `${patch.op} ${target} ${muted("=")} ${truncateJson(patch.value)}`;
        case "renameKey":
            return `${patch.op} ${target} ${muted("→")} ${patch.to}`;
        default:
            return `${patch.op} ${target}`;
    }
}

/** The path a change touches: the object's path with the key or index added. */
function targetOf(patch: Patch): string {
    const base = patch.path;

    if (patch.op === "setIndex" || patch.op === "insertAt" || patch.op === "removeIndex") {
        return `${base}[${patch.index}]`;
    }

    if (/^[A-Za-z_$][\w$-]*$/.test(patch.key)) {
        return base === "" ? patch.key : `${base}.${patch.key}`;
    }

    return `${base}${base === "" ? "" : "."}"${patch.key}"`;
}

/** What a plugin explained about a change (an expression and what it read), muted under it. */
function annotationLines(out: Printer, layer: LayerView, pad: string): void {
    for (const [key, value] of Object.entries(layer.annotations ?? {})) {
        const text = typeof value === "string" ? value : truncateJson(value);

        out.log(`${pad}${out.style.muted(`${key}: ${text}`)}`);
    }
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
    return `${count} ${count === 1 ? singular : pluralForm}`;
}
