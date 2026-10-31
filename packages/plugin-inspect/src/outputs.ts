/**
 * What the inspect intents show: the config as data, the layers of a value as a tree or a table,
 * the validation result, every plugin and what it registered, and the timings. Each builder
 * returns outputs; the handlers add the machine data to the last one.
 */

import {
    ConfigError,
    DataValue,
    IntentOutput,
    ReportEntryStyle,
    Table,
    TextBlock,
    Tree,
    VariableSet,
    type Patch,
    type PluginInfo,
    type TableColumn,
    type TimingEntry,
    type TreeNode,
    type VariableEntry,
} from "@sous-io/plugin-api";
import type { ConfigGetResult, ConfigShowResult, ConfigValidateResult, LayerView, RawConfigFile } from "./types.js";

/** The outputs with `data` set on the last one, which is what machines get. */
export function withData<T extends object>(outputs: readonly IntentOutput[], data: T): IntentOutput[] {
    const last = outputs[outputs.length - 1];

    if (last === undefined) {
        return [new IntentOutput({ data })];
    }

    return [...outputs.slice(0, -1), new IntentOutput<T>({ title: last.title, summary: last.summary, result: last.result, style: last.style, data })];
}

/** A value as JSON on one line, cut to `max` characters with an ellipsis. */
function truncateJson(value: unknown, max = 80): string {
    const encoded = JSON.stringify(value);

    if (encoded === undefined) {
        return "undefined";
    }

    return encoded.length > max ? `${encoded.slice(0, max - 1)}…` : encoded;
}

/** Whether a value is a JSON scalar: a string, number, boolean or `null`. */
function isScalar(value: unknown): value is string | number | boolean | null {
    return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
    return `${count} ${count === 1 ? singular : pluralForm}`;
}

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

/** Each config file as written, verbatim, under a line naming the file and its contributor. */
function rawFileOutputs(files: readonly RawConfigFile[]): IntentOutput[] {
    return files.map((file) => new IntentOutput({ result: new TextBlock(`# ${file.path} (${file.contributor})\n${file.text.replace(/\n$/, "")}`, { verbatim: true }) }));
}

// ---------------------------------------------------------------------------------------------
// config show
// ---------------------------------------------------------------------------------------------

/**
 * `sous config show`: the config as data. `--layers` shows every contributor's changes instead,
 * and `--raw` each file as written.
 */
export function configShowOutputs(result: ConfigShowResult): IntentOutput[] {
    if (!result.layers && !result.raw) {
        return withData([new IntentOutput({ result: new DataValue(result.config) })], result);
    }

    const outputs: IntentOutput[] = [];

    if (result.raw) {
        outputs.push(...rawFileOutputs(result.raw));
    }

    if (result.layers) {
        outputs.push(new IntentOutput({ result: layerTree(result.layers) }));
        outputs.push(new IntentOutput({ result: new VariableSet([{ label: "result", value: `settled after ${plural(result.passes, "pass", "passes")}` }]) }));
    }

    return withData(outputs, result);
}

// ---------------------------------------------------------------------------------------------
// config get
// ---------------------------------------------------------------------------------------------

/**
 * `sous config get <path>`: a scalar is the bare value, with no quotes, so a script can use it as
 * it is; an object or an array is data. A path with no value is a `ConfigError`. `--layers` shows
 * each contributor's change to the value, then the result.
 *
 * ```text
 * $ sous config get name --layers
 * config-files/sous.config.jsonc   "demo"
 * confd/610-mac.jsonc              "demo-mac"
 * result                           "demo-mac"   (settled after 1 pass)
 * ```
 */
export function configGetOutputs(result: ConfigGetResult): IntentOutput[] {
    const outputs: IntentOutput[] = result.raw ? rawFileOutputs(result.raw) : [];

    if (result.layers) {
        if (!result.exists && result.layers.length === 0) {
            throw missingInLayers(result.path);
        }

        outputs.push(new IntentOutput({ result: layerTable(result) }));

        const shown = result.exists && result.value !== undefined ? truncateJson(result.value) : "(not set)";

        outputs.push(new IntentOutput({ result: new VariableSet([{ label: "result", value: shown, detail: `settled after ${plural(result.passes, "pass", "passes")}` }]) }));

        return withData(outputs, result);
    }

    if (!result.exists || result.value === undefined) {
        throw missingValue(result.path);
    }

    outputs.push(new IntentOutput({ result: isScalar(result.value) ? new TextBlock(String(result.value), { verbatim: true }) : new DataValue(result.value) }));

    return withData(outputs, result);
}

// ---------------------------------------------------------------------------------------------
// config validate
// ---------------------------------------------------------------------------------------------

/**
 * `sous config validate`: "Config is valid" and what was checked, or the number of problems and
 * each problem (the caller ends the command with exit code 1).
 *
 * ```text
 * Config is valid
 *   Config File: /work/app/.sous/sous.config.json
 *   Layers     : 3
 *   Targets    : 2
 *   Tools      : claude
 * ```
 */
