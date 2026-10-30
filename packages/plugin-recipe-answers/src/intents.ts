/**
 * The `vars` intents: `vars.ask`, `vars.list` (also bare `sous vars`), `vars.show` and `vars.map`.
 * Each is written once here; the CLI and MCP generate their commands and tools from it (S6, rule 7).
 */

import { type Context, ConfigError, InputError, type IntentDefinition, jsonSchema } from "@sous-io/plugin-api";
import type { EnvFileKind } from "@sous-io/plugin-config-files/types";
import { askForMissing, type AnswerStore, storeGivenAnswers } from "./ask.js";
import { namesVariable, recipeKey } from "./definitions.js";
import type { Ladder } from "./ladder.js";
import { VAR_MAPPINGS_FILE } from "./mappings.js";
import { resolveUserPath } from "./paths.js";
import { unknownAnswerError } from "./preanswers.js";
import { describeSelection, resolveSelection, SEE_ALL } from "./selection.js";
import { answerFileFor, buildLadder, displayValue, hiddenValue } from "./sources.js";
import type {
    DefinedVariable,
    VariableDetail,
    VariableListing,
    VarsAskInput,
    VarsAskResult,
    VarsListInput,
    VarsMapInput,
    VarsMapResult,
    VarsShowInput,
} from "./types.js";
import { constraintBullets, validateAnswer } from "./validate.js";

/** The `--file` input every `vars` intent takes. */
const FILE_FIELD = {
    type: "string",
    description: "Read the variable definitions from a standalone definitions file instead of the project's recipes",
} as const;

/** The help line every listing names its definitions source with. */
function definitionsLabel(file: string | undefined): string {
    return file ?? "the project's subscribed recipes";
}

/** A ladder for this chain, over the env files as they are now. */
function ladderFor(ctx: Context): Ladder {
    return buildLadder({ services: ctx.services, env: ctx.env, config: ctx.config });
}

/** One variable as a listing shows it. */
export function listingOf(variable: DefinedVariable, ladder: Ladder, hidden: string): VariableListing {
    const resolved = ladder.resolve(variable);

    return {
        variable,
        answered: resolved !== undefined,
        ...(resolved === undefined ? {} : { value: displayValue(resolved.value, variable.definition.secret, hidden), source: resolved.source }),
        storedAs: resolved?.source.envName ?? ladder.bareName(variable),
        storeIn: answerFileFor(variable.definition),
    };
}

/** One variable with everything about how it was answered. */
export function detailOf(variable: DefinedVariable, ladder: Ladder, hidden: string): VariableDetail {
    const diagnosis = ladder.diagnose(variable);
    const checked = diagnosis.resolved === undefined ? undefined : validateAnswer(variable.definition, diagnosis.resolved.value, { recipe: recipeKey(variable.recipe) });
    const mapping = diagnosis.resolved?.source.rung === "mapping" ? diagnosis.resolved.source.envName : undefined;
    const shownDiagnosis =
        diagnosis.resolved === undefined || !variable.definition.secret ? diagnosis : { ...diagnosis, resolved: { ...diagnosis.resolved, value: hidden } };

    return {
        ...listingOf(variable, ladder, hidden),
        diagnosis: shownDiagnosis,
        constraints: constraintBullets(variable.definition),
        ...(checked?.ok === false ? { problem: checked.message } : {}),
        ...(mapping === undefined ? {} : { mapping: { envName: mapping, target: ladder.mappings[mapping] ?? "" } }),
    };
}

/** The variables a name names, or an error saying none does. */
function variablesNamed(variables: readonly DefinedVariable[], name: string): DefinedVariable[] {
    const matches = variables.filter((entry) => namesVariable(entry, name));

    if (matches.length === 0) {
        throw new ConfigError(`No variable named '${name}' is in play.`, { details: ["Run 'sous vars list' to see every variable this project's recipes define."] });
    }

    return matches;
}

/** Writes answers and mappings through their owners: `config-files.env` and `recipe-answers.mappings`. */
function storeFor(ctx: Context): AnswerStore {
    const env = ctx.services.get("config-files.env");

    return {
        envPath: (file: EnvFileKind) => env.paths()?.[file] ?? (file === "local" ? ".sous/.env.local" : ".sous/.env"),
        mappingPath: () => ctx.services.get("confd.managed").path(VAR_MAPPINGS_FILE),
        writeAnswer: async (file, envName, value, comment) => {
            await env.write(file, { [envName]: value }, { comment });
        },
        writeMapping: async (envName, target) => {
            const mappings = ctx.services.get("recipe-answers.mappings");

            return (await mappings.set(envName, mappings.parseTarget(target))).file;
        },
    };
}

