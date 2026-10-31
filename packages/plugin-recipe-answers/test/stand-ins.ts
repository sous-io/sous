/**
 * Stand-ins for the plugins plugin-recipe-answers depends on, which are not written yet. Each is
 * the smallest working version of its contract, enough to test this plugin through the engine.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
    type Choice,
    ConfigError,
    definePlugin,
    type DocumentNode,
    jsonSchema,
    type PluginDefinition,
    type Prompter,
    type ServiceReader,
} from "@sous-io/plugin-api";
import type { ConfdManaged, ManagedEditResult } from "@sous-io/plugin-confd/types";
import type { ConfigFilesEnv, EnvFileKind, EnvFileValues } from "@sous-io/plugin-config-files/types";
import type { FormatParser, VariableDefinition } from "@sous-io/plugin-formats/types";
import type { ActiveRecipeEntity } from "@sous-io/plugin-recipes/types";
import type { RefsPicker, RefsResolver, SousRef } from "@sous-io/plugin-refs/types";
import type { VariablesNames, VariablesSecrets } from "@sous-io/plugin-variables/types";
import { Ladder, type LadderLayers } from "../src/ladder.js";
import { defineVariable } from "../src/definitions.js";
import type { DefinedVariable, DefiningRecipe } from "../src/types.js";
import packageJson from "../package.json" with { type: "json" };

// ---------------------------------------------------------------------------------------------
// variables.names, variables.secrets
// ---------------------------------------------------------------------------------------------

/** `apiBaseUrl` → `API_BASE_URL`. */
function toUpperSnake(name: string): string {
    return name
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
        .replace(/[-\s.]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_|_$/g, "")
        .toUpperCase();
}

/** The names service, as plugin-variables will give it. */
export const names: VariablesNames = {
    envPrefix: "SOUS_VAR_",
    toUpperSnake,
    sharedName: (variable) => `SOUS_VAR_${toUpperSnake(variable)}`,
    recipeScopedName: (namespace, recipe, variable) => `SOUS_VAR_${toUpperSnake(namespace)}_${toUpperSnake(recipe)}_${toUpperSnake(variable)}`,
    namespaceScopedName: (namespace, variable) => `SOUS_VAR_${toUpperSnake(namespace)}_${toUpperSnake(variable)}`,
    bareName: (definition) => definition.env ?? `SOUS_VAR_${toUpperSnake(definition.name)}`,
    isVariableName: (text) => /^[a-z][a-zA-Z0-9]*$/.test(text),
    isEnvName: (text) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(text),
};

/** The secrets service, only as far as this plugin uses it. */
export const secrets = { hiddenValue: "(hidden)" } as VariablesSecrets;

// ---------------------------------------------------------------------------------------------
// config-files.env
// ---------------------------------------------------------------------------------------------

/** An env file service over two in-memory files. */
export class MemoryEnv implements ConfigFilesEnv {
    readonly files: Record<EnvFileKind, Record<string, string>> = { shared: {}, local: {} };
    readonly comments: string[] = [];

    constructor(
        private readonly sousDir = "/project/.sous",
        private readonly env: Record<string, string> = {},
    ) {}

    paths() {
        return { shared: path.join(this.sousDir, ".env"), local: path.join(this.sousDir, ".env.local") };
    }

    async read(): Promise<EnvFileValues> {
        return this.readSync();
    }

    readSync(): EnvFileValues {
        return { shared: { ...this.files.shared }, local: { ...this.files.local }, merged: { ...this.files.shared, ...this.files.local, ...this.env } };
    }

    async write(kind: EnvFileKind, entries: Readonly<Record<string, string | undefined>>, options: { dryRun?: boolean; comment?: string } = {}) {
        const set: string[] = [];

        if (options.comment !== undefined) {
            this.comments.push(options.comment);
        }

        for (const [name, value] of Object.entries(entries)) {
            if (value !== undefined && options.dryRun !== true) {
                this.files[kind][name] = value;
                set.push(name);
            }
        }

        return { file: this.paths()[kind], changed: set.length > 0, set, removed: [] };
    }

    parse(text: string): Record<string, string> {
        const values: Record<string, string> = {};

        for (const line of text.split("\n")) {
            const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);

            if (match) {
                values[match[1]!] = match[2]!.replace(/^"(.*)"$/, "$1");
            }
        }

        return values;
    }
}

// ---------------------------------------------------------------------------------------------
// confd.managed
// ---------------------------------------------------------------------------------------------

/** Managed files in memory, edited by dotted path. */
export class MemoryConfd implements Pick<ConfdManaged, "path" | "read" | "set" | "delete" | "header"> {
    readonly data: Record<string, Record<string, unknown>> = {};

    path(name: string): string {
        return `/project/.sous/conf.d/${name}`;
    }

    async read(name: string) {
        return this.data[name] as never;
    }

