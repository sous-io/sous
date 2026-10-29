import { type IntentInfo, type IntentRequest, InputError, toJsonSchema } from "@sous-io/plugin-api";
import type { McpSettings, McpToolDefinition, McpTools } from "./types.js";

/** The tools and the problems found while making them. */
export interface ToolSet {
    readonly tools: McpToolDefinition[];
    /** One line per problem, such as two intents claiming the same tool name. */
    readonly warnings: string[];
}

/**
 * The tool name of an intent: its `agent.tool`, or its name with dots as underscores.
 *
 * ```ts
 * toolName({ intent: "namespace.list" });                          // "namespace_list"
 * toolName({ intent: "version", agent: { tool: "sous_version" } }); // "sous_version"
 * ```
 */
export function toolName(definition: IntentInfo["definition"]): string {
    return definition.agent?.tool ?? definition.intent.replace(/\./g, "_");
}

/**
 * Whether MCP shows an intent: not internal, not `agent.hidden`, and not a background intent (a
 * tool call that never returns, such as `mcp.serve` itself, would leave the agent waiting).
 */
export function isAgentVisible(definition: IntentInfo["definition"]): boolean {
    return definition.internal !== true && definition.agent?.hidden !== true && definition.background !== true;
}

/**
 * The description of a tool: the summary, then `agent.usage`, then `agent.whenNotToUse`, as
 * paragraphs. CLI aliases and examples are left out; they are for the CLI only (S1).
 */
export function toolDescription(definition: IntentInfo["definition"]): string {
    const parts: string[] = [];
    const summary = definition.summary ?? definition.description;

    parts.push(summary ?? `Runs the sous intent "${definition.intent}".`);

    if (definition.agent?.usage) {
        parts.push(definition.agent.usage);
    }

    if (definition.agent?.whenNotToUse) {
        parts.push(`When not to use it: ${definition.agent.whenNotToUse}`);
    }

    return parts.join("\n\n");
}

/** The input JSON Schema of a tool. MCP needs an object schema, so a missing one becomes `{}` properties. */
export function toolInputSchema(definition: IntentInfo["definition"]): Record<string, unknown> {
    const schema = toJsonSchema(definition.input);

    if (!schema) {
        return { type: "object", properties: {} };
    }

    if (schema.type === undefined && schema.properties !== undefined) {
        return { ...schema, type: "object" };
    }

    return { ...schema };
}

/** The output JSON Schema of a tool, when the intent declares an object result. MCP allows only objects. */
export function toolOutputSchema(definition: IntentInfo["definition"]): Record<string, unknown> | undefined {
    const schema = toJsonSchema(definition.output);

    return schema?.type === "object" ? { ...schema } : undefined;
}

/**
 * Whether a tool name matches a glob: `*` matches any run of characters, `?` one character.
 *
 * ```ts
 * matchesGlob("recipe_search", "recipe_*"); // true
 * ```
 */
export function matchesGlob(name: string, glob: string): boolean {
    const pattern = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");

    return new RegExp(`^${pattern}$`).test(name);
}

/**
 * Makes a tool from every intent MCP shows, filtered by the `mcp` key's `include` and `exclude`.
 * When two intents claim one tool name, the first in plugin order keeps it and a warning names both.
 */
export function buildTools(intents: readonly IntentInfo[], settings: Partial<McpSettings> = {}): ToolSet {
    const tools: McpToolDefinition[] = [];
    const warnings: string[] = [];
    const owners = new Map<string, IntentInfo>();
    const include = settings.include;
    const exclude = settings.exclude ?? [];

    for (const info of intents) {
        const definition = info.definition;

        if (!isAgentVisible(definition)) {
            continue;
        }

        const name = toolName(definition);

        if (include && !include.some((glob) => matchesGlob(name, glob))) {
            continue;
        }

        if (exclude.some((glob) => matchesGlob(name, glob))) {
            continue;
        }

        const owner = owners.get(name);

        if (owner) {
            warnings.push(
                `Two intents claim the MCP tool "${name}": "${owner.definition.intent}" (${owner.plugin}) and ` +
                    `"${definition.intent}" (${info.plugin}). The first keeps it; set agent.tool on one of them.`,
            );
            continue;
        }

        owners.set(name, info);

        const outputSchema = toolOutputSchema(definition);

        tools.push({
            name,
            intent: definition.intent,
            description: toolDescription(definition),
            inputSchema: toolInputSchema(definition),
            ...(outputSchema ? { outputSchema } : {}),
        });
    }

    return { tools, warnings };
}

/** The `mcp.tools` service over a set of tools. */
export function createMcpTools(set: ToolSet): McpTools & { readonly warnings: readonly string[] } {
    const byName = new Map(set.tools.map((tool) => [tool.name, tool]));

    return {
        warnings: set.warnings,
        list: () => [...set.tools],
        toRequest(tool: string, args: Readonly<Record<string, unknown>>): IntentRequest {
            const found = byName.get(tool);

            if (!found) {
                throw new InputError(tool, [{ path: "", message: `No MCP tool is named "${tool}".` }]);
            }

            return { intent: found.intent, input: { ...args } };
        },
    };
}