/** `vars.ask`. */
export async function handleAsk(input: VarsAskInput, ctx: Context): Promise<VarsAskResult> {
    const dryRun = input.dryRun === true;
    const hidden = hiddenValue(ctx.services);

    ctx.reporter.log("info", `Definitions: ${definitionsLabel(input.file)}`);
    ctx.reporter.log("info", `Asking: ${describeSelection(input)}`);

    if (dryRun) {
        ctx.reporter.note("Dry run: no answers will be written.");
    }

    const preanswers = ctx.services.get("recipe-answers.preanswers");
    const provided = await preanswers.read(input.answersFile === undefined ? input : { ...input, answersFile: resolveUserPath(input.answersFile, ctx) });
    const variables = await ctx.services.get("recipe-answers.definitions").list(input.file === undefined ? {} : { file: resolveUserPath(input.file, ctx) });

    if (variables.length === 0) {
        // A given answer naming a variable nothing defines is a typo until shown otherwise.
        if (provided[0] !== undefined) {
            throw unknownAnswerError(provided[0], variables);
        }

        ctx.reporter.note(
            "No recipe in this project defines any variables yet, so there is nothing to ask. Subscribe to a recipe that publishes some, or read a definitions file with --file.",
        );

        return { answered: [], inherited: [], skipped: [], dryRun };
    }

    const ladder = ladderFor(ctx);
    const only = await resolveSelection(variables, ladder, input, ctx);
    const run = { prompter: ctx.prompter, reporter: ctx.reporter, store: storeFor(ctx), hidden, dryRun };

    // Answers given up front are checked and stored before anything is asked, so what is left is
    // what nobody answered.
    const given = await storeGivenAnswers(preanswers.match(provided, variables), ladder, run);
    const report = await askForMissing(variables, ladder, { ...(only === undefined ? {} : { only }), skip: given.keys, reask: input.all === true }, run);
    const result: VarsAskResult = {
        answered: [...given.stored, ...report.answered],
        inherited: report.inherited.map(({ variable, resolved }) => ({ variable, resolved: variable.definition.secret ? { ...resolved, value: hidden } : resolved })),
        skipped: report.skipped,
        dryRun,
    };

    if (!dryRun && result.answered.some((entry) => entry.outcome !== "not written")) {
        ctx.configChanged();
    }

    // The CLI view prints the summary (askSummary); reporting it here too would show it twice.
    return result;
}

/** `vars.list`, and `sous vars <name>`. */
export async function handleList(input: VarsListInput, ctx: Context): Promise<VariableListing[]> {
    const variables = await ctx.services.get("recipe-answers.definitions").list(input.file === undefined ? {} : { file: resolveUserPath(input.file, ctx) });
    const ladder = ladderFor(ctx);
    const hidden = hiddenValue(ctx.services);

    // The CLI view names the definitions source in its "Command Variables" block.
    ctx.reporter.log("debug", `Definitions: ${definitionsLabel(input.file)}`);

    if (input.name !== undefined) {
        return variablesNamed(variables, input.name).map((variable) => detailOf(variable, ladder, hidden));
    }

    return variables.map((variable) => listingOf(variable, ladder, hidden));
}

/** `vars.show`. Several matches are settled by `refs.picker` (`--accept-first`). */
export async function handleShow(input: VarsShowInput, ctx: Context): Promise<VariableDetail> {
    const variables = await ctx.services.get("recipe-answers.definitions").list(input.file === undefined ? {} : { file: resolveUserPath(input.file, ctx) });
    const matches = variablesNamed(variables, input.name);
    const ladder = ladderFor(ctx);
    const hidden = hiddenValue(ctx.services);

    if (matches.length === 1) {
        return detailOf(matches[0]!, ladder, hidden);
    }

    const picked = await ctx.services.get("refs.picker").pick(
        matches.map((entry) => entry.ref),
        { search: input.name, acceptFirst: input.acceptFirst === true, announce: false, details: [SEE_ALL] },
        ctx,
    );
    const chosen = matches.find((entry) => entry.ref === picked) ?? matches.find((entry) => JSON.stringify(entry.ref) === JSON.stringify(picked)) ?? matches[0]!;

    return detailOf(chosen, ladder, hidden);
}

/** `vars.map`. */
export async function handleMap(input: VarsMapInput, ctx: Context): Promise<VarsMapResult> {
    const mappings = ctx.services.get("recipe-answers.mappings");
    const dryRun = input.dryRun === true;

    if (input.remove === true) {
        const { file, changed } = await mappings.remove(input.envName, { dryRun });

        if (changed && !dryRun) {
            ctx.configChanged();
        }

        ctx.reporter.note(changed ? `${dryRun ? "Would remove" : "Removed"} the mapping of ${input.envName} in ${file}.` : `${input.envName} has no mapping in ${file}.`);

        return { envName: input.envName, file, changed, dryRun };
    }

    if (input.target === undefined) {
        throw new InputError("vars.map", [{ path: "target", message: "Name the variable to bind, as 'namespace/recipe/variableName', or pass --remove." }]);
    }

    const target = mappings.formatTarget(mappings.parseTarget(input.target));
    const { file, changed } = await mappings.set(input.envName, mappings.parseTarget(target), { dryRun });

    if (changed && !dryRun) {
        ctx.configChanged();
    }

    ctx.reporter.note(changed ? `${dryRun ? "Would map" : "Mapped"} ${input.envName} to ${target} in ${file}.` : `${input.envName} is already mapped to ${target}.`);

    return { envName: input.envName, target, file, changed, dryRun };
}