    async set(name: string, at: string, value: unknown, options: { dryRun?: boolean } = {}): Promise<ManagedEditResult> {
        const file = structuredClone(this.data[name] ?? {});
        const [head, key] = at.split(".") as [string, string];
        const block = (file[head] ?? {}) as Record<string, unknown>;
        const changed = block[key] !== value;

        block[key] = value;
        file[head] = block;

        if (options.dryRun !== true) {
            this.data[name] = file;
        }

        return { file: this.path(name), created: false, changed, patches: { patches: [] } as never, text: JSON.stringify(file) };
    }

    async delete(name: string, at: string, options: { dryRun?: boolean } = {}): Promise<ManagedEditResult> {
        const file = structuredClone(this.data[name] ?? {});
        const [head, key] = at.split(".") as [string, string];
        const block = (file[head] ?? {}) as Record<string, unknown>;
        const changed = key in block;

        delete block[key];
        file[head] = block;

        if (options.dryRun !== true) {
            this.data[name] = file;
        }

        return { file: this.path(name), created: false, changed, patches: { patches: [] } as never, text: JSON.stringify(file) };
    }

    header(): string {
        return "";
    }

    edit(_name: string, _edit: (root: DocumentNode) => void): never {
        throw new Error("not in the stand-in");
    }
}

// ---------------------------------------------------------------------------------------------
// formats
// ---------------------------------------------------------------------------------------------

/** Checks one definition and fills in its defaults, as `formats.variable-definition` will. */
export const definitionParser: FormatParser<VariableDefinition> = {
    label: "variable definition",
    parse(value, sourceLabel) {
        const checked = this.check(value, sourceLabel);

        if (checked.issues) {
            throw new ConfigError(`The ${this.label} in ${sourceLabel} is not valid.`, { details: checked.issues });
        }

        return checked.value;
    },
    check(value) {
        const raw = value as Partial<VariableDefinition> | null;
        const issues = ["name", "type", "prompt", "description", "example"].filter((key) => raw?.[key as keyof VariableDefinition] === undefined).map((key) => `${key}: is required`);

        if (issues.length > 0) {
            return { issues };
        }

        return { value: { required: true, secret: false, scope: "shared", ...raw } as VariableDefinition };
    },
};

/** Reads a JSON file (the stand-in reads only JSON). */
export async function readJson(file: string): Promise<unknown> {
    return JSON.parse(readFileSync(file, "utf8"));
}

// ---------------------------------------------------------------------------------------------
// refs
// ---------------------------------------------------------------------------------------------

/**
 * A small ref parser: `repo:` qualifies; `a/b.c` is a variable; `a/b` a recipe; a word is every
 * kind it could be; an upper snake word is also an environment name.
 */
export function parseRef(input: string): SousRef[] {
    const colon = input.indexOf(":");
    const repo = colon === -1 ? undefined : { kind: "repo" as const, name: input.slice(0, colon) };
    const rest = input.slice(colon + 1);

    if (rest === "") {
        return repo ? [repo] : [];
    }

    if (rest.includes(".")) {
        const [recipePart, variable] = rest.split(".") as [string, string];
        const [namespace, recipe] = recipePart.includes("/") ? (recipePart.split("/") as [string, string]) : [undefined, recipePart];

        return [
            {
                kind: "variable",
                name: variable,
                recipe: { kind: "recipe", name: recipe, ...(namespace === undefined ? (repo ? { repo } : {}) : { namespace: { kind: "namespace", name: namespace, ...(repo ? { repo } : {}) } }) },
            },
        ];
    }

    if (rest.includes("/")) {
        const [namespace, recipe] = rest.split("/") as [string, string];

        return [{ kind: "recipe", name: recipe, namespace: { kind: "namespace", name: namespace, ...(repo ? { repo } : {}) } }];
    }

    const readings: SousRef[] = [];

    if (/^[A-Z_][A-Z0-9_]*$/.test(rest)) {
        readings.push({ kind: "envVar", name: rest });
    }

    if (repo === undefined) {
        readings.push({ kind: "repo", name: rest });
    }

    readings.push({ kind: "namespace", name: rest, ...(repo ? { repo } : {}) });
    readings.push({ kind: "recipe", name: rest, ...(repo ? { repo } : {}) });
    readings.push({ kind: "variable", name: rest, ...(repo ? { repo } : {}) });

    return readings;
}

/** `refs.resolver`, parsing only. */
export const resolver = {
    parse: (input: string) => ({ input, refs: parseRef(input), dropped: [], warnings: [], usedLookup: false }),
} as unknown as RefsResolver;

/** `refs.picker`: the first with `acceptFirst`, else asks through the prompter. */
export const picker: RefsPicker = {
    async pick(matches, options, io) {
        if (options.acceptFirst === true) {
            return matches[0]!;
        }

        const choices: Choice<SousRef>[] = matches.map((ref) => ({ label: JSON.stringify(ref), value: ref }));

        return io.prompter.askChoice({ message: options.prompt ?? `Which '${options.search}' did you mean?`, choices, answeredBy: "--accept-first" });
    },
    facts: () => ({ search: "", resolvedTo: "", kind: "" }),
};

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