export function configValidateOutputs(result: ConfigValidateResult): IntentOutput[] {
    if (result.ok) {
        const summary = result.summary;

        return withData(
            [
                new IntentOutput({
                    title: "Config is valid",
                    ...(summary === undefined
                        ? {}
                        : {
                              result: new VariableSet({
                                  "Config File": summary.configFile ?? "(none)",
                                  Layers: summary.layers,
                                  Targets: summary.targets,
                                  Tools: summary.tools.length > 0 ? summary.tools.join(", ") : "(none)",
                              }),
                          }),
                }),
            ],
            result,
        );
    }

    return withData(
        [
            new IntentOutput({ title: `The config has ${plural(result.issues.length, "problem")}` }),
            ...result.issues.map((issue) => new IntentOutput({ result: new TextBlock(issue), style: ReportEntryStyle.Problem })),
        ],
        result,
    );
}

// ---------------------------------------------------------------------------------------------
// plugins show
// ---------------------------------------------------------------------------------------------

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
 * `sous plugins show`: one output per plugin, titled with its name and version and what is notable
 * about it, holding what it registered, wrapped or replaced.
 *
 * ```text
 * plugin-claude-code (built in)
 *   entities           harness: claude    skill-target: claude-code
 *   listeners          build.after
 * sous-plugin-mcp-extras (loaded by sous-plugin-claude-code)
 *   options            { "port": 7801 }
 * ```
 */
export function pluginsShowOutputs(plugins: readonly PluginInfo[]): IntentOutput[] {
    return plugins.map((plugin) => {
        const notes = [plugin.builtIn ? "built in" : plugin.loadedBy ? `loaded by ${plugin.loadedBy}` : undefined, plugin.active ? undefined : "inactive"].filter(
            (note): note is string => note !== undefined,
        );
        const version = plugin.version ? ` ${plugin.version}` : "";
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

        const title = `${plugin.name}${version}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`;

        return new IntentOutput(entries.length > 0 ? { title, result: new VariableSet(entries) } : { title });
    });
}

// ---------------------------------------------------------------------------------------------
// timings show
// ---------------------------------------------------------------------------------------------

/** `sous timings show`: one row per timing, slowest first. */
export function timingsShowOutput(entries: readonly TimingEntry[]): IntentOutput {
    const rows = [...entries]
        .sort((a, b) => b.totalMs - a.totalMs)
        .map((entry) => ({
            name: entry.key,
            calls: entry.count,
            total: `${entry.totalMs.toFixed(1)} ms`,
            max: `${entry.maxMs.toFixed(1)} ms`,
            budget: `${entry.budgetMs === false ? "no budget warning" : `budget ${entry.budgetMs} ms`}${entry.overBudget > 0 ? `, ${entry.overBudget} over` : ""}`,
        }));

    return new IntentOutput({
        result: new Table(
            [
                { key: "name", header: "Name", overflow: "truncate", truncate: "middle" },
                { key: "calls", header: "Calls", kind: "number" },
                { key: "total", header: "Total", kind: "number" },
                { key: "max", header: "Max", kind: "number" },
                { key: "budget", header: "Budget", priority: "low" },
            ],
            rows,
            { title: "Timings", empty: "No timings yet." },
        ),
    });
}

// ---------------------------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------------------------

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
function layerTree(layers: readonly LayerView[]): Tree {
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

    return new Tree(roots as TreeNode[]);
}

/** `apply order 50`, or `apply order 10, moved to 51` when `before` or `after` moved it. */
function applyOrderText(layer: LayerView): string[] {
    return layer.actualApplyOrder === layer.applyOrder ? [`apply order ${layer.applyOrder}`] : [`apply order ${layer.applyOrder}, moved to ${layer.actualApplyOrder}`];
}

/** The columns of `config get --layers`. */
const LAYER_COLUMNS: TableColumn[] = [
    { key: "source", header: "Config", overflow: "truncate", kind: "path" },
    { key: "change", header: "Change", overflow: "wrap", flex: 1 },
];

/**
 * `config get --layers`: each config file (or contributor) that changed the value on the left, what
 * the value was and became on the right.
 */
function layerTable(result: ConfigGetResult): Table {
    const rows: Array<Record<string, string>> = [];

    for (const layer of result.layers ?? []) {
        const text = layer.change ? `${shownOrUnset(layer.change, "from")} -> ${shownOrUnset(layer.change, "to")}` : changeAt(layer.patch, result.path);

        rows.push({ source: layer.source ?? layer.contributor, change: text });

        for (const line of annotationLines(layer)) {
            rows.push({ source: "", change: line });
        }
    }

    return new Table(LAYER_COLUMNS, rows);
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
