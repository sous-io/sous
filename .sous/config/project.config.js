// Temp until I figure out how to resolve paths.
const sousProjectRoot = "/home/luke/Projects/puravida/infra/sous";

// --- VARIABLES -------------------------------------------------------------------------------------------------------

/**
 * Defines project-level constant variables.
 */
const projectConstants = {
  projectMemoryEntryPointFilename: "MEMORY.root.tpl.md",
  projectRunTimeContextPromptFilename: "session-context.md",
  projectTicketPrefix: "devops-"
};

/**
 * Just some strings that can be used to reference Claude Code
 * in the templates. These are injected into the compiler outputs
 * so they'll only be available to Claude outputs.
 */
const claudeSpecificVariables = {
  tool: "claude",
  toolName: "Claude Code",
  toolNameShort: "Claude",
  toolMetaDirectory: `.claude`,
};

/**
 * Defines all of the relevant project-level paths for the Sous project.
 */
const projectPaths = {
  projectRoot: sousProjectRoot,

  // project sub-folders
  projectMetaRoot: "${projectRoot}/.sous",
  projectClaudeRoot: "${projectRoot}/.claude",

  // meta sub-folders
  projectConfigRoot: "${projectMetaRoot}/config",
  projectPromptRoot: "${projectMetaRoot}/prompts",
  projectStateRoot: "${projectMetaRoot}/state",
  projectTaskRoot: "${projectMetaRoot}/tasks",

  // config sub-folders
  projectClaudeSpecificFileRoot: "${projectConfigRoot}/.claude",

  // prompt sub-folders
  projectMemoryRoot: "${projectPromptRoot}/memory",
  projectRuntimeContextRoot: "${projectPromptRoot}/runtime-context",
  projectSkillRoot: "${projectPromptRoot}/skills",

};

// --- COMPILER CONFIGS ------------------------------------------------------------------------------------------------

/**
 * Compiler Config: Main Memory File (Root CLAUDE.md)
 */
const mainMemoryCompilationConfig = {
  entryPoint: "${projectMemoryRoot}/${projectMemoryEntryPointFilename}",
  generateRuntimeContext: false, // todo: how is this different than `runtimeContext.generate`?
  outputs: [
    { _vars: claudeSpecificVariables, destinationFile: "${projectRoot}/CLAUDE.md" },
  ],
};

/**
 * Compiler Config: Claude-Specific Files
 */
const claudeSpecificCompilationConfig = {
  entryGlob: "${projectClaudeSpecificFileRoot}/**/*",
  outputs: [
    { _vars: claudeSpecificVariables, destinationDir: "${projectClaudeRoot}" },
  ],
};

/**
 * Compiler Config: Local Skills
 * These skills are specific to the `sous` project and are stored in its `.sous` directory.
 */
const localSkillsCompilationConfig = {
  entryGlob: "${projectSkillRoot}/**/*",
  outputs: [
    { _vars: claudeSpecificVariables, destinationDir: "${projectClaudeRoot}/skills" },
  ],
};

/** Bring the compiler configs together **/
const compilationTargets = [
  mainMemoryCompilationConfig,
  claudeSpecificCompilationConfig,
  localSkillsCompilationConfig,
];

// --- ADDITIONAL CONFIGS ----------------------------------------------------------------------------------------------

/**
 * Configuration for launching Claude Code
 */
const claudeLaunchConfig = {
  command: "claude",
  args: ["--dangerously-skip-permissions"],
};

/**
 * Run-time Context Generation Config
 * Provides information about the current state of the project folder/session, including:
 * - Current Git Branch
 * - Path to Active Task File (if one is active)
 * - Contents of Active Task File (if one is active)
 */
const runtimeContextGenerationConfig = {
  /** Enable run-time context generation **/
  generate: false, //true,

  /** Indicates the root directory of the project's Git repository **/
  gitRoot: "${projectRoot}",

  /** Indicates where the session-context.md should be output to **/
  outputPath: "${projectRuntimeContextRoot}/${projectRunTimeContextPromptFilename}",

  /** Indicates where task files are stored **/
  taskFileRoot: "${projectTaskRoot}",

  /** The pattern to look for in the branch name to know we're on a feature branch **/
  branchPattern: "${projectTicketPrefix}",
};

// --- FINAL CONFIG ASSEMBLY -------------------------------------------------------------------------------------------

export const sousProjectConfig = {
  /** The human-readable name of the project **/
  name: "Sous",

  /** Project-level Template Variables **/
  _vars: {
    ...projectConstants,
    ...projectPaths,
  },

  /** Configuration for run-time context generation **/
  runtimeContext: runtimeContextGenerationConfig,

  /** Compilation config, including targets **/
  compilation: {
    /** @todo remove this entirely, it will probably never be useful to output the source comments **/
    includeSourceComments: false,

    /** Each compilation input and output **/
    targets: compilationTargets,
  },

  /** Tool configs; mostly just launch instructions **/
  tools: {
    claude: claudeLaunchConfig,
  },
};