/** A variable definition with the defaults the schema applies. */
export function definition(overrides: Partial<VariableDefinition> = {}): VariableDefinition {
    return {
        name: "apiUrl",
        type: "string",
        prompt: "Which API?",
        description: "The service every request this recipe generates is sent to.",
        example: "https://api.example.com",
        required: true,
        secret: false,
        scope: "shared",
        ...overrides,
    };
}

/** A defining recipe, `sous-recipes:misc/stuff` unless told otherwise. */
export function recipe(overrides: Partial<DefiningRecipe> = {}): DefiningRecipe {
    return { repo: "sous-recipes", namespace: "misc", name: "stuff", version: "1.0.0", direct: true, ...overrides };
}

/** A defined variable. */
export function variable(overrides: Partial<VariableDefinition> = {}, recipeOverrides: Partial<DefiningRecipe> = {}): DefinedVariable {
    return defineVariable(recipe(recipeOverrides), definition(overrides));
}

/** A ladder over the given layers and mappings. */
export function ladder(layers: Partial<LadderLayers> = {}, mappings: Record<string, string> = {}): Ladder {
    return new Ladder(names, { shell: {}, local: {}, shared: {}, ...layers }, mappings);
}

/** An active recipe entity. */
export function activeRecipe(key: string, variables: VariableDefinition[], overrides: Partial<ActiveRecipeEntity> = {}): ActiveRecipeEntity {
    const [namespace, name] = key.split("/") as [string, string];

    return {
        id: key,
        namespace,
        name,
        repo: "sous-recipes",
        identity: "github.com/sous-io/sous-recipes",
        version: "1.0.0",
        hash: "sha256-0",
        kind: "subscribes",
        requestedBy: ["project"],
        dir: `/store/${key}`,
        source: "store",
        manifest: { formatVersion: 1, namespace, name, version: "1.0.0", variables } as ActiveRecipeEntity["manifest"],
        ...overrides,
    };
}

/** A service reader over a fixed map, for code that only reads services. */
export function serviceReader(services: Record<string, unknown>): ServiceReader {
    return {
        get: ((name: string) => {
            if (!(name in services)) {
                throw new Error(`no stand-in for ${name}`);
            }

            return services[name];
        }) as ServiceReader["get"],
        has: (name) => name in services,
    };
}

/** A prompter that cannot ask, and records nothing. */
export const silentPrompter: Prompter = {
    interactive: false,
    askValue: () => Promise.reject(new Error("cannot ask")),
    askChoice: () => Promise.reject(new Error("cannot ask")),
    confirm: () => Promise.reject(new Error("cannot ask")),
};

/** What the stand-in plugins share with a test. */
export interface StandIns {
    env: MemoryEnv;
    confd: MemoryConfd;
    /** The recipes the stand-in `recipes.fetch` adds. */
    recipes: ActiveRecipeEntity[];
    plugins: PluginDefinition[];
}

/** Stand-in plugins for every dependency, named and versioned as the real ones. */
export function standInPlugins(recipes: ActiveRecipeEntity[] = [], env = new MemoryEnv()): StandIns {
    const confd = new MemoryConfd();
    const version = packageJson.version;
    const anything = jsonSchema({});
    const plugins: PluginDefinition[] = [
        definePlugin({
            name: "@sous-io/plugin-variables",
            version,
            register(sous) {
                sous.entities.define("variable-source", anything);
                sous.services.add("variables.names", () => names, { lifetime: "singleton" });
                sous.services.add("variables.secrets", () => secrets, { lifetime: "singleton" });
            },
        }),
        definePlugin({
            name: "@sous-io/plugin-refs",
            version,
            register(sous) {
                sous.entities.define("ref-lookup", anything);
                sous.services.add("refs.resolver", () => resolver);
                sous.services.add("refs.picker", () => picker);
            },
        }),
        definePlugin({
            name: "@sous-io/plugin-formats",
            version,
            register(sous) {
                sous.services.add("formats.variable-definition", () => definitionParser, { lifetime: "singleton" });
                sous.services.add("formats.manifests", () => ({ readFile: readJson }) as never, { lifetime: "singleton" });
            },
        }),
        definePlugin({
            name: "@sous-io/plugin-config-files",
            version,
            register(sous) {
                sous.services.add("config-files.env", () => env, { lifetime: "singleton" });
            },
        }),
        definePlugin({
            name: "@sous-io/plugin-confd",
            version,
            register(sous) {
                sous.services.add("confd.managed", () => confd as unknown as ConfdManaged);
                // Stands in for conf.d/520: applies the managed file's data to the config.
                sous.config.contribute({
                    id: "confd/520-var-mappings.jsonc",
                    contribute(config) {
                        const data = confd.data["520-var-mappings.jsonc"];

                        if (data !== undefined) {
                            config.root().merge(data as never);
                        }
                    },
                });
            },
        }),
        definePlugin({
            name: "@sous-io/plugin-recipes",
            version,
            register(sous) {
                sous.entities.define("active-recipe", anything);
                sous.config.contribute({
                    id: "recipes.fetch",
                    contribute(config) {
                        for (const entry of recipes) {
                            config.addEntity("active-recipe", entry);
                        }
                    },
                });
            },
        }),
    ];

    return { env, confd, recipes, plugins };
}
