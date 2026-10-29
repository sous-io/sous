/**
 * plugin-cli: the command-line front end of sous (S1, "The CLI foundation"; S6).
 */

import "./types.js";

export { BUILT_IN_GLOBAL_ARGUMENTS, CLI_PLUGIN_NAME, cliPlugin, createCliPlugin } from "./plugin.js";
export type { CliPluginOptions } from "./plugin.js";
export { CommandTree } from "./command-tree.js";
export type { Command, CommandNode, CommandPicks } from "./command-tree.js";
export { argumentsFromSchema, convertValue } from "./flags.js";
export type { CommandArguments, FlagSpec, PositionalSpec, ValueKind } from "./flags.js";
export { BUILT_IN_GROUPS } from "./groups.js";
export { helpIntent } from "./help-intent.js";
export { globalSpecs } from "./globals.js";
export { renderHelp } from "./help.js";
export { processIo } from "./io.js";
export type { CliIo, InputStream, OutputStream } from "./io.js";
export { parseLine } from "./parse.js";
export type { ParsedLine } from "./parse.js";
export { runCommandLine, thresholdOf } from "./front-end.js";
export { canPrompt, TerminalPrompter } from "./terminal-prompter.js";
export { TerminalReporter } from "./terminal-reporter.js";
export { viewError } from "./errors.js";
export { renderResult, renderTimings } from "./views.js";
export { editDistance, suggest, toKebab } from "./words.js";
export type * from "./types.js";
