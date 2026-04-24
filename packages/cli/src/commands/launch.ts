import { Args, Flags } from "@oclif/core";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { BaseCommand } from "../base-command.js";
import { BuildService } from "../lib/build-service.js";
import { resolveProjectTools, resolveRootScope, resolveScope } from "../lib/settings.js";
import { displayError, footer, heading, showCommandVars } from "../utils/formatting.js";

export default class Launch extends BaseCommand {
  static description = "Build and launch a coding agent for a project";

  static examples = [
    "<%= config.bin %> launch claude",
    "<%= config.bin %> launch codex --no-build",
    "<%= config.bin %> launch claude --continuous",
    "<%= config.bin %> launch codex --project volta",
  ];

  static args = {
    tool: Args.string({
      description: "Tool to launch (e.g. claude, codex)",
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    "no-build": Flags.boolean({
      description: "Skip xcv build before launching",
      default: false,
    }),
    continuous: Flags.boolean({
      description: "Restart the agent automatically on exit",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Launch);

    const project = this.resolveProject(flags.project);
    const rootScope = resolveRootScope(this.settings);
    const tools = resolveProjectTools(project, rootScope);
    const toolConfig = tools[args.tool];

    if (!toolConfig) {
      displayError(
        `Tool '${args.tool}' not found in project '${project.key}'. ` +
          `Available tools: ${Object.keys(tools).join(", ") || "(none)"}`
      );
      this.exit(1);
    }

    const projectScope = resolveScope(project._vars ?? {}, rootScope);
    const projectRoot = projectScope.projectRoot ?? process.cwd();

    showCommandVars({
      Project: project.name,
      Tool: args.tool,
      "Project Root": projectRoot,
      "No Build": flags["no-build"],
      Continuous: flags.continuous,
    });

    const buildService = new BuildService();

    do {
      // Build step (unless --no-build)
      if (!flags["no-build"]) {
        heading("Building");
        await buildService.build(project.key, this.settings);
        footer();
      }

      // Resolve promptFile content
      const launchArgs = [...(toolConfig.args ?? [])];
      if (toolConfig.promptFile) {
        if (!fs.existsSync(toolConfig.promptFile)) {
          displayError(`promptFile not found: ${toolConfig.promptFile}`);
          this.exit(1);
        }
        const promptContent = fs.readFileSync(toolConfig.promptFile, "utf8");
        launchArgs.push(promptContent);
      }

      heading(`Launching ${args.tool}`);

      // Run the tool with inherited stdio (interactive)
      const result = spawnSync(toolConfig.command, launchArgs, {
        cwd: projectRoot,
        stdio: "inherit",
        shell: false,
      });

      if (result.error) {
        displayError(`Failed to launch '${args.tool}': ${result.error.message}`);
        this.exit(1);
      }

      if (flags.continuous) {
        // Small delay to avoid tight spin on immediate crash
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    } while (flags.continuous);

    footer();
  }
}
