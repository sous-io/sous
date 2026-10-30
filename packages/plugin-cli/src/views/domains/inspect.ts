/**
 * The views of plugin-inspect's intents (`config show`, `config get`, `config validate`,
 * `plugins show`, `timings show`) and of `version`. Ported from today's `src/commands/config/*.ts`,
 * `src/lib/config-inspect.ts` and `src/lib/version-report.ts`; `--layers` and `plugins show` follow
 * The output of `sous config show`, `get` and `plugins show`.
 */

import os from "node:os";
import {
    ConfigError,
    type ConfigLayer,
    type JsonObject,
    type JsonValue,
    LogLevel,
    type Patch,
    type PluginInfo,
    type Reporter,
    type TableColumn,
    type TimingEntry,
    type VariableEntry,
} from "@sous-io/plugin-api";
import type { CliViewContext, CliViewEntity, CliViewOutput } from "../../types.js";
import { reportTimings } from "../../views.js";
import { isScalar, truncateJson } from "../json.js";

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
export function configShowView(result: ConfigShowResult, view: CliViewContext): void {
    const reporter = view.reporter;

    if (!result.layers && !result.raw) {
        reporter.data(result.config);

        return;
    }

    if (result.raw) {
        rawFiles(reporter, result.raw);
    }

    if (result.layers) {
        layerTree(reporter, result.layers);
        reporter.variable("result", `settled after ${plural(result.passes, "pass", "passes")}`);
    }
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
export function configGetView(result: ConfigGetResult, view: CliViewContext): void {
    const reporter = view.reporter;

    if (result.raw) {
        rawFiles(reporter, result.raw);
    }

    if (result.layers) {
        if (!result.exists && result.layers.length === 0) {
            throw missingInLayers(result.path);
        }

        layerColumns(reporter, result);

        return;
    }

    if (!result.exists || result.value === undefined) {
        throw missingValue(result.path);
    }

    if (isScalar(result.value)) {
        reporter.text(String(result.value));
    } else {
        reporter.data(result.value);
    }
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
export function configValidateView(result: ConfigValidateResult, view: CliViewContext): CliViewOutput {
    const reporter = view.reporter;

    if (result.ok) {
        reporter.operationStart("Config is valid", LogLevel.Info);

        if (result.summary) {
            reporter.variables({
                "Config File": result.summary.configFile ?? "(none)",
                Layers: result.summary.layers,
                Targets: result.summary.targets,
                Tools: result.summary.tools.length > 0 ? result.summary.tools.join(", ") : "(none)",
            });
        }

        return;
    }

    reporter.operationStart(`The config has ${plural(result.issues.length, "problem")}`, LogLevel.Info);

    for (const issue of result.issues) {
        const [first = "", ...rest] = issue.split("\n");
        const cause = rest.join("\n").trim();

        reporter.problem(first, cause === "" ? {} : { cause: rest.join("\n") }, LogLevel.Error);
    }

    return { exitCode: 1 };
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
export function pluginsShowView(result: readonly PluginInfo[], view: CliViewContext): void {
    const reporter = view.reporter;

    for (const plugin of result) {
        const notes = [plugin.builtIn ? "built in" : plugin.loadedBy ? `loaded by ${plugin.loadedBy}` : undefined, plugin.active ? undefined : "inactive"].filter(
            (note): note is string => note !== undefined,
        );
        const version = plugin.version ? ` ${plugin.version}` : "";

        reporter.stepStart(`${plugin.name}${version}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`, LogLevel.Info);

        const groups = new Map<string, string[]>();

        for (const registration of plugin.registrations) {
            const label = REGISTRATION_LABELS[registration.kind] ?? registration.kind;
            const names = groups.get(label) ?? [];

            names.push(registration.name);
            groups.set(label, names);
        }

        const entries: VariableEntry[] = [...groups].map(([label, names]) => ({ label, value: names.join("    ") }));

        if (plugin.options && Object.keys(plugin.options).length > 0) {
            entries.push({ label: "options", value: JSON.stringify(plugin.options, null, 1).replace(/\n\s*/g, " ") });
        }

        if (entries.length > 0) {
            reporter.variables(entries);
        }
    }
}

/** `sous timings show`: one line per timing, slowest first. */
export function timingsShowView(result: readonly TimingEntry[], view: CliViewContext): void {
    if (result.length === 0) {
        view.reporter.info("No timings yet.");
    } else {
        reportTimings(view.reporter, result);
    }
}

/**
 * `sous version`: `v1.2.3`, as `sous --version` printed before the refactor; with `--verbose`, the
 * package, where it is installed, the platform and the Node build under it.
 */
export function versionView(result: string | { name: string; version: string; root?: string }, view: CliViewContext): void {
    if (typeof result === "string") {
        view.reporter.text(`v${result}`);

        return;
    }

    view.reporter.text(`v${result.version}`);
    view.reporter.variables({ Package: result.name, ...(result.root === undefined ? {} : { Install: result.root }), Platform: `${os.platform()}-${os.arch()}`, Node: process.version });
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

function rawFiles(reporter: Reporter, files: readonly RawConfigFile[]): void {
    for (const file of files) {
        reporter.text(`# ${file.path} (${file.contributor})\n${file.text.replace(/\n$/, "")}`);
    }
}

/**
 * `config show --layers`: each contributor with its apply order, then the helpers around each
 * change and the change itself. When `before` or `after` moved the contributor, both numbers show.
 * A tree: each contributor, the helpers it went through, each change under its helpers, and what a
 * plugin explained about a change under the change.
 *
 * ```text
 * conf.d/620-no-diagrams.js (confd/620-no-diagrams.js, @sous-io/plugin-confd, apply order 90620)
 *   removeWhere > removeIndex compilation.targets[7]
 * claude-code/late-fixups (plugin-claude-code, apply order 0, moved to 90621)
 *   setKey compilation.overwriteUntracked = false
 * ```
 */
function layerTree(reporter: Reporter, layers: readonly LayerView[]): void {
    /** A tree node still being filled. */
    interface OpenNode {
        label: string;
        detail?: string;
        children: OpenNode[];
    }

    const roots: OpenNode[] = [];
    let contributor: string | undefined;

    for (const layer of layers) {
        if (layer.contributor !== contributor || roots.length === 0) {
            contributor = layer.contributor;
            const details = [...(layer.source ? [layer.contributor] : []), layer.plugin, ...applyOrderText(layer)];

            roots.push({ label: layer.source ?? layer.contributor, detail: details.join(", "), children: [] });
        }

        // Helpers shared with the change before stay one node; the change hangs under the last helper.
        let parent = roots[roots.length - 1]!;

        for (const helper of layer.helpers) {
            const last = parent.children[parent.children.length - 1];

            if (last !== undefined && last.label === helper && last.children.length > 0) {
                parent = last;
            } else {
                const node: OpenNode = { label: helper, children: [] };

                parent.children.push(node);
                parent = node;
            }
        }

        parent.children.push({ label: describePatch(layer.patch), children: annotationLines(layer).map((line) => ({ label: line, children: [] })) });
    }

    reporter.tree(roots);
}

/** `apply order 50`, or `apply order 10, moved to 51` when `before` or `after` moved it. */
function applyOrderText(layer: LayerView): string[] {
    return layer.actualApplyOrder === layer.applyOrder
        ? [`apply order ${layer.applyOrder}`]
        : [`apply order ${layer.applyOrder}, moved to ${layer.actualApplyOrder}`];
}

/** The columns of `config get --layers`. */
const LAYER_COLUMNS: TableColumn[] = [
    { key: "source", header: "Config", overflow: "truncate", kind: "path" },
    { key: "change", header: "Change", overflow: "wrap", flex: 1 },
];

/**
 * `config get --layers`: each config file (or contributor) that changed the value on the left, what
 * the value was and became on the right, then the result.
 */
function layerColumns(reporter: Reporter, result: ConfigGetResult): void {
    const layers = result.layers ?? [];
    const rows: Array<Record<string, string>> = [];

    for (const layer of layers) {
        const text = layer.change ? `${shownOrUnset(layer.change, "from")} -> ${shownOrUnset(layer.change, "to")}` : changeAt(layer.patch, result.path);

        rows.push({ source: layer.source ?? layer.contributor, change: text });

        for (const line of annotationLines(layer)) {
            rows.push({ source: "", change: line });
        }
    }

    reporter.table(LAYER_COLUMNS, rows);

    const shown = result.exists && result.value !== undefined ? truncateJson(result.value) : "(not set)";

    reporter.variable("result", shown, `settled after ${plural(result.passes, "pass", "passes")}`);
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

    return describePatch(patch);
}

/** A change as one line: `setKey name = "demo"`. */
function describePatch(patch: Patch): string {
    const target = targetOf(patch);

    switch (patch.op) {
        case "setKey":
        case "setIndex":
        case "insertAt":
            return `${patch.op} ${target} = ${truncateJson(patch.value)}`;
        case "renameKey":
            return `${patch.op} ${target} → ${patch.to}`;
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

/** What a plugin explained about a change (an expression and what it read), as `key: text` lines. */
function annotationLines(layer: LayerView): string[] {
    return Object.entries(layer.annotations ?? {}).map(([key, value]) => `${key}: ${typeof value === "string" ? value : truncateJson(value)}`);
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
    return `${count} ${count === 1 ? singular : pluralForm}`;
}
