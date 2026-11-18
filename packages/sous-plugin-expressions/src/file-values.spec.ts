/**
 * `$file`: an object whose only key is `$file` stands in for the value a file holds. Its path is
 * relative to the data's own folder and interpolated for `${name}`; JSON, JSONC and YAML give a
 * structured value, anything else a string; a `.tpl.` file is rendered as Liquid first; every `${`
 * in the result is escaped, so nothing in the file is interpolated later. And `harness.id`, which
 * every expression can read and which is `""` when no harness is known.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EntityReader, JsonValue, ServiceReader } from "@sous-io/sous-plugin-api";
import type { VariablesResolver, VarScope } from "@sous-io/sous-plugin-variables/types";
import { createEvaluator, escapeVariables } from "./evaluator.js";
import { fakeBuilder } from "../test/helpers.js";

const noEntities: EntityReader = { get: () => undefined, list: () => [], has: () => false, describe: () => [], kinds: () => [] };

/** A resolver stand-in: root `_vars` and `extra`, with `${name}` substitution and the `$${` escape. */
function resolver(): VariablesResolver {
    const pattern = /(\$?)\$\{([^}]+)\}/g;
    const references = (text: string) => [...text.matchAll(pattern)].filter((match) => match[1] === "").map((match) => match[2]!);

    return {
        scopeIn: (config: { atPath(path: string): { get(): unknown } }, request: { extra?: VarScope } = {}) => ({
            ...((config.atPath("_vars").get() as VarScope | undefined) ?? {}),
            ...request.extra,
        }),
        references,
        unresolved: (text: string, scope: VarScope = {}) => references(text).filter((name) => !Object.hasOwn(scope, name)),
        substitute: (text: string, scope: VarScope) =>
            text.replace(pattern, (match, escape: string, name: string) => (escape ? match.slice(1) : (scope[name] ?? match))),
    } as unknown as VariablesResolver;
}

/** A `formats.manifests` stand-in that records what it was asked to parse. */
const parsed: string[] = [];
const manifests = {
    parseText(text: string, fileName: string): unknown {
        parsed.push(fileName);

        return fileName.endsWith(".yaml") ? { yaml: text.trim() } : JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
    },
};

function services(): ServiceReader {
    const resolved = resolver();

    return {
        get: (name: string) => {
            if (name === "variables.resolver") return resolved;
            if (name === "formats.manifests") return manifests;
            throw new Error(`no service ${name}`);
        },
        has: (name: string) => name === "variables.resolver" || name === "formats.manifests",
    } as ServiceReader;
}

let dir: string;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sous-file-values-"));
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

function write(name: string, text: string): string {
    const file = path.join(dir, name);

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);

    return file;
}

/** Evaluates data whose `$file` paths are relative to the temporary folder. */
function run(data: unknown, options: { vars?: Record<string, string>; harness?: string } = {}) {
    const evaluator = createEvaluator({
        services: services(),
        entities: noEntities,
        project: undefined,
        platform: "linux",
    });
    const { builder } = fakeBuilder({ _vars: options.vars ?? {} });

    // The engine gives each config build its harness on the builder.
    Object.assign(builder, { harness: { id: options.harness ?? "" } });
    const result = evaluator.evaluateLayer(data as JsonValue, { file: "sous.recipe.yaml", config: builder, baseDir: dir });

    return { ...result, evaluator };
}

