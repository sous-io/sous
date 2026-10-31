/**
 * The plugin interface of sous: the one promise sous makes outside its
 * monorepo. It holds `definePlugin`, the interfaces plugins add their types to, every public
 * type, the `Reporter` and `Prompter` interfaces and the error classes. Everything else a plugin
 * uses is handed to it in `register(sous)` and in each `ctx`.
 */

export type * from "./config.js";
export type * from "./context.js";
export type * from "./entities.js";
export type * from "./events.js";
export type * from "./intents.js";
export type * from "./json.js";
export type * from "./node.js";
export type * from "./registry.js";
export type * from "./services.js";

export { definePlugin } from "./plugin.js";
export type * from "./plugin.js";

export {
    CancelledError,
    ConfigError,
    ConflictError,
    InputError,
    isSousError,
    isSousErrorOfKind,
    LoopError,
    NonInteractiveError,
    NotFoundError,
    PluginError,
    SousError,
} from "./errors.js";
export type { InputIssue, SousErrorKind, SousErrorOptions } from "./errors.js";

export { nonInteractivePrompter, scriptedPrompter } from "./prompter.js";
export type * from "./prompter.js";

export {
    BaseReporter,
    BufferedReporter,
    createReporter,
    isLevelShown,
    isLogLevel,
    LOG_LEVELS,
    errorChain,
    LogLevel,
    messageText,
    nullReporter,
    ReportEntryStyle,
    Reporting,
} from "./reporter.js";
export type * from "./reporter.js";

export { commandVariables } from "./command-variables.js";
export { DataValue, IntentOutput, IntentOutputs, ItemList, Payload, Table, TextBlock, Tree, VariableSet } from "./outputs.js";
export type * from "./outputs.js";

export { formatIssuePath, isSchema, jsonSchema, toJsonSchema, validateWith, validateWithSync } from "./schema.js";
export type * from "./schema.js";

export { TIMING_CATEGORIES } from "./timing.js";
export type * from "./timing.js";