/** Every `vars` intent, as registered. */
export const varsIntents: IntentDefinition[] = [
    {
        intent: "vars.ask",
        summary: "Answer the variables this project's recipes define, storing the answers in the .sous env files",
        description:
            "Asks only what is unanswered or no longer fits; --all asks everything again. The name may be a variable, an environment variable name, a recipe, a namespace or a repository. Every question can be answered ahead of time with --answer <name>=<value> or --answers-file.",
        input: jsonSchema<VarsAskInput>({
            type: "object",
            properties: {
                name: { type: "string", description: "What to ask about: a variable, an environment variable name, a recipe, a namespace or a repository" },
                all: { type: "boolean", default: false, description: "Ask every variable again, including the ones already answered" },
                repo: { type: "string", description: "Ask only the variables published by this repository" },
                namespace: { type: "string", description: "Ask only the variables published in this namespace" },
                recipe: { type: "string", description: "Ask only the variables published by this recipe (namespace/recipe)" },
                var: { type: "array", items: { type: "string" }, description: "Ask only this variable. Repeat it for each variable" },
                acceptFirst: { type: "boolean", default: false, description: "When a name matches several things, take the first one listed" },
                file: FILE_FIELD,
                dryRun: { type: "boolean", default: false, description: "Report what would be asked and written, without writing anything" },
                answer: { type: "array", items: { type: "string" }, description: "Answer a variable ahead of its question, as <name>=<value>. Repeat it for each answer" },
                answersFile: { type: "string", description: "Read answers from a YAML, JSON or .env file of name: value pairs" },
            },
            additionalProperties: false,
        }),
        cli: {
            command: ["vars", "ask"],
            aliases: [["var", "ask"]],
            positional: ["name"],
            examples: [
                "sous vars ask",
                "sous vars ask apiUrl",
                "sous vars ask SOUS_VAR_API_URL",
                "sous vars ask workflow/task-files",
                "sous vars ask workflow --accept-first",
                "sous vars ask --namespace workflow --var apiUrl",
                "sous vars ask --all",
                "sous vars ask --file ./questions.yaml",
                "sous vars ask --answer apiUrl=https://api.example.com",
                "sous vars ask --answers-file ./answers.yaml",
            ],
        },
        agent: {
            usage: "Pass every answer with `answer` (name=value pairs) or `answersFile`; questions cannot be asked through MCP unless the client supports elicitation.",
        },
        requiresProject: true,
        handle: handleAsk as IntentDefinition["handle"],
    },
    {
        intent: "vars.list",
        summary: "List every variable this project's recipes define, with its answer",
        input: jsonSchema<VarsListInput>({
            type: "object",
            properties: {
                name: { type: "string", description: "A variable's name (or its namespace/recipe.name key) to show in full" },
                file: FILE_FIELD,
            },
            additionalProperties: false,
        }),
        parallel: true,
        cli: {
            command: ["vars", "list"],
            aliases: [["var", "list"], ["vars"]],
            positional: ["name"],
            examples: ["sous vars", "sous vars apiUrl", "sous vars list", "sous vars list --file ./questions.yaml"],
        },
        requiresProject: true,
        handle: handleList as IntentDefinition["handle"],
    },
    {
        intent: "vars.show",
        summary: "Show everything about one variable, including how it was answered",
        input: jsonSchema<VarsShowInput>({
            type: "object",
            properties: {
                name: { type: "string", description: "A variable's name, or its namespace/recipe.name key" },
                file: FILE_FIELD,
                acceptFirst: { type: "boolean", default: false, description: "When the name matches several variables, take the first one listed" },
            },
            required: ["name"],
            additionalProperties: false,
        }),
        parallel: true,
        cli: {
            command: ["vars", "show"],
            aliases: [["var", "show"]],
            positional: ["name"],
            examples: ["sous vars show apiUrl", "sous vars show workflow/task-files.apiUrl"],
        },
        requiresProject: true,
        handle: handleShow as IntentDefinition["handle"],
    },
    {
        intent: "vars.map",
        summary: "Bind an environment variable to one recipe variable, in conf.d/520-var-mappings.jsonc",
        input: jsonSchema<VarsMapInput>({
            type: "object",
            properties: {
                envName: { type: "string", description: "The environment variable name, in upper snake case" },
                target: { type: "string", description: "The variable it answers: namespace/recipe/variableName, optionally repo:-qualified" },
                remove: { type: "boolean", default: false, description: "Remove the mapping instead" },
                dryRun: { type: "boolean", default: false, description: "Report what would change, without writing anything" },
            },
            required: ["envName"],
            additionalProperties: false,
        }),
        changesConfig: true,
        cli: {
            command: ["vars", "map"],
            aliases: [["var", "map"]],
            positional: ["envName", "target"],
            examples: ["sous vars map TEAM_API_URL sous-recipes:misc/stuff/apiUrl", "sous vars map TEAM_API_URL --remove"],
        },
        requiresProject: true,
        handle: handleMap as IntentDefinition["handle"],
    },
];