describe("$file", () => {
    /**
     * edits:
     *   - file: .claude/settings.json
     *     set: { path: permissions.deny, value: { $file: documents/deny-rules.json } }
     * // value -> ["Bash(rm:*)"]
     */
    it("should give a JSON file's structured value, relative to the data's folder", () => {
        write("documents/deny-rules.json", '["Bash(rm:*)"]');

        expect(run({ value: { $file: "documents/deny-rules.json" } }).value).toEqual({ value: ["Bash(rm:*)"] });
    });

    /** YAML and JSONC are structured too, parsed by sous-plugin-formats' reader (a stand-in here). */
    it("should parse YAML and JSONC by their extension", () => {
        parsed.length = 0;
        write("server.yaml", "command: npx\n");
        write("rules.jsonc", '// rules\n["a"]');

        expect(run({ a: { $file: "server.yaml" }, b: { $file: "rules.jsonc" } }).value).toEqual({ a: { yaml: "command: npx" }, b: ["a"] });
        expect(parsed).toEqual(["server.yaml", "rules.jsonc"]);
    });

    /** Any other file gives its text as a string. */
    it("should give any other file as a string", () => {
        write("notes.md", "# Notes\n");

        expect(run({ text: { $file: "notes.md" } }).value).toEqual({ text: "# Notes\n" });
    });

    /**
     * Nothing in the file is interpolated: every `${` is escaped as `$${`, which the reader's
     * substitution turns back into `${`.
     */
    it("should escape every ${ in what the file gives", () => {
        write("hook.txt", 'bash "${CLAUDE_PLUGIN_ROOT}/x.sh"');

        expect(run({ command: { $file: "hook.txt" } }).value).toEqual({ command: 'bash "$${CLAUDE_PLUGIN_ROOT}/x.sh"' });
    });

    /** The path is interpolated for variables: `${shared}/rules.json`. */
    it("should interpolate the path", () => {
        write("shared/rules.json", "[1]");

        expect(run({ v: { $file: "${shared}/rules.json" } }, { vars: { shared: path.join(dir, "shared") } }).value).toEqual({ v: [1] });
    });

    /** A path whose variable nobody sets yet gives `undefined` for this pass, as an expression does. */
    it("should wait for a variable the path reads that is not set yet", () => {
        const result = run({ v: { $file: "${later}/rules.json" } });

        expect(result.value).toEqual({});
        expect(result.pending).toBe(true);
    });

    /** A `.tpl.` file is rendered as Liquid first, with the variables and `host` and `harness`. */
    it("should render a .tpl. file as Liquid before parsing it", () => {
        write("server.tpl.json", '{"mode": "{{ mode }}", "os": "{{ host.platform }}", "harness": "{{ harness.id }}"}');

        expect(run({ v: { $file: "server.tpl.json" } }, { vars: { mode: "strict" }, harness: "codex" }).value).toEqual({
            v: { mode: "strict", os: "linux", harness: "codex" },
        });
    });

    /** It combines with `$if`: the file is read only when its branch is chosen. */
    it("should combine with $if", () => {
        write("codex.json", '{"a": 1}');

        expect(run({ v: { $if: { expr: "harness.id == 'codex'", then: { $file: "codex.json" } } } }, { harness: "codex" }).value).toEqual({ v: { a: 1 } });
        expect(run({ v: { $if: { expr: "harness.id == 'codex'", then: { $file: "missing.json" } } } }, { harness: "claude-code" }).value).toEqual({});
    });

    /** Every file read is listed, so watch mode rebuilds the config when one changes. */
    it("should list every file it read", () => {
        const file = write("a.json", "1");

        expect(run({ v: { $file: "a.json" } }).evaluator.files()).toEqual([file]);
    });

    /** `$file` holds no other key, and a missing file is an error naming it. */
    it("should refuse a $file mixed with other keys, and a file it cannot read", () => {
        expect(() => run({ v: { $file: "a.json", then: 1 } })).toThrow(/mixes "\$file" with "then"/);
        expect(() => run({ v: { $file: "nope.json" } })).toThrow(/nope\.json, which could not be read/);
    });
});

describe("harness.id", () => {
    /** With no harness known, `harness.id` is the empty string, never an unknown variable. */
    it("should be the empty string when no harness is known", () => {
        const result = run({ a: { $expr: "harness.id" }, b: { $if: "harness.id == ''" } });

        expect(result.value).toEqual({ a: "", b: true });
        expect(result.pending).toBe(false);
    });

    /** With a harness, conditions read its id. */
    it("should read the harness the config is built for", () => {
        expect(run({ a: { $if: { expr: "harness.id == 'claude-code'", then: "yes" }, $else: "no" } }, { harness: "claude-code" }).value).toEqual({ a: "yes" });
    });
});

describe("boolean variables (gh-161, ADR 0038)", () => {
    /**
     * A recipe variable of type boolean answered false is the text "false"; a condition on it
     * takes the false branch, because the variable source names it a boolean.
     *
     * exclude: [{ $if: { expr: "jiraEnabled", then: "skills/jira/**" } }]  // jiraEnabled "false" -> dropped
     */
    it("should read a boolean answered false as false", () => {
        const evaluator = createEvaluator({ services: services(), entities: noEntities, project: undefined, platform: "linux" });
        const source = { id: "recipe-answers", description: "recipe answers", variables: () => ({}), booleans: () => ["jiraEnabled"] };
        const { builder } = fakeBuilder({ _vars: { jiraEnabled: "false", other: "false" } }, { "variable-source": [source] });
        const data = { a: { $if: "jiraEnabled" }, b: { $if: "other" }, c: { $if: { expr: "jiraEnabled != true", then: "off" } } } as unknown as JsonValue;

        expect(evaluator.evaluateLayer(data, { file: "m", config: builder }).value).toEqual({ b: true, c: "off" });
    });
});

describe("escapeVariables()", () => {
    /** Keys stay as they are; every string's `${` becomes `$${`. */
    it("should escape strings at any depth", () => {
        expect(escapeVariables({ "${k}": ["${a}", { b: "x ${c}" }], n: 1 })).toEqual({ "${k}": ["$${a}", { b: "x $${c}" }], n: 1 });
    });
});
